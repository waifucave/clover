// The daemon's end of the bridge (spec §9.3, protocol agents.ts role `bridge`): a Unix socket the bridge process
// connects to, says `protocol.hello` with its role, token and session, and then may call only `bridge.tools`,
// `bridge.call`, `bridge.sendMessage` and `glossary.query`, bound to that one agent session.
//
// Lane C's `protocol.hello` on the daemon's main socket (C-M1) is where role `bridge` will finally live. Until it
// lands this endpoint serves the role on a socket of its own (`<home>/run/bridge.sock`, mode 0600), with the same
// hello and the same methods, so C can mount `serveBridgeConnection` there without the bridge noticing.
//
// The hello is checked by `BridgeTokens.accept` with the kernel's pid for the caller (peer.ts): a stolen token is
// refused from any process outside the agent's tree, and while one bridge is connected no second one is accepted.
// A refused hello is answered and the connection closed; the token's value never appears in a log or an error.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  AGENTS_METHODS, CLOVER_ERR, CLOVER_PROTOCOL_VERSION, CloverHelloParams, PLUGINS_METHODS, type CloverHelloResult,
} from "@waifucave/clover-protocol";
import type { z } from "zod";
import { RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, RpcError, RpcPeer } from "../acp/jsonrpc";
import { peerPidOf } from "./peer";
import type { BridgeTokens } from "./tokens";
import type { BridgeToolDef } from "./tools";

/** What the bridge's methods do, for one session; the agent manager provides it. */
export interface BridgeHandlers {
  /** The session's bot, for the hello's caller. */
  sessionInfo(sessionId: string): { bot?: string } | undefined;
  tools(sessionId: string): Promise<{ tools: BridgeToolDef[]; instructions: string }>;
  call(sessionId: string, call: { callId: string; tool: string; input: unknown }): Promise<{ content: unknown[]; isError: boolean }>;
  sendMessage(sessionId: string, m: { text: string; to?: string }): Promise<void>;
  glossary(sessionId: string, q: { query?: string | string[]; load?: string | string[] }): Promise<{ results: unknown[]; loaded: unknown[] }>;
}

export interface BridgeEndpointOptions {
  socketPath: string;
  tokens: BridgeTokens;
  handlers: BridgeHandlers;
  /** This computer's device id, for the hello's result. */
  device: string;
  serverVersion: string;
  /** How long a connection has to say hello. */
  helloTimeoutMs?: number;
  log?(line: string): void;
  /** TEST SEAM: the caller's pid, as the kernel would give it. */
  peerPid?: (fd: number | undefined) => number | null;
}

type BunSocket = { fd?: number; write(data: string | Uint8Array): number; end(): void; data: ConnState };

interface ConnState {
  peer: RpcPeer;
  sessionId?: string;
  connection?: number;
  pending: Uint8Array[];
  closed: boolean;
  helloTimer?: ReturnType<typeof setTimeout>;
}

const BRIDGE_METHODS = new Set(["bridge.tools", "bridge.call", "bridge.sendMessage", "glossary.query"]);

function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const r = schema.safeParse(params ?? {});
  if (!r.success) throw new RpcError(RPC_INVALID_PARAMS, `invalid params: ${r.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ")}`);
  return r.data;
}

export class BridgeEndpoint {
  readonly #opts: BridgeEndpointOptions;
  #server: { stop(force?: boolean): void } | undefined;
  readonly #conns = new Set<BunSocket>();
  readonly #unrevoke: () => void;

  constructor(opts: BridgeEndpointOptions) {
    this.#opts = opts;
    this.#unrevoke = opts.tokens.onRevoke(({ sessionId }) => {
      for (const s of this.#conns) if (s.data.sessionId === sessionId) this.#close(s);
    });
  }

  get socketPath(): string {
    return this.#opts.socketPath;
  }

  listen(): void {
    if (this.#server) return;
    const path = this.#opts.socketPath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rmSync(path, { force: true });
    this.#server = Bun.listen<ConnState>({
      unix: path,
      socket: {
        open: (socket) => this.#open(socket as unknown as BunSocket),
        data: (socket, chunk) => socket.data.peer.feed(chunk),
        drain: (socket) => this.#flush(socket as unknown as BunSocket),
        close: (socket) => this.#closed(socket as unknown as BunSocket),
        error: (socket) => this.#closed(socket as unknown as BunSocket),
      },
    });
    chmodSync(path, 0o600);
  }

  close(): void {
    this.#unrevoke();
    for (const s of [...this.#conns]) this.#close(s);
    this.#server?.stop(true);
    this.#server = undefined;
    rmSync(this.#opts.socketPath, { force: true });
  }

  #open(socket: BunSocket): void {
    const state: ConnState = {
      pending: [],
      closed: false,
      peer: new RpcPeer({
        write: (line) => this.#write(socket, line),
        onRequest: (method, params) => this.#request(socket, method, params),
        onBadLine: (reason) => this.#opts.log?.(`bridge: ${reason}`),
      }),
    };
    socket.data = state;
    this.#conns.add(socket);
    state.helloTimer = setTimeout(() => {
      if (!state.sessionId) this.#close(socket);
    }, this.#opts.helloTimeoutMs ?? 30_000);
  }

  #write(socket: BunSocket, line: string): void {
    const s = socket.data;
    if (s.closed) throw new Error("closed");
    const bytes = new TextEncoder().encode(line);
    if (s.pending.length > 0) {
      s.pending.push(bytes);
      return;
    }
    const n = socket.write(bytes);
    if (n < bytes.length) s.pending.push(bytes.subarray(Math.max(0, n)));
  }

  #flush(socket: BunSocket): void {
    const s = socket.data;
    while (s.pending.length > 0) {
      const head = s.pending[0]!;
      const n = socket.write(head);
      if (n < head.length) {
        s.pending[0] = head.subarray(Math.max(0, n));
        return;
      }
      s.pending.shift();
    }
  }

  #closed(socket: BunSocket): void {
    const s = socket.data;
    if (!s || s.closed) return;
    s.closed = true;
    if (s.helloTimer) clearTimeout(s.helloTimer);
    s.peer.close();
    this.#conns.delete(socket);
    if (s.sessionId !== undefined && s.connection !== undefined) this.#opts.tokens.release(s.sessionId, s.connection);
  }

  #close(socket: BunSocket): void {
    this.#closed(socket);
    try {
      socket.end();
    } catch {
      // Already gone.
    }
  }

  async #request(socket: BunSocket, method: string, params: unknown): Promise<unknown> {
    const s = socket.data;
    if (method === "protocol.hello") return this.#hello(socket, params);
    if (!s.sessionId) throw new RpcError(CLOVER_ERR.ROLE_REFUSED, "say protocol.hello first");
    if (!BRIDGE_METHODS.has(method)) throw new RpcError(CLOVER_ERR.ROLE_REFUSED, `the bridge role may not call ${method}`);
    // Every request, not just the hello: a token revoked since (TaskStop, the agent's exit) is closed here even if the
    // revoke's close hasn't reached this socket yet (review 5).
    if (s.connection === undefined || !this.#opts.tokens.isLive(s.sessionId, s.connection)) {
      this.#close(socket);
      throw new RpcError(CLOVER_ERR.ROLE_REFUSED, "this bridge's token was revoked");
    }
    const h = this.#opts.handlers;
    const id = s.sessionId;
    switch (method) {
      case "bridge.tools": {
        const r = await h.tools(id);
        return { tools: r.tools, instructions: r.instructions };
      }
      case "bridge.call":
        return h.call(id, parse(AGENTS_METHODS.bridgeCall.params, params));
      case "bridge.sendMessage": {
        const p = parse(AGENTS_METHODS.bridgeSendMessage.params, params);
        await h.sendMessage(id, { text: p.text, ...(p.to === undefined ? {} : { to: p.to }) });
        return { ok: true };
      }
      case "glossary.query": {
        const p = parse(PLUGINS_METHODS.glossaryQuery.params, params);
        return h.glossary(id, { ...(p.query === undefined ? {} : { query: p.query }), ...(p.load === undefined ? {} : { load: p.load }) });
      }
      default:
        throw new RpcError(RPC_METHOD_NOT_FOUND, method);
    }
  }

  async #hello(socket: BunSocket, params: unknown): Promise<CloverHelloResult> {
    const s = socket.data;
    if (s.sessionId) throw new RpcError(CLOVER_ERR.ROLE_REFUSED, "already said hello");
    const p = parse(CloverHelloParams, params);
    const refuse = (why: string): never => {
      this.#opts.log?.(`bridge: refused a hello for session ${p.agentSessionId ?? "?"}: ${why}`);
      setTimeout(() => this.#close(socket), 0);
      throw new RpcError(CLOVER_ERR.ROLE_REFUSED, `the bridge was refused: ${why}`);
    };
    if (p.role !== "bridge") refuse(`this socket serves only the bridge role, not ${p.role}`);
    if (p.protocolVersion < 1) {
      throw new RpcError(CLOVER_ERR.VERSION_REFUSED, "protocol version refused", { min: 1, max: CLOVER_PROTOCOL_VERSION });
    }
    if (!p.agentSessionId) refuse("no agent session named");
    const pid = (this.#opts.peerPid ?? peerPidOf)(socket.fd);
    const verdict = await this.#opts.tokens.accept(p.token, p.agentSessionId!, pid);
    if (!verdict.ok) refuse(verdict.reason);
    const ok = verdict as { ok: true; sessionId: string; connection: number };
    if (s.closed) {
      // It went away while the check ran: give the token's one connection back.
      this.#opts.tokens.release(ok.sessionId, ok.connection);
      throw new RpcError(CLOVER_ERR.ROLE_REFUSED, "closed");
    }
    s.sessionId = ok.sessionId;
    s.connection = ok.connection;
    if (s.helloTimer) clearTimeout(s.helloTimer);
    const info = this.#opts.handlers.sessionInfo(ok.sessionId);
    const bot = info?.bot;
    return {
      ok: true,
      serverVersion: this.#opts.serverVersion,
      protocolVersion: CLOVER_PROTOCOL_VERSION,
      caller: { kind: "session", sessionId: ok.sessionId, sessionKind: bot === undefined ? "coding" : "agent", ...(bot === undefined ? {} : { bot }) },
      device: this.#opts.device,
      features: [],
    };
  }
}
