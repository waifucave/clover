// Clover's own plugins this build can't run yet (`availability: { status: "not-yet" }`, the bundled tree only): listed,
// off, never started, never switched, and a home that had one on keeps its records untouched.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPointDecl, NOT_AVAILABLE_YET, parseJsonc, PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { grantsInForce } from "../../contracts/plugin-registry";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import type { Manifest } from "../../contracts/sdk-types";
import { memoryPluginSettings, PluginSettings } from "../../plugin-host/api/settings";
import { registryEvents } from "../../plugin-host/registry-events";
import { pluginRegistryMethods } from "../../plugin-host/registry-methods";
import { RegistryCore, type RegistryInput } from "../core";
import { PluginFolders } from "../folders";
import { openPluginRegistry } from "../open";
import { fileRegistryStore, memoryRegistryStore } from "../state";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const clover: Manifest = { manifest: 1, id: "clover", name: "Clover" } as Manifest;
// The forwarder as it was (try 11) and as it is now: the same plugin, marked.
const forwarder = (marked: boolean): Manifest => ({
  manifest: 1, name: "waifucave forwarder", engines: { clover: "^1.0.0" },
  host: { entry: "host/index.ts", runtime: "bun", start: "each" },
  capabilities: ["network:hooks.waifucave.com"],
  contributes: { "webhook.ingress": [{ id: "waifucave", name: "waifucave forwarder", handler: "ingress" }] },
  ...(marked ? { availability: { status: "not-yet", reason: "webhook-keys" } } : {}),
} as unknown as Manifest);
const tree = (marked: boolean, hash: string) => [
  { id: "clover", manifest: clover, treeHash: hash, approved: true, source: "bundled" as const },
  { id: "clover/forwarder", manifest: forwarder(marked), treeHash: hash, approved: true, source: "bundled" as const },
];

// The browser tool as it is: a host half and the `browser` server bots are offered, with its instructions.
const browser = (marked: boolean): Manifest => ({
  manifest: 1, name: "Browser tool", engines: { clover: "^1.0.0" }, host: { entry: "host/index.ts", runtime: "bun" }, capabilities: ["browser"],
  contributes: { mcpServers: { browser: { type: "host", tools: { Browser: "preload" }, instructions: "instructions.md", perComputer: true } } },
  ...(marked ? { availability: { status: "not-yet", reason: "no-browser-composed" } } : {}),
} as unknown as Manifest);
const withBrowser = (marked: boolean, hash: string) => [
  { id: "clover", manifest: clover, treeHash: hash, approved: true, source: "bundled" as const },
  { id: "clover/browser", manifest: browser(marked), treeHash: hash, approved: true, source: "bundled" as const },
];

describe("a plugin not available in this build yet", () => {
  test("the browser tool marked: its server is in no session's list (so neither are its tool nor its instructions), its capability not in force", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll(withBrowser(false, "sha256:1"));
    // Unmarked, it is offered (what every session's plugin servers are read from: `entries("mcpServers")`).
    expect(reg.entries("mcpServers").filter((e) => e.pluginId === "clover/browser").map((e) => e.entryId)).toEqual(["browser"]);
    expect(grantsInForce(reg.get("clover/browser"))).toEqual(["browser"]);
    reg.putAll(withBrowser(true, "sha256:2"));
    expect(reg.entries("mcpServers").filter((e) => e.pluginId === "clover/browser")).toEqual([]);
    expect(grantsInForce(reg.get("clover/browser"))).toEqual([]);
    const r = reg.get("clover/browser")!;
    expect([r.state, r.reason, r.enabled, r.okHash]).toEqual(["off", NOT_AVAILABLE_YET, true, "sha256:2"]);
    expect(reg.okCards()).toEqual([]);
  });

  test("is listed, off with the plain reason, its entries out of every point, no capability in force", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll(tree(true, "sha256:2"));
    const r = reg.get("clover/forwarder")!;
    expect([r.state, r.reason, r.enabled]).toEqual(["off", NOT_AVAILABLE_YET, true]);
    expect(grantsInForce(r)).toEqual([]);
    expect(reg.entries("webhook.ingress")).toEqual([]);
    // Its parent runs as before.
    expect(reg.get("clover")!.state).toBe("running");
  });

  test("can't be switched, either way: a plain refusal, and its switch stays as it was", async () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll(tree(true, "sha256:2"));
    for (const enabled of [true, false]) {
      const err = await reg.setEnabled("clover/forwarder", enabled).catch((e: Error) => e);
      expect((err as Error).message).toBe("clover/forwarder isn't available in this build yet, so it can't be turned on or off");
    }
    expect(reg.get("clover/forwarder")!.enabled).toBe(true);
  });

  test("the app's and the terminal's doors refuse it plainly: switch and restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-notyet-"));
    temps.push(home);
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
    try {
      opened.registry.putAll(tree(true, "sha256:2"));
      const m = pluginRegistryMethods({ opened, host: { restart: async () => { throw new Error("started"); } }, home });
      for (const client of ["app", "cli"]) {
        const ctx = { caller: { kind: "user", client } } as never;
        const on = await m["plugin.setEnabled"]!({ id: "clover/forwarder", enabled: true }, ctx).catch((e: Error) => e.message);
        expect(on).toContain("isn't available in this build yet");
        const restart = await m["plugin.restart"]!({ id: "clover/forwarder" }, ctx).catch((e: Error) => e.message);
        expect(restart).toBe(`clover/forwarder isn't running (off: ${NOT_AVAILABLE_YET}), so there's nothing to restart`);
        // Remove: a part of a tree is never removed on its own (the call takes a top-level id), and Clover's own tree
        // isn't removed at all.
        const remove = await m["plugin.remove"]!({ id: "clover/forwarder" }, ctx).then(() => "removed", (e: Error) => e.message);
        expect(remove).toContain("plugin.remove: id:");
        const whole = await m["plugin.remove"]!({ id: "clover" }, ctx).then(() => "removed", (e: Error) => e.message);
        expect(whole).toBe("clover comes with Clover; switch it off instead");
      }
    } finally {
      opened.close();
    }
  });

  test("an upgrade from a home where it was on and OK'd: listed as not available, its switch and OK kept, no card", () => {
    const store = memoryRegistryStore();
    const before = new RegistryCore({ catalog: catalogPointDecl, store });
    before.putAll(tree(false, "sha256:1"));
    // On (waiting for the point it fills, which this tree doesn't declare, or running).
    expect(["running", "waiting"]).toContain(before.get("clover/forwarder")!.state);
    expect(before.get("clover/forwarder")!.enabled).toBe(true);
    const okBefore = before.get("clover/forwarder")!.okHash;
    expect(okBefore).toBe("sha256:1");
    // The new build, on the same records.
    const after = new RegistryCore({ catalog: catalogPointDecl, store });
    after.putAll(tree(true, "sha256:2"));
    const r = after.get("clover/forwarder")!;
    expect([r.state, r.reason, r.enabled]).toEqual(["off", NOT_AVAILABLE_YET, true]);
    // Clover's own tree carries its OK to the new tree as any upgrade does: never forgotten, never asked again.
    expect(r.okHash).toBe("sha256:2");
    expect(after.okCards()).toEqual([]);
    // The records keep it on (it runs again once a build can run it).
    const kept = new RegistryCore({ catalog: catalogPointDecl, store });
    kept.putAll(tree(false, "sha256:3"));
    expect(["running", "waiting"]).toContain(kept.get("clover/forwarder")!.state);
    expect(kept.get("clover/forwarder")!.enabled).toBe(true);
  });

  // Every plugin this build parks, from its own manifest in the repository, as an upgrade from a build that ran it.
  const PLUGINS = join(import.meta.dir, "..", "..", "..", "..", "..", "plugins", "clover", "plugins");
  const PARKED = [
    "companion-ios", "companion-web", "forwarder", "provider-gcp", "provider-hetzner", "push", "relay-cloudflare", "trigger-webhook",
  ];
  const real = (folder: string): Manifest => {
    const r = parseJsonc(readFileSync(join(PLUGINS, folder, "clover.json"), "utf8"));
    if (!r.ok) throw new Error(`${folder}: ${r.error.message}`);
    return r.value as Manifest;
  };
  const unmarked = (m: Manifest): Manifest => {
    const { availability: _a, ...rest } = m as Manifest & { availability?: unknown };
    return rest as Manifest;
  };
  const points = (m: Manifest) => Object.keys((m as { contributes?: Record<string, unknown> }).contributes ?? {});

  for (const folder of PARKED) {
    test(`${folder}, from its own manifest: marked, it's listed off, contributes nothing, holds no capability; its switch and OK kept, no card`, () => {
      const id = `clover/${folder}`;
      const marked = real(folder);
      expect((marked as { availability?: { status?: string } }).availability?.status).toBe("not-yet");
      const store = memoryRegistryStore();
      const put = (reg: RegistryCore, m: Manifest, hash: string) =>
        reg.putAll([{ id: "clover", manifest: clover, treeHash: hash, approved: true, source: "bundled" }, { id, manifest: m, treeHash: hash, approved: true, source: "bundled" }]);
      const before = new RegistryCore({ catalog: catalogPointDecl, store });
      put(before, unmarked(marked), "sha256:1");
      expect(["running", "waiting"]).toContain(before.get(id)!.state);
      expect(grantsInForce(before.get(id))).toEqual((marked as { capabilities?: string[] }).capabilities ?? []);
      const after = new RegistryCore({ catalog: catalogPointDecl, store });
      put(after, marked, "sha256:2");
      const r = after.get(id)!;
      expect([r.state, r.reason, r.enabled, r.okHash]).toEqual(["off", NOT_AVAILABLE_YET, true, "sha256:2"]);
      expect(grantsInForce(r)).toEqual([]);
      for (const point of points(marked)) expect([point, after.entries(point).filter((e) => e.pluginId === id)]).toEqual([point, []]);
      expect(after.okCards()).toEqual([]);
      // A build that runs it again finds it on.
      const again = new RegistryCore({ catalog: catalogPointDecl, store });
      put(again, unmarked(marked), "sha256:3");
      expect(["running", "waiting"]).toContain(again.get(id)!.state);
    });
  }

  test("the browser view marked: its panel is out of the `panel` spot", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    const put = (m: Manifest, hash: string) =>
      reg.putAll([{ id: "clover", manifest: clover, treeHash: hash, approved: true, source: "bundled" }, { id: "clover/browser-view", manifest: m, treeHash: hash, approved: true, source: "bundled" }]);
    put(unmarked(real("browser-view")), "sha256:1");
    expect(reg.entries("ui").filter((e) => e.pluginId === "clover/browser-view").map((e) => [e.key, (e.value as { spot?: string }).spot])).toEqual([["browser", "panel"]]);
    // (The shipped manifest carries no mark now that the browser is composed; a mark on it still parks the panel.)
    put({ ...real("browser-view"), availability: { status: "not-yet", reason: "no-browser-composed" } } as unknown as Manifest, "sha256:2");
    expect(reg.entries("ui").filter((e) => e.pluginId === "clover/browser-view")).toEqual([]);
  });

  test("a cloud provider marked: its saved settings and keys are kept as they are, and reach nothing", async () => {
    const id = "clover/provider-gcp";
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    const put = (m: Manifest, hash: string) =>
      reg.putAll([{ id: "clover", manifest: clover, treeHash: hash, approved: true, source: "bundled" }, { id, manifest: m, treeHash: hash, approved: true, source: "bundled" }]);
    put(unmarked(real("provider-gcp")), "sha256:1");
    const secrets = new MemorySecretStore();
    const settings = new PluginSettings({ registry: reg, backend: memoryPluginSettings(), secrets });
    settings.set(id, "project", "my-clover-123456");
    // A dummy, self-set (never a real key).
    await secrets.set({ owner: { kind: "plugin", pluginId: id }, name: "gcp-oauth" }, "dummy-token");
    put(real("provider-gcp"), "sha256:2");
    expect(reg.get(id)!.reason).toBe(NOT_AVAILABLE_YET);
    expect(settings.get(id, "project")).toBe("my-clover-123456");
    expect((await secrets.list({ kind: "plugin", pluginId: id })).map((m) => m.ref.name)).toEqual(["gcp-oauth"]);
    // Nothing it holds is in force: the keyed fetch and the plugin API need a running plugin with its capability.
    expect(grantsInForce(reg.get(id))).toEqual([]);
    expect(reg.entries("computerProviders")).toEqual([]);
    // Unmarked again, it has them back.
    put(unmarked(real("provider-gcp")), "sha256:3");
    expect(settings.get(id, "project")).toBe("my-clover-123456");
  });

  test("a marked parent: off with the reason; its children unmarked are off with it, none holding a capability", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    const parent = { ...clover, availability: { status: "not-yet", reason: "whole-tree" } } as unknown as Manifest;
    reg.putAll([
      { id: "clover", manifest: parent, treeHash: "sha256:1", approved: true, source: "bundled" },
      { id: "clover/browser", manifest: browser(false), treeHash: "sha256:1", approved: true, source: "bundled" },
    ]);
    expect([reg.get("clover")!.state, reg.get("clover")!.reason]).toEqual(["off", NOT_AVAILABLE_YET]);
    expect([reg.get("clover/browser")!.state, reg.get("clover/browser")!.reason]).toEqual(["off", "its parent is off"]);
    expect([grantsInForce(reg.get("clover")), grantsInForce(reg.get("clover/browser"))]).toEqual([[], []]);
    expect(reg.entries("mcpServers")).toEqual([]);
  });

  test("an invalid marked plugin reads invalid; fixed, it reads not available", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([...tree(true, "sha256:1").slice(0, 1), { ...tree(true, "sha256:1")[1]!, invalid: "a broken field" }]);
    expect([reg.get("clover/forwarder")!.state, reg.get("clover/forwarder")!.reason]).toEqual(["invalid", "a broken field"]);
    reg.putAll(tree(true, "sha256:2"));
    expect([reg.get("clover/forwarder")!.state, reg.get("clover/forwarder")!.reason]).toEqual(["off", NOT_AVAILABLE_YET]);
    expect(grantsInForce(reg.get("clover/forwarder"))).toEqual([]);
  });

  test("the mark counts only in a tree installed as Clover's own: a development folder's or an update's is no mark", () => {
    // Put straight in (the validator refuses the mark outside the bundled tree; these skip it): the rules ignore it.
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    const luna = { manifest: 1, id: "luna", name: "Luna", availability: { status: "not-yet", reason: "later" } } as unknown as Manifest;
    reg.putAll([
      { id: "clover", manifest: clover, treeHash: "sha256:1", approved: true, source: "local", dev: true },
      { id: "clover/forwarder", manifest: forwarder(true), treeHash: "sha256:1", approved: true, source: "local", dev: true },
      { id: "luna", manifest: luna, treeHash: "sha256:l", approved: true, source: "index" },
    ]);
    for (const id of ["clover/forwarder", "luna"]) expect(reg.get(id)!.reason).not.toBe(NOT_AVAILABLE_YET);
    expect(reg.get("luna")!.state).toBe("running");
  });

  test("a plugins.watch consumer sees it go off, its switch on (ids and states only)", () => {
    const store = memoryRegistryStore();
    const reg = new RegistryCore({ catalog: catalogPointDecl, store });
    reg.putAll(tree(false, "sha256:1"));
    const events: unknown[] = [];
    const stop = registryEvents({ registry: reg, emit: (e) => events.push(e) });
    reg.putAll(tree(true, "sha256:2"));
    stop();
    expect(events).toContainEqual({ type: "plugin_changed", id: "clover/forwarder", state: "off", enabled: true });
  });
});

describe("a capability only Clover's own plugins may hold", () => {
  // `terminal` is bundled-only (the SDK's catalog). The rules drop it from `granted` for any plugin not in Clover's own
  // tree by its install source, whatever its manifest or record says, even put straight in, past the validator.
  const holds = (id: string, source: RegistryInput["source"], caps: string[]): RegistryInput =>
    ({ id, manifest: { manifest: 1, name: id, capabilities: caps } as unknown as Manifest, treeHash: `sha256:${id}`, approved: true, source });

  test("a stale record: a plugin from an index, OK'd when its manifest held it, gets only the rest", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([
      { id: "clover", manifest: clover, treeHash: "sha256:c", approved: true, source: "bundled" },
      { ...holds("clover/panel-terminal", "bundled", ["terminal"]), treeHash: "sha256:c" },
      holds("luna", "index", ["terminal", "notify"]),
    ]);
    expect(grantsInForce(reg.get("luna"))).toEqual(["notify"]);
    expect(grantsInForce(reg.get("clover/panel-terminal"))).toEqual(["terminal"]);
  });

  test("a spoofed id: a tree whose top id is `clover` but isn't installed as Clover's own holds none", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([
      { id: "clover", manifest: clover, treeHash: "sha256:s", approved: true, source: "local" },
      { ...holds("clover/x", "local", ["terminal", "notify"]), treeHash: "sha256:s" },
    ]);
    expect(grantsInForce(reg.get("clover/x"))).toEqual(["notify"]);
  });

  test("a spoofed id through the plugins folder: a tree that says it is `clover` is invalid, granted nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-notyet-spoof-"));
    temps.push(home);
    const pluginsDir = join(home, "plugins");
    const store = fileRegistryStore(join(home, "plugins-state"));
    const core = new RegistryCore({ catalog: catalogPointDecl, store });
    const folders = new PluginFolders({ core, store, pluginsDir, bundledDirs: [], settleMs: 50 });
    const engines = { clover: `^${PLUGIN_API_VERSION}` };
    mkdirSync(join(pluginsDir, "clover", "plugins", "x"), { recursive: true });
    writeFileSync(join(pluginsDir, "clover", "clover.json"), JSON.stringify({ manifest: 1, id: "clover", name: "Clover", version: "1.0.0", engines }));
    writeFileSync(join(pluginsDir, "clover", "plugins", "x", "clover.json"), JSON.stringify({ manifest: 1, name: "X", engines, capabilities: ["terminal"], availability: { status: "not-yet", reason: "x" } }));
    await folders.scan();
    for (const id of ["clover", "clover/x"]) {
      const r = core.get(id);
      if (r === undefined) continue;
      expect([id, r.state, grantsInForce(r)]).toEqual([id, "invalid", []]);
    }
    expect(core.get("clover")?.issues?.map((i) => i.code)).toContain("id_reserved");
  });
});
