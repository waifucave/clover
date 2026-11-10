// The worker's end of a plugin's `net.fetch` across the plugin host (fetch-wire.ts has the messages). The plugin calls
// `api.net.fetch(url, init, options)` as it would `fetch`, and gets a real `Response`: its status, its headers, and a
// body that streams in as the plugin reads it.
//
// * The request: its headers as pairs, a body given whole as bytes (a string, bytes, a Blob, a form; its content type
//   kept), or a `ReadableStream` sent in pieces within the credit the daemon gives. The signal stays here: an abort
//   sends `pluginHost.fetchCancel`, and the fetch (or its body) fails with the signal's reason.
// * The response's body: pieces queue here until the plugin reads them; each piece read gives its bytes back to the
//   daemon as credit, so at most a window is ever in flight. Cancelling the body cancels the fetch.
// * A failure is an Error whose `code` is the keyed fetch's (`host_not_declared`, `redirect_refused`, `idle_timeout`,
//   …) when it has one, the contract's otherwise.
//
// Nothing here is a limit the daemon relies on: it enforces every one itself (fetch-daemon.ts).
import { FETCH_LIMITS, fetchErrorFrom, headerPairs } from "./fetch-wire";
import type { RpcPeer } from "./link";

interface State {
  queue: Uint8Array[];
  ended: boolean;
  error?: unknown;
  wake?: () => void;
  /** Upload credit the daemon gave and not yet used. */
  sendCredit: number;
  sendWake?: () => void;
  done: boolean;
}

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

export class WorkerFetches {
  readonly #peer: RpcPeer;
  readonly #open = new Map<string, State>();

  constructor(peer: RpcPeer) {
    this.#peer = peer;
    peer.handle("pluginHost.fetchBody", (x: { fetchId: string; bytes?: Uint8Array; end?: boolean; error?: { code?: unknown; message?: unknown; detail?: unknown } }) => {
      const st = this.#open.get(x.fetchId);
      if (st === undefined) return;
      if (x.bytes !== undefined && x.bytes.length > 0) st.queue.push(x.bytes);
      if (x.error !== undefined) st.error = fetchErrorFrom(x.error);
      if (x.end === true) st.ended = true;
      st.wake?.();
    });
    peer.handle("pluginHost.fetchSendCredit", (x: { fetchId: string; bytes: number }) => {
      const st = this.#open.get(x.fetchId);
      if (st === undefined || typeof x.bytes !== "number") return;
      st.sendCredit += x.bytes;
      st.sendWake?.();
    });
  }

  /** Fetches open now (tests). */
  get open(): number {
    return this.#open.size;
  }

  async fetch(pluginId: string, invocation: string | undefined, args: readonly unknown[]): Promise<Response> {
    const [input, init0, options] = args as [unknown, RequestInit | undefined, Record<string, unknown> | undefined];
    const init = init0 ?? {};
    let url: string;
    let method: string;
    let headers: Headers;
    let body: BodyInit | null | undefined;
    let signal: AbortSignal | undefined;
    if (input instanceof Request) {
      url = input.url;
      method = init.method ?? input.method;
      headers = new Headers(init.headers ?? input.headers);
      body = init.body !== undefined ? init.body : input.body;
      signal = init.signal ?? input.signal;
    } else {
      url = input instanceof URL ? input.href : String(input);
      method = init.method ?? "GET";
      headers = new Headers(init.headers);
      body = init.body;
      signal = init.signal ?? undefined;
    }
    if (signal?.aborted === true) throw abortReason(signal);
    let whole: Uint8Array | undefined;
    let upload: ReadableStream<Uint8Array> | undefined;
    if (body instanceof ReadableStream) upload = body as ReadableStream<Uint8Array>;
    else if (body !== undefined && body !== null) {
      const r = new Response(body);
      whole = new Uint8Array(await r.arrayBuffer());
      const type = r.headers.get("content-type");
      if (type !== null && !headers.has("content-type")) headers.set("content-type", type);
    }
    // The keyed fetch's options as data (a function or a signal there would not cross; they aren't options).
    let opts: Record<string, unknown> | undefined;
    try {
      opts = options === undefined ? undefined : (JSON.parse(JSON.stringify(options)) as Record<string, unknown>);
    } catch {
      opts = undefined;
    }

    const fetchId = `fetch_${crypto.randomUUID()}`;
    const st: State = { queue: [], ended: false, sendCredit: 0, done: false };
    this.#open.set(fetchId, st);
    const end = () => {
      if (st.done) return;
      st.done = true;
      this.#open.delete(fetchId);
      signal?.removeEventListener("abort", onAbort);
      st.wake?.();
      st.sendWake?.();
    };
    const cancel = () => {
      if (st.done) return;
      this.#peer.notify("pluginHost.fetchCancel", { pluginId, fetchId });
      end();
    };
    const onAbort = () => {
      st.error ??= abortReason(signal!);
      cancel();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (upload !== undefined) void this.#upload(pluginId, fetchId, st, upload, cancel);

    let head: { status: number; statusText: string; headers: [string, string][]; body: boolean };
    try {
      head = (await this.#peer.request("pluginHost.fetch", {
        pluginId, fetchId, url, method, headers: headerPairs(headers),
        ...(whole !== undefined ? { body: whole } : {}),
        ...(upload !== undefined ? { upload: true } : {}),
        ...(opts !== undefined ? { options: opts } : {}),
        ...(invocation !== undefined ? { invocation } : {}),
      })) as typeof head;
    } catch (err) {
      end();
      // The plugin's abort may have come while the head was on its way.
      const s = signal as AbortSignal | undefined;
      if (s?.aborted === true) throw abortReason(s);
      throw fetchErrorFrom(err as { code?: unknown; message?: unknown; detail?: unknown });
    }
    if (!head.body) end();
    const stream = !head.body
      ? null
      : new ReadableStream<Uint8Array>(
          {
            pull: async (c) => {
              for (;;) {
                const piece = st.queue.shift();
                if (piece !== undefined) {
                  c.enqueue(piece);
                  if (!st.done) this.#peer.notify("pluginHost.fetchCredit", { pluginId, fetchId, bytes: piece.length });
                  return;
                }
                if (st.error !== undefined) {
                  end();
                  c.error(st.error);
                  return;
                }
                if (st.ended) {
                  end();
                  c.close();
                  return;
                }
                if (st.done) {
                  c.error(new DOMException("The operation was aborted.", "AbortError"));
                  return;
                }
                await new Promise<void>((r) => { st.wake = r; });
                st.wake = undefined;
              }
            },
            cancel: () => cancel(),
          },
          { highWaterMark: 0 },
        );
    return new Response(stream, { status: head.status, statusText: head.statusText, headers: head.headers });
  }

  /** Sends a streamed request body in pieces, only within the credit the daemon gave. */
  async #upload(pluginId: string, fetchId: string, st: State, body: ReadableStream<Uint8Array>, cancel: () => void): Promise<void> {
    const reader = body.getReader();
    let seq = 0;
    try {
      for (;;) {
        if (st.done) return void reader.cancel().catch(() => {});
        const r = await reader.read();
        if (r.done) {
          if (!st.done) this.#peer.notify("pluginHost.fetchSend", { pluginId, fetchId, seq: seq++, end: true });
          return;
        }
        const value: unknown = r.value;
        let bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
        while (bytes.length > 0) {
          while (st.sendCredit <= 0 && !st.done) {
            await new Promise<void>((w) => { st.sendWake = w; });
            st.sendWake = undefined;
          }
          if (st.done) return void reader.cancel().catch(() => {});
          const n = Math.min(bytes.length, st.sendCredit, FETCH_LIMITS.chunkBytes);
          this.#peer.notify("pluginHost.fetchSend", { pluginId, fetchId, seq: seq++, bytes: bytes.slice(0, n) });
          st.sendCredit -= n;
          bytes = bytes.subarray(n);
        }
      }
    } catch (err) {
      st.error ??= err;
      cancel();
    }
  }
}
