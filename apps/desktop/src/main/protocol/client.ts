// The app's protocol client (spec §3.1): JSON-RPC 2.0 over NDJSON on the daemon's local socket (a Unix socket on
// macOS and Linux, a named pipe on Windows), requests and responses in both directions on one connection, and events
// as notifications. It runs in Electron's main process on Node, and in Bun for the tests, so it uses only `node:net`.
//
// The daemon also sends the app requests of its own (`app.show`, `app.quit`, lane B's "the app and the pair"): a
// handler answers each, and a method with no handler is answered "method not found".
import { connect, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { LineDecoder, encodeLine } from "@waifucave/clover-protocol";

/** Where the daemon listens for a home, as lane C's `platform/transport.ts` resolves it: `<home>/run/core.sock`, or
 *  on Windows the named pipe `\\.\pipe\clover-core-<id>`, `<id>` the first 16 hex of SHA-256 over the run
 *  directory's path, so two homes (the dist one, the dev one, a test's) never meet. */
export function daemonEndpoint(home: string, platform: NodeJS.Platform = process.platform): string {
  const runDir = platform === "win32" ? win32.join(home, "run") : posix.join(home, "run");
  if (platform !== "win32") return posix.join(runDir, "core.sock");
  const id = createHash("sha256").update(runDir).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\clover-core-${id}`;
}

/** A JSON-RPC error answer, or a local failure (`closed`, `timeout`) with a code of its own. */
export class RpcCallError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "RpcCallError";
  }
}

/** Local failures, outside JSON-RPC's own range. */
export const CLIENT_ERR = { CLOSED: -32900, TIMEOUT: -32901 } as const;
const METHOD_NOT_FOUND = -32601;
const INTERNAL = -32603;

export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

interface Waiting {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DaemonClient {
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly decoder = new LineDecoder();
  private closedFlag = false;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = this.decoder.push(chunk);
      } catch {
        this.close();
        return;
      }
      for (const line of lines) this.receive(line);
    });
    socket.on("close", () => this.closed());
    socket.on("error", () => this.closed());
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  private closed(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new RpcCallError(CLIENT_ERR.CLOSED, "the connection closed"));
    }
    this.waiting.clear();
    for (const l of this.closeListeners) l();
  }

  private receive(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    const method = typeof msg.method === "string" ? msg.method : undefined;
    if (method !== undefined && msg.id !== undefined) {
      void this.answer(msg.id as number | string, method, msg.params);
      return;
    }
    if (method !== undefined) {
      for (const l of this.notificationListeners) l(method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const w = this.waiting.get(msg.id);
    if (w === undefined) return;
    this.waiting.delete(msg.id);
    clearTimeout(w.timer);
    const err = msg.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (err !== undefined && err !== null) w.reject(new RpcCallError(typeof err.code === "number" ? err.code : INTERNAL, typeof err.message === "string" ? err.message : "error", err.data));
    else w.resolve(msg.result);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    if (handler === undefined) {
      this.write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `the app has no ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result === undefined ? { ok: true } : result });
    } catch (err) {
      this.write({ jsonrpc: "2.0", id, error: { code: INTERNAL, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private write(msg: unknown): void {
    if (this.closedFlag) return;
    this.socket.write(encodeLine(msg));
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<T> {
    if (this.closedFlag) return Promise.reject(new RpcCallError(CLIENT_ERR.CLOSED, "the connection is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new RpcCallError(CLIENT_ERR.TIMEOUT, `${method} took longer than ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Answers the daemon's own requests for one method. */
  handle(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    if (this.closedFlag) listener();
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
    this.closed();
  }
}

/** Dials the daemon; undefined when nothing answers within `timeoutMs`. */
export function dial(endpoint: string, timeoutMs = 1000): Promise<DaemonClient | undefined> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(new DaemonClient(socket));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(undefined);
    });
  });
}
