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
import { ContractError } from "../contracts/common";
import { MCP_INVOCATION_META, resolveHandler } from "../contracts/plugin-host";
import type { HandlerContext, HostModule, McpServerTransport, PluginApi } from "../contracts/sdk-types";
import { LISTENER_ARG } from "./api-channel";
import type { RpcPeer } from "./link";

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

export class HostRuntime {
  readonly #o: HostRuntimeOptions;
  readonly #running = new Map<string, Running>();
  /** The open call an MCP server's code runs inside (R7). */
  readonly #scope = new AsyncLocalStorage<string | undefined>();
  #apiSeq = 0;

  constructor(o: HostRuntimeOptions) {
    this.#o = o;
    const p = o.peer;
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
    const r: Running = { module, calls: new Map(), subs: new Map(), mcp: new Map() };
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
    const target = resolveHandler(r.module, x.handler, x.method);
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

  /** The plugin API for one plugin: every call, at any depth, goes to the daemon by its dotted path, stamped with this
   *  plugin and the open call it is made inside (see the file's header). */
  #apiFor(pluginId: string, invocation?: string, live?: () => boolean): PluginApi {
    const peer = this.#o.peer;
    const make = (path: string[]): unknown =>
      new Proxy(() => {}, {
        get: (_t, prop) => (typeof prop === "string" && prop !== "then" ? make([...path, prop]) : undefined),
        apply: (_t, _this, args: unknown[]) => {
          const call = path.join(".");
          if (live && !live()) return Promise.reject(new ContractError("closed", `${call}: this call's \`ctx.api\` ended with the call; a plugin acting later acts as itself`));
          const inside = invocation ?? this.#scope.getStore();
          const listeners = args.filter((a) => typeof a === "function");
          const wire = args.map((a) => (typeof a === "function" ? { [LISTENER_ARG]: true } : a));
          const params = { pluginId, callId: `api_${++this.#apiSeq}`, call, args: wire, ...(inside === undefined ? {} : { invocation: inside }) };
          if (listeners.length === 0) return peer.request("pluginHost.api", params).then((r) => (r as { result: unknown }).result);
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
