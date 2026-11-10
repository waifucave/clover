// The plugin host for real: the daemon side starts a plugin-host process (`process-main.ts`, linked on fd 3), which runs
// each plugin in a worker of its own. Plain Bun here; the daemon runs it on the plugin Bun with #234's guard.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller, HostProcess } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import { SystemClock } from "../../clock/system-clock";
import { CorePluginHost, type HostedRecord } from "../core-host";
import { HOST_PROCESS_ENTRY, spawnHostProcess } from "../launch";
import { HostMux, type WorkerHandle } from "../mux";
import { loopbackPeers, type RpcPeer } from "../link";
import { MCP_INVOCATION_META } from "../../contracts/plugin-host";

const USER: Caller = { kind: "user", client: "app" };
const SESSION: Caller = { kind: "session", sessionId: "s_1", sessionKind: "bot" } as Caller;

const HOST_JS = `
let started = 0;
export function start(api) { started++; }
export async function hello(args, ctx) { return { hi: args.name, started, computer: ctx.computer, caller: ctx.caller, deadline: ctx.deadline > 0 }; }
export async function* count(args) { for (let i = 0; i < args.n; i++) yield i; return "done"; }
export async function stored(args, ctx) { return await ctx.api.storage.synced.get("k"); }
export async function chatty() { console.log("hello from the worker", { a: 1 }); return 1; }
export async function unawaited(args, ctx) { void ctx.api.storage.synced.get("boom"); return started; }
export async function stray() { void Promise.reject(new Error("the plugin's own")); return 1; }
export async function die() { setTimeout(() => { throw new Error("boom"); }, 0); await new Promise(() => {}); }
export const bytes = (args) => new Uint8Array([1, 2, args.x]);
export const big = (args) => ({ n: args.data.length, back: new Uint8Array(args.n).fill(7) });
export const mcp = {
  tools: async (transport, api) => {
    transport.onmessage = async (msg) => {
      const seen = await api.storage.synced.get("who");
      await transport.send({ jsonrpc: "2.0", id: msg.id, result: { meta: msg.params?._meta ?? null, seen } });
    };
  },
};
`;

function plugin(): string {
  const folder = mkdtempSync(join(tmpdir(), "clover-b2-proc-"));
  mkdirSync(join(folder, "host"));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  return folder;
}

const processes: { kill(): void }[] = [];
afterAll(() => {
  for (const p of processes) p.kill();
});

function realHost(o: { logs?: string[][] } = {}) {
  const folder = plugin();
  const records = new Map<string, HostedRecord>([["tarot", { id: "tarot", source: "local", folder, entry: "host/index.js", dataFolder: join(folder, "data") }]]);
  const links = new Map<string, RpcPeer>();
  const host = new CorePluginHost({
    clock: new SystemClock(),
    computer: "Studio",
    record: (id) => records.get(id),
    connect: (process: HostProcess) => {
      let peer = links.get(process);
      if (peer === undefined || peer.closed) {
        const p = spawnHostProcess({ cmd: [globalThis.process.execPath, HOST_PROCESS_ENTRY], env: { ...(globalThis.process.env as Record<string, string>), CLOVER_COMPUTER: "Studio" } });
        processes.push(p);
        links.set(process, (peer = p.peer));
      }
      return peer;
    },
    log: (id, lines) => o.logs?.push([id, ...lines]),
  });
  host.serveApi(async (call) => {
    if (call.path === "storage.synced.get" && call.args[0] === "boom") throw new ContractError("not_found", "tarot has no item boom");
    return call.path === "storage.synced.get" ? { [String(call.args[0])]: call.caller } : undefined;
  });
  return host;
}

describe("a real plugin-host process", () => {
  test("start runs once, handlers run in the plugin's worker with their context, and bytes and streams cross the pipe", async () => {
    const host = realHost();
    expect(await host.invoke({ pluginId: "tarot", handler: "hello", args: { name: "fool" }, caller: USER })).toEqual({ hi: "fool", started: 1, computer: "Studio", caller: USER, deadline: true });
    await host.invoke({ pluginId: "tarot", handler: "hello", args: { name: "x" }, caller: USER });
    expect(await host.invoke({ pluginId: "tarot", handler: "bytes", args: { x: 7 }, caller: USER })).toEqual(new Uint8Array([1, 2, 7]));
    // Megabytes both ways over the pipe (a would-block write is retried, never lost).
    const big = (await host.invoke({ pluginId: "tarot", handler: "big", args: { data: new Uint8Array(6_000_000).fill(1), n: 6_000_000 }, caller: USER })) as { n: number; back: Uint8Array };
    expect([big.n, big.back.length, big.back[5_999_999]]).toEqual([6_000_000, 6_000_000, 7]);
    const values: unknown[] = [];
    const s = host.stream({ pluginId: "tarot", handler: "count", args: { n: 3 }, caller: USER });
    for (;;) {
      const n = await s.next();
      if (n.done) {
        expect(n.value).toBe("done");
        break;
      }
      values.push(n.value);
    }
    expect(values).toEqual([0, 1, 2]);
    const e = (await host.invoke({ pluginId: "tarot", handler: "nope", args: null, caller: USER }).catch((x: unknown) => x)) as ContractError;
    expect(e.code).toBe("not_installed");
  }, 30_000);

  test("API calls come back to the core's router as the call's session (R7), an MCP server's as the request's", async () => {
    const host = realHost();
    expect(await host.invoke({ pluginId: "tarot", handler: "stored", args: null, caller: SESSION, session: "s_1" })).toEqual({ k: SESSION });
    const ch = await host.openMcp("tarot", "tools");
    const answer = new Promise<Record<string, unknown>>((resolve) => ch.onMessage(resolve));
    ch.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", _meta: { [MCP_INVOCATION_META]: "forged", other: 1 } } }, SESSION);
    expect(await answer).toEqual({ jsonrpc: "2.0", id: 1, result: { meta: { other: 1 }, seen: { who: SESSION } } });
    ch.close();
  }, 30_000);

  test("a plugin-API call that fails unawaited is a line in the plugin's log naming the call, never a crash; the plugin's own unhandled rejection still is", async () => {
    const logs: string[][] = [];
    const host = realHost({ logs });
    expect(await host.invoke({ pluginId: "tarot", handler: "unawaited", args: null, caller: USER })).toBe(1);
    await Bun.sleep(200);
    expect(host.status("tarot")).toMatchObject({ state: "running", crashes: 0 });
    expect(logs.flat().filter((l) => l.includes("storage.synced.get"))).toEqual(["the plugin API call storage.synced.get failed and nothing awaited it: not_found: tarot has no item boom"]);
    // The same worker answers on (its start ran once).
    expect(await host.invoke({ pluginId: "tarot", handler: "hello", args: { name: "on" }, caller: USER })).toMatchObject({ hi: "on", started: 1 });
    await host.invoke({ pluginId: "tarot", handler: "stray", args: null, caller: USER }).catch(() => {});
    await Bun.sleep(200);
    expect(host.status("tarot")).toMatchObject({ state: "restarting", crashes: 1 });
  }, 30_000);

  test("a worker that goes closes its plugin's open MCP channels at once (a crash, a reload): nothing waits on a server that is gone", async () => {
    const host = realHost();
    const ch = await host.openMcp("tarot", "tools");
    expect(ch.closed).toBe(false);
    // A crash: the worker dies, its channel closes with it.
    await host.invoke({ pluginId: "tarot", handler: "die", args: null, caller: USER }).catch(() => {});
    expect(ch.closed).toBe(true);
    expect(() => ch.send({ jsonrpc: "2.0", id: 1, method: "ping" })).toThrow();
    // After the restart a new channel answers; a reload closes it too.
    await Bun.sleep(1300);
    const again = await host.openMcp("tarot", "tools");
    const answer = new Promise<Record<string, unknown>>((resolve) => again.onMessage(resolve));
    again.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await answer).id).toBe(2);
    await host.reload("tarot");
    expect(again.closed).toBe(true);
    expect((await host.openMcp("tarot", "tools")).closed).toBe(false);
  }, 30_000);

  test("a worker's console goes to its plugin's log; a worker that dies is a crash, and the plugin restarts", async () => {
    const logs: string[][] = [];
    const host = realHost({ logs });
    await host.invoke({ pluginId: "tarot", handler: "chatty", args: null, caller: USER });
    await Bun.sleep(50);
    expect(logs[0]?.[0]).toBe("tarot");
    expect(logs[0]?.[1]).toContain("hello from the worker");
    const e = (await host.invoke({ pluginId: "tarot", handler: "die", args: null, caller: USER }).catch((x: unknown) => x)) as ContractError;
    expect(e.code).toBe("failed");
    expect(host.status("tarot")).toMatchObject({ state: "restarting", crashes: 1 });
    await Bun.sleep(1300);
    expect(await host.invoke({ pluginId: "tarot", handler: "hello", args: { name: "again" }, caller: USER })).toMatchObject({ hi: "again", started: 1 });
  }, 30_000);
});

describe("the process's heartbeat", () => {
  test("a worker that doesn't answer for 30 seconds is ended and reported", async () => {
    const [daemon, host] = loopbackPeers();
    const states: unknown[] = [];
    daemon.handle("pluginHost.state", (x) => void states.push(x));
    const [w, worker] = loopbackPeers();
    worker.handle("pluginHost.start", () => ({ ok: true })); // never answers "ping"
    worker.handle("ping", () => new Promise(() => {}));
    let terminated = false;
    const handle: WorkerHandle = { peer: w, terminate: () => void (terminated = true), onExit: () => {} };
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const mux = new HostMux({ daemon: host, spawnWorker: () => handle, heartbeatMs: 5 });
      await daemon.request("pluginHost.start", { pluginId: "tarot", folder: "/x", entry: "e.js", runtime: "bun", dataFolder: "/d", process: "shared" });
      now += 31_000;
      await Bun.sleep(30);
      expect(terminated).toBe(true);
      expect(states).toEqual([{ pluginId: "tarot", state: "heartbeat-missed", reason: "no answer to the heartbeat for 30 seconds" }]);
      mux.close();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("the process's streams", () => {
  test("a worker's chunk reaches the daemon only for a call made to its own plugin", async () => {
    const [daemon, host] = loopbackPeers();
    const chunks: unknown[] = [];
    daemon.handle("pluginHost.chunk", (x) => void chunks.push(x));
    const workers = new Map<string, RpcPeer>();
    const release = new Map<string, () => void>();
    const mux = new HostMux({
      daemon: host,
      spawnWorker: (x) => {
        const [w, worker] = loopbackPeers();
        worker.handle("pluginHost.start", () => ({ ok: true }));
        worker.handle("ping", () => "pong");
        worker.handle("pluginHost.invoke", (p: { callId: string }) => new Promise((resolve) => release.set(p.callId, () => resolve(1))));
        workers.set(x.pluginId, worker);
        return { peer: w, terminate: () => {}, onExit: () => {} };
      },
    });
    for (const pluginId of ["alpha", "bravo"]) await daemon.request("pluginHost.start", { pluginId, folder: "/x", entry: "e.js", runtime: "bun", dataFolder: "/d", process: "shared" });
    const call = daemon.request("pluginHost.invoke", { callId: "c-alpha", pluginId: "alpha" });
    await Bun.sleep(5);
    workers.get("bravo")!.notify("pluginHost.chunk", { callId: "c-alpha", seq: 0, value: "forged" });
    workers.get("alpha")!.notify("pluginHost.chunk", { callId: "c-alpha", seq: 0, value: "real" });
    await Bun.sleep(5);
    release.get("c-alpha")!();
    await call;
    expect(chunks).toEqual([{ callId: "c-alpha", seq: 0, value: "real" }]);
    mux.close();
  });
});

describe("a guarded plugin-host process (per-worker folders)", () => {
  test("each worker is held to its own plugin's folder: another plugin's file, or a nested worker claiming the host, is refused", async () => {
    const { hostProcessLaunch } = await import("../launch");
    const base = mkdtempSync(join(tmpdir(), "clover-b2-guard-"));
    const make = (name: string, js: string) => {
      const folder = join(base, "plugins", name);
      mkdirSync(join(folder, "host"), { recursive: true });
      writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(folder, "host", "index.js"), js);
      return folder;
    };
    const b = make("bravo", `export const secret = () => "bravo's";\n`);
    const a = make("alpha2", `
export const own = async () => (await import("./helper.js")).x;
export const steal = async () => (await import(${JSON.stringify(join(b, "host", "index.js"))})).secret();
export const nested = () => new Promise((resolve) => {
  const w = new Worker(URL.createObjectURL(new Blob([\`import(${JSON.stringify(join(b, "host", "index.js"))}).then(() => postMessage("loaded"), (e) => postMessage("refused: " + e.message));\`])), { env: { CLOVER_PLUGIN_HOST: "1" } });
  w.onmessage = (e) => { resolve(e.data); w.terminate(); };
});
`);
    writeFileSync(join(a, "host", "helper.js"), "export const x = 41 + 1;\n");
    const launch = await hostProcessLaunch({ runDir: join(base, "run"), computer: "Studio", base: process.env as Record<string, string>, shared: [], cloverHome: base });
    const p = spawnHostProcess(launch);
    processes.push(p);
    const records = new Map<string, HostedRecord>([
      ["alpha2", { id: "alpha2", source: "local", folder: a, entry: "host/index.js", dataFolder: join(base, "data") }],
      ["bravo", { id: "bravo", source: "local", folder: b, entry: "host/index.js", dataFolder: join(base, "data") }],
    ]);
    const host = new CorePluginHost({ clock: new SystemClock(), computer: "Studio", record: (id) => records.get(id), connect: () => p.peer });
    expect(await host.invoke({ pluginId: "bravo", handler: "secret", args: null, caller: USER })).toBe("bravo's");
    expect(await host.invoke({ pluginId: "alpha2", handler: "own", args: null, caller: USER })).toBe(42);
    const stolen = (await host.invoke({ pluginId: "alpha2", handler: "steal", args: null, caller: USER }).catch((x: unknown) => x)) as ContractError;
    expect([stolen.code, stolen.message.includes("outside the plugin's own folder")]).toEqual(["failed", true]);
    const nested = await host.invoke({ pluginId: "alpha2", handler: "nested", args: null, caller: USER });
    expect(String(nested)).toContain("refused");
  }, 60_000);

  // #289: a Bun macro would run its module's code while the plugin's file loads. The host's workers refuse it, at
  // start (a static import) and later (a dynamic one), and the macro's code never runs.
  test("a plugin with a macro import is refused at load, and the macro never runs", async () => {
    const { hostProcessLaunch } = await import("../launch");
    const base = mkdtempSync(join(tmpdir(), "clover-b2-macro-"));
    const ran = join(base, "macro-ran");
    const make = (name: string, files: Record<string, string>) => {
      const folder = join(base, "plugins", name);
      mkdirSync(join(folder, "host"), { recursive: true });
      writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(folder, "host", "mac.js"), `import { writeFileSync } from "node:fs";\nexport function leak() { writeFileSync(${JSON.stringify(ran)}, String(process.pid)); return "leaked"; }\n`);
      for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, "host", file), text);
      return folder;
    };
    const eager = make("eager", { "index.js": `import { leak } from "./mac.js" with { type: "macro" };\nexport const value = () => leak();\n` });
    const lazy = make("lazy", {
      "index.js": `export const fine = () => "fine";\nexport const late = async () => (await import("./late.js")).value;\n`,
      "late.js": `import { leak } from "./mac.js" with { type: "macro" };\nexport const value = leak();\n`,
    });
    const launch = await hostProcessLaunch({ runDir: join(base, "run"), computer: "Studio", base: process.env as Record<string, string>, shared: [], cloverHome: base });
    expect(launch.cmd).toContain("--no-macros");
    const p = spawnHostProcess(launch);
    processes.push(p);
    const records = new Map<string, HostedRecord>([
      ["eager", { id: "eager", source: "local", folder: eager, entry: "host/index.js", dataFolder: join(base, "data") }],
      ["lazy", { id: "lazy", source: "local", folder: lazy, entry: "host/index.js", dataFolder: join(base, "data") }],
    ]);
    const host = new CorePluginHost({ clock: new SystemClock(), computer: "Studio", record: (id) => records.get(id), connect: () => p.peer });
    const atStart = (await host.invoke({ pluginId: "eager", handler: "value", args: null, caller: USER }).catch((x: unknown) => x)) as ContractError;
    expect(atStart).toBeInstanceOf(Error);
    expect(atStart.message).toContain("a Bun macro");
    expect(await host.invoke({ pluginId: "lazy", handler: "fine", args: null, caller: USER })).toBe("fine");
    const later = (await host.invoke({ pluginId: "lazy", handler: "late", args: null, caller: USER }).catch((x: unknown) => x)) as ContractError;
    expect([later.code, later.message.includes("a Bun macro")]).toEqual(["failed", true]);
    expect(existsSync(ran)).toBe(false);
  }, 60_000);
});

// #322's review, S4: a host process is its group's leader, and ending it ends what its plugins started.
describe.skipIf(process.platform === "win32")("what a plugin starts ends with its host process", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const gone = async (pid: number) => { for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50); return !alive(pid); };
  const start = async () => {
    const { hostProcessLaunch } = await import("../launch");
    const base = mkdtempSync(join(tmpdir(), "clover-b2-group-"));
    const folder = join(base, "plugins", "spawner");
    mkdirSync(join(folder, "host"), { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    // A child that ignores SIGTERM, so only the SIGKILL after the grace ends it.
    writeFileSync(join(folder, "host", "index.js"), `export const spawn = () => Bun.spawn(["/bin/sh", "-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: ["ignore", "ignore", "ignore"] }).pid;\n`);
    const launch = await hostProcessLaunch({ runDir: join(base, "run"), computer: "Studio", base: process.env as Record<string, string>, shared: [], cloverHome: base });
    const p = spawnHostProcess({ ...launch, graceMs: 300 });
    processes.push(p);
    const records = new Map<string, HostedRecord>([["spawner", { id: "spawner", source: "local", folder, entry: "host/index.js", dataFolder: join(base, "data") }]]);
    const host = new CorePluginHost({ clock: new SystemClock(), computer: "Studio", record: (id) => records.get(id), connect: () => p.peer });
    const child = await host.invoke({ pluginId: "spawner", handler: "spawn", args: null, caller: USER }) as number;
    expect(alive(child)).toBe(true);
    return { p, child };
  };

  test("the daemon's stop: the host and a worker's Bun.spawn child are gone", async () => {
    const { p, child } = await start();
    p.kill();
    expect(await gone(p.pid!)).toBe(true);
    expect(await gone(child)).toBe(true);
  }, 60_000);

  test("the host crashing: a worker's Bun.spawn child is gone too", async () => {
    const { p, child } = await start();
    process.kill(p.pid!, "SIGKILL");
    expect(await gone(p.pid!)).toBe(true);
    expect(await gone(child)).toBe(true);
  }, 60_000);
});
