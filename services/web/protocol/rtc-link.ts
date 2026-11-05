// A link over WebRTC data channels, between the page and a computer: requests and answers, notifications, and
// streams of binary chunks, with lane B's priority classes (the `Link` contract, packages/core/src/contracts on
// lane/b-m0). The same file runs in browsers and, with node-datachannel's RTCPeerConnection, on a computer.
//
// Channels:
//   "control"   ordered, reliable: JSON frames for requests, answers and notifications at `control` priority
//   "tokens"    ordered, reliable: the same frames at `tokens` priority, so a token stream never waits behind control
//   "s:<id>"    one channel per stream (screenshots, files): its first frame is JSON {label, priority, meta}, then
//               binary chunks, then the text "end" or {"abort": reason}
// Each stream has its own channel, so SCTP interleaves it with the small messages instead of holding them up
// (spec §8.2, "Priorities").

export const LINK_PRIORITIES = ["control", "tokens", "screenshots", "files"] as const;
export type LinkPriority = (typeof LINK_PRIORITIES)[number];

export type LinkErrorCode = "offline" | "timeout" | "not_found" | "failed" | "closed" | "cancelled" | "refused" | "invalid";

export class LinkError extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

/** The data-channel surface the link needs; a browser's RTCDataChannel and node-datachannel's both have it. */
export interface ChannelLike {
  readonly label: string;
  readonly readyState: string;
  binaryType: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onbufferedamountlow: ((event: unknown) => void) | null;
}

export interface PeerConnectionLike {
  createDataChannel(label: string, init?: { ordered?: boolean }): ChannelLike;
  close(): void;
}

export interface LinkStream {
  readonly id: string;
  readonly label: string;
  readonly priority: LinkPriority;
  write(chunk: Uint8Array): Promise<void>;
  end(): void;
  abort(reason?: string): void;
  onData(fn: (chunk: Uint8Array) => void): () => void;
  onEnd(fn: (error?: Error) => void): () => void;
}

type Frame =
  | { t: "req"; id: number; method: string; params: unknown }
  | { t: "res"; id: number; result: unknown }
  | { t: "err"; id: number; error: { code: string; message: string } }
  | { t: "note"; method: string; params: unknown };

const HIGH_WATER = 1024 * 1024;

/** Messages a channel received before its link took it (see `holdMessages`). */
const held = new WeakMap<ChannelLike, { data: unknown }[]>();

/**
 * Keeps what a channel receives until a link takes it. The other end may send as soon as its own side is open,
 * before this end has finished setting up; a data channel with no message handler drops what arrives.
 */
export function holdMessages(channel: ChannelLike): void {
  if (held.has(channel)) return;
  const queue: { data: unknown }[] = [];
  held.set(channel, queue);
  channel.onmessage = (event) => queue.push(event);
}

/**
 * Points a channel's messages at `fn`. What was held is handed over on the next task, after whoever made the link
 * has registered its handlers in the turn it got the link (as `adopt` does).
 */
function takeMessages(channel: ChannelLike, fn: (event: { data: unknown }) => void): void {
  const queue = held.get(channel);
  if (!queue) {
    channel.onmessage = fn;
    return;
  }
  // Until the hand-over, new messages keep queueing behind the held ones, so the order holds.
  setTimeout(() => {
    held.delete(channel);
    for (const event of queue.splice(0)) fn(event);
    channel.onmessage = fn;
  }, 0);
}
const MAX_FRAME = 256 * 1024;

class RtcStream implements LinkStream {
  private readonly data = new Set<(chunk: Uint8Array) => void>();
  private readonly ends = new Set<(error?: Error) => void>();
  private ended = false;

  constructor(
    readonly id: string,
    readonly label: string,
    readonly priority: LinkPriority,
    private readonly channel: ChannelLike,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.ended) throw new LinkError("closed", "the stream has ended");
    for (let offset = 0; offset < chunk.length; offset += MAX_FRAME) {
      while (this.channel.bufferedAmount > HIGH_WATER && this.channel.readyState === "open") {
        await new Promise<void>((resolve) => {
          this.channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
          this.channel.onbufferedamountlow = () => resolve();
        });
      }
      if (this.channel.readyState !== "open") throw new LinkError("offline", "the link closed");
      this.channel.send(chunk.subarray(offset, Math.min(chunk.length, offset + MAX_FRAME)));
    }
  }

  end(): void {
    if (this.ended) return;
    try {
      this.channel.send("end");
    } catch {
      // Closed already.
    }
    this.finish();
  }

  abort(reason = "aborted"): void {
    if (this.ended) return;
    try {
      this.channel.send(JSON.stringify({ abort: reason }));
    } catch {
      // Closed already.
    }
    this.finish(new LinkError("cancelled", reason));
  }

  onData(fn: (chunk: Uint8Array) => void): () => void {
    this.data.add(fn);
    return () => this.data.delete(fn);
  }

  onEnd(fn: (error?: Error) => void): () => void {
    this.ends.add(fn);
    return () => this.ends.delete(fn);
  }

  /** From the channel. */
  receive(data: unknown): void {
    if (this.ended) return;
    if (typeof data === "string") {
      if (data === "end") return this.finish();
      let reason = "aborted";
      try {
        reason = String((JSON.parse(data) as { abort?: unknown }).abort ?? reason);
      } catch {
        // A malformed control frame ends the stream too.
      }
      return this.finish(new LinkError("cancelled", reason));
    }
    const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!chunk) return;
    for (const fn of [...this.data]) fn(chunk);
  }

  finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const fn of [...this.ends]) {
      try {
        fn(error);
      } catch {
        // A listener's own failure.
      }
    }
    setTimeout(() => {
      try {
        this.channel.close();
      } catch {
        // Closed already.
      }
    }, 0);
  }
}

export interface RtcLinkOptions {
  /** The other end's id (the browser's device id on a computer; the computer's key in the page). */
  peer: string;
  pc: PeerConnectionLike;
  control: ChannelLike;
  tokens: ChannelLike;
  /** The default time a request waits for its answer. */
  requestTimeoutMs?: number;
}

export class RtcLink {
  readonly peer: string;
  private readonly pc: PeerConnectionLike;
  private readonly control: ChannelLike;
  private readonly tokens: ChannelLike;
  private readonly timeoutMs: number;
  private nextId = 1;
  private nextStream = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly handlers = new Map<string, (params: unknown) => unknown>();
  private readonly notes = new Map<string, Set<(params: unknown) => void>>();
  private readonly streamHandlers = new Map<string, (stream: LinkStream, meta: unknown) => void>();
  private readonly closers = new Set<(reason: string) => void>();
  private closed = false;

  constructor(options: RtcLinkOptions) {
    this.peer = options.peer;
    this.pc = options.pc;
    this.control = options.control;
    this.tokens = options.tokens;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    for (const channel of [this.control, this.tokens]) {
      channel.onclose = () => this.close("the peer went away");
      takeMessages(channel, (event) => this.onFrame(event.data));
    }
  }

  get open(): boolean {
    return !this.closed && this.control.readyState === "open";
  }

  /** A data channel the other end opened: a stream's. Called by whoever set up the connection (ondatachannel). */
  adoptChannel(channel: ChannelLike): void {
    if (!channel.label.startsWith("s:")) return;
    channel.binaryType = "arraybuffer";
    let stream: RtcStream | null = null;
    channel.onclose = () => stream?.finish(new LinkError("offline", "the stream's channel closed"));
    takeMessages(channel, (event) => {
      if (stream) return stream.receive(event.data);
      try {
        const head = JSON.parse(String(event.data)) as { label: string; priority: LinkPriority; meta?: unknown };
        stream = new RtcStream(channel.label.slice(2), head.label, head.priority, channel);
        const handler = this.streamHandlers.get(head.label);
        if (!handler) return stream.abort("no handler");
        handler(stream, head.meta);
      } catch {
        channel.close();
      }
    });
  }

  handle(method: string, fn: (params: unknown) => unknown): () => void {
    this.handlers.set(method, fn);
    return () => this.handlers.delete(method);
  }

  onNotify(method: string, fn: (params: unknown) => void): () => void {
    let set = this.notes.get(method);
    if (!set) this.notes.set(method, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  onStream(label: string, fn: (stream: LinkStream, meta: unknown) => void): () => void {
    this.streamHandlers.set(label, fn);
    return () => this.streamHandlers.delete(label);
  }

  onClose(fn: (reason: string) => void): () => void {
    this.closers.add(fn);
    return () => this.closers.delete(fn);
  }

  private channelFor(priority: LinkPriority | undefined): ChannelLike {
    return priority === "tokens" ? this.tokens : this.control;
  }

  private sendFrame(frame: Frame, priority?: LinkPriority): void {
    const text = JSON.stringify(frame);
    if (text.length > MAX_FRAME) throw new LinkError("invalid", "the message is too large for one frame; use a stream");
    const channel = this.channelFor(priority);
    if (this.closed || channel.readyState !== "open") throw new LinkError("offline", "the link is closed");
    channel.send(text);
  }

  request<R = unknown>(method: string, params: unknown, opts: { priority?: LinkPriority; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<R> {
    if (this.closed) return Promise.reject(new LinkError("offline", "the link is closed"));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LinkError("timeout", `${method} had no answer`));
      }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      opts.signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(new LinkError("cancelled", `${method} was cancelled`));
      });
      try {
        this.sendFrame({ t: "req", id, method, params }, opts.priority);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method: string, params: unknown, opts: { priority?: LinkPriority } = {}): void {
    this.sendFrame({ t: "note", method, params }, opts.priority);
  }

  openStream(label: string, priority: LinkPriority, meta?: unknown): LinkStream {
    if (this.closed) throw new LinkError("offline", "the link is closed");
    const id = `${this.nextStream++}`;
    const channel = this.pc.createDataChannel(`s:${id}`, { ordered: true });
    channel.binaryType = "arraybuffer";
    const stream = new RtcStream(id, label, priority, channel);
    const opened = new Promise<void>((resolve, reject) => {
      channel.onopen = () => {
        channel.send(JSON.stringify({ label, priority, meta }));
        resolve();
      };
      channel.onclose = () => {
        reject(new LinkError("offline", "the stream's channel closed"));
        stream.finish(new LinkError("offline", "the stream's channel closed"));
      };
    });
    opened.catch(() => undefined);
    channel.onmessage = (event) => stream.receive(event.data);
    // Writes wait until the channel is open and its first frame is out.
    const write = stream.write.bind(stream);
    stream.write = async (chunk) => {
      await opened;
      return write(chunk);
    };
    const end = stream.end.bind(stream);
    stream.end = () => void opened.then(end, () => undefined);
    return stream;
  }

  private onFrame(data: unknown): void {
    if (typeof data !== "string") return;
    let frame: Frame;
    try {
      frame = JSON.parse(data) as Frame;
    } catch {
      return;
    }
    if (frame.t === "res" || frame.t === "err") {
      const waiting = this.pending.get(frame.id);
      if (!waiting) return;
      this.pending.delete(frame.id);
      clearTimeout(waiting.timer);
      if (frame.t === "res") waiting.resolve(frame.result);
      else waiting.reject(new LinkError((frame.error.code as LinkErrorCode) ?? "failed", frame.error.message));
      return;
    }
    if (frame.t === "note") {
      for (const fn of [...(this.notes.get(frame.method) ?? [])]) {
        try {
          fn(frame.params);
        } catch {
          // A listener's own failure.
        }
      }
      return;
    }
    if (frame.t === "req") void this.answer(frame);
  }

  private async answer(frame: Extract<Frame, { t: "req" }>): Promise<void> {
    const handler = this.handlers.get(frame.method);
    let reply: Frame;
    if (!handler) reply = { t: "err", id: frame.id, error: { code: "not_found", message: `no method ${frame.method}` } };
    else {
      try {
        reply = { t: "res", id: frame.id, result: (await handler(frame.params)) ?? null };
      } catch (err) {
        const code = err instanceof LinkError ? err.code : typeof (err as { code?: unknown })?.code === "string" ? String((err as { code: string }).code) : "failed";
        reply = { t: "err", id: frame.id, error: { code, message: err instanceof Error ? err.message : "failed" } };
      }
    }
    try {
      this.sendFrame(reply);
    } catch {
      // The link closed while the handler ran: the caller's request fails `offline` on its side.
    }
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new LinkError("offline", reason));
      this.pending.delete(id);
    }
    for (const fn of [...this.closers]) {
      try {
        fn(reason);
      } catch {
        // A listener's own failure.
      }
    }
    try {
      this.pc.close();
    } catch {
      // Closed already.
    }
  }
}
