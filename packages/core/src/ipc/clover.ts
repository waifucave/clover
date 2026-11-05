// Clover's connections on the daemon's endpoint (spec §3.1; B's roles.ts and clover.ts). The inherited
// protocol (v0: harness, admin, remote, plugin) stays beside it until C1 retires it method by method;
// a hello naming protocol version 1 or later is Clover's and comes here: its role and token
// (auth/clover-tokens.ts), the caller check on the peer process (platform/caller-probe.ts,
// auth/clover-caller.ts), then each request through the role's allow list and `userOnly`. The pair's
// methods (`pair.status`, `pair.quit`, `pair.exiting`) and `layer.token` are lane C's and served here;
// other lanes add theirs through `handlers`. A method on a role's list that no lane serves yet answers
// METHOD_NOT_FOUND.
import {
  CLOVER_ERR, CLOVER_METHODS, CLOVER_PROTOCOL_MIN_VERSION, CLOVER_PROTOCOL_VERSION, CloverHelloParams, ERR,
  PairStatus, encodeLine, helloVersionServed, type Caller, type CloverHelloResult, type CloverRole,
} from "@waifucave/clover-protocol";
import { isRefusal, type CloverTokens } from "../auth/clover-tokens";
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
  /** Areas this connection subscribed to (`events.subscribe`). */
  readonly areas: Set<string>;
  /** Send the client a request from the daemon (`app.quit`, `app.show`, `pluginHost.invoke`…). */
  send(method: string, params: unknown): void;
}

export type CloverHandler = (conn: CloverConn, params: unknown) => Promise<unknown> | unknown;

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
  /** Other lanes' Clover methods, by wire name. */
  readonly handlers?: Readonly<Record<string, CloverHandler>>;
  readonly features?: readonly string[];
  readonly os?: DaemonPlatform;
  /** Test seam: the peer of a socket. */
  probe?(socket: object): PeerFacts;
  log?(line: string): void;
}

function currentOs(): DaemonPlatform {
  return process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
}

export interface CloverServer {
  /** The listener's `open`: on Windows, finds the connection's peer among the daemon's handles. */
  opened(socket: object): void;
  /** Whether a `protocol.hello`'s params are Clover's (protocol version 1 or later). */
  isCloverHello(params: unknown): boolean;
  hello(socket: object, connId: number, params: unknown, write: (bytes: Uint8Array) => void): Promise<{ conn: CloverConn; result: CloverHelloResult }>;
  handle(conn: CloverConn, method: string, params: unknown): Promise<unknown>;
  closed(conn: CloverConn | null, socket: object): void;
  /** `app.quit{reason}` to these app connections (the pair's `tellAppQuit`). */
  tellAppQuit(reason: PairStopReason, connIds: readonly string[]): void;
  connections(): readonly CloverConn[];
}

export function createCloverServer(deps: CloverServerDeps): CloverServer {
  const os = deps.os ?? currentOs();
  const pipePeers = os === "win32" ? new WindowsPipePeers() : null;
  const conns = new Map<number, CloverConn>();
  let requestSeq = 0;

  const peerOf = (socket: object): PeerFacts => {
    if (deps.probe) return deps.probe(socket);
    if (pipePeers) return probePeer(null, "win32", pipePeers.pidOf(socket));
    return probePeer(socket, os);
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
      deps.pair?.appExiting(String(conn.connId), (p as { reason: "quit" | "update" | "restart" }).reason);
      return { ok: true };
    },
    // A token for one plugin's UI layer, which the app's main process opens a `layer` connection with.
    // The plugin registry (lane B) will check the plugin is installed and has a layer before minting.
    "layer.token": (_conn, p) => ({ token: deps.tokens.mint({ role: "layer", pluginId: (p as { pluginId: string }).pluginId }) }),
  };

  return {
    opened(socket) { pipePeers?.opened(socket); },

    isCloverHello(params) {
      const v = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
      return typeof v === "number" && v >= CLOVER_PROTOCOL_MIN_VERSION;
    },

    async hello(socket, connId, params, write) {
      const parsed = CloverHelloParams.safeParse(params);
      if (!parsed.success) throw new CloverRpcError(ERR.INVALID_PARAMS, "invalid hello");
      const h = parsed.data;
      if (!helloVersionServed(h.protocolVersion)) {
        throw new CloverRpcError(CLOVER_ERR.VERSION_REFUSED, "protocol version not served", { min: CLOVER_PROTOCOL_MIN_VERSION, max: CLOVER_PROTOCOL_VERSION });
      }
      const binding = await deps.tokens.verify(h);
      if (isRefusal(binding)) throw new CloverRpcError(binding.code, binding.message);
      const peer = peerOf(socket);
      const hostPid = binding.role === "plugin-host" ? deps.hostPidOf?.(binding.hostProcess, binding.pluginId) : undefined;
      const caller = resolveCloverCaller({ binding, peer, processes: deps.processes, ...(hostPid !== undefined ? { hostPid } : {}) });
      if ("code" in caller) throw new CloverRpcError(caller.code, caller.message);
      const conn: CloverConn = {
        connId, role: h.role, caller, features: h.features ?? [], clientName: h.clientName, areas: new Set(),
        send(method, p) { write(encodeLine({ jsonrpc: "2.0", id: `d${++requestSeq}`, method, params: p })); },
      };
      conns.set(connId, conn);
      if (h.role === "app") deps.pair?.appConnected(String(connId), conn.features);
      deps.log?.(`[clover] ${h.role} connection ${connId} (${h.clientName}) counts as ${caller.kind}`);
      return {
        conn,
        result: { ok: true, serverVersion: deps.serverVersion, protocolVersion: CLOVER_PROTOCOL_VERSION, caller, device: deps.deviceId, features: [...(deps.features ?? [])] },
      };
    },

    async handle(conn, method, params) {
      if (method === "protocol.hello") throw new CloverRpcError(ERR.INVALID_REQUEST, "already authenticated — open a new connection to change role");
      const spec = CLOVER_METHODS.get(method);
      if (spec === undefined) throw new CloverRpcError(ERR.METHOD_NOT_FOUND, `no such method ${method}`);
      const refused = gateCloverRequest(conn.role, conn.caller, method);
      if (refused) throw new CloverRpcError(refused.code, refused.message);
      const p = spec.params.safeParse(params ?? {});
      if (!p.success) throw new CloverRpcError(ERR.INVALID_PARAMS, `invalid params for ${method}`);
      const handler = own[method] ?? deps.handlers?.[method];
      if (handler === undefined) throw new CloverRpcError(ERR.METHOD_NOT_FOUND, `${method} is not served yet`);
      return handler(conn, p.data);
    },

    closed(conn, socket) {
      pipePeers?.closed(socket);
      if (conn === null) return;
      conns.delete(conn.connId);
      if (conn.role === "app") deps.pair?.appDisconnected(String(conn.connId));
    },

    tellAppQuit(reason, connIds) {
      for (const id of connIds) conns.get(Number(id))?.send("app.quit", { reason });
    },

    connections() { return [...conns.values()]; },
  };
}
