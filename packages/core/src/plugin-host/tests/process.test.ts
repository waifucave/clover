// The plugin host for real: the daemon side starts a plugin-host process (`process-main.ts`, linked on fd 3), which runs
// each plugin in a worker of its own. Plain Bun here; the daemon runs it on the plugin Bun with #234's guard.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
export async function die() { setTimeout(() => { throw new Error("boom"); }, 0); await new Promise(() => {}); }
export const bytes = (args) => new Uint8Array([1, 2, args.x]);
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
  host.serveApi(async (call) => (call.path === "storage.synced.get" ? { [String(call.args[0])]: call.caller } : undefined));
  return host;
}

describe("a real plugin-host process", () => {
  test("start runs once, handlers run in the plugin's worker with their context, and bytes and streams cross the pipe", async () => {
    const host = realHost();
    expect(await host.invoke({ pluginId: "tarot", handler: "hello", args: { name: "fool" }, caller: USER })).toEqual({ hi: "fool", started: 1, computer: "Studio", caller: USER, deadline: true });
    await host.invoke({ pluginId: "tarot", handler: "hello", args: { name: "x" }, caller: USER });
    expect(await host.invoke({ pluginId: "tarot", handler: "bytes", args: { x: 7 }, caller: USER })).toEqual(new Uint8Array([1, 2, 7]));
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
    const launch = await hostProcessLaunch({ runDir: join(base, "run"), computer: "Studio", base: process.env as Record<string, string>, shared: [] });
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
});
