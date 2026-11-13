// Every plugin API member the SDK's catalog lists (`API_CALLS`) is served where the catalog says, on a REAL daemon: the
// plugin host started by the daemon's own composition (`startDaemon`, its `startPluginHost` call and daemon-parts
// wiring, no test-built router or caller), a temp home and a throwaway secret store. Four times the daemon's real
// composition missed a handler its unit tests had (each built its own router or caller); this walks the catalog instead.
//
// A third-party fixture holding every capability a third party may hold runs a host half in a process of its own:
// - host members (`host`, `own`, `both`) are called by its host half, as the app's page would reach it (`host.call`
//   through `plugin.layer.api`);
// - component members (`ui`, `both`) are called through the SDK's own component API (`usePluginApi`, the code a plugin's
//   page runs), its bridge routed as the app's main process routes it: the pickers to main's dialog, every other call
//   on the plugin's own layer connection to the core (role `layer`, `layer.token` as the app gets it).
// The bundled tree's own members (`clover`) can't be called by a third party: listed as not checked here.
//
// A member not marked `notYet` must not answer "not served", "isn't available", "no handler", a missing method, or be
// absent; a refusal for a real reason (a bad argument, a fence, a capability) counts as served. A member marked
// `notYet` must say it isn't available. The test fails naming each member, where, and what it answered.
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
        if (typeof m["id"] === "number") { pending.get(m["id"])?.(m); pending.delete(m["id"]); } else if (typeof m["method"] === "string") for (const n of notes) n(m["method"], m["params"]);
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
  "files.grep": ["truth", { cwd: "home/Studio" }], "files.watch": ["home/Studio", FN], "files.path": [GRANT],
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
  if (info.notYet !== undefined) return a.error !== undefined && SAYS_NOT_YET.test(a.error) ? undefined : `marked notYet, but answered ${said}`;
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

darwinTest("every API member the catalog lists is served where it says, on the daemon's own composition", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-api-truth-")));
  const home = join(root, "clover-home");
  const userHome = join(root, "home");
  mkdirSync(userHome, { recursive: true });
  writeFileSync(join(userHome, "truth.txt"), "truth\n");
  // The fixture: every capability a third party may hold (a capability the validator keeps from third parties is
  // left out, and its members named below), a host half in a process of its own. Its layer connection needs no UI
  // entry (`layer.token` is minted for any plugin).
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

  // The user's OK for it: it runs.
  const stateOf = async () => ((await app.request("plugin.get", { id: PLUGIN }))["result"] as { plugin: { state: string } } | undefined)?.plugin.state;
  for (let i = 0; i < 300 && (await stateOf()) === undefined; i++) await Bun.sleep(10);
  const switched = (await app.request("plugin.setEnabled", { id: PLUGIN, enabled: true }))["result"] as { applied: boolean; card: string };
  const broker = daemon.cloverParts.broker()!;
  for (let i = 0; i < 300 && broker.cards().find((c) => c.id === switched.card) === undefined; i++) await Bun.sleep(10);
  const okCard = broker.cards().find((c) => c.id === switched.card)!;
  expect(await broker.answer(okCard.id, { optionId: "approve", hash: okCard.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(okCard.id)!, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
  for (let i = 0; i < 1000 && (await stateOf()) !== "running"; i++) await Bun.sleep(10);
  if ((await stateOf()) !== "running") throw new Error(`the fixture isn't running: ${JSON.stringify((await app.request("plugin.get", { id: PLUGIN }))["result"]).slice(0, 1500)}`);
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
  try {
    // The host half: each host member through `host.call` (`plugin.layer.api`), as the app's page reaches it.
    for (const [path, info] of entries) {
      if (info.where === "ui") continue;
      if (info.where === "clover") { notChecked.push(`${path} (host, the bundled clover process only)`); continue; }
      const r = await app.request("plugin.layer.api", { pluginId: PLUGIN, call: "host.call", args: ["api", { path, args: ARGS[path] ?? [] }, { timeoutMs: 20_000 }] });
      const a: Answer = r["error"] !== undefined ? { error: `host.call failed: ${JSON.stringify(r["error"]).slice(0, 300)}` } : (r["result"] as { result: Answer }).result;
      const why = verdict(path, info, a);
      seen.push({ path, where: "host", a });
      if (why !== undefined) wrong.push(`${path} [host]: ${why}`);
    }

    // The component side: the SDK's own `usePluginApi`, its bridge routed as the app's main process routes it.
    const { token } = (await app.request("layer.token", { pluginId: PLUGIN }))["result"] as { token: string };
    const layer = await rpc(daemon.socketPath);
    const hello = await layer.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "layer", token, clientName: "test-layer", pluginId: PLUGIN });
    expect(hello["error"]).toBeUndefined();
    const layerMethods = allowedMethods("layer");
    const PICKS = new Set(["files.pickOpen", "files.pickFolder", "files.pickSave"]);
    const bridgeApi = async (_mount: string, method: string, params: unknown): Promise<unknown> => {
      if (PICKS.has(method)) return { app: `main's own dialog (${method})` };
      if (!layerMethods.has(method)) throw new Error(`a layer doesn't call ${method} (the app's layer links refuse it)`);
      const r = await layer.request(method, params ?? {});
      if (r["error"] !== undefined) { const e = r["error"] as { code?: number; message?: string }; throw Object.assign(new Error(e.message ?? "error"), { code: e.code }); }
      return r["result"];
    };
    const mainOnly = (what: string) => () => Promise.resolve({ app: what });
    configureLayer({ bridge: new Proxy({ api: bridgeApi, onMessage: () => {} } as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : k === "shell" ? (_m: string, method: string) => Promise.resolve({ app: `main's shell.${method}` }) : mainOnly(`main's ${k}`)),
    }) as never });
    const api = componentApi({ mount: "m_truth", pluginId: PLUGIN });
    for (const [path, info] of entries) {
      if (info.where !== "ui" && info.where !== "both") continue;
      const parts = path.split(".");
      const holder = parts.slice(0, -1).reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], api) as Record<string, unknown> | undefined;
      const fn = parts.length === 1 ? api[path] : holder?.[parts.at(-1)!];
      let a: Answer;
      if (typeof fn !== "function") a = { absent: typeof fn };
      else {
        try {
          const args = (ARGS[path] ?? []).map((x) => (x === FN ? () => {} : x));
          const out = await Promise.race([Promise.resolve().then(() => (fn as (...x: unknown[]) => unknown).apply(holder ?? api, args)), Bun.sleep(6_000).then(() => { throw Object.assign(new Error("no answer in 6 s"), { code: "hung" }); })]);
          if (typeof out === "function") (out as () => void)();
          const app = (out as { app?: string } | undefined)?.app;
          a = app !== undefined ? { app } : { value: out };
        } catch (e) {
          const err = e as { code?: unknown; message?: string };
          a = { error: `${err.code !== undefined ? `${String(err.code)}: ` : ""}${err.message ?? String(e)}` };
        }
      }
      const why = verdict(path, info, a);
      seen.push({ path, where: "component", a });
      if (why !== undefined) wrong.push(`${path} [component]: ${why}`);
    }
    layer.close();
  } finally {
    clearInterval(denier);
    app.close();
  }
  if (process.env.CLOVER_TRUTH_DUMP) writeFileSync(process.env.CLOVER_TRUTH_DUMP, seen.map((x) => `${x.where}\t${x.path}\t${JSON.stringify(x.a).slice(0, 300)}`).join("\n"));
  console.log(`not checked here (the bundled tree's own): ${notChecked.join("; ")}`);
  expect(wrong).toEqual([]);
});
