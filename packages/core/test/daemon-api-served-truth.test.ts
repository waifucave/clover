// Every plugin API member the SDK's catalog lists (`API_CALLS`) is served where the catalog says, on a REAL daemon: the
// plugin host started by the daemon's own composition (`startDaemon`, its `startPluginHost` call and daemon-parts
// wiring, no test-built router or caller), a temp home and a throwaway secret store. Four times the daemon's real
// composition missed a handler its unit tests had (each built its own router or caller); this walks the catalog instead.
//
// Two fixtures, each walked on both sides:
// - a third party holding every capability a third party may hold, its host half in a process of its own;
// - a child of the bundled `clover` tree (`clover/truth`, staged as the dev stage `<home>/run/dev-bundled/` a daemon
//   with its own store reads), holding every capability, its host half in the `clover` process: the bundled-only
//   capabilities and the `clover`-process members (`keys.*`, `desktop.*`) are called for real.
// On each side:
// - host members (`host`, `own`, `clover`, `both`) are called by its host half, as the app's page would reach it
//   (`host.call` through `plugin.layer.api`);
// - component members (`ui`, `both`) are called through the SDK's own component API (`usePluginApi`, the code a plugin's
//   page runs), its bridge routed as the app's main process routes it: the pickers to main's dialog, every other call
//   on the plugin's own layer connection to the core (role `layer`, `layer.token` as the app gets it), whose
//   notifications reach the page as the app relays them (`api-event`), so a watch (`plugin.layer.watch`) is opened and
//   heard for real.
//
// A member not marked `notYet` must not answer "not served", "isn't available", "no handler", a missing method, or be
// absent; a refusal for a real reason (a bad argument, a fence, a capability) counts as served. A member marked
// `notYet` must say it isn't available, or be absent from the API. The test fails naming each member, where, and what
// it answered.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedMethods, CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/clover-protocol";
import { API_CALLS, CAPABILITIES, PLUGIN_API_VERSION, type ApiCallInfo } from "@waifucave/clover-plugin-sdk";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { configureLayer, usePluginApi } from "../../plugin-sdk/src/ui/index";
// @ts-expect-error: the SDK's own React (the instance its hooks dispatch through), which this package doesn't type
import * as React from "../../plugin-sdk/node_modules/react/index.js";
import { FileSecretStore } from "../src/auth/secret-store";
import { BUNDLED_MANIFEST_FILE, formatBundledManifest, measureBundledTree } from "../src/bundled-plugins-dir";
import { Drivers } from "../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { MemoryNetwork } from "../src/links/memory-wire";
import { validatePluginFolder } from "../src/registry/validate";
import { darwinTest } from "./helpers/darwin-only";

setDefaultTimeout(240_000);

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

/** A raw Clover connection: requests by id, and every notification the daemon sends. */
async function rpc(path: string) {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const notes: ((method: string, params: unknown) => void)[] = [];
  let next = 1;
  const socket = await Bun.connect({ unix: path, socket: {
    data(_s, chunk) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l) as Record<string, unknown>;
        // The daemon's own requests (`app.ping`, which an app that doesn't answer is restarted for): answered at once.
        if (typeof m["method"] === "string" && m["id"] !== undefined) writer.enqueue(encodeLine({ jsonrpc: "2.0", id: m["id"], result: {} }));
        else if (typeof m["id"] === "number") { pending.get(m["id"])?.(m); pending.delete(m["id"]); } else if (typeof m["method"] === "string") for (const n of notes) n(m["method"], m["params"]);
      }
    },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket as unknown as WritableSocket);
  return {
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = next++;
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return new Promise((r) => pending.set(id, r));
    },
    onNotification(fn: (method: string, params: unknown) => void) { notes.push(fn); },
    close() { socket.end(); },
  };
}

const PLUGIN = "truth";
const GRANT = "grant:5f0c2a8e-1b3d-4c6e-9f7a-2d4b6c8e0a1f";
/** Marks a listener argument: the side that calls makes it a function there. */
const FN = "$fn";

/** Minimal arguments per member; a member not here is called with none. Real-reason refusals count as served. */
const ARGS: Record<string, unknown[]> = {
  confirm: ["truth: a card the test denies"], confirmCard: ["truth: a card the test denies"], t: ["truth.hello"],
  "points.entries": ["truth.nothing"], "points.watch": ["truth.nothing", FN], "points.call": ["truth.nothing", { pluginId: PLUGIN, entryId: "x" }, "handler"],
  "commands.run": ["truth.none"], "host.call": ["noop"], "host.on": ["evt", FN], "ui.send": ["evt", {}],
  "storage.synced.get": ["k"], "storage.synced.set": ["k", "v"], "storage.synced.delete": ["k"], "storage.synced.watch": [FN],
  "net.fetch": ["https://truth.invalid/"], "secrets.get": ["api-key"],
  "keys.publicKey": ["k"], "keys.open": ["k", { enc: [], ciphertext: [] }], "keys.delete": ["k"],
  "settings.get": ["x"], "settings.watch": [null, FN], "settings.set": ["x", 1],
  "conversation.get": ["s_none"], "conversation.history": ["s_none", { limit: 1 }], "conversation.follow": ["s_none", FN],
  "conversation.note": ["s_none", { text: "truth" }], "conversation.send": ["s_none", "truth"], "conversation.answer": ["s_none", "c_none", {}],
  "memory.list": ["alpha"], "memory.read": ["alpha", "MEMORY.md"],
  "bots.get": ["alpha"], "bots.watch": [FN], "routines.runs": ["r_none"], "routines.fire": ["r_none", "schedule"],
  "computers.get": ["Studio"], "computers.watch": [FN], "computers.holds": ["Studio"], "computers.takeHold": ["Studio", { kind: "app", app: "com.example.none" }],
  "computers.releaseHold": ["h_none"], "computers.setUserWorking": ["Studio", false], "computers.setActionRunning": ["Studio", false], "computers.cloverWindows": ["Studio"],
  "devices.watch": [FN], "approvals.watch": [FN],
  "files.stat": ["home/Studio/truth.txt"], "files.readText": ["home/Studio/truth.txt"], "files.readBytes": ["home/Studio/truth.txt"],
  "files.write": ["home/Studio/truth.txt", "truth"], "files.list": ["home/Studio"], "files.remove": ["home/Studio/truth-none.txt"],
  "files.move": ["home/Studio/truth-none.txt", "home/Studio/truth-none2.txt"], "files.glob": ["*.txt", { cwd: "home/Studio" }],
  "files.grep": ["truth", { cwd: "home/Studio" }], "files.watch": ["home/Studio/watched", FN], "files.path": [GRANT],
  "files.pickOpen": [{}], "files.pickFolder": [{}], "files.pickSave": [{}], "files.url": [GRANT], "files.onDrop": [FN],
  "browser.open": [{ owner: { kind: "plugin", plugin: PLUGIN } }], "browser.close": ["tab_none"], "browser.navigate": ["tab_none", "about:blank"],
  "browser.show": ["tab_none"], "browser.hide": ["tab_none"], "browser.screenshot": ["tab_none"], "browser.cdp": ["tab_none", "Page.reload", {}],
  "browser.onCdpEvent": ["tab_none", FN], "browser.watch": [FN],
  "terminal.open": [{ computer: "Studio", cols: 80, rows: 24 }], "terminal.input": ["term_none", { type: "key", key: "a", isTrusted: false }],
  "terminal.onData": ["term_none", FN], "terminal.resize": ["term_none", 80, 24], "terminal.close": ["term_none"],
  "shell.watch": [FN], "plugins.install": [{ from: "folder", path: "/nonexistent/truth" }],
  "usage.rows": [{ since: 0 }], "usage.summary": [{ from: 0, to: Date.now(), groupBy: "source" }], "usage.watch": [FN],
  "logs.read": ["core", { lines: 1 }], "logs.follow": [{ plugin: PLUGIN }, FN],
  "notify.send": [{ title: "truth" }], "desktop.show": [{ title: "truth" }], "desktop.close": ["n_none"],
  "avatar.cue": [{ kind: "expression", name: "none" }], "avatar.watch": [FN], "avatar.report": ["truth", undefined],
  "audio.play": [{ format: "mp3", data: [] }], "audio.onRecording": [FN],
};

/** The host half: `ui.api` calls `ctx.api.<path>` with the arguments (`$fn` a listener), and says what came back. */
const HOST_JS = `
const at = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const plain = (v, d = 0) => v === undefined ? "undefined" : typeof v === "function" ? "fn" : v instanceof Uint8Array ? "bytes:" + v.length
  : d > 2 ? "..." : Array.isArray(v) ? v.slice(0, 3).map((x) => plain(x, d + 1)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).slice(0, 6).map(([k, x]) => [k, plain(x, d + 1)])) : v;
const argsOf = (path, args) => args.map((a) => a === "$fn" ? () => {} : (path === "keys.open" && a && a.enc) ? { enc: new Uint8Array(0), ciphertext: new Uint8Array(0) } : (path === "audio.play" && a && a.data) ? { ...a, data: new Uint8Array(0) } : a);
export const ui = {
  noop: async () => "noop",
  api: async ({ path, args }, ctx) => {
    const fn = at(ctx.api, path);
    if (typeof fn !== "function") return { absent: typeof fn };
    const self = path.includes(".") ? at(ctx.api, path.slice(0, path.lastIndexOf("."))) : ctx.api;
    try {
      const out = await Promise.race([Promise.resolve().then(() => fn.apply(self, argsOf(path, args))), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("no answer in 6 s"), { code: "hung" })), 6000))]);
      if (typeof out === "function") { try { out(); } catch {} }
      else if (out && typeof out.stop === "function") { try { out.stop(); } catch {} }
      return { value: plain(out) };
    } catch (e) {
      return { error: (e && e.code ? e.code + ": " : "") + (e && e.message ? e.message : String(e)) };
    }
  },
};
`;

type Answer = { value?: unknown; error?: string; absent?: string; app?: string };

/** Words that mean nothing serves the call (as opposed to a refusal for a reason). */
const NOT_SERVED = /not served|isn't available|is not available|not available in layers|no handler|method not found|unknown method|-32601|doesn't call|isn't a method|no such method/i;
/** A wiring error: the core reached for something it wasn't given. */
const WIRING = /cannot read propert|undefined is not an object|null is not an object|is not a function|is not a constructor/i;
/** The words a `notYet` member answers with (`ApiCallInfo.notYet`: the core refuses it "isn't available yet"). */
const SAYS_NOT_YET = /isn't available|not available|not served/i;

function verdict(path: string, info: ApiCallInfo, a: Answer): string | undefined {
  const said = a.absent !== undefined ? `absent (${a.absent})` : a.error !== undefined ? `error: ${a.error}` : a.app !== undefined ? `app: ${a.app}` : `value: ${JSON.stringify(a.value)?.slice(0, 120)}`;
  if (info.notYet !== undefined) return (a.error !== undefined && SAYS_NOT_YET.test(a.error)) || a.absent !== undefined ? undefined : `marked notYet, but answered ${said}`;
  if (a.absent !== undefined) return `absent from the API (${a.absent})`;
  if (a.error !== undefined && NOT_SERVED.test(a.error)) return `not served: ${a.error.slice(0, 300)}`;
  if (a.error !== undefined && WIRING.test(a.error)) return `wiring error: ${a.error.slice(0, 300)}`;
  if (a.error !== undefined && /^hung: /.test(a.error)) return `no answer in 6 s`;
  return undefined;
}

/** The SDK's component API for one part, outside React's renderer: `usePluginApi`'s own code, its hooks answered by a
 *  minimal dispatcher (the part's context, memo as a plain call). */
function componentApi(part: { mount: string; pluginId: string }): Record<string, unknown> {
  const internals = (React as unknown as Record<string, { H: unknown }>)["__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"]!;
  const partValue = { mount: part.mount, entry: { pluginId: part.pluginId, id: "status", spot: "status" }, tokens: {}, context: { os: "macos", material: "none", safeMode: false, window: { narrow: false } } };
  const before = internals.H;
  internals.H = {
    useContext: (c: { _currentValue: unknown }) => (c._currentValue === null ? partValue : c._currentValue),
    useMemo: (f: () => unknown) => f(), useCallback: (f: unknown) => f, useRef: (v: unknown) => ({ current: v }),
    useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => {}], useEffect: () => {}, useLayoutEffect: () => {},
  };
  try {
    return usePluginApi() as unknown as Record<string, unknown>;
  } finally {
    internals.H = before;
  }
}

const BUNDLED = "clover/truth";

darwinTest("every API member the catalog lists is served where it says, on the daemon's own composition", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-api-truth-")));
  const home = join(root, "clover-home");
  const userHome = join(root, "home");
  mkdirSync(userHome, { recursive: true });
  writeFileSync(join(userHome, "truth.txt"), "truth\n");
  mkdirSync(join(userHome, "watched"));
  // The third party: every capability a third party may hold (a capability the validator keeps from third parties is
  // left out; the bundled fixture calls its members), a host half in a process of its own. Its layer connection needs
  // no UI entry (`layer.token` is minted for any plugin).
  const folder = join(home, "plugins", PLUGIN);
  mkdirSync(join(folder, "host"), { recursive: true });
  const all = CAPABILITIES.map((c) => c.name).filter((n) => !n.includes("*"));
  const manifest = (caps: string[]) => ({
    manifest: 1, id: PLUGIN, name: "Truth", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js", process: "own" },
    capabilities: [...caps, "network:truth.invalid", `call:${PLUGIN}`],
  });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
  writeFileSync(join(folder, "clover.json"), JSON.stringify(manifest(all)));
  const checked = await validatePluginFolder(folder, { os: "macos" });
  const keptOut = all.filter((c) => checked.issues.some((i) => i.severity === "error" && i.message.includes(c)));
  if (keptOut.length > 0) writeFileSync(join(folder, "clover.json"), JSON.stringify(manifest(all.filter((c) => !keptOut.includes(c)))));
  const again = await validatePluginFolder(folder, { os: "macos" });
  expect(again.issues.filter((i) => i.severity === "error")).toEqual([]);
  // The bundled child: the dev stage a daemon with its own store reads (`devBundledSource`), the `clover` tree with one
  // child holding every capability, its host half in the `clover` process.
  const devRoot = join(home, "run", "dev-bundled", "plugins");
  mkdirSync(join(devRoot, "clover"), { recursive: true });
  writeFileSync(join(devRoot, "clover", "clover.json"), JSON.stringify({ manifest: 1, id: "clover", name: "Clover", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } }));
  const child = join(devRoot, "clover", "plugins", "truth");
  mkdirSync(join(child, "host"), { recursive: true });
  writeFileSync(join(child, "clover.json"), JSON.stringify({
    manifest: 1, name: "Truth (bundled)", engines: { clover: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js" }, capabilities: [...all.filter((c) => !c.includes("<")), "network:truth.invalid", "call:clover"],
  }));
  writeFileSync(join(child, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(child, "host", "index.js"), HOST_JS);
  writeFileSync(join(home, "run", "dev-bundled", BUNDLED_MANIFEST_FILE), formatBundledManifest(measureBundledTree(devRoot)));

  const net = new MemoryNetwork();
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
    links: {
      wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" },
    },
    parts: {
      userHome,
      node: { terminals: { launch: () => ({ cmd: ["/bin/cat"], env: {} }) } },
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: false,
    },
  });
  await daemon.cloverParts.ready;
  const app = await rpc(daemon.socketPath);
  expect((await app.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: ["app.quit"] }))["error"]).toBeUndefined();
  // A component's watch values go to its own layer connection alone: the app's connection, subscribed to every area,
  // never hears one.
  expect((await app.request("events.subscribe", { areas: ["plugins", "computers", "sessions"] }))["error"]).toBeUndefined();
  const appHeard: string[] = [];
  app.onNotification((_m, params) => { const t = (params as { type?: unknown } | undefined)?.type; if (t === "plugin_api_event") appHeard.push(JSON.stringify(params).slice(0, 200)); });

  // The user's OK for the third party: it runs. The bundled child runs with no card.
  const stateOf = async (id: string) => ((await app.request("plugin.get", { id }))["result"] as { plugin: { state: string } } | undefined)?.plugin.state;
  for (let i = 0; i < 300 && (await stateOf(PLUGIN)) === undefined; i++) await Bun.sleep(10);
  const switched = (await app.request("plugin.setEnabled", { id: PLUGIN, enabled: true }))["result"] as { applied: boolean; card: string };
  const broker = daemon.cloverParts.broker()!;
  for (let i = 0; i < 300 && broker.cards().find((c) => c.id === switched.card) === undefined; i++) await Bun.sleep(10);
  const okCard = broker.cards().find((c) => c.id === switched.card)!;
  expect(await broker.answer(okCard.id, { optionId: "approve", hash: okCard.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(okCard.id)!, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
  for (const id of [PLUGIN, BUNDLED]) {
    for (let i = 0; i < 1000 && (await stateOf(id)) !== "running"; i++) await Bun.sleep(10);
    if ((await stateOf(id)) !== "running") throw new Error(`the fixture ${id} isn't running: ${JSON.stringify((await app.request("plugin.get", { id }))["result"]).slice(0, 1500)}`);
  }
  // Any card a call raises (confirm, a change) is answered no, so nothing waits on the user.
  const denier = setInterval(() => {
    for (const c of broker.cards()) {
      const deny = c.options.find((o) => o.kind === "deny");
      if (deny !== undefined && c.id !== okCard.id) void broker.answer(c.id, { optionId: deny.id, hash: c.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(c.id)!, input: "click", at: Date.now() } }, { role: "app" }).catch(() => undefined);
    }
  }, 100);

  const entries = Object.entries(API_CALLS) as [string, ApiCallInfo][];
  const wrong: string[] = [];
  const notChecked: string[] = [];
  /** Every answer, written where `CLOVER_TRUTH_DUMP` says (to read what each member answered). */
  const seen: { path: string; where: string; a: Answer }[] = [];
  const layerMethods = allowedMethods("layer");
  const PICKS = new Set(["files.pickOpen", "files.pickFolder", "files.pickSave"]);

  /** One fixture's walk, both sides. */
  const walk = async (pluginId: string) => {
    const bundled = pluginId.startsWith("clover/");
    // The host half: each host member through `host.call` (`plugin.layer.api`), as the app's page reaches it.
    for (const [path, info] of entries) {
      if (info.where === "ui") continue;
      if (info.where === "clover" && !bundled) { notChecked.push(`${path} [${pluginId}] (host, the bundled clover process only: the bundled fixture calls it)`); continue; }
      const r = await app.request("plugin.layer.api", { pluginId, call: "host.call", args: ["api", { path, args: ARGS[path] ?? [] }, { timeoutMs: 20_000 }] });
      const a: Answer = r["error"] !== undefined ? { error: `host.call failed: ${JSON.stringify(r["error"]).slice(0, 300)}` } : (r["result"] as { result: Answer }).result;
      const why = verdict(path, info, a);
      seen.push({ path, where: `${pluginId} host`, a });
      if (why !== undefined) wrong.push(`${path} [${pluginId} host]: ${why}`);
    }

    // The component side: the SDK's own `usePluginApi`, its bridge routed as the app's main process routes it, the
    // layer connection's notifications relayed to the page as the app relays them.
    const { token } = (await app.request("layer.token", { pluginId }))["result"] as { token: string };
    const layer = await rpc(daemon!.socketPath);
    const hello = await layer.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "layer", token, clientName: "test-layer", pluginId });
    expect(hello["error"]).toBeUndefined();
    const pageListeners = new Set<(m: unknown) => void>();
    layer.onNotification((method, params) => { for (const l of pageListeners) l({ type: "api-event", pluginId, method, params }); });
    const bridgeApi = async (_mount: string, method: string, params: unknown): Promise<unknown> => {
      if (PICKS.has(method)) return { app: `main's own dialog (${method})` };
      // The bundled tree's parts: main's tree table takes what a layer doesn't call (`plugin.settings.get` …) on the
      // app's own connection; everything else goes on the layer's, as any part's.
      const viaApp = bundled && !layerMethods.has(method);
      if (!layerMethods.has(method) && !viaApp) throw new Error(`a layer doesn't call ${method} (the app's layer links refuse it)`);
      const r = await (viaApp ? app : layer).request(method, params ?? {});
      if (r["error"] !== undefined) { const e = r["error"] as { code?: number; message?: string }; throw Object.assign(new Error(e.message ?? "error"), { code: e.code }); }
      return r["result"];
    };
    const mainOnly = (what: string) => () => Promise.resolve({ app: what });
    configureLayer({ bridge: new Proxy({ api: bridgeApi, onMessage: (l: (m: unknown) => void) => { pageListeners.add(l); return () => pageListeners.delete(l); } } as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : k === "shell" ? (_m: string, method: string) => Promise.resolve({ app: `main's shell.${method}` }) : mainOnly(`main's ${k}`)),
    }) as never });
    const api = componentApi({ mount: `m_${pluginId.replace("/", "_")}`, pluginId });
    for (const [path, info] of entries) {
      if (info.where !== "ui" && info.where !== "both") continue;
      // Paced under the layer's calls-per-second cap (LAYER_CALLS_PER_SECOND), so no answer is the cap's.
      await Bun.sleep(60);
      const parts = path.split(".");
      const holder = parts.slice(0, -1).reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], api) as Record<string, unknown> | undefined;
      const fn = parts.length === 1 ? api[path] : holder?.[parts.at(-1)!];
      let a: Answer;
      if (typeof fn !== "function") a = { absent: typeof fn };
      else {
        try {
          const args = (ARGS[path] ?? []).map((x) => (x === FN ? () => {} : path === "audio.play" && typeof x === "object" && x !== null ? { ...x, data: new Uint8Array(0) } : x));
          const hung = () => Bun.sleep(6_000).then(() => { throw Object.assign(new Error("no answer in 6 s"), { code: "hung" }); });
          const out = await Promise.race([Promise.resolve().then(() => (fn as (...x: unknown[]) => unknown).apply(holder ?? api, args)), hung()]);
          // A watch the core opens (`plugin.layer.watch`): its answer is the opening's.
          if (typeof out === "function" && (out as { opened?: unknown }).opened instanceof Promise) {
            try {
              await Promise.race([(out as unknown as { opened: Promise<void> }).opened, hung()]);
            } finally {
              (out as () => void)();
            }
          } else if (typeof out === "function") (out as () => void)();
          const app = (out as { app?: string } | undefined)?.app;
          a = app !== undefined ? { app } : { value: out };
        } catch (e) {
          const err = e as { code?: unknown; message?: string };
          a = { error: `${err.code !== undefined ? `${String(err.code)}: ` : ""}${err.message ?? String(e)}` };
        }
      }
      const why = verdict(path, info, a);
      seen.push({ path, where: `${pluginId} component`, a });
      if (why !== undefined) wrong.push(`${path} [${pluginId} component]: ${why}`);
    }

    // What a component now reaches, for real: its answers are the core's, the bytes as bytes, and a watch is heard.
    await Bun.sleep(1_100);
    const files = api["files"] as { readText(p: string): Promise<string>; readBytes(p: string): Promise<Uint8Array>; write(p: string, d: string | Uint8Array): Promise<unknown>; watch(p: string, fn: (c: unknown) => void): Promise<() => void> };
    const heard: unknown[] = [];
    const off = await files.watch("home/Studio/watched", (c) => heard.push(c));
    const name = `watched/${pluginId.replace("/", "-")}.txt`;
    // Written again while unheard: a folder watch can miss a change made the moment it starts.
    for (let i = 0; i < 1000 && !JSON.stringify(heard).includes(name.slice("watched/".length)); i++) {
      if (i % 200 === 0) await files.write(`home/Studio/${name}`, new TextEncoder().encode("seen\n"));
      await Bun.sleep(10);
    }
    off();
    expect(JSON.stringify(heard)).toContain(name.slice("watched/".length));
    expect(readFileSync(join(userHome, name), "utf8")).toBe("seen\n");
    expect(await files.readText(`home/Studio/${name}`)).toBe("seen\n");
    const bytes = await files.readBytes(`home/Studio/${name}`);
    expect(bytes instanceof Uint8Array && new TextDecoder().decode(bytes)).toBe("seen\n");
    // `secrets.get` stays a host half's in a process of its own: never on a component's path.
    expect((await layer.request("plugin.layer.call", { call: "secrets.get", args: ["api-key"] }))["error"]).toMatchObject({ message: expect.stringContaining("host code") });
    layer.close();
  };

  try {
    await walk(PLUGIN);
    await walk(BUNDLED);
  } finally {
    clearInterval(denier);
    app.close();
  }
  if (process.env.CLOVER_TRUTH_DUMP) writeFileSync(process.env.CLOVER_TRUTH_DUMP, seen.map((x) => `${x.where}\t${x.path}\t${JSON.stringify(x.a).slice(0, 300)}`).join("\n"));
  if (notChecked.length > 0) console.log(`not checked on the third party (the bundled fixture's): ${notChecked.join("; ")}`);
  expect(wrong).toEqual([]);
  expect(appHeard).toEqual([]);
});
