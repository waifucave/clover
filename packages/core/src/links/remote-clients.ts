// RPC and events over links, for remote clients (plan §4 H, M2; spec §10 "What a remote client may do is core", "The
// Swift Gateway in the Mac app, which connects to the daemon as `remote`, moves into the daemon in C4"). A paired phone
// speaks the same Clover protocol it would on the daemon's socket, over a stream on its persistent link: requests
// and their answers, the daemon's own requests, and the events its role may see.
//
// * **The door:** a stream labelled `clover/rpc/1` from a paired, unrevoked phone (role `remote`) or browser (role
//   `web`). A computer is refused: computers speak `peer.*` and `sync.*`, never a client role.
// * **The hello:** the client's first message is `protocol.hello`. The link already proved the device, so the core mints
//   the role's token for that device itself (lane C's `CloverTokens`, `{role, device}`) and passes the hello to lane C's
//   server, which applies the role's allow list and `userOnly` to every request after it, as on the socket.
// * **The wire:** each stream chunk is one JSON-RPC message, UTF-8. What lane C's server writes (answers, the daemon's
//   requests, `event` and `core.event` notifications) goes back the same way.
// * **Events:** the server delivers a session's events itself (`conn.notify`); `core.event`s go to a connection
//   whose role may receive them and that subscribed to their area (`events.subscribe`), from `coreEvents` when the
//   daemon passes it (lane C routes them otherwise).
// * **Ending:** the stream's end, a revocation or the link's loss closes the connection (`closed`).
import { allowedEvents, CLOVER_EVENTS, type CloverHelloResult, type CloverRole } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "../contracts/common";
import type { LinkStream, LinkTransport } from "../contracts/link-transport";
import type { FileDeviceRegistry } from "../devices/registry";

export const REMOTE_RPC_LABEL = "clover/rpc/1";

/** The connection lane C's server keeps (`CloverConn`), as far as the door needs it. */
export interface RemoteConn {
  readonly connId: number;
  readonly role: CloverRole;
  readonly areas: Set<string>;
}

/** Lane C's `CloverServer` and `CloverTokens`, as far as the door needs them. */
export interface RemoteRpcServer {
  hello(socket: object, connId: number, params: unknown, write: (bytes: Uint8Array) => void, end?: () => void): Promise<{ conn: RemoteConn; result: CloverHelloResult }>;
  handle(conn: RemoteConn, method: string, params: unknown): Promise<unknown>;
  closed(conn: RemoteConn | null, socket: object): void;
  response?(conn: RemoteConn, msg: { id?: unknown }): void;
}

export interface RemoteTokens {
  mint(binding: { role: "remote" | "web" | "peer"; device: string }): string;
}

export interface RemoteClientsOptions {
  transport: Pick<LinkTransport, "onStream">;
  registry: Pick<FileDeviceRegistry, "get">;
  server: RemoteRpcServer;
  tokens: RemoteTokens;
  /** Core events to forward to subscribed connections, when lane C's daemon doesn't route them to every connection. */
  coreEvents?(fn: (event: { type: string; [key: string]: unknown }) => void): Unsubscribe;
  /** Connection ids for these connections, apart from the socket's (lane C's numbering, or a counter). */
  nextConnId?(): number;
  log?(line: string): void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Which client role a device's link may carry. */
function roleFor(kind: string): "remote" | "web" | undefined {
  if (kind === "phone") return "remote";
  if (kind === "browser") return "web";
  return undefined;
}

export function mountRemoteClients(o: RemoteClientsOptions): Unsubscribe {
  let counter = 1_000_000;
  const next = o.nextConnId ?? (() => ++counter);
  const live = new Set<{ conn: RemoteConn; send(msg: unknown): void }>();
  const offEvents = o.coreEvents?.((event) => {
    const spec = CLOVER_EVENTS.get(event.type);
    if (!spec || spec.scope !== "core") return;
    for (const c of live) {
      if (!c.conn.areas.has(spec.area) || !allowedEvents(c.conn.role).has(event.type)) continue;
      c.send({ jsonrpc: "2.0", method: "core.event", params: event });
    }
  });
  const offStream = o.transport.onStream(REMOTE_RPC_LABEL, (stream, _meta, from) => {
    const d = o.registry.get(from);
    const role = d && d.revokedAt === undefined ? roleFor(d.kind) : undefined;
    if (!role) {
      stream.abort("only a paired phone or browser speaks the client protocol over a link");
      return;
    }
    void serve(o, stream, from, role, next(), live);
  });
  return () => {
    offStream();
    offEvents?.();
  };
}

async function serve(o: RemoteClientsOptions, stream: LinkStream, device: string, role: "remote" | "web", connId: number, live: Set<{ conn: RemoteConn; send(msg: unknown): void }>): Promise<void> {
  const socket = { device, link: true };
  let conn: RemoteConn | null = null;
  let entry: { conn: RemoteConn; send(msg: unknown): void } | undefined;
  let queue = Promise.resolve();
  let closed = false;
  const writeBytes = (bytes: Uint8Array) => {
    if (closed) return;
    // A line from the server may carry its newline: the stream's chunks are the messages.
    const text = dec.decode(bytes).replace(/\n$/, "");
    void stream.write(enc.encode(text)).catch(() => undefined);
  };
  const send = (msg: unknown) => writeBytes(enc.encode(JSON.stringify(msg)));
  const finish = () => {
    if (closed) return;
    closed = true;
    if (entry) live.delete(entry);
    o.server.closed(conn, socket);
    stream.end();
  };
  stream.onEnd(() => finish());

  const take = async (raw: Uint8Array) => {
    let msg: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(dec.decode(raw)) as typeof msg;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    // An answer to one of the daemon's own requests.
    if (msg.method === undefined) {
      if (conn && ("result" in msg || "error" in msg)) o.server.response?.(conn, msg);
      return;
    }
    const id = msg.id;
    const reply = (body: { result: unknown } | { error: unknown }) => {
      if (id !== undefined) send({ jsonrpc: "2.0", id, ...body });
    };
    if (typeof msg.method !== "string") return reply({ error: { code: -32600, message: "invalid request" } });
    try {
      if (!conn) {
        if (msg.method !== "protocol.hello") return reply({ error: { code: -32001, message: "say hello first" } });
        // The link proved the device: the token is the core's own for it, never one the client holds.
        const p = { ...(msg.params as Record<string, unknown> | undefined), role, device, token: o.tokens.mint({ role, device }) };
        const h = await o.server.hello(socket, connId, p, writeBytes, () => stream.end());
        conn = h.conn;
        entry = { conn, send };
        live.add(entry);
        return reply({ result: h.result });
      }
      reply({ result: await o.server.handle(conn, msg.method, msg.params) });
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown; data?: unknown };
      reply({ error: { code: typeof e.code === "number" ? e.code : -32603, message: typeof e.message === "string" ? e.message : "failed", ...(e.data === undefined ? {} : { data: e.data }) } });
    }
  };
  // Until the hello is answered, messages wait their turn; after it they run side by side, as on the socket.
  stream.onData((chunk) => {
    if (conn) void take(chunk);
    else queue = queue.then(() => take(chunk)).catch(() => undefined);
  });
}
