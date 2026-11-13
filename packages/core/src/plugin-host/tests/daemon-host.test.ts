// The daemon's one plugin host (`startPluginHost`) over a real plugin registry and a real plugin-host process: a
// plugin's handler runs in its worker, its API calls reach the router (and handlers added after start, behind its gate),
// its console reaches its log, and switching it off drops it. Temp homes, the fake approval broker and an in-memory
// secret store; nothing opens a window.
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

/** Waits until the registry has applied the OK card's answer (the plugin leaves "found"), on the registry's own change
 *  signal rather than a clock: a loaded runner once took longer than the 5 s a polling loop allowed, and the test then
 *  called a plugin the host couldn't start yet ("isn't installed"). The test's own timeout bounds the wait. */
function approved(registry: { get(id: string): { state: string } | undefined; watch(fn: () => void): () => void }, id: string): Promise<void> {
  return new Promise((resolve) => {
    const off = registry.watch(() => {
      if (registry.get(id)?.state !== "found") {
        off();
        resolve();
      }
    });
    // Checked after subscribing, so a change between the two isn't missed.
    if (registry.get(id)?.state !== "found") {
      off();
      resolve();
    }
  });
}

const USER: Caller = { kind: "user", client: "app" };

describe("startPluginHost", () => {
  test("a plugin's handler runs in the host process, its API calls are served, its console is its log, and switching it off drops it", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-daemon-host-"));
    const folder = join(home, "plugins", "tarot");
    mkdirSync(join(folder, "host"), { recursive: true });
    writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" }, capabilities: ["notify"] }));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(folder, "host", "index.js"), [
      "export const remember = async (args, ctx) => {",
      "  console.log(\"remembering \" + args.card);",
      "  await ctx.api.storage.synced.set(\"last\", args.card);",
      "  return { last: await ctx.api.storage.synced.get(\"last\"), computer: ctx.computer };",
      "};",
      "export const forbidden = async (args, ctx) => ctx.api.secrets.get(\"key\");",
      "export const say = async (args, ctx) => ctx.api.notify.send({ title: args.key });",
      // A member outside the catalog fails at access, by name (never a callable stand-in for a value); inspection and
      // promise keys stay harmless, and a call's own `bind` works.
      // What test frameworks and bundlers read on an object holding `api` (jest's equals, isMockFunction and spyOn, its
      // Immutable checks, pretty-format; esbuild's __toESM for `import * as ns`; interopRequireDefault): no throw.
      "const JEST_KEYS = [\"asymmetricMatch\", \"toAsymmetricMatcher\", \"_isMockFunction\", \"getMockName\", \"mock\", \"mockImplementation\", \"calls\", \"$$typeof\", \"nodeType\", \"nodeName\", \"tagName\", \"constructor\", \"toJSON\", \"displayName\", \"caller\", \"arguments\", \"@@__IMMUTABLE_ITERABLE__@@\", \"@@__IMMUTABLE_KEYED__@@\", \"@@__IMMUTABLE_ORDERED__@@\", \"@@__IMMUTABLE_RECORD__@@\", \"@@__IMMUTABLE_SET__@@\", \"__esModule\", \"default\"];",
      "const toESM = (mod) => {",
      "  const t = mod.__esModule ? Object.create(Object.getPrototypeOf(mod)) : Object.defineProperty(Object.create(Object.getPrototypeOf(mod)), \"default\", { value: mod, enumerable: true });",
      "  for (const key of Object.getOwnPropertyNames(mod)) if (!Object.prototype.hasOwnProperty.call(t, key)) Object.defineProperty(t, key, { get: () => mod[key], enumerable: true });",
      "  return t;",
      "};",
      "export const interop = async (args, ctx) => {",
      "  const api = ctx.api;",
      "  const tried = (f) => { try { return f(); } catch (e) { return e.message; } };",
      "  const read = (o) => JEST_KEYS.map((k) => tried(() => (o[k] === undefined ? \"u\" : typeof o[k]))).join(\"\");",
      "  const ns = toESM(api);",
      "  return {",
      "    top: read(api), area: read(api.settings), call: read(api.settings.get),",
      // Bun's deep equality is what bun:test's toEqual and toStrictEqual run.
      "    equal: tried(() => Bun.deepEquals({ api }, { api }) && Bun.deepEquals({ api }, { api }, true)),",
      "    esm: [ns.default === api, Object.keys(ns).sort().join(\"|\"), tried(() => Object.keys(ns).map((k) => typeof ns[k]).join(\"|\"))],",
      "    interopDefault: (api && api.__esModule ? api : { default: api }).default === api,",
      "    spy: tried(() => { const original = api.settings.get; return original._isMockFunction === true ? \"mock\" : \"original\"; }),",
      "  };",
      "};",
      "export const probe = async (args, ctx) => {",
      "  const tried = (f) => { try { return String(f()); } catch (e) { return e.message; } };",
      "  return {",
      "    env: tried(() => ctx.api.env?.CLOVER_HOOKS_ORIGIN),",
      "    log: tried(() => ctx.api.log.warn),",
      "    method: tried(() => ctx.api.settings.nope),",
      "    then: String(ctx.api.then), sym: String(ctx.api[Symbol.toStringTag]), json: String(ctx.api.toJSON),",
      "    awaited: (await Promise.resolve(ctx.api.storage)) === ctx.api.storage ? \"same\" : \"other\",",
      "    bound: await ctx.api.storage.synced.get.bind(ctx.api.storage.synced)(\"last\"),",
      "    has: [\"settings\" in ctx.api, \"plugin\" in ctx.api, \"env\" in ctx.api, \"get\" in ctx.api.settings, \"nope\" in ctx.api.settings, \"memory\" in ctx.api, \"run\" in ctx.api.commands].join(),",
      "    stringified: String(JSON.stringify(ctx.api)), inspected: tried(() => typeof Bun.inspect(ctx.api)), keys: Object.keys(ctx.api).length,",
      "    cloned: tried(() => structuredClone(ctx.api)),",
      "  };",
      "};",
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
      await approved(opened.registry, "tarot");
      expect(opened.registry.get("tarot")?.state).toBe("running");
      expect(hostedRecordOf(opened.registry, home, "tarot")).toMatchObject({ id: "tarot", folder, root: folder, entry: "host/index.js" });

      expect(await ph.host.invoke({ pluginId: "tarot", handler: "remember", args: { card: "The Fool" }, caller: USER })).toEqual({ last: "The Fool", computer: "Studio" });
      expect(await ph.host.invoke({ pluginId: "tarot", handler: "probe", args: null, caller: USER })).toEqual({
        env: "api.env doesn't exist in the plugin API (see API_CALLS in @waifucave/clover-plugin-sdk)",
        log: "api.log doesn't exist in the plugin API (see API_CALLS in @waifucave/clover-plugin-sdk)",
        method: "api.settings.nope doesn't exist in the plugin API (see API_CALLS in @waifucave/clover-plugin-sdk)",
        then: "undefined", sym: "undefined", json: "undefined", awaited: "other", bound: "The Fool",
        // Feature-tests answer without throwing; serialising the API gives nothing and inspecting it doesn't throw.
        has: "true,true,false,true,false,true,true", stringified: "undefined", inspected: "string", keys: 0,
        // The API is calls, not data: cloning it fails as cloning any function does (as it always has).
        cloned: "The object can not be cloned.",
      });
      const u = "u".repeat(23);
      expect(await ph.host.invoke({ pluginId: "tarot", handler: "interop", args: null, caller: USER })).toEqual({
        top: u, area: u, call: u, equal: true, esm: [true, "default|length|name", "function|undefined|undefined"], interopDefault: true, spy: "original",
      });
      expect(JSON.parse(readFileSync(join(home, "settings", "plugin-stores", "tarot.json"), "utf8"))).toEqual({ last: "The Fool" });
      // A handler added after start serves at once, behind the same gate; a path a core area already serves is refused,
      // and taking it away leaves the call unserved again.
      const notServed = (await ph.host.invoke({ pluginId: "tarot", handler: "say", args: { key: "hello" }, caller: USER }).catch((x: unknown) => x)) as ContractError;
      // (`notify.send`: the daemon serves it through the notify service's handlers, which this host was started without.)
      expect(notServed.message).toContain("notify.send is not served on this computer");
      const seen: unknown[] = [];
      const offT = ph.addApiHandlers({ "notify.send": (ctx, args) => { seen.push([ctx.pluginId, ctx.process, args[0]]); return "Hello"; } });
      expect(await ph.host.invoke({ pluginId: "tarot", handler: "say", args: { key: "hello" }, caller: USER })).toBe("Hello");
      expect(seen).toEqual([["tarot", "shared", { title: "hello" }]]);
      expect(() => ph.addApiHandlers({ "notify.send": () => "other" })).toThrow("already served");
      expect(() => ph.addApiHandlers({ "storage.synced.set": () => "other" })).toThrow("already served");
      expect(() => ph.addApiHandlers({ "nope.call": () => 1 } as never)).toThrow("isn't a call of the plugin API");
      expect(() => ph.addApiHandlers({ "net.fetch": "no" } as never)).toThrow("isn't a function");
      const offSecrets = ph.addApiHandlers({ "secrets.get": () => "leaked" });
      offT();
      offT();
      const again = (await ph.host.invoke({ pluginId: "tarot", handler: "say", args: { key: "hello" }, caller: USER }).catch((x: unknown) => x)) as ContractError;
      expect(again.message).toContain("notify.send is not served on this computer");
      // A call the plugin may not make here (`secrets.get` outside a process of its own) is refused by the router.
      const refused = (await ph.host.invoke({ pluginId: "tarot", handler: "forbidden", args: null, caller: USER }).catch((x: unknown) => x)) as ContractError;
      expect(refused).toBeInstanceOf(ContractError);
      expect(refused.message).toContain("secrets.get");
      offSecrets();
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
      await approved(opened.registry, "tarot");
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
