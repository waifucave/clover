// A DevTools client for a headless shell the daemon started itself, over `--remote-debugging-pipe` (NUL-framed JSON):
// no port, so no other local process can connect to it (spec §12.1; S7 §4). The pipe is a browser-level connection: it
// reaches `Target`, `Browser` and `Storage` for every tab, so only the daemon ever holds it, and the API's calls go
// through `HeadlessBrowser`'s allow list first. Every call times out; a call that times out while the browser answers
// nothing at all (not even a ping) means the pipe stalled, and the browser is killed so nothing waits on it again.

/** Our side of the DevTools pipe, whichever OS made it. */
export interface PipeTransport {
  /** False once the pipe is closed. */
  write(bytes: Uint8Array): boolean;
  onData(listener: (chunk: Uint8Array) => void): void;
  onClose(listener: (why: string) => void): void;
  close(): void;
}

/** The browser's process, whichever API started it. */
export interface BrowserProcess {
  pid: number;
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
  /** The last lines the browser printed, for an error. */
  stderrTail(n?: number): string;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export type CdpErrorKind = "protocol" | "timeout" | "closed";

export class CdpError extends Error {
  constructor(readonly kind: CdpErrorKind, message: string, readonly code?: number) {
    super(message);
    this.name = "CdpError";
  }
}

/** What `HeadlessBrowser` needs of a browser connection (a fake one in the unit tests). */
export interface CdpConnection {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
  on(listener: (event: CdpEvent) => void): () => void;
  /** The browser went: it exited, crashed, or its pipe closed or stalled. Called once. */
  onClose(listener: (why: string) => void): void;
  readonly closed: boolean;
  /** `Browser.close`, then a kill if it hasn't gone in a few seconds. */
  close(): Promise<void>;
  /** The browser's process id, where there is one (the network filter checks who connects, `peer-owner.ts`). */
  readonly pid?: number;
}

/** Splits NUL-framed messages out of the bytes so far. Pure. */
export function splitFrames(buffered: Uint8Array[], chunk: Uint8Array): { messages: Uint8Array[]; rest: Uint8Array[] } {
  const messages: Uint8Array[] = [];
  let parts = buffered;
  let from = 0;
  for (;;) {
    const at = chunk.indexOf(0, from);
    if (at < 0) break;
    const piece = chunk.subarray(from, at);
    messages.push(parts.length === 0 ? piece : concat([...parts, piece]));
    parts = [];
    from = at + 1;
  }
  const tail = chunk.subarray(from);
  return { messages, rest: tail.length === 0 ? parts : [...parts, tail] };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export const DEFAULT_CALL_MS = 15_000;
/** How long the browser has to answer a ping once a call timed out, before its pipe counts as stalled. */
export const PING_MS = 5_000;

export class PipeConnection implements CdpConnection {
  private nextId = 1;
  private buffered: Uint8Array[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private readonly closeListeners: Array<(why: string) => void> = [];
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private lastIn = 0;
  private pinging = false;
  private why: string | undefined;

  private readonly pingMs: number;

  get pid(): number {
    return this.proc.pid;
  }

  constructor(readonly proc: BrowserProcess, private readonly pipe: PipeTransport, opts: { pingMs?: number } = {}) {
    this.pingMs = opts.pingMs ?? PING_MS;
    pipe.onData((chunk) => this.onData(chunk));
    pipe.onClose((why) => this.gone(why));
    void proc.exited.then(({ code, signal }) => this.gone(`the browser exited (${signal ?? code})`));
  }

  get closed(): boolean {
    return this.why !== undefined;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = DEFAULT_CALL_MS): Promise<T> {
    if (this.why !== undefined) return Promise.reject(new CdpError("closed", `${method}: ${this.why}`));
    const id = this.nextId++;
    const sentAt = Date.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError("timeout", `${method} got no answer from the browser in ${Math.round(timeoutMs / 1000)} s`));
        if (this.lastIn < sentAt) this.ping();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      const text = JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
      if (!this.pipe.write(this.encoder.encode(`${text}\0`))) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError("closed", `${method}: the pipe to the browser is closed`));
      }
    });
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (why: string) => void): void {
    if (this.why !== undefined) listener(this.why);
    else this.closeListeners.push(listener);
  }

  async close(): Promise<void> {
    if (this.why === undefined) {
      await this.send("Browser.close", {}, undefined, 3000).catch(() => undefined);
      const done = await Promise.race([this.proc.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000).unref())]);
      if (!done) this.proc.kill();
    }
    this.pipe.close();
    this.gone("closed");
  }

  /** A call timed out with nothing from the browser since: is it there at all? */
  private ping(): void {
    if (this.pinging || this.why !== undefined) return;
    this.pinging = true;
    const before = this.lastIn;
    this.send("Browser.getVersion", {}, undefined, this.pingMs).then(
      () => { this.pinging = false; },
      () => {
        this.pinging = false;
        if (this.why === undefined && this.lastIn === before) {
          this.proc.kill();
          this.gone("the browser's pipe stalled: it answered nothing, so it was stopped");
        }
      },
    );
  }

  private onData(chunk: Uint8Array): void {
    this.lastIn = Date.now();
    const { messages, rest } = splitFrames(this.buffered, chunk);
    this.buffered = rest;
    for (const m of messages) this.onMessage(this.decoder.decode(m));
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new CdpError("protocol", `${p.method}: ${msg.error.message}`, msg.error.code));
      else p.resolve(msg.result ?? {});
    } else if (typeof msg.method === "string") {
      const e: CdpEvent = { method: msg.method, params: msg.params ?? {}, ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}) };
      for (const l of [...this.listeners]) {
        try {
          l(e);
        } catch {
          // One listener's mistake never stops the others.
        }
      }
    }
  }

  private gone(why: string): void {
    if (this.why !== undefined) return;
    this.why = why;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError("closed", `${p.method}: ${why}`));
    }
    this.pending.clear();
    this.pipe.close();
    // A pipe that closed or stalled under a live browser leaves no browser behind (killing one that exited is a no-op).
    this.proc.kill();
    for (const l of this.closeListeners.splice(0)) {
      try {
        l(why);
      } catch {
        // Below.
      }
    }
  }
}
