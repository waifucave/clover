// A fake app client: what the Electron app will be to the daemon (spec §3.1) — a local client that says hello,
// calls methods and receives every event — so a test can drive a daemon the way the app does, with no window.
// It speaks the daemon's JSON-RPC 2.0 over NDJSON on the socket and records what arrives.
import { CLIENT_CAPABILITY_ISLAND, encodeLine, LineDecoder, METHODS, PROTOCOL_VERSION } from "@waifucave/clover-protocol";

export interface RpcError extends Error {
  rpc: { code: number; message: string; data?: unknown };
}

export interface Notification {
  method: string;
  params: unknown;
}

export interface FakeAppClientOptions {
  socketPath: string;
  token: string;
  /** Today's local-client role, the one the retired Mac app used; lane B's protocol may pin an app role. */
  role?: "harness" | "admin";
  clientName?: string;
  /** Hello capabilities. Default: the island's, as a desktop app's surface shows every pending card. */
  capabilities?: string[];
  timeoutMs?: number;
}

export class FakeAppClient {
  /** Every notification received, in order (`event` frames and any other method the daemon pushes). */
  readonly notifications: Notification[] = [];
  /** The `features` the daemon's hello answered with. */
  features: readonly string[] = [];
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly waiters = new Set<{ match: (n: Notification) => boolean; resolve: (n: Notification) => void }>();
  private nextId = 1;
  private closed = false;
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;

  private constructor(private readonly timeoutMs: number) {}

  static async connect(opts: FakeAppClientOptions): Promise<FakeAppClient> {
    const client = new FakeAppClient(opts.timeoutMs ?? 5000);
    client.socket = await Bun.connect({
      unix: opts.socketPath,
      socket: {
        data: (_socket, chunk) => client.receive(chunk),
        close: () => client.onClose(),
        error: () => {},
      },
    });
    const hello = (await client.call(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION,
      role: opts.role ?? "harness",
      token: opts.token,
      clientName: opts.clientName ?? "clover-app (fake)",
      capabilities: opts.capabilities ?? [CLIENT_CAPABILITY_ISLAND],
    })) as { features?: string[] };
    client.features = hello.features ?? [];
    return client;
  }

  /** Calls `method` and resolves with its result; rejects with the daemon's error (its `rpc` attached). */
  call(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    this.socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /** The `event` notifications' params (the daemon's `SessionEvent`s), in order. */
  events(): unknown[] {
    return this.notifications.filter((n) => n.method === METHODS.event).map((n) => n.params);
  }

  /** Resolves with the first notification (already received, or still to come) that `match` accepts. */
  waitFor(match: (n: Notification) => boolean, timeoutMs = this.timeoutMs): Promise<Notification> {
    const seen = this.notifications.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (n: Notification) => { clearTimeout(timer); resolve(n); } };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`no matching notification within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.socket.end();
    this.onClose();
  }

  private receive(chunk: Uint8Array): void {
    for (const line of this.decoder.push(chunk)) {
      let msg: { id?: number | null; result?: unknown; error?: { code: number; message: string; data?: unknown }; method?: string; params?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(`${msg.error.message} (code ${msg.error.code})`), { rpc: msg.error }) as RpcError);
        else p.resolve(msg.result);
      } else if (typeof msg.method === "string") {
        const n: Notification = { method: msg.method, params: msg.params };
        this.notifications.push(n);
        for (const w of [...this.waiters]) {
          if (w.match(n)) {
            this.waiters.delete(w);
            w.resolve(n);
          }
        }
      }
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("connection closed"));
    this.pending.clear();
  }
}
