// Clover's connections on the daemon's endpoint (spec §3.1; B's roles.ts and clover.ts). The inherited
// protocol (v0: harness, admin, remote, plugin) stays beside it until C1 retires it method by method;
// a hello naming protocol version 1 or later is Clover's and comes here: its role and token
// (auth/clover-tokens.ts), the caller check on the peer process (platform/caller-probe.ts,
// auth/clover-caller.ts), then each request through the role's allow list and `userOnly`. The pair's
// methods (`pair.status`, `pair.quit`, `pair.exiting`) and `layer.token` are lane C's and served here;
// other lanes add theirs through `handlers`. A method on a role's list that no lane serves yet answers
// METHOD_NOT_FOUND.
//
// The `bridge` role (§9.3, lane K) is checked by K's bridge tokens when the daemon gives them (`bridge`):
// the token, the agent session it names, and the kernel's pid for the caller (`LOCAL_PEERPID`,
// `SO_PEERCRED`, or the pipe's client pid on Windows), with one live connection per token. A revoked
// token's connection is closed. `bridgeMethodHandlers` mounts K's handlers for the role's four methods.
// `laneMethodHandlers` mounts handlers written in D's shape (`bots/rpc.ts`; D's sessions, H's devices,
// the usage counter): each runs as the connection's caller, with its event stream.
import {
  CLOVER_ERR, CLOVER_METHODS, CLOVER_PROTOCOL_MIN_VERSION, CLOVER_ROLES, CLOVER_PROTOCOL_VERSION, CloverHelloParams, ERR,
  PairStatus, encodeLine, helloVersionServed, type Caller, type CloverHelloResult, type CloverRole, type SessionKind,
} from "@waifucave/clover-protocol";
import { createHash } from "node:crypto";
import { ERR_UNAUTHORIZED, isRefusal, type CloverTokens } from "../auth/clover-tokens";
import { proveDaemon } from "../platform/pair/run-files";
import { gateCloverRequest, resolveCloverCaller, type SessionProcesses } from "../auth/clover-caller";
import { probePeer, WindowsPipePeers, type PeerFacts } from "../platform/caller-probe";
import type { DaemonPair, PairStopReason } from "../platform/pair/policy";
import type { DaemonPlatform } from "../platform/transport";

/** A thrown JSON-RPC error; the server's pump reads `code`, `message` and `data` off it. */
export class CloverRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) { super(message); }
}

/** One Clover connection, after its hello. */
export interface CloverConn {
  readonly connId: number;
  readonly role: CloverRole;
  readonly caller: Caller;
  readonly features: readonly string[];
  readonly clientName: string;
  /** A plugin-host connection's verified process (review S1): handlers take the call's process from here, never
   *  from a plugin id a plugin could share. */
  readonly hostProcess?: { readonly hostProcess: "clover" | "shared" | "own"; readonly pluginId?: string };
  /** Areas this connection subscribed to (`events.subscribe`). */
  readonly areas: Set<string>;
  /** Send the client a request from the daemon (`app.quit`, `app.show`, `pluginHost.invoke`…); its id. */
  send(method: string, params: unknown): string;
  /** Send the client a notification (`event` for a session's events, `core.event`). */
  notify(method: string, params: unknown): void;
  /** The sessions this connection follows live (`session.attach`), each with its unsubscribe; ended at close. */
  readonly follows: Map<string, () => void>;
}

export type CloverHandler = (conn: CloverConn, params: unknown) => Promise<unknown> | unknown;

/** A handler in the shape lanes D, H and the usage counter write theirs (`bots/rpc.ts`'s `MethodHandler`): the
 *  params and who calls, with the connection's event stream for a method that follows a session. */
export type LaneMethodHandler = (params: unknown, ctx: {
  caller: Caller;
  stream?: { send(event: { type: string; seq: number; sessionId: string; ts: number; [key: string]: unknown }): void; follows: Map<string, () => void> };
}) => Promise<unknown>;

/** Mounts lane handlers on Clover connections: each runs as the connection's caller, and a session's events go
 *  to it as the inherited `event` notification. Their errors (`MethodError`: code, message, data) pass as they are. */
export function laneMethodHandlers(handlers: Readonly<Record<string, LaneMethodHandler>>): Record<string, CloverHandler> {
  return Object.fromEntries(Object.entries(handlers).map(([name, h]) => [name, (conn: CloverConn, params: unknown) =>
    h(params, { caller: conn.caller, stream: { send: (event) => conn.notify("event", event), follows: conn.follows } })]));
}

/** What K's bridge tokens answer (`agents/bridge/tokens.ts`, `BridgeAcceptance`). */
export type BridgeVerdict = { ok: true; sessionId: string; connection: number } | { ok: false; reason: string };

/** The bridge's token check, as K's `BridgeTokens` gives it: the token, the session the hello names and the
 *  kernel's pid for the caller (null where it can't be read, which the gate refuses); one live connection per
 *  token, given back with `release`; `onRevoke` when a token is revoked, so its connection is closed. */
export interface BridgeGate {
  accept(token: string, sessionId: string, peerPid: number | null): Promise<BridgeVerdict>;
  release(sessionId: string, connection: number): void;
  onRevoke?(fn: (e: { sessionId: string; connection?: number }) => void): () => void;
}

/** K's handlers for the bridge's methods, by session (`agents/bridge/endpoint.ts`, `BridgeHandlers`). */
export interface BridgeMethods {
  tools(sessionId: string): Promise<{ tools: unknown[]; instructions: string }>;
  call(sessionId: string, call: { callId: string; tool: string; input: unknown }): Promise<{ content: unknown[]; isError: boolean }>;
  sendMessage(sessionId: string, m: { text: string; to?: string }): Promise<void>;
  glossary(sessionId: string, q: { query?: string | string[]; load?: string | string[] }): Promise<{ results: unknown[]; loaded: unknown[] }>;
}

/** The bridge role's four methods as Clover handlers, each bound to the connection's own agent session. */
export function bridgeMethodHandlers(h: BridgeMethods): Record<string, CloverHandler> {
  const session = (conn: CloverConn): string => {
    if (conn.caller.kind !== "session") throw new CloverRpcError(CLOVER_ERR.ROLE_REFUSED, "not a bridge connection");
    return conn.caller.sessionId;
  };
  return {
    "bridge.tools": async (conn) => { const r = await h.tools(session(conn)); return { tools: r.tools, instructions: r.instructions }; },
    "bridge.call": (conn, p) => h.call(session(conn), p as { callId: string; tool: string; input: unknown }),
    "bridge.sendMessage": async (conn, p) => {
      const m = p as { text: string; to?: string };
      await h.sendMessage(session(conn), { text: m.text, ...(m.to === undefined ? {} : { to: m.to }) });
      return { ok: true };
    },
    "glossary.query": (conn, p) => {
      const q = p as { query?: string | string[]; load?: string | string[] };
      return h.glossary(session(conn), { ...(q.query === undefined ? {} : { query: q.query }), ...(q.load === undefined ? {} : { load: q.load }) });
    },
  };
}

export interface CloverServerDeps {
  readonly tokens: CloverTokens;
  readonly processes: SessionProcesses;
  readonly serverVersion: string;
  /** This computer's device id (lane H's device key; a stand-in until H-M1). */
  readonly deviceId: string;
  /** The daemon's side of the pair; absent on a daemon with none (tests, a server without a pair). */
  readonly pair?: DaemonPair;
  /** What else `pair.status` reports (bots, routines, agents, hand-over, an update), from their lanes. */
  pairStatusExtras?(): Omit<PairStatus, "safeMode">;
  /** Release the lease so another computer takes the bots (`pair.quit{handOver}`; lanes F and H). */
  handOver?(): Promise<void>;
  /** The pid the daemon started a plugin-host process with. */
  hostPidOf?(hostProcess: "clover" | "shared" | "own", pluginId?: string): number | undefined;
  /** The link sidecar's pid (lane H): the only local process that says hello as `remote`, `web` or `peer`. */
  linkPid?(): number | undefined;
  /** This run's app token, for `protocol.prove` (the app's check of the daemon before its hello). */
  readonly appToken?: string;
  /** Other lanes' Clover methods, by wire name. */
  readonly handlers?: Readonly<Record<string, CloverHandler>>;
  /** M-M2: whether the app may leave for an update now (`pair.exiting{update}`): the update gate closed and idle, and
   *  then committed to the restart. */
  acceptUpdateExit?(): boolean;
  readonly features?: readonly string[];
  readonly os?: DaemonPlatform;
  /** The endpoint this server answers on (Windows: only that pipe's ends are matched to connections, review S4). */
  readonly endpoint?: string;
  /** Test seam: the peer of a socket. */
  probe?(socket: object): PeerFacts;
  /** K's bridge tokens, and the session's bot for the hello's caller. Without it a `bridge` hello is checked
   *  against tokens minted here (`CloverTokens`), with no pid check. */
  readonly bridge?: { readonly gate: BridgeGate; sessionInfo?(sessionId: string): { bot?: string } | undefined };
  /** The app's heartbeat (ruling R9): `app.ping` every `intervalMs`, ended after `timeoutMs` unanswered. */
  readonly heartbeat?: { readonly intervalMs?: number; readonly timeoutMs?: number; now?(): number };
  /** End a hung app's process (default SIGKILL; TerminateProcess on Windows). */
  killApp?(pid: number): void;
  log?(line: string): void;
}

function currentOs(): DaemonPlatform {
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
}

/** The hash a signed answer binds a call with (review S7): SHA-256 over the method and its params in a canonical
 *  JSON (object keys sorted, no spaces), hex. C-M3's sealed cards adopt it. */
export function canonicalCallHash(method: string, params: unknown): string {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
    : v;
  return createHash("sha256").update(JSON.stringify(canon({ method, params: params ?? null }))).digest("hex");
}

export interface CloverServer {
  /** The listener's `open`: on Windows, finds the connection's peer among the daemon's handles. True when the
   *  connection was made before the pipe's DACL was locked down, so the listener closes it (review M3). */
  opened(socket: object): boolean;
  /** Right after the listener locked the pipe's DACL down (Windows). */
  lockedDown(): void;
  /** `protocol.prove {nonce}` before the hello (review S3): an HMAC under this run's app token over the app's
   *  nonce and the pid the daemon sees on this very connection, so a proof relayed from another connection fails. */
  prove(socket: object, params: unknown): { proof: string; pid: number };
  /** Whether a `protocol.hello`'s params are Clover's (protocol version 1 or later). */
  isCloverHello(params: unknown): boolean;
  /** `end` closes the connection (a revoked bridge token's, a refused bridge). */
  hello(socket: object, connId: number, params: unknown, write: (bytes: Uint8Array) => void, end?: () => void): Promise<{ conn: CloverConn; result: CloverHelloResult }>;
  handle(conn: CloverConn, method: string, params: unknown): Promise<unknown>;
  closed(conn: CloverConn | null, socket: object): void;
  /** A response from the client to one of the daemon's requests (the heartbeat's). */
  response(conn: CloverConn, msg: { id?: unknown }): void;
  /** `app.quit{reason}` to these app connections (the pair's `tellAppQuit`). */
  tellAppQuit(reason: PairStopReason, connIds: readonly string[]): void;
  connections(): readonly CloverConn[];
  /** Runs a method for a caller with no connection here: another computer's `peer.call` (lane H's door), under
   *  `role`'s allow list. `answer`: the user's signed answer the door verified, by its card id and the call hash it
   *  binds (`canonicalCallHash`). It stands in for the user on a `userOnly` method only for this method and these
   *  params, and once (review S7). */
  dispatch(method: string, params: unknown, as: { caller: Caller; role: CloverRole; answer?: { cardId: string; callHash: string } }): Promise<unknown>;
  dispose(): void;
}

export function createCloverServer(deps: CloverServerDeps): CloverServer {
  const os = deps.os ?? currentOs();
  const pipePeers = os === "win32" ? new WindowsPipePeers(deps.endpoint) : null;
  const spentAnswers = new Set<string>();
  const conns = new Map<number, CloverConn>();
  let requestSeq = 0;
  const beatEvery = deps.heartbeat?.intervalMs ?? 5_000;
  const beatTimeout = deps.heartbeat?.timeoutMs ?? 15_000;
  const now = deps.heartbeat?.now ?? Date.now;
  const beats = new Map<number, { timer: ReturnType<typeof setInterval>; heard: number; pid: number | null; pending: Set<string> }>();
  const killApp = deps.killApp ?? ((pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  const stopBeat = (connId: number) => { const b = beats.get(connId); if (b) { clearInterval(b.timer); beats.delete(connId); } };
  const startBeat = (conn: CloverConn, pid: number | null) => {
    const beat = { heard: now(), pid, pending: new Set<string>(), timer: setInterval(() => {
      if (now() - beat.heard > beatTimeout) {
        stopBeat(conn.connId);
        deps.log?.(`[clover] the app (connection ${conn.connId}) didn't answer app.ping for ${beatTimeout} ms`);
        // With no pid it can't be ended, and a new one beside it would be a second app (review M6): its
        // connection closing counts as the crash instead.
        if (beat.pid === null) { deps.log?.("[clover] its process is unknown: waiting for its connection to close"); return; }
        deps.pair?.appHung(String(conn.connId));
        killApp(beat.pid);
        return;
      }
      beat.pending.add(conn.send("app.ping", {}));
    }, beatEvery) };
    (beat.timer as { unref?: () => void }).unref?.();
    beats.set(conn.connId, beat);
  };

  const peerOf = (socket: object): PeerFacts => {
    if (deps.probe) return deps.probe(socket);
    if (pipePeers) return probePeer(null, "win32", pipePeers.pidOf(socket));
    return probePeer(socket, os);
  };

  // Sockets the listener has closed: a hello still waiting on a check (the bridge's waits for its agent's
  // pid) finds its connection gone and gives back what it took.
  const gone = new WeakSet<object>();
  const bridged = new Map<number, { sessionId: string; connection: number; end?: () => void }>();
  const unrevoke = deps.bridge?.gate.onRevoke?.(({ sessionId, connection }) => {
    for (const [connId, b] of bridged) {
      if (b.sessionId !== sessionId || (connection !== undefined && b.connection !== connection)) continue;
      bridged.delete(connId);
      conns.delete(connId);
      deps.log?.(`[clover] bridge connection ${connId}: its token was revoked`);
      try { b.end?.(); } catch { /* already gone */ }
    }
  });

  // The bridge's hello through K's tokens: refused hellos are answered and the connection closed.
  const bridgeHello = async (socket: object, h: CloverHelloParams, peer: PeerFacts, end?: () => void) => {
    const gate = deps.bridge!.gate;
    const refuse = (code: number, why: string): never => {
      deps.log?.(`[clover] refused a bridge hello for session ${h.agentSessionId ?? "?"}: ${why}`);
      if (end) setTimeout(() => { try { end(); } catch { /* gone */ } }, 0);
      throw new CloverRpcError(code, `the bridge was refused: ${why}`);
    };
    if (!h.agentSessionId) refuse(CLOVER_ERR.ROLE_REFUSED, "no agent session named");
    const v = await gate.accept(h.token, h.agentSessionId!, peer.pid);
    if (!v.ok) {
      const code = v.reason === "unknown-token" || v.reason === "wrong-session" || v.reason === "revoked" ? ERR_UNAUTHORIZED
        : v.reason === "unverified-caller" || v.reason === "not-the-agent" ? CLOVER_ERR.PROCESS_REFUSED : CLOVER_ERR.ROLE_REFUSED;
      refuse(code, v.reason);
    }
    const ok = v as Extract<BridgeVerdict, { ok: true }>;
    if (gone.has(socket)) {
      gate.release(ok.sessionId, ok.connection);
      throw new CloverRpcError(CLOVER_ERR.ROLE_REFUSED, "closed");
    }
    const bot = deps.bridge!.sessionInfo?.(ok.sessionId)?.bot;
    const sessionKind: SessionKind = bot === undefined ? "coding" : "agent";
    const caller: Caller = { kind: "session", sessionId: ok.sessionId, sessionKind, ...(bot === undefined ? {} : { bot }) };
    return { caller, sessionId: ok.sessionId, connection: ok.connection };
  };

  // One request through the role's allow list, `userOnly` (unless the user's signed answer for this call stands
  // in), the method's params, then its handler.
  const run = async (conn: CloverConn, method: string, params: unknown, answered: boolean): Promise<unknown> => {
    const spec = CLOVER_METHODS.get(method);
    if (spec === undefined) throw new CloverRpcError(ERR.METHOD_NOT_FOUND, `no such method ${method}`);
    const refused = gateCloverRequest(conn.role, answered ? { kind: "user", client: "app" } : conn.caller, method);
    if (refused) throw new CloverRpcError(refused.code, refused.message);
    const p = spec.params.safeParse(params ?? {});
    if (!p.success) throw new CloverRpcError(ERR.INVALID_PARAMS, `invalid params for ${method}`);
    const handler = own[method] ?? deps.handlers?.[method];
    if (handler === undefined) throw new CloverRpcError(ERR.METHOD_NOT_FOUND, `${method} is not served yet`);
    return handler(conn, p.data);
  };

  const pairStatus = (): PairStatus => {
    const extras = deps.pairStatusExtras?.() ?? { bots: [], routines: 0, agents: 0, canHandOver: false };
    return PairStatus.parse({ ...extras, safeMode: deps.pair?.status().safeMode ?? false });
  };

  const own: Record<string, CloverHandler> = {
    "events.subscribe": (conn, p) => { for (const a of (p as { areas: string[] }).areas) conn.areas.add(a); return { ok: true }; },
    "events.unsubscribe": (conn, p) => { for (const a of (p as { areas: string[] }).areas) conn.areas.delete(a); return { ok: true }; },
    "pair.status": () => pairStatus(),
    "pair.quit": async (conn, p) => {
      if ((p as { handOver: boolean }).handOver) await deps.handOver?.();
      // The app that asked leaves with the answer: no `app.quit` back to it (E-M1).
      deps.pair?.quit("quit", conn.role === "app" ? String(conn.connId) : undefined);
      return { ok: true };
    },
    "pair.exiting": (conn, p) => {
      const reason = (p as { reason: "quit" | "update" | "restart" }).reason;
      // M-M2: an update's exit only once `update.apply` closed the gate and nothing runs; the app then keeps running.
      if (reason === "update" && deps.acceptUpdateExit?.() === false) {
        throw new CloverRpcError(ERR.RETRY, "not idle for the update: ask update.apply again", { code: "update_not_ready" });
      }
      deps.pair?.appExiting(String(conn.connId), reason);
      return { ok: true };
    },
    // A token for one plugin's UI layer, which the app's main process opens a `layer` connection with.
    // The plugin registry (lane B) will check the plugin is installed and has a layer before minting.
    "layer.token": (_conn, p) => ({ token: deps.tokens.mint({ role: "layer", pluginId: (p as { pluginId: string }).pluginId }) }),
  };

  return {
    opened(socket) { pipePeers?.opened(socket); return pipePeers?.isEarly(socket) ?? false; },

    lockedDown() { pipePeers?.lockedDown(); },

    prove(socket, params) {
      const nonce = (params as { nonce?: unknown } | null)?.nonce;
      if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) throw new CloverRpcError(ERR.INVALID_PARAMS, "protocol.prove takes a base64url nonce of 16 to 96 bytes");
      if (deps.appToken === undefined) throw new CloverRpcError(ERR.METHOD_NOT_FOUND, "this daemon has no app token");
      const pid = peerOf(socket).pid;
      if (pid === null) throw new CloverRpcError(CLOVER_ERR.PROCESS_REFUSED, "this connection's process is unknown");
      return { proof: proveDaemon(deps.appToken, nonce, pid), pid };
    },

    // Clover's when it names version 1 or later and one of Clover's roles: an inherited role
    // (harness, admin, plugin) at any other version keeps the inherited path and its VERSION_MISMATCH.
    isCloverHello(params) {
      const p = params as { protocolVersion?: unknown; role?: unknown } | null;
      return typeof p?.protocolVersion === "number" && p.protocolVersion >= CLOVER_PROTOCOL_MIN_VERSION
        && typeof p.role === "string" && (CLOVER_ROLES as readonly string[]).includes(p.role);
    },

    async hello(socket, connId, params, write, end) {
      const parsed = CloverHelloParams.safeParse(params);
      if (!parsed.success) throw new CloverRpcError(ERR.INVALID_PARAMS, "invalid hello");
      const h = parsed.data;
      if (!helloVersionServed(h.protocolVersion)) {
        throw new CloverRpcError(CLOVER_ERR.VERSION_REFUSED, "protocol version not served", { min: CLOVER_PROTOCOL_MIN_VERSION, max: CLOVER_PROTOCOL_VERSION });
      }
      let caller: Caller;
      let peer: PeerFacts;
      let bridge: { sessionId: string; connection: number } | undefined;
      let hostProcess: CloverConn["hostProcess"];
      if (h.role === "bridge" && deps.bridge) {
        peer = peerOf(socket);
        const b = await bridgeHello(socket, h, peer, end);
        caller = b.caller;
        bridge = { sessionId: b.sessionId, connection: b.connection };
      } else {
        const binding = await deps.tokens.verify(h);
        if (isRefusal(binding)) throw new CloverRpcError(binding.code, binding.message);
        peer = peerOf(socket);
        const hostPid = binding.role === "plugin-host" ? deps.hostPidOf?.(binding.hostProcess, binding.pluginId) : undefined;
        const linkPid = deps.linkPid?.();
        const resolved = resolveCloverCaller({ binding, peer, processes: deps.processes, ...(hostPid !== undefined ? { hostPid } : {}), ...(linkPid !== undefined ? { linkPid } : {}) });
        if ("code" in resolved) throw new CloverRpcError(resolved.code, resolved.message);
        caller = resolved;
        if (binding.role === "plugin-host") hostProcess = { hostProcess: binding.hostProcess, ...(binding.pluginId ? { pluginId: binding.pluginId } : {}) };
        if (gone.has(socket)) throw new CloverRpcError(CLOVER_ERR.ROLE_REFUSED, "closed");
      }
      if (bridge) bridged.set(connId, { ...bridge, ...(end ? { end } : {}) });
      const conn: CloverConn = {
        connId, role: h.role, caller, features: h.features ?? [], clientName: h.clientName, areas: new Set(), ...(hostProcess ? { hostProcess } : {}),
        send(method, p) { const id = `d${++requestSeq}`; write(encodeLine({ jsonrpc: "2.0", id, method, params: p })); return id; },
        notify(method, p) { write(encodeLine({ jsonrpc: "2.0", method, params: p })); },
        follows: new Map(),
      };
      conns.set(connId, conn);
      if (h.role === "app") { deps.pair?.appConnected(String(connId), conn.features); startBeat(conn, peer.pid); }
      deps.log?.(`[clover] ${h.role} connection ${connId} (${h.clientName}) counts as ${caller.kind}`);
      return {
        conn,
        result: { ok: true, serverVersion: deps.serverVersion, protocolVersion: CLOVER_PROTOCOL_VERSION, caller, device: deps.deviceId, features: [...(deps.features ?? [])] },
      };
    },

    async handle(conn, method, params) {
      if (method === "protocol.hello") throw new CloverRpcError(ERR.INVALID_REQUEST, "already authenticated — open a new connection to change role");
      return run(conn, method, params, false);
    },

    async dispatch(method, params, as) {
      if (method === "protocol.hello") throw new CloverRpcError(ERR.INVALID_REQUEST, "a hello is a connection's");
      let answered = false;
      if (as.answer) {
        if (as.answer.callHash !== canonicalCallHash(method, params)) throw new CloverRpcError(CLOVER_ERR.NOT_THE_USER, "the answer is for another call");
        if (spentAnswers.has(as.answer.cardId)) throw new CloverRpcError(CLOVER_ERR.NOT_THE_USER, "the answer was already used");
        spentAnswers.add(as.answer.cardId);
        answered = true;
      }
      const conn: CloverConn = {
        connId: -1, role: as.role, caller: as.caller, features: [], clientName: "peer.call", areas: new Set(),
        send() { throw new CloverRpcError(ERR.INVALID_REQUEST, "a peer.call has no connection to send on"); },
        notify() { /* nowhere to send it */ },
        follows: new Map(),
      };
      try { return await run(conn, method, params, answered); }
      finally { for (const stop of conn.follows.values()) { try { stop(); } catch { /* gone */ } } }
    },

    closed(conn, socket) {
      gone.add(socket);
      pipePeers?.closed(socket);
      if (conn === null) return;
      stopBeat(conn.connId);
      conns.delete(conn.connId);
      for (const stop of conn.follows.values()) { try { stop(); } catch { /* the session is gone */ } }
      conn.follows.clear();
      const b = bridged.get(conn.connId);
      if (b) { bridged.delete(conn.connId); deps.bridge?.gate.release(b.sessionId, b.connection); }
      if (conn.role === "app") deps.pair?.appDisconnected(String(conn.connId));
    },

    // Any answer to a ping, a result or an error, shows the app's main process is responsive.
    response(conn, msg) {
      const b = beats.get(conn.connId);
      if (b && typeof msg.id === "string" && b.pending.delete(msg.id)) b.heard = now();
    },

    tellAppQuit(reason, connIds) {
      for (const id of connIds) conns.get(Number(id))?.send("app.quit", { reason });
    },

    connections() { return [...conns.values()]; },

    dispose() {
      unrevoke?.();
      for (const connId of [...beats.keys()]) stopBeat(connId);
    },
  };
}
