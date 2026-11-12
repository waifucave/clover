import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_ERR, CLOVER_PROTOCOL_VERSION, SESSIONS_METHODS, ConnWriter, encodeLine, ERR, LineDecoder, METHODS, PROTOCOL_VERSION, type PluginState, type WritableSocket } from "@waifucave/clover-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { bridgeMethodHandlers, canonicalCallHash, createCloverServer, laneMethodHandlers, type BridgeGate, type BridgeVerdict } from "../../src/ipc/clover";
import { checkDaemonProof } from "../../src/platform/pair/run-files";
import { appCaptureHandler } from "../../src/ipc/app-capture";
import { handler, MethodError } from "../../src/bots/rpc";
import { CloverTokens } from "../../src/auth/clover-tokens";
import { SessionProcesses } from "../../src/auth/clover-caller";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { DaemonPair } from "../../src/platform/pair/policy";
import type { PeerFacts } from "../../src/platform/caller-probe";
import type { PeerHandle } from "../../src/platform/peer-handle";
import { appPeerByRequirement, auditTokenSatisfies, type AppPeerCheck } from "../../src/platform/peer-signature";
import { spawnSync } from "node:child_process";
import { resolveEndpoint } from "../../src/platform/transport";
import { commandMethods } from "../../src/registry/commands";
import { grantsInForce } from "../../src/contracts/plugin-registry";
import { darwinTest, onDarwin } from "../helpers/darwin-only";

// C-M1: Clover's roles, tokens, caller check and the pair's methods over the daemon's real endpoint,
// beside the inherited protocol on the same server.

class Client {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly fromDaemon: any[] = [];
  /** Answer the daemon's app.ping, as the app's main process does. */
  answerPings = true;
  /** Answers to the daemon's other requests, by method: a result, or `{ error }` for an error answer. */
  answers: Record<string, (params: any) => unknown> = {};
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
            const answer = c.answers[msg.method];
            if (answer !== undefined) {
              const r = answer(msg.params) as { error?: unknown } | undefined;
              c.writer.enqueue(encodeLine(r !== undefined && r !== null && typeof r === "object" && "error" in r ? { jsonrpc: "2.0", id: msg.id, error: r.error } : { jsonrpc: "2.0", id: msg.id, result: r }));
            }
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

/** K's `BridgeTokens` as the server sees them: one token for one session, accepted only from the agent's tree,
 *  one live connection, given back on close; `revoke` tells the server to close it. */
class FakeBridgeTokens implements BridgeGate {
  readonly seen: Array<number | null> = [];
  readonly released: number[] = [];
  private live: number | undefined;
  private seq = 0;
  private readonly listeners = new Set<(e: { sessionId: string; connection?: number }) => void>();
  constructor(readonly token: string, readonly session: string, readonly tree: (pid: number) => boolean, readonly waitMs = 0) {}
  async accept(token: string, sessionId: string, pid: number | null): Promise<BridgeVerdict> {
    this.seen.push(pid);
    if (token !== this.token) return { ok: false, reason: "unknown-token" };
    if (sessionId !== this.session) return { ok: false, reason: "wrong-session" };
    if (pid === null) return { ok: false, reason: "unverified-caller" };
    if (this.waitMs) await Bun.sleep(this.waitMs); // the agent's pid not bound yet
    if (!this.tree(pid)) return { ok: false, reason: "not-the-agent" };
    if (this.live !== undefined) return { ok: false, reason: "in-use" };
    this.live = ++this.seq;
    return { ok: true, sessionId, connection: this.live };
  }
  release(_sessionId: string, connection: number): void { this.released.push(connection); if (this.live === connection) this.live = undefined; }
  onRevoke(fn: (e: { sessionId: string; connection?: number }) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  revoke(): void { const c = this.live; this.live = undefined; for (const fn of this.listeners) fn({ sessionId: this.session, ...(c === undefined ? {} : { connection: c }) }); }
}

describe("Clover connections (C-M1)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(opts: { peer?: PeerFacts; realPeer?: boolean; bridge?: FakeBridgeTokens; heartbeat?: { intervalMs: number; timeoutMs: number }; acceptUpdateExit?: () => boolean; appPeer?: AppPeerCheck | "default"; grants?: Record<string, string[]>; records?: Record<string, { enabled: boolean; state: PluginState; granted: string[] }> } = {}) {
    // A plugin's record as the registry holds it (on and running unless a test says otherwise), read on every call.
    const records = opts.records ?? Object.fromEntries(Object.entries(opts.grants ?? {}).map(([id, granted]) => [id, { enabled: true, state: "running" as PluginState, granted }]));
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
    const killedVia: Array<PeerHandle | undefined> = [];
    const calls: Array<{ method: string; sessionId: string; params?: unknown }> = [];
    const bridge = opts.bridge ? {
      gate: opts.bridge,
      sessionInfo: (id: string) => (id === "s-agent" ? { bot: "alpha" } : undefined),
    } : undefined;
    const bridgeHandlers = bridgeMethodHandlers({
      tools: async (sessionId) => { calls.push({ method: "bridge.tools", sessionId }); return { tools: [], instructions: "hi" }; },
      call: async (sessionId, c) => { calls.push({ method: "bridge.call", sessionId, params: c }); return { content: [], isError: false }; },
      sendMessage: async (sessionId, m) => { calls.push({ method: "bridge.sendMessage", sessionId, params: m }); },
      glossary: async (sessionId, q) => { calls.push({ method: "glossary.query", sessionId, params: q }); return { results: [], loaded: [] }; },
    });
    // A lane's handlers in D's shape (bots/rpc.ts): session.attach streams, session.detach stops, and
    // session.list refuses with a MethodError.
    const unfollowed: string[] = [];
    const laneHandlers = laneMethodHandlers({
      "session.attach": handler(SESSIONS_METHODS.sessionAttach, (p, ctx) => {
        calls.push({ method: "session.attach", sessionId: p.id, params: ctx.caller });
        ctx.stream!.follows.set(p.id, () => { unfollowed.push(p.id); });
        ctx.stream!.send({ type: "text_delta", seq: 3, sessionId: p.id, ts: 1, delta: "hi" });
        return { lastSeq: 3 };
      }),
      "session.list": handler(SESSIONS_METHODS.sessionList, () => { throw new MethodError(CLOVER_ERR.NOT_THE_USER, "only the user can list", { why: "test" }); }),
      "session.interrupt": handler(SESSIONS_METHODS.sessionInterrupt, (p, ctx) => { calls.push({ method: "session.interrupt", sessionId: p.id, params: ctx.caller }); return { ok: true as const }; }),
      // B: `command.run`, its args checked against the command's schema before the handler runs.
      ...commandMethods({
        registry: { get: ((id: string) => records[id]) as never, entries: ((point: string) => point !== "commands" ? [] : [{
          point: "commands", pluginId: "tarot", ref: "commands/0", entryId: "tarot.draw", state: "active",
          value: { name: "draw", description: "Draw", handler: "draw", args: { type: "object", required: ["cards"], properties: { cards: { type: "integer", minimum: 1, maximum: 3 } } } },
        }]) as never },
        host: { invoke: async <R>(req: { handler: string; args: unknown; caller: unknown }) => { calls.push({ method: "command.run", sessionId: req.handler, params: { args: req.args, caller: req.caller } }); return { drawn: req.args } as R; } },
      }),
    });
    // The test process says hello as the app: no peer-image check unless a test asks for one (`opts.appPeer`).
    const appPeer = opts.appPeer === "default" ? {} : { appPeer: opts.appPeer ?? ("none" as const) };
    clover = createCloverServer({ tokens, processes, serverVersion: "test", deviceId: "d".repeat(32), pair, appToken, ...appPeer,
      ...(opts.grants || opts.records ? { pluginCapabilities: (id: string) => grantsInForce(records[id]) } : {}),
      hostPidOf: (hp) => (hp === "shared" ? 4242 : undefined), linkPid: () => 4242,
      ...(opts.realPeer ? {} : { probe: () => peer }), ...(bridge ? { bridge } : {}), handlers: { ...bridgeHandlers, ...laneHandlers, "app.capture": appCaptureHandler({ connections: () => clover.connections(), ask: (conn, method, params, ms) => clover.ask(conn, method, params, ms) }) },
      ...(opts.heartbeat ? { heartbeat: opts.heartbeat } : {}), ...(opts.acceptUpdateExit ? { acceptUpdateExit: opts.acceptUpdateExit } : {}), killApp: (pid, handle) => { killed.push(pid); killedVia.push(handle); } });
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, cloverConnections: clover });
    stop = () => { clover.dispose(); pair.dispose(); server.stop(); store.close(); };
    return { socketPath, appToken, legacy, tokens, processes, pair, stops, quits, killed, killedVia, calls, unfollowed, clover, setPeer: (p: PeerFacts) => { peer = p; } };
  }

  test("command.run over the socket: args that fit reach the handler; args that don't answer invalid_args with the path", async () => {
    const b = await boot();
    const c = await Client.connect(b.socketPath);
    await c.hello("app", b.appToken, { features: ["app.show", "app.quit", "layers"] });
    const ok = await c.request("command.run", { name: "tarot.draw", args: { cards: 2 } });
    expect(ok.result).toEqual({ result: { drawn: { cards: 2 } } });
    expect(b.calls.filter((x) => x.method === "command.run")).toEqual([{ method: "command.run", sessionId: "draw", params: { args: { cards: 2 }, caller: { kind: "user", client: "app" } } }]);
    for (const [args, path, keyword] of [[{ cards: 9 }, "/cards", "maximum"], [{}, "/cards", "required"], [{ cards: 1, note: "private words" }, "/note", "additionalProperties"]] as const) {
      const bad = await c.request("command.run", { name: "tarot.draw", args });
      expect(bad.error).toMatchObject({ code: ERR.INVALID_PARAMS, data: { code: "invalid_args", path, keyword } });
      expect(JSON.stringify(bad.error)).not.toContain("private words");
    }
    expect(b.calls.filter((x) => x.method === "command.run").length).toBe(1);
    const missing = await c.request("command.run", { name: "tarot.nope" });
    expect(missing.error.data).toMatchObject({ code: "not_installed" });
    c.close();
  });

  test("command.run on a plugin's layer connection: another plugin's command only with call:<it>; its own with none", async () => {
    const b = await boot({ grants: { "vn-composer": ["conversation.read"], friend: ["call:tarot"], tarot: [] } });
    const app = await Client.connect(b.socketPath);
    await app.hello("app", b.appToken);
    const layerOf = async (pluginId: string) => {
      const { token } = (await app.request("layer.token", { pluginId })).result;
      const c = await Client.connect(b.socketPath);
      await c.hello("layer", token, { pluginId });
      return c;
    };
    const runs = () => b.calls.filter((x) => x.method === "command.run").map((x) => (x.params as { caller: { pluginId?: string } }).caller.pluginId);
    const vn = await layerOf("vn-composer");
    const refused = await vn.request("command.run", { name: "tarot.draw", args: { cards: 9 } });
    expect(refused.error.data).toMatchObject({ code: "refused" });
    expect(refused.error.message).toContain("call:tarot");
    // Refused before its args are looked at: the args were out of range, and the answer isn't invalid_args.
    expect(runs()).toEqual([]);
    const friend = await layerOf("friend");
    expect((await friend.request("command.run", { name: "tarot.draw", args: { cards: 1 } })).error).toBeUndefined();
    const tarot = await layerOf("tarot");
    expect((await tarot.request("command.run", { name: "tarot.draw", args: { cards: 2 } })).error).toBeUndefined();
    expect(runs()).toEqual(["friend", "tarot"]);
    // The user's own door (the app's connection, the composer's slash menu) is unchanged.
    expect((await app.request("command.run", { name: "tarot.draw", args: { cards: 3 } })).error).toBeUndefined();
    app.close(); vn.close(); friend.close(); tarot.close();
  });

  test("a layer's method that names a capability is refused, before its handler, for a plugin whose OK doesn't grant it", async () => {
    const b = await boot({ grants: { "vn-composer": ["conversation.read"], bare: [] } });
    const app = await Client.connect(b.socketPath);
    await app.hello("app", b.appToken);
    const layerOf = async (pluginId: string) => {
      const { token } = (await app.request("layer.token", { pluginId })).result;
      const c = await Client.connect(b.socketPath);
      await c.hello("layer", token, { pluginId });
      return c;
    };
    const bare = await layerOf("bare");
    const r = await bare.request("session.interrupt", { id: "s_1" });
    // session.interrupt is the user's: refused at the role gate, as before.
    expect(r.error.code).toBe(CLOVER_ERR.ROLE_REFUSED);
    const read = await bare.request("session.list", {});
    expect(read.error.code).toBe(CLOVER_ERR.CAPABILITY_REFUSED);
    expect(read.error.message).toContain("conversation.read");
    // With the capability the call passes the gate and reaches its handler (here a stand-in that refuses on its own).
    const vn = await layerOf("vn-composer");
    expect((await vn.request("session.list", {})).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    // An unknown plugin (no record) is granted nothing.
    const ghost = await layerOf("ghost");
    expect((await ghost.request("session.list", {})).error.code).toBe(CLOVER_ERR.CAPABILITY_REFUSED);
    app.close(); bare.close(); vn.close(); ghost.close();
  });

  test("a plugin that may not run gets nothing on its open layer connection: turned off, stopped, blocked, or waiting for its OK", async () => {
    const records: Record<string, { enabled: boolean; state: PluginState; granted: string[] }> = {
      tarot: { enabled: true, state: "running", granted: ["conversation.read"] },
      friend: { enabled: true, state: "running", granted: ["conversation.read", "call:tarot"] },
    };
    const b = await boot({ records });
    const app = await Client.connect(b.socketPath);
    await app.hello("app", b.appToken);
    const layerOf = async (pluginId: string) => {
      const { token } = (await app.request("layer.token", { pluginId })).result;
      const c = await Client.connect(b.socketPath);
      await c.hello("layer", token, { pluginId });
      return c;
    };
    const tarot = await layerOf("tarot");
    const friend = await layerOf("friend");
    // Running and OK'd: past the gate (the stand-in handler refuses on its own), and friend runs tarot's command.
    expect((await tarot.request("session.list", {})).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect((await friend.request("command.run", { name: "tarot.draw", args: { cards: 1 } })).error).toBeUndefined();
    // Each state in which its host half wouldn't run: the frame's connection is still open, and gets nothing.
    for (const [enabled, state] of [[false, "off"], [true, "stopped"], [true, "blocked"], [true, "invalid"], [true, "refused"]] as const) {
      records.tarot = { ...records.tarot!, enabled, state };
      records.friend = { ...records.friend!, enabled, state };
      expect([state, (await tarot.request("session.list", {})).error.code]).toEqual([state, CLOVER_ERR.CAPABILITY_REFUSED]);
      expect([state, (await friend.request("command.run", { name: "tarot.draw", args: { cards: 1 } })).error.data]).toEqual([state, expect.objectContaining({ code: "refused" })]);
    }
    // A change waiting for its new OK: what the registry says for its process. Held until the OK (found, nothing granted):
    // nothing. The old version still running on the old OK (an official index's update): the old grant.
    records.tarot = { enabled: true, state: "found", granted: [] };
    expect((await tarot.request("session.list", {})).error.code).toBe(CLOVER_ERR.CAPABILITY_REFUSED);
    records.tarot = { enabled: true, state: "running", granted: ["conversation.read"] };
    expect((await tarot.request("session.list", {})).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    app.close(); tarot.close(); friend.close();
  });

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

  // The peer-image check over a real socket (macOS): the server's default checks the connection's audit token against
  // the profile's Clover app, and this test's own process (bun) isn't it. A check against bun's own signature (the
  // requirement alone: bun's entitlements open it, so the hardened check refuses it too) lets the same hello in, so
  // the refusal is the check's, not a token that couldn't be read.
  const bunSigner = onDarwin ? /^TeamIdentifier=(\w+)$/m.exec(spawnSync("codesign", ["-dv", process.execPath], { encoding: "utf8" }).stderr ?? "")?.[1] : undefined;
  darwinTest("macOS: the default app check refuses a peer that isn't the signed Clover app; its own signature's requirement lets it in", async () => {
    const def = await boot({ realPeer: true, appPeer: "default" });
    const c = await Client.connect(def.socketPath);
    const r = await c.hello("app", def.appToken, { features: ["app.show", "app.quit"] });
    expect(r.error?.code).toBe(CLOVER_ERR.PROCESS_REFUSED);
    expect(def.pair.status().appConnected).toBe(false);
    c.close();
    stop?.();
    if (bunSigner === undefined || bunSigner === "not set") return; // a Bun built locally carries no team to check
    const req = `identifier "bun" and anchor apple generic and certificate leaf[subject.OU] = "${bunSigner}"`;
    const hardened = await boot({ realPeer: true, appPeer: appPeerByRequirement(req) });
    const h = await Client.connect(hardened.socketPath);
    expect((await h.hello("app", hardened.appToken, { features: ["app.show"] })).error?.code).toBe(CLOVER_ERR.PROCESS_REFUSED);
    h.close();
    stop?.();
    const own = await boot({ realPeer: true, appPeer: (peer) => auditTokenSatisfies(peer.handle?.auditToken, req, { hardened: false }) });
    const ok = await Client.connect(own.socketPath);
    const r2 = await ok.hello("app", own.appToken, { features: ["app.show", "app.quit"] });
    expect(r2.error).toBeUndefined();
    expect(r2.result).toMatchObject({ ok: true, caller: { kind: "user", client: "app" } });
    ok.close();
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

  test("app.capture: the user's CLI gets the app's own picture; a bot's session, the app's role, a layer and an app that left are refused", async () => {
    const b = await boot();
    const app = await Client.connect(b.socketPath);
    const asked: unknown[] = [];
    const shot = { windows: [{ name: "main", bounds: { x: 0, y: 0, width: 4, height: 2 }, scale: 2, visible: true, drawn: true, png: "iVBORw0KGgo=", pixels: { width: 8, height: 4 }, views: [] }] };
    app.answers["app.window.capture"] = (p) => { asked.push(p); return shot; };
    await app.hello("app", b.appToken, { features: ["app.show", "app.quit", "layers", "app.capture"] });
    const cli = await Client.connect(b.socketPath);
    await cli.hello("cli", b.legacy.harness);
    const ok = await cli.request("app.capture", { window: "main", frames: true });
    expect(ok.result).toEqual(shot);
    expect(asked).toEqual([{ window: "main", frames: true }]);
    // The app's own role may not ask it (the method is the CLI's), nor a layer.
    expect((await app.request("app.capture", { window: "main" })).error.code).toBe(CLOVER_ERR.ROLE_REFUSED);
    const { token } = (await app.request("layer.token", { pluginId: "vn-composer" })).result;
    const layer = await Client.connect(b.socketPath);
    await layer.hello("layer", token, { pluginId: "vn-composer" });
    expect((await layer.request("app.capture", { window: "main" })).error.code).toBe(CLOVER_ERR.ROLE_REFUSED);
    // A bot's session's CLI (a command run inside the session) is not the user.
    b.setPeer(fenced);
    b.processes.add(5150, { sessionId: "s-1", sessionKind: "bot", bot: "alpha" });
    const bots = await Client.connect(b.socketPath);
    expect((await bots.hello("cli", b.legacy.harness)).result.caller.kind).toBe("session");
    expect((await bots.request("app.capture", { window: "main" })).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(asked).toHaveLength(1);
    // The app's error answer comes back as one; an app that leaves while asked, as a retry.
    app.answers["app.window.capture"] = () => ({ error: { code: ERR.NOT_FOUND, message: "no window named nope" } });
    const nope = await cli.request("app.capture", { window: "nope" });
    expect(nope.error).toMatchObject({ code: ERR.NOT_FOUND, message: "no window named nope" });
    delete app.answers["app.window.capture"];
    const waiting = cli.request("app.capture", { window: "main" });
    await Bun.sleep(100);
    app.close();
    expect((await waiting).error.code).toBe(ERR.RETRY);
    expect((await cli.request("app.capture", { window: "main" })).error).toMatchObject({ code: ERR.NOT_FOUND, message: "the app isn't running on this computer" });
    cli.close(); layer.close(); bots.close();
  });

  test("app.capture: an app whose hello doesn't list app.capture is said to be older", async () => {
    const b = await boot();
    const app = await Client.connect(b.socketPath);
    await app.hello("app", b.appToken, { features: ["app.show", "app.quit", "layers"] });
    const cli = await Client.connect(b.socketPath);
    await cli.hello("cli", b.legacy.harness);
    expect((await cli.request("app.capture", { window: "main" })).error.message).toContain("older than app.capture");
    app.close(); cli.close();
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

  test("plugin-host: the token is its process's, and the peer must be the process the daemon started (both pids)", async () => {
    const b = await boot();
    const shared = b.tokens.mint({ role: "plugin-host", hostProcess: "shared" });
    const c = await Client.connect(b.socketPath);
    expect((await c.hello("plugin-host", shared, { hostProcess: "clover" })).error.code).toBe(CLOVER_ERR.PROCESS_REFUSED);
    const d = await Client.connect(b.socketPath);
    expect((await d.hello("plugin-host", shared, { hostProcess: "shared" })).result.caller.kind).toBe("plugin");
    expect(b.clover.connections().find((x) => x.role === "plugin-host")?.hostProcess).toEqual({ hostProcess: "shared" });
    b.setPeer({ ...outside, pid: null, floor: "fenced" }); // the peer's pid unknown
    const e = await Client.connect(b.socketPath);
    expect((await e.hello("plugin-host", shared, { hostProcess: "shared" })).error.code).toBe(CLOVER_ERR.PROCESS_REFUSED);
    b.setPeer(outside);
    const own = b.tokens.mint({ role: "plugin-host", hostProcess: "own", pluginId: "luna" }); // no pid recorded for it
    const f = await Client.connect(b.socketPath);
    expect((await f.hello("plugin-host", own, { hostProcess: "own", pluginId: "luna" })).error.code).toBe(CLOVER_ERR.PROCESS_REFUSED);
    c.close(); d.close(); e.close(); f.close();
  });

  test("peer: another computer is always fenced, and comes only from the link sidecar's process", async () => {
    const b = await boot();
    const t = b.tokens.mint({ role: "peer", device: "e".repeat(32) });
    const c = await Client.connect(b.socketPath);
    expect((await c.hello("peer", t, { device: "e".repeat(32) })).result.caller).toEqual({ kind: "peer", device: "e".repeat(32) });
    b.setPeer({ ...outside, pid: 6161 }); // not the sidecar
    const r = b.tokens.mint({ role: "remote", device: "f".repeat(32) });
    const d = await Client.connect(b.socketPath);
    expect((await d.hello("remote", r, { device: "f".repeat(32) })).error.code).toBe(CLOVER_ERR.PROCESS_REFUSED);
    c.close(); d.close();
  });

  test("B1: a process the daemon started is never the user or the app, by its parents or the probe's verdict", async () => {
    const b = await boot();
    b.setPeer({ ...outside, pid: 777, ancestors: [process.pid, 1] }); // the reviewer's probe: the daemon among its parents
    const c = await Client.connect(b.socketPath);
    expect((await c.hello("app", b.appToken)).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    b.setPeer({ ...outside, spawnedByDaemon: true }); // a double fork the OS still ties to the daemon
    const d = await Client.connect(b.socketPath);
    expect((await d.hello("cli", b.legacy.harness)).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    c.close(); d.close();
  });

  test("B1 for real: a child of this process that says hello as the app is refused", async () => {
    const b = await boot({ realPeer: true });
    const script = `const s = await Bun.connect({ unix: ${JSON.stringify(b.socketPath)}, socket: { data(_s, d) { console.log(new TextDecoder().decode(d).trim()); process.exit(0); } } });
      s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: ${CLOVER_PROTOCOL_VERSION}, role: "app", token: ${JSON.stringify(b.appToken)}, clientName: "child" } }) + "\\n");`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    expect(JSON.parse(out.trim().split("\n")[0]!).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
  });

  test("S3: protocol.prove before the hello, bound to this connection's pid", async () => {
    const b = await boot();
    const c = await Client.connect(b.socketPath);
    const nonce = "n".repeat(32);
    const r = (await c.request("protocol.prove", { nonce })).result;
    expect(r.pid).toBe(4242);
    expect(checkDaemonProof(b.appToken, nonce, r.proof, 4242)).toBe(true);
    expect(checkDaemonProof(b.appToken, nonce, r.proof, process.pid)).toBe(false);
    expect((await c.request("protocol.prove", { nonce: "short" })).error.code).toBe(ERR.INVALID_PARAMS);
    expect((await c.hello("app", b.appToken)).result.ok).toBe(true); // then the hello, on the same connection
    expect((await c.request("protocol.prove", { nonce })).error).toBeDefined(); // only before it
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

  test("M-M2: an update's exit only once the update gate is closed and idle; a refused one leaves the pair as it was", async () => {
    let allowed = false;
    const b = await boot({ acceptUpdateExit: () => allowed });
    const app = await Client.connect(b.socketPath);
    await app.hello("app", b.appToken);
    const refused = await app.request("pair.exiting", { reason: "update" });
    expect(refused.error).toMatchObject({ code: ERR.RETRY, data: { code: "update_not_ready" } });
    expect(b.pair.status().stopping).toBeNull();
    allowed = true;
    expect((await app.request("pair.exiting", { reason: "update" })).result).toEqual({ ok: true });
    expect(b.pair.status().stopping).toBe("update");
    app.close();
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

  test("the heartbeat ends the app through its connection's handle, never a pid alone (review S5)", async () => {
    const b = await boot({ heartbeat: { intervalMs: 20, timeoutMs: 100 }, realPeer: true });
    const hung = await Client.connect(b.socketPath);
    hung.answerPings = false;
    await hung.hello("app", b.appToken);
    for (let i = 0; i < 100 && b.killed.length === 0; i++) await Bun.sleep(10);
    expect(b.killed).toEqual([process.pid]); // this test is the app's process here, so the kill is a spy
    const handle = b.killedVia[0];
    expect(handle?.pid).toBe(process.pid);
    if (process.platform === "darwin") expect(handle?.via).toBe("token");
    if (process.platform === "linux") expect(["pidfd", "pid"]).toContain(handle!.via);
    expect(handle?.alive()).toBe(true);
    hung.close();
    for (let i = 0; i < 100 && b.pair.status().appConnected; i++) await Bun.sleep(5);
    if (handle?.via === "pidfd") expect(handle.alive()).toBe(false); // closed with its connection
  });

  test("bridge (K): K's tokens check it with the peer's pid; its four methods only, bound to its session; one live connection", async () => {
    const gate = new FakeBridgeTokens("t".repeat(43), "s-agent", (pid) => pid === 4242);
    const b = await boot({ bridge: gate });
    const c = await Client.connect(b.socketPath);
    const r = await c.hello("bridge", gate.token, { agentSessionId: "s-agent" });
    expect(r.result.caller).toEqual({ kind: "session", sessionId: "s-agent", sessionKind: "agent", bot: "alpha" });
    expect(gate.seen).toEqual([4242]);
    expect(b.clover.connections().find((x) => x.role === "bridge")?.bridgeConnection).toBe(1); // K's accept's number
    expect((await c.request("bridge.tools", {})).result).toEqual({ tools: [], instructions: "hi" });
    expect((await c.request("bridge.sendMessage", { text: "done" })).result).toEqual({ ok: true });
    expect((await c.request("glossary.query", { query: "x" })).result).toEqual({ results: [], loaded: [] });
    expect(b.calls.map((x) => [x.method, x.sessionId])).toEqual([["bridge.tools", "s-agent"], ["bridge.sendMessage", "s-agent"], ["glossary.query", "s-agent"]]);
    expect((await c.request("pair.status", {})).error.code).toBe(CLOVER_ERR.ROLE_REFUSED);

    const second = await Client.connect(b.socketPath);
    expect((await second.hello("bridge", gate.token, { agentSessionId: "s-agent" })).error.code).toBe(CLOVER_ERR.ROLE_REFUSED); // in use
    for (let i = 0; i < 100 && !second.closed; i++) await Bun.sleep(5);
    expect(second.closed).toBe(true); // a refused bridge is answered and closed

    c.close();
    for (let i = 0; i < 100 && gate.released.length === 0; i++) await Bun.sleep(5);
    expect(gate.released).toEqual([1]);
    const again = await Client.connect(b.socketPath);
    expect((await again.hello("bridge", gate.token, { agentSessionId: "s-agent" })).result.ok).toBe(true);
    again.close();
  });

  test("bridge (K): a wrong token, another session, a process outside the agent, and a revoked token", async () => {
    const gate = new FakeBridgeTokens("t".repeat(43), "s-agent", (pid) => pid === 4242);
    const b = await boot({ bridge: gate });
    const bad = await Client.connect(b.socketPath);
    expect((await bad.hello("bridge", "x".repeat(43), { agentSessionId: "s-agent" })).error.code).toBe(ERR.UNAUTHORIZED);
    const other = await Client.connect(b.socketPath);
    expect((await other.hello("bridge", gate.token, { agentSessionId: "s-other" })).error.code).toBe(ERR.UNAUTHORIZED);
    b.setPeer(fenced);
    const stranger = await Client.connect(b.socketPath);
    const refused = await stranger.hello("bridge", gate.token, { agentSessionId: "s-agent" });
    expect(refused.error.code).toBe(CLOVER_ERR.PROCESS_REFUSED);
    expect(JSON.stringify(refused)).not.toContain(gate.token); // the token never shows
    b.setPeer(outside);
    const live = await Client.connect(b.socketPath);
    expect((await live.hello("bridge", gate.token, { agentSessionId: "s-agent" })).result.ok).toBe(true);
    gate.revoke();
    for (let i = 0; i < 100 && !live.closed; i++) await Bun.sleep(5);
    expect(live.closed).toBe(true);
    bad.close(); other.close(); stranger.close();
  });

  test("bridge (K): a bridge that goes while its check waits gives its connection back", async () => {
    const gate = new FakeBridgeTokens("t".repeat(43), "s-agent", () => true, 150);
    const b = await boot({ bridge: gate });
    const c = await Client.connect(b.socketPath);
    void c.hello("bridge", gate.token, { agentSessionId: "s-agent" });
    await Bun.sleep(30);
    c.close();
    for (let i = 0; i < 100 && gate.released.length === 0; i++) await Bun.sleep(10);
    expect(gate.released).toEqual([1]);
    expect(b.calls).toEqual([]);
  });

  test("bridge (K): the gate gets the kernel's pid for the caller (LOCAL_PEERPID, SO_PEERCRED, the pipe's client pid)", async () => {
    const gate = new FakeBridgeTokens("t".repeat(43), "s-agent", (pid) => pid === process.pid);
    const b = await boot({ bridge: gate, realPeer: true });
    const c = await Client.connect(b.socketPath);
    expect((await c.hello("bridge", gate.token, { agentSessionId: "s-agent" })).result.ok).toBe(true);
    expect(gate.seen).toEqual([process.pid]); // this test process is the client
    c.close();
  });

  test("lane handlers in D's shape: the caller, a session's events as `event`, MethodError's code and data, follows ended at close", async () => {
    const b = await boot();
    const c = await Client.connect(b.socketPath);
    await c.hello("cli", b.legacy.harness);
    expect((await c.request("session.attach", { id: "s-1" })).result).toEqual({ lastSeq: 3 });
    expect(b.calls).toEqual([{ method: "session.attach", sessionId: "s-1", params: { kind: "user", client: "cli" } }]);
    for (let i = 0; i < 100 && c.fromDaemon.length === 0; i++) await Bun.sleep(5);
    expect(c.fromDaemon[0]).toEqual({ jsonrpc: "2.0", method: "event", params: { type: "text_delta", seq: 3, sessionId: "s-1", ts: 1, delta: "hi" } });
    const refused = await c.request("session.list", {});
    expect(refused.error).toEqual({ code: CLOVER_ERR.NOT_THE_USER, message: "only the user can list", data: { why: "test" } });
    expect((await c.request("session.attach", { id: 7 })).error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
    for (let i = 0; i < 100 && b.unfollowed.length === 0; i++) await Bun.sleep(5);
    expect(b.unfollowed).toEqual(["s-1"]);
  });

  test("dispatch, for H's peer.call door: the role's list, the peer as the caller, userOnly only with the door's checked answer", async () => {
    const b = await boot();
    const peer = { kind: "peer" as const, device: "e".repeat(32) };
    expect(await b.clover.dispatch("session.attach", { id: "s-2" }, { caller: peer, role: "remote" })).toEqual({ lastSeq: 3 });
    expect(b.calls.at(-1)).toEqual({ method: "session.attach", sessionId: "s-2", params: peer }); // runs as the peer
    expect(b.unfollowed).toEqual(["s-2"]); // nothing to stream to: let go at once
    await expect(b.clover.dispatch("pair.quit", { handOver: false }, { caller: peer, role: "remote" })).rejects.toMatchObject({ code: CLOVER_ERR.ROLE_REFUSED });
    await expect(b.clover.dispatch("session.interrupt", { id: "s-2" }, { caller: peer, role: "remote" })).rejects.toMatchObject({ code: CLOVER_ERR.NOT_THE_USER });
    const other = { cardId: "card-0", callHash: canonicalCallHash("session.interrupt", { id: "s-3" }) }; // an answer for another call
    await expect(b.clover.dispatch("session.interrupt", { id: "s-2" }, { caller: peer, role: "remote", answer: other })).rejects.toMatchObject({ code: CLOVER_ERR.NOT_THE_USER });
    const answer = { cardId: "card-1", callHash: canonicalCallHash("session.interrupt", { id: "s-2" }) };
    expect(await b.clover.dispatch("session.interrupt", { id: "s-2" }, { caller: peer, role: "remote", answer })).toEqual({ ok: true });
    await expect(b.clover.dispatch("session.interrupt", { id: "s-2" }, { caller: peer, role: "remote", answer })).rejects.toMatchObject({ code: CLOVER_ERR.NOT_THE_USER }); // once
    expect(b.calls.at(-1)).toEqual({ method: "session.interrupt", sessionId: "s-2", params: peer }); // still the peer, not the user
    expect(b.stops).toEqual([]);
  });
});
