// The daemon's end of a plugin's `net.fetch` across the plugin host (fetch-wire.ts has the messages): one per
// plugin-host process connection, beside `apiChannel`. The request goes to the same router as every plugin-API call
// (`net.fetch` on B's gate: the call exists there, the plugin is on and running, its OK granted the host), with a body
// given whole or streamed in, and an abort that the plugin's cancel reaches; the response's head is the call's answer,
// its body goes back in pieces.
//
// Every limit is enforced here, never trusted to the worker (the worker is the plugin's code; the plugin-host process
// runs it): a bounded body, header pairs and bytes, fetches open per plugin and per process, a URL's length, ids that
// are open (another plugin's included), and the credit windows. An upload piece past the credit the daemon gave, past
// `chunkBytes`, or out of order cuts the fetch off (its request aborted), never buffered. A body message, a credit or a
// cancel naming a fetch another plugin opened changes nothing.
import type { HostProcess } from "@waifucave/clover-protocol";
import { PLUGINS_METHODS } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { ApiRouter } from "../contracts/plugin-host";
import { handler, type MethodHandler } from "../rpc/handler";
import { FETCH_LIMITS, fetchFailure, headerPairs } from "./fetch-wire";
import type { InvocationTable } from "./invocations";
import { errorToWire } from "./link";

export interface FetchChannelOptions {
  process: HostProcess;
  router: ApiRouter;
  invocations: InvocationTable;
  /** Sends a notification to the process on this connection. */
  send(method: string, params: unknown): void;
  /** Tests only: smaller limits. */
  limits?: Partial<{ -readonly [K in keyof typeof FETCH_LIMITS]: number }>;
}

export interface FetchChannel {
  methods: Record<string, MethodHandler>;
  /** The connection closed: every open fetch is aborted. */
  closeAll(): void;
  /** Fetches open now, for tests and status. */
  readonly open: number;
}

interface Upload {
  /** Credit given and not yet used. */
  outstanding: number;
  nextSeq: number;
  queue: Uint8Array[];
  ended: boolean;
  wake?: () => void;
}

interface Open {
  pluginId: string;
  abort: AbortController;
  upload?: Upload;
  /** Body bytes the worker takes now. */
  credit: number;
  seq: number;
  creditWake?: () => void;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  /** The head was answered: a failure now goes as `fetchBody`'s error. */
  answered: boolean;
  done: boolean;
  /** Why the daemon cut it off. */
  cut?: string;
}

export function fetchChannel(o: FetchChannelOptions): FetchChannel {
  const L = { ...FETCH_LIMITS, ...(o.limits ?? {}) };
  const M = PLUGINS_METHODS;
  const opens = new Map<string, Open>();
  const countOf = (pluginId: string) => {
    let n = 0;
    for (const f of opens.values()) if (f.pluginId === pluginId) n++;
    return n;
  };

  /** Ends a fetch: its request aborted (unless it ended), its body read no further, its slot released. */
  const finish = (id: string, f: Open, why?: string) => {
    if (f.done) return;
    f.done = true;
    if (opens.get(id) === f) opens.delete(id);
    if (why !== undefined) {
      f.cut = why;
      f.abort.abort(new ContractError("refused", why));
    } else f.abort.abort(new ContractError("cancelled", "the plugin let go of the fetch"));
    void f.reader?.cancel().catch(() => {});
    f.upload?.wake?.();
    f.creditWake?.();
  };

  /** Cuts a fetch off for breaking a rule: aborted, and the worker told why when its head was answered. */
  const cutOff = (id: string, f: Open, why: string) => {
    if (f.done) return;
    const answered = f.answered;
    finish(id, f, why);
    if (answered) o.send(M.pluginHostFetchBody.name, { fetchId: id, seq: f.seq, error: errorToWire(new ContractError("refused", why)) });
  };

  const uploadStream = (id: string, f: Open, up: Upload): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>(
      {
        pull: async (c) => {
          for (;;) {
            if (f.done) {
              c.error(new ContractError("cancelled", f.cut ?? "the fetch ended"));
              return;
            }
            const next = up.queue.shift();
            if (next !== undefined) {
              c.enqueue(next);
              return;
            }
            if (up.ended) {
              c.close();
              return;
            }
            // Nothing queued and no credit out: give the next window, then wait for a piece.
            if (up.outstanding === 0) {
              up.outstanding = L.window;
              o.send(M.pluginHostFetchSendCredit.name, { fetchId: id, bytes: L.window });
            }
            await new Promise<void>((r) => { up.wake = r; });
            up.wake = undefined;
          }
        },
        cancel: () => finish(id, f),
      },
      { highWaterMark: 0 },
    );

  /** Sends the body back within the worker's credit, in pieces of at most `chunkBytes`. */
  const pump = async (id: string, f: Open, body: ReadableStream<Uint8Array>) => {
    const reader = (f.reader = body.getReader());
    let pending: Uint8Array | undefined;
    try {
      for (;;) {
        if (f.done) return;
        if (pending === undefined || pending.length === 0) {
          const r = await reader.read();
          if (f.done) return;
          if (r.done) {
            finish(id, f);
            o.send(M.pluginHostFetchBody.name, { fetchId: id, seq: f.seq++, end: true });
            return;
          }
          pending = r.value;
          continue;
        }
        if (f.credit <= 0) {
          // Nobody reads the body (no credit back): held at most `creditWaitMs`, then the fetch ends, its slot freed.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const credited = await new Promise<boolean>((r) => {
            f.creditWake = () => r(true);
            timer = setTimeout(() => r(false), L.creditWaitMs);
          });
          clearTimeout(timer);
          f.creditWake = undefined;
          if (!credited && !f.done && f.credit <= 0) {
            const why = `nobody read the response body for ${Math.round(L.creditWaitMs / 1000)} s: the fetch was ended and its slot freed`;
            finish(id, f, why);
            o.send(M.pluginHostFetchBody.name, { fetchId: id, seq: f.seq++, error: errorToWire(new ContractError("timeout", why)) });
            return;
          }
          continue;
        }
        const n = Math.min(pending.length, f.credit, L.chunkBytes);
        const piece = pending.slice(0, n);
        pending = pending.subarray(n);
        f.credit -= n;
        o.send(M.pluginHostFetchBody.name, { fetchId: id, seq: f.seq++, bytes: piece });
      }
    } catch (err) {
      if (f.done) return;
      finish(id, f);
      o.send(M.pluginHostFetchBody.name, { fetchId: id, seq: f.seq++, error: errorToWire(fetchFailure(err)) });
    }
  };

  const mine = (p: { pluginId: string; fetchId: string }): Open | undefined => {
    const f = opens.get(p.fetchId);
    return f !== undefined && f.pluginId === p.pluginId && !f.done ? f : undefined;
  };

  const methods: Record<string, MethodHandler> = {
    // Its failure crosses as the contract's error with its detail (the keyed fetch's code in `detail.fetch`), which
    // `handler`'s mapping would drop: the params are checked the same way.
    [M.pluginHostFetch.name]: async (raw) => {
      const parsed = M.pluginHostFetch.params.safeParse(raw);
      if (!parsed.success) throw new ContractError("invalid", `pluginHost.fetch: ${parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ")}`);
      const p = parsed.data;
      if (opens.has(p.fetchId)) throw new ContractError("refused", "a fetch with this id is open");
      if (countOf(p.pluginId) >= L.perPlugin) throw new ContractError("refused", `${p.pluginId} has ${L.perPlugin} fetches open, the most one plugin may`);
      if (opens.size >= L.perProcess) throw new ContractError("refused", `this plugin host has ${L.perProcess} fetches open, the most one process may`);
      if (p.url.length > L.urlChars) throw new ContractError("invalid", `a fetch's URL is at most ${L.urlChars} characters`);
      if (p.headers.length > L.headerPairs) throw new ContractError("invalid", `a fetch takes at most ${L.headerPairs} headers`);
      let headerBytes = 0;
      for (const [n, v] of p.headers) headerBytes += Buffer.byteLength(n) + Buffer.byteLength(v);
      if (headerBytes > L.headerBytes) throw new ContractError("invalid", `a fetch's headers are at most ${L.headerBytes} bytes`);
      if (p.body !== undefined && p.body.length > L.bodyBytes) throw new ContractError("invalid", `a body given whole is at most ${L.bodyBytes} bytes; a bigger one goes as a stream`);
      if (p.body !== undefined && p.upload === true) throw new ContractError("invalid", "a fetch's body is given whole or streamed, not both");
      let headers: Headers;
      try {
        headers = new Headers(p.headers);
      } catch {
        throw new ContractError("invalid", "a fetch's headers aren't valid HTTP headers");
      }
      const caller = o.invocations.callerFor(p.pluginId, p.invocation);
      const f: Open = { pluginId: p.pluginId, abort: new AbortController(), credit: L.window, seq: 0, answered: false, done: false };
      if (p.upload === true) f.upload = { outstanding: 0, nextSeq: 0, queue: [], ended: false };
      opens.set(p.fetchId, f);
      const init: RequestInit = {
        method: p.method,
        headers,
        signal: f.abort.signal,
        ...(p.body !== undefined ? { body: p.body } : f.upload !== undefined ? { body: uploadStream(p.fetchId, f, f.upload) } : {}),
      };
      let response: unknown;
      try {
        response = await o.router({ pluginId: p.pluginId, process: o.process, path: "net.fetch", args: [p.url, init, p.options ?? {}], caller });
      } catch (err) {
        const cut = f.cut;
        finish(p.fetchId, f);
        throw cut !== undefined ? new ContractError("refused", cut) : fetchFailure(err);
      }
      if (!(response instanceof Response)) {
        finish(p.fetchId, f);
        throw new ContractError("failed", "net.fetch answered no response");
      }
      if (f.done) {
        void response.body?.cancel().catch(() => {});
        throw new ContractError(f.cut !== undefined ? "refused" : "cancelled", f.cut ?? "the plugin let go of the fetch");
      }
      f.answered = true;
      const head = { status: response.status, statusText: response.statusText, headers: headerPairs(response.headers), body: response.body !== null };
      if (response.body === null) finish(p.fetchId, f);
      else void pump(p.fetchId, f, response.body);
      return head;
    },
    [M.pluginHostFetchSend.name]: handler(M.pluginHostFetchSend, (p) => {
      const f = mine(p);
      const up = f?.upload;
      if (f === undefined || up === undefined) return { ok: true as const };
      if (up.ended) return void cutOff(p.fetchId, f, "the upload sent a piece after its end"), { ok: true as const };
      if (p.seq !== up.nextSeq) return void cutOff(p.fetchId, f, `the upload's piece ${p.seq} came out of order (expected ${up.nextSeq})`), { ok: true as const };
      up.nextSeq++;
      const bytes = p.bytes;
      if (bytes !== undefined && bytes.length > 0) {
        if (bytes.length > L.chunkBytes) return void cutOff(p.fetchId, f, `the upload sent a piece of ${bytes.length} bytes; at most ${L.chunkBytes}`), { ok: true as const };
        if (bytes.length > up.outstanding) return void cutOff(p.fetchId, f, "the upload sent past the credit it was given"), { ok: true as const };
        up.outstanding -= bytes.length;
        up.queue.push(bytes);
      }
      if (p.end === true) up.ended = true;
      up.wake?.();
      return { ok: true as const };
    }),
    [M.pluginHostFetchCredit.name]: handler(M.pluginHostFetchCredit, (p) => {
      const f = mine(p);
      if (f === undefined) return { ok: true as const };
      // Never more than a window: an inflated credit doesn't make the daemon read faster.
      f.credit = Math.min(L.window, f.credit + p.bytes);
      f.creditWake?.();
      return { ok: true as const };
    }),
    [M.pluginHostFetchCancel.name]: handler(M.pluginHostFetchCancel, (p) => {
      const f = mine(p);
      if (f !== undefined) finish(p.fetchId, f);
      return { ok: true as const };
    }),
  };

  return {
    methods,
    closeAll() {
      for (const [id, f] of [...opens]) finish(id, f);
    },
    get open() {
      return opens.size;
    },
  };
}
