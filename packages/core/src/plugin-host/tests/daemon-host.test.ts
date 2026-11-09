// The daemon's one plugin host (`startPluginHost`) over a real plugin registry and a real plugin-host process: a
// plugin's handler runs in its worker, its API calls reach the router, its console reaches its log, and switching it off
// drops it. Temp homes, the fake approval broker and an in-memory secret store; nothing opens a window.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { hostedRecordOf, pluginLogWriter, startPluginHost } from "../daemon-host";

const USER: Caller = { kind: "user", client: "app" };

describe("startPluginHost", () => {
  test("a plugin's handler runs in the host process, its API calls are served, its console is its log, and switching it off drops it", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-daemon-host-"));
    const folder = join(home, "plugins", "tarot");
    mkdirSync(join(folder, "host"), { recursive: true });
    writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" } }));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(folder, "host", "index.js"), [
      "export const remember = async (args, ctx) => {",
      "  console.log(\"remembering \" + args.card);",
      "  await ctx.api.storage.synced.set(\"last\", args.card);",
      "  return { last: await ctx.api.storage.synced.get(\"last\"), computer: ctx.computer };",
      "};",
      "export const forbidden = async (args, ctx) => ctx.api.secrets.get(\"key\");",
      "",
    ].join("\n"));
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
    try {
      // Before its OK the plugin isn't startable: no record, so no process starts for it.
      expect(hostedRecordOf(opened.registry, home, "tarot")).toBeUndefined();
      const { card } = await opened.registry.installed("tarot", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await Bun.sleep(5);
      expect(opened.registry.get("tarot")?.state).toBe("running");
      expect(hostedRecordOf(opened.registry, home, "tarot")).toMatchObject({ id: "tarot", folder, root: folder, entry: "host/index.js" });

      expect(await ph.host.invoke({ pluginId: "tarot", handler: "remember", args: { card: "The Fool" }, caller: USER })).toEqual({ last: "The Fool", computer: "Studio" });
      expect(JSON.parse(readFileSync(join(home, "settings", "plugin-stores", "tarot.json"), "utf8"))).toEqual({ last: "The Fool" });
      // A call the plugin may not make here (`secrets.get` outside a process of its own) is refused by the router.
      const refused = (await ph.host.invoke({ pluginId: "tarot", handler: "forbidden", args: null, caller: USER }).catch((x: unknown) => x)) as ContractError;
      expect(refused).toBeInstanceOf(ContractError);
      expect(refused.message).toContain("secrets.get");
      // The worker's console, in the plugin's own log.
      const logFile = join(home, "logs", "plugins", "tarot.log");
      for (let i = 0; i < 50 && !(existsSync(logFile) && readFileSync(logFile, "utf8").includes("remembering")); i++) await Bun.sleep(20);
      expect(readFileSync(logFile, "utf8")).toContain("remembering The Fool");

      // A plugin's own secret, read through `pluginSecrets` by its plugin and name; nothing else passes (S3).
      const ref = { owner: { kind: "plugin" as const, pluginId: "tarot" }, name: "key" };
      await secrets.set(ref, { value: "sk-test" } as never);
      await secrets.set({ owner: { kind: "core" }, name: "key" } as never, { value: "core's" } as never);
      expect(await ph.pluginSecrets.forPlugin("tarot").get("key")).not.toBeNull();
      expect(await ph.pluginSecrets.forPlugin("other").get("key")).toBeNull();
      expect("get" in ph.pluginSecrets).toBe(false);
      // A reference passed as the name is a name: it never reaches another owner's item.
      expect(await ph.pluginSecrets.forPlugin("tarot").get(ref as never).catch((x: unknown) => x)).toBeInstanceOf(ContractError);

      // Switched off: dropped, and a call finds nothing to start.
      await opened.registry.setEnabled("tarot", false);
      await Bun.sleep(5);
      expect(hostedRecordOf(opened.registry, home, "tarot")).toBeUndefined();
      const off = (await ph.host.invoke({ pluginId: "tarot", handler: "remember", args: { card: "x" }, caller: USER }).catch((x: unknown) => x)) as ContractError;
      expect(off.code).toBe("not_installed");
    } finally {
      await ph.close();
      opened.close();
    }
  }, 60_000);

  test("a launch that can't be made fails each plugin's start with why, and the host still answers", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-daemon-host-nolaunch-"));
    const folder = join(home, "plugins", "tarot");
    mkdirSync(join(folder, "host"), { recursive: true });
    writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" } }));
    writeFileSync(join(folder, "host", "index.js"), "export const hi = () => \"hi\";\n");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets, settleMs: 50 });
    const lines: string[] = [];
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, log: (l) => lines.push(l), launch: async () => { throw new Error("no host bundles in this build"); } });
    try {
      const { card } = await opened.registry.installed("tarot", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await Bun.sleep(5);
      const err = (await ph.host.invoke({ pluginId: "tarot", handler: "hi", args: null, caller: USER }).catch((x: unknown) => x)) as ContractError;
      expect(err).toBeInstanceOf(ContractError);
      expect(err.message).toContain("no host bundles in this build");
      expect(lines.join("\n")).toContain("plugin processes can't start: no host bundles in this build");
    } finally {
      await ph.close();
      opened.close();
    }
  }, 30_000);
});

describe("a plugin's log file", () => {
  test("is rate-limited per plugin (the rest counted, then noted once) and rotated at its cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-b2-logs-"));
    let now = 1_000_000;
    const write = pluginLogWriter({ dir, log: () => {}, now: () => now, maxBytes: 2_000, perWindow: 5, windowMs: 1_000 });
    write("noisy", Array.from({ length: 12 }, (_, i) => `line ${i}`));
    write("quiet", ["hello"]);
    const noisy = () => readFileSync(join(dir, "noisy.log"), "utf8").trim().split("\n");
    expect(noisy().map((l) => l.split(" ").slice(1).join(" "))).toEqual(["line 0", "line 1", "line 2", "line 3", "line 4"]);
    expect(readFileSync(join(dir, "quiet.log"), "utf8")).toContain("hello");
    now += 1_000;
    write("noisy", ["next window"]);
    expect(noisy().slice(-2).map((l) => l.split(" ").slice(1).join(" "))).toEqual(["[clover] 7 more lines dropped (over 5 in 1 s)", "next window"]);
    // Past the cap the file moves aside (one generation kept) and a new one starts.
    for (let i = 0; i < 40; i++) {
      now += 1_000;
      write("noisy", ["x".repeat(200)]);
    }
    expect(existsSync(join(dir, "noisy.log.1"))).toBe(true);
    expect(statSync(join(dir, "noisy.log")).size).toBeLessThan(2_000 + 300);
    expect(statSync(join(dir, "noisy.log.1")).size).toBeLessThan(2_000 + 300);
  });
});
