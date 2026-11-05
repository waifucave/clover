import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_ERR, CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, ERR, LineDecoder, METHODS, PROTOCOL_VERSION, type WritableSocket } from "@waifucave/clover-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { createCloverServer } from "../../src/ipc/clover";
import { CloverTokens } from "../../src/auth/clover-tokens";
import { SessionProcesses } from "../../src/auth/clover-caller";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { DaemonPair } from "../../src/platform/pair/policy";
import type { PeerFacts } from "../../src/platform/caller-probe";
import { resolveEndpoint } from "../../src/platform/transport";

// C-M1: Clover's roles, tokens, caller check and the pair's methods over the daemon's real endpoint,
// beside the inherited protocol on the same server.

class Client {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly fromDaemon: any[] = [];
  /** Answer the daemon's app.ping, as the app's main process does. */
  answerPings = true;
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  closed = false;

  static async connect(path: string): Promise<Client> {
    const c = new Client();
    c.socket = await Bun.connect({ unix: path, socket: {
      data(_s, chunk) {
        for (const line of c.decoder.push(chunk)) {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number" && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
          else if (msg.method) {
            c.fromDaemon.push(msg);
            if (msg.method === "app.ping" && c.answerPings) c.writer.enqueue(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
          }
        }
      },
      drain() { c.writer.onDrain(); },
      close() { c.closed = true; },
    } });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  hello(role: string, token: string, extra: Record<string, unknown> = {}): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role, token, clientName: `test-${role}`, ...extra });
  }
  close(): void { this.socket.end(); }
}

const outside: PeerFacts = { pid: 4242, ancestors: [1], probe: { sandboxedMac: false, inHostNamespacesLinux: true, tokenRestrictedWin: false, appContainerWin: false }, floor: "outside-floor" };
const fenced: PeerFacts = { pid: 5151, ancestors: [5150, 1], probe: { sandboxedMac: true }, floor: "fenced" };

describe("Clover connections (C-M1)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(opts: { peer?: PeerFacts; heartbeat?: { intervalMs: number; timeoutMs: number } } = {}) {
    const home = mkdtempSync(join(tmpdir(), "clover-conns-"));
    const store = new SessionStore(home);
    const socketPath = resolveEndpoint(join(home, "run")).path;
    mkdirSync(join(home, "run"), { recursive: true });
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const legacy = await authority.ensureTokens();
    const appToken = "a".repeat(43);
    const tokens = new CloverTokens({ appToken, verifyCli: (t) => authority.verify("harness", t) });
    const processes = new SessionProcesses();
    let peer = opts.peer ?? outside;
    const stops: string[] = [];
    const quits: Array<{ reason: string; to: readonly string[] }> = [];
    let clover!: ReturnType<typeof createCloverServer>;
    const pair = new DaemonPair({
      now: () => Date.now(), after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
      startApp: async () => "started", stopDaemon: (why) => { stops.push(why); },
      tellAppQuit: (reason, to) => { quits.push({ reason, to }); clover.tellAppQuit(reason, to); },
    }, { desktop: true, graceMs: 60_000 });
    const killed: number[] = [];
    clover = createCloverServer({ tokens, processes, serverVersion: "test", deviceId: "d".repeat(32), pair, probe: () => peer,
      ...(opts.heartbeat ? { heartbeat: opts.heartbeat } : {}), killApp: (pid) => { killed.push(pid); } });
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, cloverConnections: clover });
    stop = () => { pair.dispose(); server.stop(); store.close(); };
    return { socketPath, appToken, legacy, tokens, processes, pair, stops, quits, killed, setPeer: (p: PeerFacts) => { peer = p; } };
  }

  test("the app says hello with this run's token and counts as the user", async () => {
    const b = await boot();
    const c = await Client.connect(b.socketPath);
    const r = await c.hello("app", b.appToken, { features: ["app.show", "app.quit", "layers"] });
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ ok: true, protocolVersion: 1, caller: { kind: "user", client: "app" }, device: "d".repeat(32) });
    expect(b.pair.status().appConnected).toBe(true);
    const s = await c.request("pair.status", {});
    expect(s.result).toEqual({ bots: [], routines: 0, agents: 0, canHandOver: false, safeMode: false });
    c.close();
  });

  test("a wrong token, a sandboxed app, and a v0 hello on the same server", async () => {
    const b = await boot();
    const bad = await Client.connect(b.socketPath);
    expect((await bad.hello("app", "x".repeat(43))).error.code).toBe(ERR.UNAUTHORIZED);
    b.setPeer(fenced);
    const sandboxed = await Client.connect(b.socketPath);
    expect((await sandboxed.hello("app", b.appToken)).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    const legacy = await Client.connect(b.socketPath);
    const r = await legacy.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: b.legacy.harness, clientName: "old-cli" });
    expect(r.result.ok).toBe(true); // the inherited protocol is untouched
    bad.close(); sandboxed.close(); legacy.close();
  });

  test("the CLI: the user from the terminal; a session's command from inside one; refused when fenced and no one's", async () => {
    const b = await boot();
    const cli = await Client.connect(b.socketPath);
    expect((await cli.hello("cli", b.legacy.harness)).result.caller).toEqual({ kind: "user", client: "cli" });
    b.setPeer(fenced);
    const lost = await Client.connect(b.socketPath);
    expect((await lost.hello("cli", b.legacy.harness)).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    b.processes.add(5150, { sessionId: "s-1", sessionKind: "bot", bot: "alpha" });
    const bots = await Client.connect(b.socketPath);
    const r = await bots.hello("cli", b.legacy.harness);
    expect(r.result.caller).toEqual({ kind: "session", sessionId: "s-1", sessionKind: "bot", bot: "alpha" });
    expect((await bots.request("pair.quit", { handOver: false })).error.code).toBe(CLOVER_ERR.NOT_THE_USER); // userOnly
    expect(b.stops).toHaveLength(0);
    cli.close(); lost.close(); bots.close();
  });

  test("roles reach only their own list", async () => {
    const b = await boot();
    const cli = await Client.connect(b.socketPath);
    await cli.hello("cli", b.legacy.harness);
    expect((await cli.request("pair.exiting", { reason: "quit" })).error.code).toBe(CLOVER_ERR.ROLE_REFUSED); // the app's
    expect((await cli.request("layer.token", { pluginId: "x" })).error.code).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect((await cli.request(METHODS.hello, { protocolVersion: 1, role: "app", token: b.appToken, clientName: "again" })).error.code).toBe(ERR.INVALID_REQUEST);
    cli.close();
  });

  test("layer tokens: minted for the app, bound to one plugin", async () => {
    const b = await boot();
    const app = await Client.connect(b.socketPath);
    await app.hello("app", b.appToken);
    const { token } = (await app.request("layer.token", { pluginId: "vn-composer" })).result;
    const layer = await Client.connect(b.socketPath);
    const other = await Client.connect(b.socketPath);
    expect((await other.hello("layer", token, { pluginId: "someone-else" })).error.code).toBe(ERR.UNAUTHORIZED);
    expect((await layer.hello("layer", token, { pluginId: "vn-composer" })).result.caller).toEqual({ kind: "plugin", pluginId: "vn-composer" });
    app.close(); layer.close(); other.close();
  });

  test("plugin-host: the token is its process's, and the peer must be the process the daemon started", async () => {
    const b = await boot();
    const shared = b.tokens.mint({ role: "plugin-host", hostProcess: "shared" });
    const c = await Client.connect(b.socketPath);
    expect((await c.hello("plugin-host", shared, { hostProcess: "clover" })).error.code).toBe(CLOVER_ERR.PROCESS_REFUSED);
    const d = await Client.connect(b.socketPath);
    expect((await d.hello("plugin-host", shared, { hostProcess: "shared" })).result.caller.kind).toBe("plugin");
    c.close(); d.close();
  });

  test("peer: another computer is always fenced", async () => {
    const b = await boot();
    const t = b.tokens.mint({ role: "peer", device: "e".repeat(32) });
    const c = await Client.connect(b.socketPath);
    expect((await c.hello("peer", t, { device: "e".repeat(32) })).result.caller).toEqual({ kind: "peer", device: "e".repeat(32) });
    c.close();
  });

  test("the pair: the app's pair.quit stops the daemon once it has gone, with no app.quit back; the CLI's tells the app", async () => {
    const b = await boot();
    const app = await Client.connect(b.socketPath);
    await app.hello("app", b.appToken, { features: ["app.quit"] });
    expect((await app.request("pair.quit", { handOver: false })).result).toEqual({ ok: true });
    expect(b.quits).toHaveLength(0);
    app.close();
    for (let i = 0; i < 100 && b.stops.length === 0; i++) await Bun.sleep(10);
    expect(b.stops).toEqual(["the app went (quit)"]);
  });

  test("the pair: a CLI's pair.quit sends app.quit to the app", async () => {
    const b = await boot();
    const app = await Client.connect(b.socketPath);
    await app.hello("app", b.appToken, { features: ["app.quit"] });
    const cli = await Client.connect(b.socketPath);
    await cli.hello("cli", b.legacy.harness);
    await cli.request("pair.quit", { handOver: false });
    for (let i = 0; i < 100 && app.fromDaemon.length === 0; i++) await Bun.sleep(10);
    expect(app.fromDaemon[0]).toMatchObject({ jsonrpc: "2.0", method: "app.quit", params: { reason: "quit" } });
    app.close(); cli.close();
  });

  test("the pair: an app gone without pair.exiting is a crash, restarted", async () => {
    const b = await boot();
    const app = await Client.connect(b.socketPath);
    await app.hello("app", b.appToken);
    app.close();
    for (let i = 0; i < 100 && b.pair.status().startPending === null; i++) await Bun.sleep(10);
    expect(b.pair.status()).toMatchObject({ appConnected: false, crashesInWindow: 1, startPending: "crash" });
  });

  test("the heartbeat (R9): an app that answers app.ping stays; one that stops is ended and restarts in safe mode", async () => {
    const b = await boot({ heartbeat: { intervalMs: 20, timeoutMs: 150 } });
    const alive = await Client.connect(b.socketPath);
    await alive.hello("app", b.appToken);
    await Bun.sleep(300);
    expect(alive.fromDaemon.filter((m) => m.method === "app.ping").length).toBeGreaterThan(5);
    expect(b.killed).toEqual([]);
    alive.close();
    for (let i = 0; i < 100 && b.pair.status().appConnected; i++) await Bun.sleep(5);

    const hung = await Client.connect(b.socketPath);
    hung.answerPings = false;
    await hung.hello("app", b.appToken);
    for (let i = 0; i < 100 && b.killed.length === 0; i++) await Bun.sleep(10);
    expect(b.killed).toEqual([4242]); // the peer's pid, from the caller check
    hung.close(); // what the kill does
    for (let i = 0; i < 100 && b.pair.status().appConnected; i++) await Bun.sleep(5);
    expect(b.pair.status().safeMode).toBe(true);
  });
});
