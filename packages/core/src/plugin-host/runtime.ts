// The plugin host's own side (spec §5.2, §5.4): what runs inside a plugin-host process and serves the daemon's
// `pluginHost.*` calls for the host halves it was given. It never decides anything the core decides: the daemon
// starts, stops and times calls, applies the crash rules and binds callers; this side runs the module, hands each
// handler its context, and carries the module's plugin-API calls back.
//
// * Each API call is stamped with the plugin of the module that made it (review S3), from this side's own table,
//   never from the call's arguments, and with the open call it was made inside (R7): a handler's own `ctx.api` carries
//   its call's id until the call ends, then rejects `closed` (#179's review, S1); a `host` MCP server's API calls carry
//   the id of the `tools/call` they were made while serving (an `AsyncLocalStorage` scope over its `onmessage`), and
//   a call made outside any carries none and acts as the plugin.
// * The core's id on an MCP request (`_meta["clover/invocation"]`) is taken off before the plugin's server sees it.
// * A listener (a watch's) stays here: the daemon gets `{ "$listener": true }`, answers with a subscription, and
//   delivers values with `pluginHost.deliver`; the watch returns its `Unsubscribe` at once, as the SDK types say.
// * Streams: a handler's async iterable goes back value by value (`pluginHost.chunk`, in order), its return value as
//   the call's result; a streamed input arrives as `pluginHost.feed` pieces and reaches the handler as `ctx.input`.
//
// Modules come from `load`: in a plugin-host process, the plugin's built entry in its own worker; in the conformance
// harness, modules a test defines.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Caller, HostProcess } from "@waifucave/clover-protocol";
// What a host half's `api` has (the catalog's rule), shared with the contracts' fake host.
import { apiHas, apiMemberValue, isDataFolder } from "./api-members";
export { apiHas, apiMember, HARMLESS_KEYS, isDataFolder } from "./api-members";
import { ContractError } from "../contracts/common";
import { MCP_INVOCATION_META, resolveHandler } from "../contracts/plugin-host";
import type { HandlerContext, HostModule, McpServerTransport, PluginApi } from "../contracts/sdk-types";
import { LISTENER_ARG } from "./api-channel";
import type { RpcPeer } from "./link";
import { WorkerFetches } from "./fetch-worker";

export interface StartParams {
  pluginId: string;
  /** The plugin's own folder, which its entry is in. */
  folder: string;
  /** Its top-level plugin's folder: the one its worker's load guard holds it to (a child's code may use its tree's). */
  root?: string;
  entry: string;
  runtime: "bun" | "node";
  dataFolder: string;
  process: HostProcess;
  /** A bundled plugin's verified files (`HostedRecord.verified`). */
  verified?: VerifiedFiles;
  /** What `api.plugin` says about the plugin (`HostedRecord.self`): plain data, never a call. */
  self?: { namespace: string; version: string; device?: string };
}

/** A bundled plugin tree's files, each by its real path, with the SHA-256 its staging verified. */
export interface VerifiedFiles {
  /** The tree's real folder: every module loaded from under it is checked. */
  root: string;
  files: Record<string, string>;
}

export interface InvokeParams {
  callId: string;
  pluginId: string;
  handler: string;
  method?: string;
  /** A component's `host.call`: the module's `ui` table only. */
  ui?: boolean;
  args: unknown;
  caller: Caller;
  session?: string;
  timeoutMs: number;
  deadline?: number;
  stream?: boolean;
  input?: boolean;
}

interface Running {
  module: HostModule;
  /** `api.plugin`, as plain data (J's review: a callable proxy there broke `initialize` in clover/browser). */
  self: Readonly<{ id: string; namespace: string; version: string; computer: string; device?: string }>;
  /** `api.storage.dataFolder`: its data folder's path, as data (`<home>/plugin-data/<id>`, made before it starts). */
  dataFolder: string;
  calls: Map<string, { abort: AbortController; input?: InputQueue; live: boolean }>;
  subs: Map<string, (value: unknown) => void>;
  mcp: Map<string, McpServerTransport & { closed: boolean }>;
}

/** A streamed input's pieces, in `seq` order, as an async iterable. */
class InputQueue implements AsyncIterable<unknown> {
  readonly #buffered = new Map<number, { value?: unknown; end?: boolean }>();
  #next = 0;
  #ended = false;
  #wake: (() => void) | undefined;

  push(seq: number, value: unknown, end: boolean): void {
    this.#buffered.set(seq, end ? { end: true } : { value });
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      const piece = this.#buffered.get(this.#next);
      if (piece !== undefined) {
        this.#buffered.delete(this.#next++);
        if (piece.end) return;
        yield piece.value;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }
}

export interface HostRuntimeOptions {
  peer: RpcPeer;
  computer: string;
  load(params: StartParams): Promise<HostModule> | HostModule;
  now?: () => number;
}

/** The plugin-API call a rejection came from (`settings.get`), on the error a plugin's API call rejects with. */
export const API_CALL_OF = Symbol.for("clover.pluginApiCall");

/** A failed plugin-API call's error, marked with the call: a plugin that doesn't await or catch it gets a line in its
 *  log naming the call (worker-main.ts), and its worker goes on. A failed call is the call's failure, never the
 *  worker's: only the worker dying or missing the heartbeat is a crash (contracts/plugin-host.ts). */
function apiFailure(err: unknown, call: string): unknown {
  if (err !== null && typeof err === "object") {
    try {
      Object.defineProperty(err, API_CALL_OF, { value: call, enumerable: false });
    } catch {
      // a frozen error goes as it is
    }
  }
  return err;
}

export class HostRuntime {
  readonly #o: HostRuntimeOptions;
  readonly #running = new Map<string, Running>();
  /** The open call an MCP server's code runs inside (R7). */
  readonly #scope = new AsyncLocalStorage<string | undefined>();
  #apiSeq = 0;
  /** The plugins' `net.fetch` across the link (fetch-worker.ts). */
  readonly #fetches: WorkerFetches;

  constructor(o: HostRuntimeOptions) {
    this.#o = o;
    const p = o.peer;
    this.#fetches = new WorkerFetches(p);
    p.handle("pluginHost.start", (x: StartParams) => this.#start(x));
    p.handle("pluginHost.stop", (x: { pluginId: string; reason: string }) => this.#stop(x.pluginId, x.reason));
    p.handle("pluginHost.invoke", (x: InvokeParams) => this.#invoke(x));
    p.handle("pluginHost.cancel", (x: { callId: string }) => this.#cancel(x.callId));
    p.handle("pluginHost.feed", (x: { callId: string; seq: number; value?: unknown; end?: boolean }) => this.#feed(x));
    p.handle("pluginHost.deliver", (x: { pluginId: string; subscription: string; value: unknown }) => this.#running.get(x.pluginId)?.subs.get(x.subscription)?.(x.value));
    p.handle("pluginHost.mcpOpen", (x: { pluginId: string; server: string; channel: string }) => this.#mcpOpen(x));
    p.handle("pluginHost.mcpMessage", (x: { channel: string; message: Record<string, unknown> }) => this.#mcpMessage(x));
    p.handle("pluginHost.mcpClose", (x: { channel: string }) => this.#mcpClose(x.channel));
  }

  /** The module's worker died (a crash, a missed heartbeat): it is dropped here, its calls abandoned. The daemon
   *  applies the crash rules. */
  drop(pluginId: string): void {
    const r = this.#running.get(pluginId);
    if (r === undefined) return;
    this.#running.delete(pluginId);
    for (const c of r.calls.values()) c.abort.abort(new ContractError("failed", "the plugin crashed"));
    for (const t of r.mcp.values()) t.closed = true;
  }

  async #start(x: StartParams): Promise<{ ok: true }> {
    if (this.#running.has(x.pluginId)) return { ok: true };
    const module = await this.#o.load(x);
    const self = Object.freeze({
      id: x.pluginId, namespace: x.self?.namespace ?? x.pluginId.split("/")[0]!, version: x.self?.version ?? "0.0.0", computer: this.#o.computer,
      ...(x.self?.device !== undefined ? { device: x.self.device } : {}),
    });
    const r: Running = { module, self, dataFolder: x.dataFolder, calls: new Map(), subs: new Map(), mcp: new Map() };
    this.#running.set(x.pluginId, r);
    try {
      await module.start?.(this.#apiFor(x.pluginId));
    } catch (err) {
      this.#running.delete(x.pluginId);
      throw new ContractError("failed", `start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true };
  }

  async #stop(pluginId: string, reason: string): Promise<{ ok: true }> {
    const r = this.#running.get(pluginId);
    if (r === undefined) return { ok: true };
    this.#running.delete(pluginId);
    for (const c of r.calls.values()) c.abort.abort(new ContractError("cancelled", "the plugin stopped"));
    for (const t of r.mcp.values()) if (!t.closed) (t.closed = true), t.onclose?.();
    try {
      await r.module.stop?.(reason === "reload" || reason === "removed" ? reason : "stop");
    } catch {
      // A failing stop doesn't keep the module running.
    }
    return { ok: true };
  }

  async #invoke(x: InvokeParams): Promise<{ result: unknown }> {
    const r = this.#running.get(x.pluginId);
    if (r === undefined) throw new ContractError("plugin_stopped", `${x.pluginId} isn't running here`);
    const target = resolveHandler(r.module, x.handler, x.method, { ui: x.ui === true });
    if (target === undefined) {
      throw new ContractError("not_installed", `${x.pluginId} has no handler \`${x.method === undefined ? x.handler : `${x.handler}.${x.method}`}\``);
    }
    const abort = new AbortController();
    const call: { abort: AbortController; input?: InputQueue; live: boolean } = { abort, live: true, ...(x.input ? { input: new InputQueue() } : {}) };
    r.calls.set(x.callId, call);
    const ctx: HandlerContext = {
      caller: x.caller,
      ...(x.session === undefined ? {} : { session: x.session }),
      computer: this.#o.computer,
      signal: abort.signal,
      deadline: x.deadline ?? (this.#o.now ?? Date.now)() + x.timeoutMs,
      api: this.#apiFor(x.pluginId, x.callId, () => call.live),
      ...(call.input ? { input: call.input } : {}),
    };
    try {
      const out = await target.fn.call(target.self, x.args, ctx);
      if (!x.stream) return { result: out };
      const it = out as AsyncIterable<unknown> | undefined;
      if (it === null || typeof it !== "object" || typeof (it as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
        throw new ContractError("failed", `${x.pluginId}.${x.handler} returned no stream`);
      }
      const iterator = it[Symbol.asyncIterator]();
      let seq = 0;
      try {
        for (;;) {
          if (abort.signal.aborted) throw abort.signal.reason;
          const next = await iterator.next();
          if (next.done) return { result: next.value };
          this.#o.peer.notify("pluginHost.chunk", { callId: x.callId, seq: seq++, value: next.value });
        }
      } finally {
        if (abort.signal.aborted) void iterator.return?.(undefined);
      }
    } catch (err) {
      if (err instanceof ContractError) throw err;
      throw new ContractError("failed", err instanceof Error ? err.message : String(err));
    } finally {
      call.live = false;
      call.input?.end();
      r.calls.delete(x.callId);
    }
  }

  #cancel(callId: string): { ok: true } {
    for (const r of this.#running.values()) r.calls.get(callId)?.abort.abort(new ContractError("cancelled", "the call was cancelled"));
    return { ok: true };
  }

  #feed(x: { callId: string; seq: number; value?: unknown; end?: boolean }): { ok: true } {
    for (const r of this.#running.values()) r.calls.get(x.callId)?.input?.push(x.seq, x.value, x.end === true);
    return { ok: true };
  }

  async #mcpOpen(x: { pluginId: string; server: string; channel: string }): Promise<{ ok: true }> {
    const r = this.#running.get(x.pluginId);
    if (r === undefined) throw new ContractError("plugin_stopped", `${x.pluginId} isn't running here`);
    const serve = r.module.mcp?.[x.server];
    if (typeof serve !== "function") throw new ContractError("not_installed", `${x.pluginId} serves no MCP server \`${x.server}\``);
    const peer = this.#o.peer;
    const transport: McpServerTransport & { closed: boolean } = {
      closed: false,
      start: async () => {},
      send: async (message) => {
        if (!transport.closed) peer.notify("pluginHost.mcpMessage", { channel: x.channel, message });
      },
      close: async () => {
        if (transport.closed) return;
        transport.closed = true;
        r.mcp.delete(x.channel);
        peer.notify("pluginHost.mcpClose", { channel: x.channel });
        transport.onclose?.();
      },
    };
    r.mcp.set(x.channel, transport);
    await serve(transport, this.#apiFor(x.pluginId));
    return { ok: true };
  }

  #mcpMessage(x: { channel: string; message: Record<string, unknown> }): void {
    for (const r of this.#running.values()) {
      const t = r.mcp.get(x.channel);
      if (t === undefined || t.closed) continue;
      const message = x.message;
      const params = message.params as { _meta?: Record<string, unknown> } | undefined;
      let invocation: string | undefined;
      if (params?._meta !== undefined && MCP_INVOCATION_META in params._meta) {
        const v = params._meta[MCP_INVOCATION_META];
        invocation = typeof v === "string" ? v : undefined;
        delete params._meta[MCP_INVOCATION_META];
      }
      this.#scope.run(invocation, () => t.onmessage?.(message));
    }
  }

  #mcpClose(channel: string): void {
    for (const r of this.#running.values()) {
      const t = r.mcp.get(channel);
      if (t === undefined) continue;
      r.mcp.delete(channel);
      if (!t.closed) (t.closed = true), t.onclose?.();
    }
  }

  /** `audio.play` from a host half: the audio crosses as pieces of one utterance (a whole clip as one piece), the last
   *  `final`; the answer is `{ stop, done }` once the first piece is taken (a refusal fails the call). `stop` sends no
   *  more and ends the utterance; `done` settles once its last piece went. */
  async #audioPlay(pluginId: string, inside: string | undefined, args: unknown[]): Promise<{ stop(): void; done: Promise<void> }> {
    const peer = this.#o.peer;
    const audio = (args[0] ?? {}) as { format?: unknown; data?: unknown };
    const opts = args[1];
    const utterance = `pa_${crypto.randomUUID()}`;
    let seq = 0;
    let stopped = false;
    const piece = (data: Uint8Array, final: boolean) => peer.request("pluginHost.api", {
      pluginId, callId: `api_${++this.#apiSeq}`, call: "audio.play",
      args: [{ format: audio.format, data }, opts ?? {}, { utterance, seq: seq++, final }],
      ...(inside === undefined ? {} : { invocation: inside }),
    }).then(() => undefined, (err: unknown) => { throw apiFailure(err, "audio.play"); });
    const data = audio.data;
    if (data instanceof Uint8Array) {
      await piece(data, true);
      return { stop: () => {}, done: Promise.resolve() };
    }
    if (data === null || typeof data !== "object" || typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
      throw apiFailure(new ContractError("invalid", "audio.play's data is bytes (a Uint8Array) or an async iterable of them"), "audio.play");
    }
    const it = (data as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const first = await it.next();
    if (first.done) {
      await piece(new Uint8Array(0), true);
      return { stop: () => {}, done: Promise.resolve() };
    }
    if (!(first.value instanceof Uint8Array)) throw apiFailure(new ContractError("invalid", "audio.play's stream gives Uint8Array pieces"), "audio.play");
    await piece(first.value, false);
    const done = (async () => {
      for (;;) {
        if (stopped) break;
        const next = await it.next();
        if (next.done || stopped) break;
        if (!(next.value instanceof Uint8Array)) throw apiFailure(new ContractError("invalid", "audio.play's stream gives Uint8Array pieces"), "audio.play");
        await piece(next.value, false);
      }
      await piece(new Uint8Array(0), true);
    })();
    done.catch(() => {});
    return { stop: () => { stopped = true; void it.return?.(); }, done };
  }

  /** The plugin API for one plugin: every call, at any depth, goes to the daemon by its dotted path, stamped with this
   *  plugin and the open call it is made inside (see the file's header). */
  #apiFor(pluginId: string, invocation?: string, live?: () => boolean): PluginApi {
    const peer = this.#o.peer;
    const make = (path: string[]): unknown =>
      new Proxy(() => {}, {
        get: (_t, prop) => {
          // `api.plugin` is data (`PluginSelf`): plain strings a plugin can put in a message, never a call.
          if (path.length === 0 && prop === "plugin") return this.#running.get(pluginId)?.self;
          // `api.storage.dataFolder` is data too: its own folder's path, a string (the SDK's `StorageApi`).
          if (isDataFolder(path, prop)) return this.#running.get(pluginId)?.dataFolder;
          // A member the catalog doesn't have fails here, by name, not later as a function where a value was meant
          // (`api.env?.X` was a callable proxy, and the mistake surfaced somewhere else).
          return apiMemberValue(path, prop, make);
        },
        // Feature-testing (`"files" in api`): true for a call (or an area with one) a host half can use, false for anything
        // else, a call not served yet included; never a throw.
        has: (_t, prop) => isDataFolder(path, prop) || apiHas(path, prop),
        apply: (_t, _this, args: unknown[]) => {
          const call = path.join(".");
          if (live && !live()) return Promise.reject(apiFailure(new ContractError("closed", `${call}: this call's \`ctx.api\` ended with the call; a plugin acting later acts as itself`), call));
          const inside = invocation ?? this.#scope.getStore();
          // `net.fetch` crosses as its own messages: a RequestInit and a Response can't go as call arguments.
          if (call === "net.fetch") return this.#fetches.fetch(pluginId, inside, args).catch((err: unknown) => { throw apiFailure(err, call); });
          // `audio.play` answers `{ stop, done }`, and its audio may be a stream: it crosses a piece at a time.
          if (call === "audio.play") return this.#audioPlay(pluginId, inside, args);
          const listeners = args.filter((a) => typeof a === "function");
          const wire = args.map((a) => (typeof a === "function" ? { [LISTENER_ARG]: true } : a));
          const params = { pluginId, callId: `api_${++this.#apiSeq}`, call, args: wire, ...(inside === undefined ? {} : { invocation: inside }) };
          if (listeners.length === 0) return peer.request("pluginHost.api", params).then((r) => (r as { result: unknown }).result, (err: unknown) => { throw apiFailure(err, call); });
          // A watch: the listener stays here and the Unsubscribe is returned at once.
          const listener = listeners[0] as (v: unknown) => void;
          let subscription: string | undefined;
          let stopped = false;
          void peer.request("pluginHost.api", params).then(
            (r) => {
              subscription = ((r as { result?: { subscription?: string } }).result ?? {}).subscription;
              if (subscription === undefined) return;
              if (stopped) return void peer.request("pluginHost.unwatch", { pluginId, subscription }).catch(() => {});
              this.#running.get(pluginId)?.subs.set(subscription, listener);
            },
            () => {},
          );
          return () => {
            stopped = true;
            if (subscription === undefined) return;
            this.#running.get(pluginId)?.subs.delete(subscription);
            void peer.request("pluginHost.unwatch", { pluginId, subscription }).catch(() => {});
          };
        },
      });
    return make([]) as PluginApi;
  }
}
