// MOSS's connections on the daemon's endpoint (spec §3.1; B's roles.ts and moss.ts). The inherited
// protocol (v0: harness, admin, remote, plugin) stays beside it until C1 retires it method by method;
// a hello naming protocol version 1 or later is MOSS's and comes here: its role and token
// (auth/moss-tokens.ts), the caller check on the peer process (platform/caller-probe.ts,
// auth/moss-caller.ts), then each request through the role's allow list and `userOnly`. The pair's
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
  MOSS_ERR, MOSS_METHODS, MOSS_PROTOCOL_MIN_VERSION, MOSS_ROLES, MOSS_PROTOCOL_VERSION, MossHelloParams, CODE_AGENT_LINE_NOTIFICATION, CODE_AGENT_MAX_LINE, ERR,
  PairStatus, encodeLine, helloVersionServed, type Caller, type MossHelloResult, type MossRole, type SessionKind,
  CardPlacement, PresenceReport, type Program, type Surface, PLUGIN_ROLES, WINDOW_PROGRAMS, dataKindOfSession, kindCapability, type DataKind, type Card,
} from "@waifucave/moss-protocol";
import type { ReleaseHome } from "../contracts/release-home";
import { doorMessage, inertAdmission, judgeHello, refusalMessage, type HelloVerdict } from "../update/release-door";
import { createHash } from "node:crypto";
import { ERR_UNAUTHORIZED, isRefusal, type MossTokens } from "../auth/moss-tokens";
import { proveDaemon } from "../platform/pair/run-files";
import { capabilityRefusal, gateMossRequest, resolveMossCaller, type SessionProcesses } from "../auth/moss-caller";
import { probePeer, socketFd, WindowsPipePeers, type PeerFacts } from "../platform/caller-probe";
import { peerHandle, type PeerHandle } from "../platform/peer-handle";
import { defaultAppPeerCheck, type AppPeerPolicy } from "../platform/peer-signature";
import { SystemClock } from "../clock/system-clock";
import type { Clock } from "../contracts/clock";
import { EngineCardRouter } from "../surfaces/card-router";
import { EngineSurfaceDoor } from "../surfaces/door";
import { resolveMossProfile } from "../profile";
import type { DaemonPair, PairStopReason } from "../platform/pair/policy";
import type { DaemonPlatform } from "../platform/transport";
import { sendCoreEvent, type CoreEventInput, type CoreEventOptions } from "./core-events";

/** A thrown JSON-RPC error; the server's pump reads `code`, `message` and `data` off it. */
/** Whether a connection is one of our programs' windows: role `app`, program MOSS or MOSS Code (never the host). */
export function isWindowConn(conn: Pick<MossConn, "role" | "program">): boolean {
  return conn.role === "app" && conn.program !== undefined && (WINDOW_PROGRAMS as readonly string[]).includes(conn.program);
}

export class MossRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) { super(message); }
}

/** One MOSS connection, after its hello. */
export interface MossConn {
  readonly connId: number;
  readonly role: MossRole;
  readonly caller: Caller;
  readonly features: readonly string[];
  readonly clientName: string;
  /** An `app` connection's surface (spec revision 19, G1): `code` when its hello named none. Undefined for other roles. */
  readonly surface?: Surface;
  /** An `app` connection's program (lane RT, `surfaces/door.ts`): its signed identity on macOS, its surface where the OS
   *  signs no running image. What its answers, its answer key and its presses belong to; never what a call says. */
  readonly program?: Program;
  /** Set when the client's release is AHEAD of the engine's (spec §3.1, RL): the connection is served the release door only
   *  (`RELEASE_DOOR_METHODS`, and the `release` events) until its engine is in. */
  readonly releaseDoor?: { readonly engine: string };
  /** A plugin-host connection's verified process (review S1): handlers take the call's process from here, never
   *  from a plugin id a plugin could share. */
  readonly hostProcess?: { readonly hostProcess: "moss" | "shared" | "own"; readonly pluginId?: string };
  /** A bridge connection's number from K's `accept` (`BridgeVerdict.connection`), for K's handlers to check
   *  `isLive(session, connection)` on every request. */
  readonly bridgeConnection?: number;
  /** Areas this connection subscribed to (`events.subscribe`). */
  readonly areas: Set<string>;
  /** Send the client a request from the daemon (`app.quit`, `app.show`, `pluginHost.invoke`…); its id. */
  send(method: string, params: unknown): string;
  /** Send the client a notification (`event` for a session's events, `core.event`). */
  notify(method: string, params: unknown): void;
  /** The sessions this connection follows live (`session.attach`), each with its unsubscribe; ended at close. */
  readonly follows: Map<string, () => void>;
  /** K-M3b: bound to a coding session (`codeAgent.open`): it is sent `codeAgent.line` and nothing else, no session
   *  event and no core event (#274's sender skips it). */
  relayed?: boolean;
}

export type MossHandler = (conn: MossConn, params: unknown) => Promise<unknown> | unknown;

/** A handler in the shape lanes D, H and the usage counter write theirs (`bots/rpc.ts`'s `MethodHandler`): the
 *  params and who calls, with the connection's event stream for a method that follows a session. */
export type LaneMethodHandler = (params: unknown, ctx: {
  caller: Caller;
  stream?: { send(event: { type: string; seq: number; sessionId: string; ts: number; [key: string]: unknown }): void; follows: Map<string, () => void> };
}) => Promise<unknown>;

/** Mounts lane handlers on MOSS connections: each runs as the connection's caller, and a session's events go
 *  to it as the inherited `event` notification. Their errors (`MethodError`: code, message, data) pass as they are. */
export function laneMethodHandlers(handlers: Readonly<Record<string, LaneMethodHandler>>): Record<string, MossHandler> {
  return Object.fromEntries(Object.entries(handlers).map(([name, h]) => [name, (conn: MossConn, params: unknown) =>
    h(params, { caller: conn.caller, stream: { send: (event) => conn.notify("event", event), follows: conn.follows } })]));
}

/** K-M3b: `moss-core code-agent`'s sessions (agents/code-agent/service.ts). `codeAgent.open` binds a `cli`
 *  connection that counts as the user to one coding session; after it the connection takes only `codeAgent.send`, and
 *  its close ends the session. */
export interface CodeAgentDoor {
  open(conn: { connId: number; clientName: string; toClient(line: string): void; end(): void }, p: { cwd: string; model?: string; effort?: string }): Promise<{ session: string }>;
  input(connId: number, line: string): void;
  close(connId: number): void;
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

/** K's handlers for the bridge's methods, by session (`agents/bridge/handlers.ts`, `BridgeHandlers`). */
export interface BridgeMethods {
  tools(sessionId: string): Promise<{ tools: unknown[]; instructions: string }>;
  call(sessionId: string, call: { callId: string; tool: string; input: unknown }): Promise<{ content: unknown[]; isError: boolean }>;
  sendMessage(sessionId: string, m: { text: string; to?: string }): Promise<void>;
  glossary(sessionId: string, q: { query?: string | string[]; load?: string | string[] }): Promise<{ results: unknown[]; loaded: unknown[] }>;
}

/** The bridge role's four methods as MOSS handlers, each bound to the connection's own agent session. */
export function bridgeMethodHandlers(h: BridgeMethods): Record<string, MossHandler> {
  const session = (conn: MossConn): string => {
    if (conn.caller.kind !== "session") throw new MossRpcError(MOSS_ERR.ROLE_REFUSED, "not a bridge connection");
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

export interface MossServerDeps {
  readonly tokens: MossTokens;
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
  /** Whether any computer-use session is driving this desktop right now (lane E's B3 answer gate). */
  computerUse?: { acting(): Promise<{ running: boolean; session?: string }> };
  /** The pid the daemon started a plugin-host process with. */
  hostPidOf?(hostProcess: "moss" | "shared" | "own", pluginId?: string): number | undefined;
  /** The link sidecar's pid (lane H): the only local process that says hello as `remote`, `web` or `peer`. */
  linkPid?(): number | undefined;
  /** This run's app token, for `protocol.prove` (the app's check of the daemon before its hello). */
  readonly appToken?: string;
  /** Other lanes' MOSS methods, by wire name. */
  readonly handlers?: Readonly<Record<string, MossHandler>>;
  /** Lane HS: whether a background host owns the screen and the pages now (the supervisor's state), so a `code` window
   *  mounts only its own points (`host/mounts.ts`'s `hostOwnsScreen`). Absent: none ever does. */
  hostOwnsScreen?(): boolean;
  /** lane HS: the engine gave up starting the host (`host_changed`'s `gaveUp`): no island anywhere. */
  hostGaveUp?(): boolean;
  /** Settles once the daemon's late doors are in: the parts that start after the socket listens (the plugin registry's
   *  `plugin.auth.*`, the links' `devices.*`, the computer node's and the bot side's methods) have each finished their
   *  first start or are waiting on something only the user can give (a locked secret store). A call to a method with no
   *  handler yet waits for it, so a client that connects the moment the socket answers is answered when its door is
   *  in, never "not served yet" in between; after it, a method with no handler is one this daemon doesn't serve. */
  readonly lateDoors?: () => Promise<void>;
  /** M-M2: whether the app may leave for an update now (`pair.exiting{update}`): the update gate closed and idle, and
   *  then committed to the restart. */
  acceptUpdateExit?(): boolean;
  readonly features?: readonly string[];
  /** One release for everything (spec §3.1, RL): the engine's release rules. With it, an `app` hello must name its release:
   *  older than the engine's is refused (`RELEASE_REFUSED`, told what it needs), newer gets the release door only. */
  readonly release?: ReleaseHome;
  /** Whether the release rule is enforced (default: yes, when `release` is given). Tests that open app connections without a
   *  release turn it off. */
  readonly enforceRelease?: boolean;
  /** A plugin's granted capabilities (lane B's registry), for the `core.event`s that need one; without it a plugin's
   *  connection gets none of those. */
  pluginCapabilities?(pluginId: string): readonly string[] | undefined;
  /** The kind of data a session is (`dataKindOfSession` over the session host's view; undefined: no such session), for the
   *  capability gate of a read by kind (§3.6): a plugin reads a code session with `sessions.read`, a bot's conversation
   *  with `conversation.read`, never one with the other's. */
  sessionKind?(id: string): DataKind | undefined;
  /** Whether a plugin is on and running (a plugin's own settings events go only to one that is). */
  pluginRunning?(pluginId: string): boolean;
  readonly os?: DaemonPlatform;
  /** The endpoint this server answers on (Windows: only that pipe's ends are matched to connections, review S4). */
  readonly endpoint?: string;
  /** Test seam: the peer of a socket. */
  probe?(socket: object): PeerFacts;
  /** Whether an `app` hello's peer is the signed MOSS app. Default: this OS's check for the running profile
   *  (`defaultAppPeerCheck`: macOS by audit token; `"none"` on Linux and Windows). Tests inject one, or `"none"`. */
  readonly appPeer?: AppPeerPolicy;
  /** K's bridge tokens, and the session's bot for the hello's caller. Without it a `bridge` hello is checked
   *  against tokens minted here (`MossTokens`), with no pid check. */
  readonly bridge?: { readonly gate: BridgeGate; sessionInfo?(sessionId: string): { bot?: string } | undefined };
  /** K's `moss-core code-agent` sessions; without it `codeAgent.*` isn't served. */
  readonly codeAgent?: CodeAgentDoor;
  /** The app's heartbeat (ruling R9): `app.ping` every `intervalMs`, ended after `timeoutMs` unanswered. */
  readonly heartbeat?: { readonly intervalMs?: number; readonly timeoutMs?: number; now?(): number };
  /** End a hung app's process: by default through the connection's handle (review S5: its audit token's start time,
   *  its pidfd, its process handle), so a pid reused since never is; SIGKILL by pid only where the OS gave none. */
  killApp?(pid: number, handle?: PeerHandle): void;
  /** The router's clock, for a presence report's hold (`surfaces/card-router.ts`); the system's by default. */
  readonly clock?: Clock;
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

export interface MossServer {
  /** The listener's `open`: on Windows, finds the connection's peer among the daemon's handles. True when the
   *  connection was made before the pipe's DACL was locked down, so the listener closes it (review M3). */
  opened(socket: object): boolean;
  /** Right after the listener locked the pipe's DACL down (Windows). */
  lockedDown(): void;
  /** `protocol.prove {nonce}` before the hello (review S3): an HMAC under this run's app token over the app's
   *  nonce and the pid the daemon sees on this very connection, so a proof relayed from another connection fails. */
  prove(socket: object, params: unknown): { proof: string; pid: number };
  /** Whether a `protocol.hello`'s params are MOSS's (protocol version 1 or later). */
  isMossHello(params: unknown): boolean;
  /** `end` closes the connection (a revoked bridge token's, a refused bridge). */
  hello(socket: object, connId: number, params: unknown, write: (bytes: Uint8Array) => void, end?: () => void): Promise<{ conn: MossConn; result: MossHelloResult }>;
  /** A paired phone's or browser's hello on its link (lane H's `mountRemoteClients`, through `linkClientServer`): no
   *  local process to probe, since the link proved the device. The token must be the one the core minted for that
   *  device and role, and that token is spent by the check (one hello per mint). `stillLinked` is asked again after
   *  the check, so a device revoked meanwhile isn't registered. The caller is the user on that
   *  device. `end` closes the link's stream (`endConnections`). Never reachable from the socket. */
  linkHello(connId: number, params: unknown, link: { device: string; role: "remote" | "web"; stillLinked?: () => boolean }, write: (bytes: Uint8Array) => void, end?: () => void): Promise<{ conn: MossConn; result: MossHelloResult }>;
  handle(conn: MossConn, method: string, params: unknown): Promise<unknown>;
  closed(conn: MossConn | null, socket: object): void;
  /** A response from the client to one of the daemon's requests (the heartbeat's, or one `ask` waits on). */
  response(conn: MossConn, msg: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } }): void;
  /** Sends the client a request from the daemon and waits for its answer: its result, or its error thrown as a
   *  `MossRpcError`; refused with RETRY when nothing comes within `timeoutMs` or the connection closes first. */
  ask(conn: MossConn, method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  /** `app.quit{reason}` to these app connections (the pair's `tellAppQuit`). */
  tellAppQuit(reason: PairStopReason, connIds: readonly string[]): void;
  connections(): readonly MossConn[];
  /** Closes every connection `match` picks that the server can close itself (a link's, through its `end`); how many. */
  endConnections(match: (conn: MossConn) => boolean): number;
  /** Sends a daemon-wide event as `core.event` to the connections that may have it (`ipc/core-events.ts`): its role,
   *  its subscribed areas, a plugin's capability, and `opts.to`. How many it went to. */
  coreEvent(event: CoreEventInput, opts?: CoreEventOptions): number;
  /** Runs a method for a caller with no connection here: another computer's `peer.call` (lane H's door), under
   *  `role`'s allow list. `answer`: the user's signed answer the door verified, by its card id and the call hash it
   *  binds (`canonicalCallHash`). It stands in for the user on a `userOnly` method only for this method and these
   *  params, and once (review S7). */
  dispatch(method: string, params: unknown, as: { caller: Caller; role: MossRole; answer?: { cardId: string; callHash: string } }): Promise<unknown>;
  /** Lane RT: the surface door (which surface and program each `app` connection is) and the router (where each pending
   *  card is drawn, from the windows' presence). The daemon feeds the router the broker's cards (`surfaces/routing.ts`). */
  readonly surfaces: { readonly door: EngineSurfaceDoor; readonly router: EngineCardRouter };
  /** The broker's pending cards in full (the daemon sets it once the broker is up): a connection that subscribes to
   *  `approvals` is told each of them (`card_requested`) before the subscription's answer, so no client loses a card by the
   *  order of its calls (a card raised before it subscribed reached no connection). */
  pendingCards?: () => readonly Card[];
  /** Hears every connection that closed after its hello (its `surface` and `program` still on it), after the server let go
   *  of it: the hook for a lane that keeps state per connection (lane HS's host). Gives back the undo. */
  onClosed(fn: (conn: MossConn) => void): () => void;
  // lane HS: start
  /** The background host's state changed: the windows' mounts follow (the router's island with them), and the windows
   *  leave the pair while a host owns the screen, or join it again when none does. */
  hostScreen(owns: boolean): void;
  // lane HS: end
  dispose(): void;
}

export function createMossServer(deps: MossServerDeps): MossServer {
  const os = deps.os ?? currentOs();
  const pipePeers = os === "win32" ? new WindowsPipePeers(deps.endpoint) : null;
  const spentAnswers = new Set<string>();
  const conns = new Map<number, MossConn>();
  // Lane RT: the hello's surface and program (the door) and where each pending card is drawn (the router). The island is
  // live while a connection that draws it is (the host; until lane HS builds it, today's `code` window).
  // lane HS: start. A `code` window mounts the screen too only while no background host owns it (`host/mounts.ts`).
  const door = new EngineSurfaceDoor({ legacy: () => !(deps.hostOwnsScreen?.() ?? false), noIsland: () => deps.hostGaveUp?.() ?? false });
  /** The windows the pair took as its app (lane HS: none while a host owns the screen). */
  const pairApps = new Set<number>();
  /** Whether a background host owns the screen now (the last `hostScreen`): MOSS's Quit stops the engine only with none. */
  let hostOwns = false;
  // lane HS: end
  const router = new EngineCardRouter({ clock: deps.clock ?? new SystemClock(), hostLive: false });
  const undoor = door.watch(() => router.hostLive(door.islandLive()));
  const closedHooks = new Set<(conn: MossConn) => void>();
  // Each card that moved, or was first placed, to the `app` connections subscribed to `surfaces` (`card_placed`).
  const unplaced = router.watch((c) => {
    sendCoreEvent({ connections: () => conns.values(), log: (line) => deps.log?.(line) }, { type: "card_placed", ts: Date.now(), card: c.card, place: c.place as CardPlacement, ...(c.before !== undefined ? { before: c.before } : {}) });
  });
  let requestSeq = 0;
  // The daemon's requests waiting on an answer (`ask`), by the connection and the request's id.
  const asked = new Map<string, { connId: number; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const settleAsked = (id: string, fn: (w: { resolve: (v: unknown) => void; reject: (e: Error) => void }) => void): boolean => {
    const w = asked.get(id);
    if (w === undefined) return false;
    asked.delete(id);
    clearTimeout(w.timer);
    fn(w);
    return true;
  };
  const beatEvery = deps.heartbeat?.intervalMs ?? 5_000;
  const beatTimeout = deps.heartbeat?.timeoutMs ?? 15_000;
  const now = deps.heartbeat?.now ?? Date.now;
  const beats = new Map<number, { timer: ReturnType<typeof setInterval>; heard: number; pid: number | null; handle?: PeerHandle; pending: Set<string>; warned?: boolean }>();
  const killApp = deps.killApp ?? ((pid: number, handle?: PeerHandle) => {
    if (handle) { if (!handle.kill()) deps.log?.(`[moss] the app's process ${pid} had already gone`); return; }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  });
  const stopBeat = (connId: number) => { const b = beats.get(connId); if (b) { clearInterval(b.timer); beats.delete(connId); } };
  // A tick that comes this much later than the one before means this process did not run in between: the computer
  // slept, or the daemon itself was held up. That silence is not the app's.
  const beatGap = Math.max(beatEvery * 2, beatEvery + 2_000);
  const startBeat = (conn: MossConn, pid: number | null, handle?: PeerHandle) => {
    let ticked = now();
    const beat = { heard: now(), pid, warned: false, ...(handle ? { handle } : {}), pending: new Set<string>(), timer: setInterval(() => {
      const t = now();
      // After a sleep the first tick used to find the last answer older than the timeout and end the app at once, with
      // no ping sent since the wake: every wake restarted it in safe mode (85 times in one night on the owner's Mac).
      // The count starts again from the wake, and the app gets a ping and its full time to answer it.
      if (t - ticked > beatGap) { beat.heard = t; beat.warned = false; }
      ticked = t;
      // A third of the time it has: one line, so what the app is doing (its main thread, the machine's load) can be looked at while it is
      // still there to look at. It changes nothing about when the app is ended.
      if (t - beat.heard > beatTimeout / 3 && t - beat.heard <= beatTimeout && beat.warned !== true) {
        beat.warned = true;
        deps.log?.(`[moss] the app (connection ${conn.connId}) has not answered app.ping for ${t - beat.heard} ms`);
      }
      if (t - beat.heard > beatTimeout) {
        stopBeat(conn.connId);
        deps.log?.(`[moss] the app (connection ${conn.connId}) didn't answer app.ping for ${beatTimeout} ms`);
        // With no pid it can't be ended, and a new one beside it would be a second app (review M6): its
        // connection closing counts as the crash instead.
        if (beat.pid === null) { deps.log?.("[moss] its process is unknown: waiting for its connection to close"); return; }
        // lane HS: the pair hears of its own app only; a hung host is ended too, and its close is the supervisor's crash.
        if (pairApps.has(conn.connId)) deps.pair?.appHung(String(conn.connId));
        killApp(beat.pid, beat.handle);
        return;
      }
      beat.pending.add(conn.send("app.ping", {}));
    }, beatEvery) };
    (beat.timer as { unref?: () => void }).unref?.();
    beats.set(conn.connId, beat);
  };

  // Each connection's process, held from its first look until it closes (review S5). On Windows it's opened as the
  // connection opens, while the client that just connected still holds its end.
  const handles = new WeakMap<object, PeerHandle | null>();
  const handleOf = (socket: object): PeerHandle | null => {
    if (handles.has(socket)) return handles.get(socket)!;
    const h = gone.has(socket) ? null : pipePeers ? peerHandle(null, "win32", pipePeers.pidOf(socket)) : peerHandle(socketFd(socket), os);
    handles.set(socket, h);
    return h;
  };
  const appPeer: AppPeerPolicy = deps.appPeer ?? defaultAppPeerCheck(os, resolveMossProfile());
  const peerOf = (socket: object): PeerFacts => {
    if (deps.probe) return deps.probe(socket);
    const handle = handleOf(socket);
    if (pipePeers) return probePeer(null, "win32", pipePeers.pidOf(socket), handle);
    return probePeer(socket, os, undefined, handle);
  };

  // Sockets the listener has closed: a hello still waiting on a check (the bridge's waits for its agent's
  // pid) finds its connection gone and gives back what it took.
  const gone = new WeakSet<object>();
  const bridged = new Map<number, { sessionId: string; connection: number; end?: () => void }>();
  // Each connection's way to close itself (K-M3b's, and a link's stream, #278), and the connections bound to a coding
  // session.
  const ends = new Map<number, () => void>();
  const binding = new Set<number>();
  const relayed = new Set<number>();
  const unrevoke = deps.bridge?.gate.onRevoke?.(({ sessionId, connection }) => {
    for (const [connId, b] of bridged) {
      if (b.sessionId !== sessionId || (connection !== undefined && b.connection !== connection)) continue;
      bridged.delete(connId);
      conns.delete(connId);
      deps.log?.(`[moss] bridge connection ${connId}: its token was revoked`);
      try { b.end?.(); } catch { /* already gone */ }
    }
  });

  // The bridge's hello through K's tokens: refused hellos are answered and the connection closed.
  const bridgeHello = async (socket: object, h: MossHelloParams, peer: PeerFacts, end?: () => void) => {
    const gate = deps.bridge!.gate;
    const refuse = (code: number, why: string): never => {
      deps.log?.(`[moss] refused a bridge hello for session ${h.agentSessionId ?? "?"}: ${why}`);
      if (end) setTimeout(() => { try { end(); } catch { /* gone */ } }, 0);
      throw new MossRpcError(code, `the bridge was refused: ${why}`);
    };
    if (!h.agentSessionId) refuse(MOSS_ERR.ROLE_REFUSED, "no agent session named");
    const v = await gate.accept(h.token, h.agentSessionId!, peer.pid);
    if (!v.ok) {
      const code = v.reason === "unknown-token" || v.reason === "wrong-session" || v.reason === "revoked" ? ERR_UNAUTHORIZED
        : v.reason === "unverified-caller" || v.reason === "not-the-agent" ? MOSS_ERR.PROCESS_REFUSED : MOSS_ERR.ROLE_REFUSED;
      refuse(code, v.reason);
    }
    const ok = v as Extract<BridgeVerdict, { ok: true }>;
    if (gone.has(socket)) {
      gate.release(ok.sessionId, ok.connection);
      throw new MossRpcError(MOSS_ERR.ROLE_REFUSED, "closed");
    }
    const bot = deps.bridge!.sessionInfo?.(ok.sessionId)?.bot;
    const sessionKind: SessionKind = bot === undefined ? "coding" : "agent";
    const caller: Caller = { kind: "session", sessionId: ok.sessionId, sessionKind, ...(bot === undefined ? {} : { bot }) };
    return { caller, sessionId: ok.sessionId, connection: ok.connection };
  };

  // One request through the role's allow list, `userOnly` (unless the user's signed answer for this call stands
  // in), the method's params, then its handler.
  const capabilityLogged = new Set<string>();
  const run = async (conn: MossConn, method: string, params: unknown, answered: boolean): Promise<unknown> => {
    if (binding.has(conn.connId)) throw new MossRpcError(MOSS_ERR.ROLE_REFUSED, "this connection is opening a coding session; it takes nothing until then");
    if (relayed.has(conn.connId) && method !== "codeAgent.send") {
      throw new MossRpcError(MOSS_ERR.ROLE_REFUSED, "this connection relays one coding session; it takes nothing else");
    }
    const spec = MOSS_METHODS.get(method);
    if (spec === undefined) throw new MossRpcError(ERR.METHOD_NOT_FOUND, `no such method ${method}`);
    if (conn.releaseDoor !== undefined && deps.release?.doorAllows(method) !== true) throw new MossRpcError(MOSS_ERR.ROLE_REFUSED, doorMessage(method, conn.releaseDoor.engine));
    const caller: Caller = answered ? { kind: "user", client: "app" } : conn.caller;
    // A plugin's connection: the method's capability, as its OK granted it (the registry's record, read per call).
    const lacking = gateMossRequest(conn.role, caller, method) === null
      ? capabilityRefusal(conn.role, caller, method, caller.kind === "plugin" ? deps.pluginCapabilities?.(caller.pluginId) : undefined, params, { sessionKind: (id) => deps.sessionKind?.(id) })
      : null;
    if (lacking !== null && caller.kind === "plugin" && !capabilityLogged.has(`${caller.pluginId}\0${method}`)) {
      // Once per plugin and method (never what the call carried), so a dead button leaves a trace in the daemon's log.
      capabilityLogged.add(`${caller.pluginId}\0${method}`);
      console.error(`[plugins] ${caller.pluginId}: ${lacking.message}`);
    }
    const refused = gateMossRequest(conn.role, caller, method) ?? lacking;
    if (refused) throw new MossRpcError(refused.code, refused.message);
    const p = spec.params.safeParse(params ?? {});
    if (!p.success) throw new MossRpcError(ERR.INVALID_PARAMS, `invalid params for ${method}`);
    // The device's single answer key is MOSS Code's (lane RT, ruling C): another program registers its own key with
    // `device.programKey.set`, never this one.
    // The person's window alone (`windowOnly`): an app connection of a program with windows, never the host's (also an
    // app, also the user) nor any other role.
    if (spec.windowOnly === true && !isWindowConn(conn)) {
      throw new MossRpcError(MOSS_ERR.NOT_THE_USER, `${method} is the person's window's: ${conn.program === "host" ? "the host draws only on the screen" : "this connection is no program's window"}`);
    }
    if (method === "device.answerKey.set" && conn.program !== undefined && conn.program !== "code") {
      throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "this desktop's single answer key is MOSS Code's: another program registers its own (device.programKey.set)");
    }
    let handler = own[method] ?? deps.handlers?.[method];
    if (handler === undefined && deps.lateDoors !== undefined) {
      // A door that comes up after the socket listens: this call waits for it rather than racing the daemon's start.
      await deps.lateDoors();
      handler = own[method] ?? deps.handlers?.[method];
    }
    if (handler === undefined) throw new MossRpcError(ERR.METHOD_NOT_FOUND, `${method} is not served yet`);
    const result = await handler(conn, p.data);
    // A list of sessions is cut to the kinds the plugin reads (`conversation.*`, §3.6), as its watch is: the gate let the call
    // through for a plugin that reads either kind.
    if (method === "session.list" && caller.kind === "plugin" && PLUGIN_ROLES.includes(conn.role)) {
      const have = deps.pluginCapabilities?.(caller.pluginId) ?? [];
      const list = result as { sessions: { kind: SessionKind }[] };
      return { ...list, sessions: list.sessions.filter((s) => have.includes(kindCapability("conversation.*", dataKindOfSession(s)))) };
    }
    return result;
  };

  const parseHello = (params: unknown): MossHelloParams => {
    const parsed = MossHelloParams.safeParse(params);
    if (!parsed.success) throw new MossRpcError(ERR.INVALID_PARAMS, "invalid hello");
    if (!helloVersionServed(parsed.data.protocolVersion)) {
      throw new MossRpcError(MOSS_ERR.VERSION_REFUSED, "protocol version not served", { min: MOSS_PROTOCOL_MIN_VERSION, max: MOSS_PROTOCOL_VERSION });
    }
    return parsed.data;
  };

  // A connection after its hello: kept for routing (`coreEvent`) and closing.
  // The hello's release check (RL): refused before anything is registered; an ahead client is registered with the door only.
  const releaseVerdict = (h: MossHelloParams): HelloVerdict => {
    const v = deps.release === undefined ? ({ kind: "unjudged" } as const) : judgeHello(deps.release, h, deps.enforceRelease !== false);
    if (v.kind === "refused") throw new MossRpcError(MOSS_ERR.RELEASE_REFUSED, refusalMessage(v.refusal), v.refusal);
    return v;
  };

  // An `app` hello's surface (G1), through the door (lane RT, `surfaces/door.ts`): absent is `code`, today's app; on any
  // other role it is refused; a second live `host` for this home is refused (one per home, §3.1); a surface that isn't
  // the connection's signed program is refused (`signed`, macOS); an older second copy of a program stops. It picks the
  // mount list only; it grants no method.
  const SURFACE_WHY = { "not-app": "surface is the app role's alone", "second-host": "a background host is already live for this home", "program-mismatch": "this connection's signature is another program's", "older-copy": "a newer copy of this program is running" } as const;
  const register = (connId: number, h: MossHelloParams, caller: Caller, write: (bytes: Uint8Array) => void, extra: Pick<MossConn, "hostProcess" | "bridgeConnection">, signed?: Program, verdict: HelloVerdict = { kind: "unjudged" }): { conn: MossConn; result: MossHelloResult } => {
    if (conns.has(connId)) throw new MossRpcError(ERR.INVALID_REQUEST, "that connection already said hello");
    // An app AHEAD of the engine holds the release door only and is kept out of the surface door's live set (release-door.ts `inertAdmission`).
    const admitted = verdict.kind === "door" ? inertAdmission({ role: h.role, surface: h.surface, signed }) : door.admit({ connId, role: h.role, ...(h.surface !== undefined ? { surface: h.surface } : {}), ...(signed !== undefined ? { signed } : {}), ...(h.release !== undefined ? { release: h.release } : {}) });
    if (!admitted.ok) throw new MossRpcError(MOSS_ERR.SURFACE_REFUSED, SURFACE_WHY[admitted.refusal.reason], admitted.refusal);
    const surface = admitted.surface;
    const conn: MossConn = {
      connId, role: h.role, caller, features: h.features ?? [], clientName: h.clientName, areas: new Set(), ...extra,
      ...(admitted.surface !== undefined ? { surface: admitted.surface, program: admitted.program } : {}),
      ...(verdict.kind === "door" ? { releaseDoor: { engine: verdict.release.engine } } : {}),
      send(method, p) { const id = `d${++requestSeq}`; write(encodeLine({ jsonrpc: "2.0", id, method, params: p })); return id; },
      notify(method, p) {
        if (conn.relayed === true && method !== CODE_AGENT_LINE_NOTIFICATION) return;
        write(encodeLine({ jsonrpc: "2.0", method, params: p }));
      },
      follows: new Map(),
    };
    conns.set(connId, conn);
    deps.log?.(`[moss] ${h.role} connection ${connId} (${h.clientName}) counts as ${caller.kind}${admitted.surface !== undefined ? ` (surface ${admitted.surface}, program ${admitted.program})` : ""}`);
    // An older copy of the same program goes: told the way the daemon tells an app to leave for an update.
    if (admitted.surface !== undefined) for (const older of admitted.stop) conns.get(older)?.send("app.quit", { reason: "update" });
    return {
      conn,
      result: {
        ok: true, serverVersion: deps.serverVersion, protocolVersion: MOSS_PROTOCOL_VERSION, caller, device: deps.deviceId, features: [...(deps.features ?? [])],
        // Until the background host runs (lane HS), a `code` window still mounts the screen's points itself.
        ...(admitted.surface !== undefined ? { surface, mount: admitted.mount } : {}),
        ...(verdict.kind === "served" || verdict.kind === "door" ? { release: verdict.release } : {}),
      },
    };
  };

  const pairStatus = (): PairStatus => {
    const extras = deps.pairStatusExtras?.() ?? { bots: [], routines: 0, agents: 0, canHandOver: false };
    return PairStatus.parse({ ...extras, safeMode: deps.pair?.status().safeMode ?? false });
  };

  const own: Record<string, MossHandler> = {
    // Lane RT: a window program's presence (§3.5), from its main process on its own connection; the host has no windows.
    "presence.report": (conn, p) => {
      if (conn.program !== "moss" && conn.program !== "code") throw new MossRpcError(MOSS_ERR.SURFACE_REFUSED, "presence comes from MOSS's or MOSS Code's window program", { reason: "not-app", ...(conn.surface !== undefined ? { surface: conn.surface } : {}) });
      return router.report({ connId: conn.connId, program: conn.program }, p as PresenceReport);
    },
    "card.placement": (_conn, p) => {
      const ids = (p as { ids?: string[] }).ids;
      const all = router.list();
      return { placements: ids === undefined ? all : all.filter((c) => ids.includes(c.card)) };
    },
    "events.subscribe": (conn, p) => {
      // A connection with the release door only follows the release events: nothing else of the engine's is its to see yet.
      const areas = (p as { areas: string[] }).areas.filter((a) => conn.releaseDoor === undefined || a === "release");
      const fresh = areas.filter((a) => !conn.areas.has(a));
      for (const a of areas) conn.areas.add(a);
      // What is already there is told to this connection alone, before the answer, in the stream's own order (lane RT): the
      // pending cards to one newly following `approvals`, and every card's place to one newly following `surfaces`, so a
      // client that subscribes after a card was raised or placed still hears it, and nothing told later is overtaken by it.
      const only = { connections: () => [conn][Symbol.iterator](), log: (line: string) => deps.log?.(line) };
      if (fresh.includes("approvals")) for (const card of server.pendingCards?.() ?? []) sendCoreEvent(only, { type: "card_requested", ts: Date.now(), card });
      if (fresh.includes("surfaces")) for (const c of router.list()) sendCoreEvent(only, { type: "card_placed", ts: Date.now(), card: c.card, place: c.place as CardPlacement });
      return { ok: true };
    },
    "events.unsubscribe": (conn, p) => { for (const a of (p as { areas: string[] }).areas) conn.areas.delete(a); return { ok: true }; },
    "pair.status": () => pairStatus(),
    "pair.quit": async (conn, p) => {
      // lane HS (the engine's lifetime with more than one program): a MOSS Code window's Quit while a MOSS window is up
      // stops nothing: that window leaves alone (out of the pair, so its close is no crash and nothing restarts it), and
      // the engine, the host and MOSS keep working.
      if (conn.role === "app" && pairApps.has(conn.connId) && [...conns.values()].some((c) => c.connId !== conn.connId && c.role === "app" && c.surface === "moss")) {
        pairApps.delete(conn.connId);
        stopBeat(conn.connId);
        deps.pair?.appReleased(String(conn.connId));
        deps.log?.("[moss] MOSS Code quits alone: a MOSS window is up, so the engine keeps working");
        return { ok: true };
      }
      // lane HS (S8): MOSS's Quit when it is the last of our windows and no host is live stops the engine exactly as MOSS
      // Code's does: otherwise nothing would stop an engine with no window, no host and no menu-bar icon. With another
      // window of ours up, or a host owning the screen (its menu stops everything), it stops nothing and MOSS just goes.
      if (conn.role === "app" && conn.surface === "moss") {
        const otherWindow = [...conns.values()].some((c) => c.connId !== conn.connId && c.role === "app" && (c.surface === "moss" || c.surface === "code"));
        if (otherWindow || hostOwns || deps.hostOwnsScreen?.() === true) {
          deps.log?.(`[moss] MOSS quits alone: ${otherWindow ? "another window of ours is up" : "a host owns the screen"}, so the engine keeps working`);
          return { ok: true };
        }
        deps.log?.("[moss] MOSS quits as the last window with no host: the engine stops too");
        deps.pair?.quit("quit", String(conn.connId));
        return { ok: true };
      }
      if ((p as { handOver: boolean }).handOver) await deps.handOver?.();
      // The app that asked leaves with the answer: no `app.quit` back to it (E-M1).
      deps.pair?.quit("quit", conn.role === "app" ? String(conn.connId) : undefined);
      return { ok: true };
    },
    "pair.exiting": (conn, p) => {
      const reason = (p as { reason: "quit" | "update" | "restart" }).reason;
      // M-M2: an update's exit only once `update.apply` closed the gate and nothing runs; the app then keeps running.
      if (reason === "update" && deps.acceptUpdateExit?.() === false) {
        throw new MossRpcError(ERR.RETRY, "not idle for the update: ask update.apply again", { code: "update_not_ready" });
      }
      deps.pair?.appExiting(String(conn.connId), reason);
      return { ok: true };
    },
    // A token for one plugin's UI layer, which the app's main process opens a `layer` connection with.
    // The plugin registry (lane B) will check the plugin is installed and has a layer before minting.
    "layer.token": (_conn, p) => ({ token: deps.tokens.mint({ role: "layer", pluginId: (p as { pluginId: string }).pluginId }) }),
    // Whether any computer-use session is driving this desktop right now (lane E's B3). User and app only:
    // no plugin asks. With no computer-use service, nothing is acting, so answer `running: false` (check 3: this
    // replaces the earlier fail-closed-when-absent rule). The app still fails closed when the call itself errors.
    // Feeding in plugin-run computer use stays with lanes J and H.
    "computer.acting": async () => {
      const r = await deps.computerUse?.acting?.();
      if (r === undefined) return { running: false, session: undefined };
      return { running: r?.running === true, session: r?.session };
    },
    // K-M3b: one coding session per connection, which then relays its ACP lines and nothing else.
    "codeAgent.open": async (conn, p) => {
      if (!deps.codeAgent) throw new MossRpcError(ERR.METHOD_NOT_FOUND, "codeAgent.open is not served yet");
      const end = ends.get(conn.connId) ?? (() => {});
      const toClient = (line: string) => {
        // Over the cap a line can't be relayed whole: it is dropped, and said so without its content.
        if (line.length > CODE_AGENT_MAX_LINE) {
          deps.log?.(`[moss] code-agent connection ${conn.connId}: dropped a line of ${line.length} characters (over ${CODE_AGENT_MAX_LINE})`);
          return;
        }
        conn.notify(CODE_AGENT_LINE_NOTIFICATION, { line });
      };
      // Binding from here: nothing else is taken meanwhile, a second open included; a failed open lets it go.
      binding.add(conn.connId);
      let r: { session: string };
      try {
        r = await deps.codeAgent.open({ connId: conn.connId, clientName: conn.clientName, toClient, end }, p as { cwd: string; model?: string; effort?: string });
      } finally {
        binding.delete(conn.connId);
      }
      // The connection closed while the session opened: it ends at once.
      if (!conns.has(conn.connId)) {
        deps.codeAgent.close(conn.connId);
        return r;
      }
      // Bound: what it followed or subscribed to before stops, and from now on it is sent its lines only.
      relayed.add(conn.connId);
      conn.relayed = true;
      for (const stop of conn.follows.values()) { try { stop(); } catch { /* the session is gone */ } }
      conn.follows.clear();
      conn.areas.clear();
      return r;
    },
    "codeAgent.send": (conn, p) => {
      if (!deps.codeAgent || !relayed.has(conn.connId)) throw new MossRpcError(ERR.INVALID_REQUEST, "open a coding session on this connection first (codeAgent.open)");
      deps.codeAgent.input(conn.connId, (p as { line: string }).line);
      return { ok: true };
    },
  };

  const server: MossServer = {
    // The connection's process is held as the connection opens, on every OS (#205's S2): no pid read later can be
    // another process's.
    opened(socket) {
      if (!pipePeers) { if (!deps.probe) handleOf(socket); return false; }
      if (pipePeers.opened(socket) !== null && !deps.probe) handleOf(socket);
      return pipePeers.isEarly(socket);
    },

    lockedDown() { pipePeers?.lockedDown(); },

    prove(socket, params) {
      const nonce = (params as { nonce?: unknown } | null)?.nonce;
      if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) throw new MossRpcError(ERR.INVALID_PARAMS, "protocol.prove takes a base64url nonce of 16 to 96 bytes");
      if (deps.appToken === undefined) throw new MossRpcError(ERR.METHOD_NOT_FOUND, "this daemon has no app token");
      const pid = peerOf(socket).pid;
      if (pid === null) throw new MossRpcError(MOSS_ERR.PROCESS_REFUSED, "this connection's process is unknown");
      return { proof: proveDaemon(deps.appToken, nonce, pid), pid };
    },

    // MOSS's when it names version 1 or later and one of MOSS's roles: an inherited role
    // (harness, admin, plugin) at any other version keeps the inherited path and its VERSION_MISMATCH.
    isMossHello(params) {
      const p = params as { protocolVersion?: unknown; role?: unknown } | null;
      return typeof p?.protocolVersion === "number" && p.protocolVersion >= MOSS_PROTOCOL_MIN_VERSION
        && typeof p.role === "string" && (MOSS_ROLES as readonly string[]).includes(p.role);
    },

    async hello(socket, connId, params, write, end) {
      const h = parseHello(params);
      let caller: Caller;
      let peer: PeerFacts;
      let bridge: { sessionId: string; connection: number } | undefined;
      let hostProcess: MossConn["hostProcess"];
      let signed: Program | undefined;
      if (h.role === "bridge" && deps.bridge) {
        peer = peerOf(socket);
        const b = await bridgeHello(socket, h, peer, end);
        caller = b.caller;
        bridge = { sessionId: b.sessionId, connection: b.connection };
      } else {
        const binding = await deps.tokens.verify(h);
        if (isRefusal(binding)) throw new MossRpcError(binding.code, binding.message);
        peer = peerOf(socket);
        const hostPid = binding.role === "plugin-host" ? deps.hostPidOf?.(binding.hostProcess, binding.pluginId) : undefined;
        const linkPid = deps.linkPid?.();
        // The peer check names the program it found (macOS): the door holds the hello's surface to it (lane RT).
        const namesProgram: AppPeerPolicy = appPeer === "none" ? "none" : (p) => {
          const r = appPeer(p);
          if (typeof r === "string") signed = r;
          return r;
        };
        const resolved = resolveMossCaller({ binding, peer, processes: deps.processes, appPeer: namesProgram, ...(hostPid !== undefined ? { hostPid } : {}), ...(linkPid !== undefined ? { linkPid } : {}) });
        if ("code" in resolved) throw new MossRpcError(resolved.code, resolved.message);
        caller = resolved;
        if (binding.role === "plugin-host") hostProcess = { hostProcess: binding.hostProcess, ...(binding.pluginId ? { pluginId: binding.pluginId } : {}) };
        if (gone.has(socket)) throw new MossRpcError(MOSS_ERR.ROLE_REFUSED, "closed");
      }
      if (bridge) bridged.set(connId, { ...bridge, ...(end ? { end } : {}) });
      // The release rule judges the caller once it is known (so a client that proves nothing learns no release).
      const verdict = bridge ? ({ kind: "unjudged" } as const) : releaseVerdict(h);
      const r = register(connId, h, caller, write, { ...(hostProcess ? { hostProcess } : {}), ...(bridge ? { bridgeConnection: bridge.connection } : {}) }, signed, verdict);
      if (end) ends.set(connId, end);
      // The pair (`pair.*`, the heartbeat and the kill of a hung app) is today's one app, MOSS Code's window: a `moss` or
      // `host` connection is never taken for it (lanes RT, then HS and RL, retire the pair).
      // lane HS: start. A window that says hello while a background host owns the screen is no half of the pair: its
      // quit stops nothing and its exit is no crash (spec §3.1, "quitting an app never stops work"). Stand-in until the
      // pair is retired (lanes RT, RL, then HS).
      // The heartbeat (R9) is the pair's app's and the host's: one that stops answering app.ping is ended, the pair's app to be
      // restarted in safe mode, the host's close a crash for its supervisor. A window outside the pair has none: nothing would
      // restart it, so ending it would only take the person's window away (and an `app` client that isn't a window, a test's,
      // answers no ping).
      if (r.conn.surface === "code" && r.conn.releaseDoor === undefined && !(deps.hostOwnsScreen?.() ?? false)) { pairApps.add(connId); deps.pair?.appConnected(String(connId), r.conn.features); startBeat(r.conn, peer.pid, peer.handle); }
      else if (r.conn.surface === "host") startBeat(r.conn, peer.pid, peer.handle);
      // lane HS: end
      // An app AHEAD of this engine is open and waits (release door only): the pair starts no second one meanwhile.
      else if (r.conn.surface === "code" && r.conn.releaseDoor !== undefined) deps.pair?.appWaiting(String(connId));
      return r;
    },

    async linkHello(connId, params, link, write, end) {
      let h: MossHelloParams;
      let binding: Awaited<ReturnType<MossTokens["verify"]>>;
      try {
        h = parseHello(params);
        if (h.role !== link.role || h.device !== link.device) throw new MossRpcError(MOSS_ERR.ROLE_REFUSED, "a link's hello is its device's, in its role");
        binding = await deps.tokens.verify(h);
      } finally {
        // One hello per minted token: spent by the check whatever it found, a hello that doesn't even parse included,
        // so the table never grows per connection.
        const token = (params as { token?: unknown } | null | undefined)?.token;
        if (typeof token === "string") deps.tokens.revoke(token);
      }
      if (isRefusal(binding)) throw new MossRpcError(binding.code, binding.message);
      if (binding.role !== link.role || !("device" in binding) || binding.device !== link.device) throw new MossRpcError(ERR_UNAUTHORIZED, "the token is for another device or role");
      // The device may have been revoked while the token was checked: asked again just before it's registered.
      if (link.stillLinked !== undefined && !link.stillLinked()) throw new MossRpcError(MOSS_ERR.ROLE_REFUSED, "the device is no longer paired");
      const caller: Caller = { kind: "user", client: link.role === "remote" ? "ios" : "web", device: link.device };
      const r = register(connId, h, caller, write, {});
      if (end) ends.set(connId, end);
      return r;
    },

    async handle(conn, method, params) {
      if (method === "protocol.hello") throw new MossRpcError(ERR.INVALID_REQUEST, "already authenticated — open a new connection to change role");
      return run(conn, method, params, false);
    },

    async dispatch(method, params, as) {
      if (method === "protocol.hello") throw new MossRpcError(ERR.INVALID_REQUEST, "a hello is a connection's");
      let answered = false;
      if (as.answer) {
        if (as.answer.callHash !== canonicalCallHash(method, params)) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "the answer is for another call");
        if (spentAnswers.has(as.answer.cardId)) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "the answer was already used");
        spentAnswers.add(as.answer.cardId);
        answered = true;
      }
      const conn: MossConn = {
        connId: -1, role: as.role, caller: as.caller, features: [], clientName: "peer.call", areas: new Set(),
        send() { throw new MossRpcError(ERR.INVALID_REQUEST, "a peer.call has no connection to send on"); },
        notify() { /* nowhere to send it */ },
        follows: new Map(),
      };
      try { return await run(conn, method, params, answered); }
      finally { for (const stop of conn.follows.values()) { try { stop(); } catch { /* gone */ } } }
    },

    closed(conn, socket) {
      gone.add(socket);
      pipePeers?.closed(socket);
      handles.get(socket)?.close();
      handles.set(socket, null);
      if (conn === null) return;
      stopBeat(conn.connId);
      conns.delete(conn.connId);
      ends.delete(conn.connId);
      // Whatever the daemon still waited on from it gets no answer now.
      for (const [id, w] of [...asked]) if (w.connId === conn.connId) settleAsked(id, (x) => x.reject(new MossRpcError(ERR.RETRY, "the connection closed before it answered")));
      for (const stop of conn.follows.values()) { try { stop(); } catch { /* the session is gone */ } }
      conn.follows.clear();
      const b = bridged.get(conn.connId);
      if (b) { bridged.delete(conn.connId); deps.bridge?.gate.release(b.sessionId, b.connection); }
      if (relayed.delete(conn.connId)) deps.codeAgent?.close(conn.connId);
      // lane HS: only a window the pair took (above).
      if (pairApps.delete(conn.connId)) deps.pair?.appDisconnected(String(conn.connId));
      else if (conn.surface === "code" && conn.releaseDoor !== undefined) deps.pair?.appWaitingGone(String(conn.connId));
      // Its presence goes at once, and the door lets its surface go (the island with it, if it drew one).
      router.dropped(conn.connId);
      door.closed(conn.connId);
      for (const fn of closedHooks) { try { fn(conn); } catch { /* a hook's fault is its own */ } }
    },

    // Any answer to a ping, a result or an error, shows the app's main process is responsive.
    response(conn, msg) {
      const b = beats.get(conn.connId);
      if (b && typeof msg.id === "string" && b.pending.delete(msg.id)) { b.heard = now(); b.warned = false; }
      // An answer to an `ask`, from the connection it was sent to only.
      if (typeof msg.id === "string" && asked.get(msg.id)?.connId === conn.connId) {
        // Any answer also shows the app's main process is responsive.
        if (b) { b.heard = now(); b.warned = false; }
        settleAsked(msg.id, (w) => {
          if (msg.error !== undefined) {
            const e = msg.error;
            w.reject(new MossRpcError(typeof e.code === "number" ? e.code : ERR.INTERNAL, typeof e.message === "string" ? e.message.slice(0, 500) : "the client refused", e.data));
          } else w.resolve(msg.result);
        });
      }
    },

    ask(conn, method, params, timeoutMs) {
      return new Promise<unknown>((resolve, reject) => {
        if (!conns.has(conn.connId)) { reject(new MossRpcError(ERR.RETRY, "that connection has closed")); return; }
        const id = conn.send(method, params);
        const timer = setTimeout(() => settleAsked(id, (w) => w.reject(new MossRpcError(ERR.RETRY, `${conn.clientName} didn't answer ${method} within ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        asked.set(id, { connId: conn.connId, resolve, reject, timer });
      });
    },

    tellAppQuit(reason, connIds) {
      for (const id of connIds) conns.get(Number(id))?.send("app.quit", { reason });
    },

    connections() { return [...conns.values()]; },

    endConnections(match) {
      let n = 0;
      for (const [connId, end] of [...ends]) {
        const conn = conns.get(connId);
        if (conn === undefined || !match(conn)) continue;
        ends.delete(connId);
        try { end(); } catch { /* already gone */ }
        n++;
      }
      return n;
    },

    coreEvent(event, opts) {
      return sendCoreEvent({
        connections: () => conns.values(),
        pluginCapabilities: (id) => deps.pluginCapabilities?.(id),
        pluginRunning: (id) => deps.pluginRunning?.(id) === true,
        log: (line) => deps.log?.(line),
      }, event, opts);
    },

    // lane HS: start
    hostScreen(owns: boolean) {
      hostOwns = owns;
      door.remount();
      for (const c of conns.values()) {
        if (c.role !== "app" || c.surface !== "code") continue;
        // Released from the pair, it loses the pair's heartbeat too (nothing restarts it; see the hello's rule). Back in the
        // pair when no host owns the screen, it is the pair's app again, with no heartbeat until it says hello again.
        if (owns && pairApps.delete(c.connId)) { stopBeat(c.connId); deps.pair?.appReleased(String(c.connId)); }
        else if (!owns && !pairApps.has(c.connId)) { pairApps.add(c.connId); deps.pair?.appConnected(String(c.connId), c.features); }
      }
    },
    // lane HS: end
    surfaces: { door, router },

    onClosed(fn) { closedHooks.add(fn); return () => { closedHooks.delete(fn); }; },

    dispose() {
      unrevoke?.();
      undoor();
      unplaced();
      for (const connId of [...beats.keys()]) stopBeat(connId);
    },
  };
  return server;
}
