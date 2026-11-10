// The daemon's side of the plugin host (the PluginHost contract; spec §5.1 "Crashes and logs", §5.2, §5.4 "Limits").
// It runs no plugin code: it starts host halves in the plugin-host processes over their links (`RpcPeer`), times every
// call, applies the crash rules, binds each API call's caller (R7) and serves the plugin API's router.
//
// * The process a plugin runs in is the core's choice from its install record (`hostProcessFor`): the `clover`
//   process, the shared one, or one of its own; `connect` gives the link to it (a process of the plugin's own per
//   plugin). A link answers only for the plugins the core started on it: an API call naming another is refused by
//   `guardApiRouter` in front of the router.
// * Limits: 10 seconds by default, at most 10 minutes unless the call keeps its own (`ownLimit`); waiting for a start
//   or a restart counts. A call past its limit fails `timeout`, an aborted one `cancelled`, and the host is told to
//   cancel it.
// * Crashes: a worker that dies or misses the heartbeat (`pluginHost.state`), or a start that throws, is a crash: the
//   calls in it fail, and it restarts after 1 s, the delay doubling to a minute; the third crash in 10 minutes stops it
//   until the user's restart.
// * Reload: calls in flight get `RELOAD_GRACE_MS`, then fail interrupted (`cancelled`), and the new module starts.
// * R7: every call into a plugin opens an invocation (`InvocationTable`) for the API calls made inside it; an MCP
//   request sent `as` a caller gets a fresh id under `_meta["clover/invocation"]` (any id it carried is replaced, and
//   one sent with no caller has it removed), and the invocation ends with the server's answer to that request.
import { randomUUID } from "node:crypto";
import type { Caller, HostProcess } from "@waifucave/clover-protocol";
import type { Clock, TimerHandle } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import {
  CRASH_LIMIT, CRASH_WINDOW_MS, MCP_INVOCATION_META, PLUGIN_CALL_MAX_TIMEOUT_MS, PLUGIN_CALL_TIMEOUT_MS, RELOAD_GRACE_MS, crashBackoffMs, hostProcessFor,
  type ApiRouter, type HostedState, type HostedStatus, type InstallRecord, type InvokeRequest, type McpChannel, type PluginHost, type StreamRequest,
} from "../contracts/plugin-host";
import { apiChannel } from "./api-channel";
import { InvocationTable } from "./invocations";
import type { RpcPeer } from "./link";
import type { StartParams, VerifiedFiles } from "./runtime";

/** What the core knows of a plugin it may start: its install record and where its built host half is. */
export interface HostedRecord extends InstallRecord {
  folder: string;
  /** The top-level plugin's folder (a child's parent's); default `folder`. */
  root?: string;
  entry: string;
  dataFolder: string;
  /** A bundled plugin's files as its staging verified them (`stageBundledPlugins`' digests, under its tree): its worker
   *  loads each module of the tree only from bytes that match, and a native addon only when it matches (S2). */
  verified?: VerifiedFiles;
}

export interface CorePluginHostOptions {
  clock: Clock;
  computer: string;
  /** The core's own record of an installed plugin, or undefined when it isn't installed. */
  record(pluginId: string): HostedRecord | undefined;
  /** The link to a plugin-host process (made, or reused, by the caller): `own` is per plugin. */
  connect(process: HostProcess, pluginId: string): RpcPeer;
  invocations?: InvocationTable;
  /** A worker's log lines (`pluginHost.log`), for `logs/plugins/<id>.log`; only for a plugin on that link. */
  log?(pluginId: string, lines: readonly string[]): void;
}

interface Call {
  reject(err: unknown): void;
}

interface Hosted {
  process: HostProcess;
  peer?: RpcPeer;
  state: HostedState;
  crashTimes: number[];
  reason?: string;
  restartAt?: number;
  timer?: TimerHandle;
  calls: Set<Call>;
  waiters: (() => void)[];
}

export class CorePluginHost implements PluginHost {
  readonly computer: string;
  readonly invocations: InvocationTable;
  readonly #o: CorePluginHostOptions;
  readonly #hosted = new Map<string, Hosted>();
  readonly #listeners = new Listeners<HostedStatus>();
  readonly #wired = new WeakSet<RpcPeer>();
  readonly #streams = new Map<string, (piece: { seq: number; value?: unknown }) => void>();
  readonly #mcp = new Map<string, { emit: Listeners<Record<string, unknown>>; close: () => void; pending: Map<unknown, () => void> }>();
  #router: ApiRouter = async ({ path }) => {
    throw new ContractError("refused", `no plugin API is served on this computer (${path})`);
  };

  constructor(o: CorePluginHostOptions) {
    this.#o = o;
    this.computer = o.computer;
    this.invocations = o.invocations ?? new InvocationTable();
  }

  /** The process a plugin's host half runs in, from the core's record. */
  processOf(pluginId: string): HostProcess | undefined {
    const r = this.#o.record(pluginId);
    return r === undefined ? undefined : hostProcessFor(r);
  }

  #hostedOf(pluginId: string): Hosted | undefined {
    const record = this.#o.record(pluginId);
    const h = this.#hosted.get(pluginId);
    if (record === undefined) return h;
    if (h !== undefined) return h;
    const fresh: Hosted = { process: hostProcessFor(record), state: "idle", crashTimes: [], calls: new Set(), waiters: [] };
    this.#hosted.set(pluginId, fresh);
    return fresh;
  }

  /** The link for a plugin, wired once: its API calls, stream pieces, MCP messages and worker states. */
  #peerOf(pluginId: string, h: Hosted): RpcPeer {
    if (h.peer !== undefined && !h.peer.closed) return h.peer;
    const peer = this.#o.connect(h.process, pluginId);
    h.peer = peer;
    if (!this.#wired.has(peer)) {
      this.#wired.add(peer);
      const channel = apiChannel({
        process: h.process,
        router: (call) => this.#router(call),
        invocations: this.invocations,
        deliver: (p, subscription, value) => peer.notify("pluginHost.deliver", { pluginId: p, subscription, value }),
      });
      for (const [method, fn] of Object.entries(channel.methods)) peer.handle(method, (params) => fn(params, { caller: { kind: "core" } }));
      peer.handle("pluginHost.log", (x: { pluginId: string; lines: string[] }) => {
        if (this.#hosted.get(x.pluginId)?.peer === peer && Array.isArray(x.lines)) this.#o.log?.(x.pluginId, x.lines.map((l) => String(l).slice(0, 4000)).slice(0, 500));
      });
      peer.handle("pluginHost.chunk", (x: { callId: string; seq: number; value?: unknown }) => this.#streams.get(x.callId)?.(x));
      peer.handle("pluginHost.state", (x: { pluginId: string; state: string; reason?: string }) => {
        if (x.state === "crashed" || x.state === "heartbeat-missed") this.crash(x.pluginId, x.reason ?? (x.state === "crashed" ? "the worker crashed" : "it missed the heartbeat for 30 seconds"));
      });
      peer.handle("pluginHost.mcpMessage", (x: { channel: string; message: Record<string, unknown> }) => {
        const ch = this.#mcp.get(x.channel);
        if (ch === undefined) return;
        if ("id" in x.message && !("method" in x.message)) ch.pending.get(x.message.id)?.();
        ch.emit.emit(x.message);
      });
      peer.handle("pluginHost.mcpClose", (x: { channel: string }) => this.#mcp.get(x.channel)?.close());
      peer.onClose(() => {
        channel.closeAll();
        for (const [id, other] of this.#hosted) if (other.peer === peer && other.state !== "stopped" && other.state !== "idle") this.crash(id, "the plugin host exited");
      });
    }
    return peer;
  }

  invoke<R = unknown>(req: InvokeRequest): Promise<R> {
    return this.#call<R>(req, false);
  }

  async *stream<T = unknown, R = unknown>(req: StreamRequest): AsyncGenerator<T, R, undefined> {
    const queue: { seq: number; value?: unknown }[] = [];
    let wake: (() => void) | undefined;
    let done: { ok: true; value: unknown } | { ok: false; err: unknown } | undefined;
    const callId = `call_${randomUUID()}`;
    this.#streams.set(callId, (piece) => {
      queue.push(piece);
      wake?.();
    });
    const result = this.#call<R>(req, true, callId).then(
      (value) => void (done = { ok: true, value }),
      (err) => void (done = { ok: false, err }),
    ).finally(() => wake?.());
    let next = 0;
    try {
      for (;;) {
        queue.sort((a, b) => a.seq - b.seq);
        if (queue.length > 0 && queue[0]!.seq === next) {
          next++;
          yield queue.shift()!.value as T;
          continue;
        }
        if (done !== undefined) {
          if (!done.ok) throw done.err;
          return done.value as R;
        }
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    } finally {
      this.#streams.delete(callId);
      if (done === undefined) {
        // The consumer stopped early: the call is cancelled.
        this.#cancelCall.get(callId)?.();
        await result;
      }
    }
  }

  readonly #cancelCall = new Map<string, () => void>();

  #call<R>(req: InvokeRequest | StreamRequest, stream: boolean, callId = `call_${randomUUID()}`): Promise<R> {
    const h = this.#hostedOf(req.pluginId);
    if (h === undefined) return Promise.reject(new ContractError("not_installed", `${req.pluginId} isn't installed`));
    if (h.state === "stopped") return Promise.reject(this.#stoppedError(req.pluginId, h));
    if (req.signal?.aborted) return Promise.reject(new ContractError("cancelled", "the call was cancelled"));
    const limit = req.ownLimit ? (req.timeoutMs ?? PLUGIN_CALL_TIMEOUT_MS) : Math.min(req.timeoutMs ?? PLUGIN_CALL_TIMEOUT_MS, PLUGIN_CALL_MAX_TIMEOUT_MS);
    const clock = this.#o.clock;
    return new Promise<R>((resolve, reject) => {
      let settled = false;
      let endInvocation: (() => void) | undefined;
      let sent: RpcPeer | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        h.calls.delete(call);
        this.#cancelCall.delete(callId);
        endInvocation?.();
        fn();
      };
      const call: Call = {
        reject: (err) =>
          finish(() => {
            if (sent === undefined || sent.closed) return reject(err);
            // The host hears the cancel before the caller hears the failure, so the handler's signal is already aborted;
            // a host that doesn't answer within a second doesn't hold the caller.
            const fallback = clock.setTimeout(() => reject(err), 1000);
            void sent.request("pluginHost.cancel", { callId }).catch(() => {}).finally(() => {
              clock.clearTimeout(fallback);
              reject(err);
            });
          }),
      };
      const onAbort = () => call.reject(new ContractError("cancelled", "the call was cancelled"));
      this.#cancelCall.set(callId, onAbort);
      const timer = clock.setTimeout(() => call.reject(new ContractError("timeout", `${req.pluginId}.${req.handler} ran past ${limit} ms`)), limit);
      req.signal?.addEventListener("abort", onAbort, { once: true });
      h.calls.add(call);
      void (async () => {
        try {
          await this.ensureStarted(req.pluginId);
        } catch (err) {
          call.reject(err);
          return;
        }
        if (settled) return;
        const peer = (sent = this.#peerOf(req.pluginId, h));
        endInvocation = this.invocations.open(callId, { pluginId: req.pluginId, caller: req.caller, ...(req.session === undefined ? {} : { session: req.session }) });
        const input = (req as StreamRequest).input;
        try {
          const answer = peer.request("pluginHost.invoke", {
            callId, pluginId: req.pluginId, handler: req.handler, ...(req.method === undefined ? {} : { method: req.method }),
            args: req.args, caller: req.caller, ...(req.session === undefined ? {} : { session: req.session }),
            timeoutMs: Math.min(limit, PLUGIN_CALL_MAX_TIMEOUT_MS), deadline: clock.now() + limit,
            ...(stream ? { stream: true } : {}), ...(input === undefined ? {} : { input: true }),
          });
          if (input !== undefined) void this.#feed(peer, callId, input, () => settled);
          const { result } = (await answer) as { result: unknown };
          finish(() => resolve(result as R));
        } catch (err) {
          call.reject(err instanceof ContractError ? err : new ContractError("failed", err instanceof Error ? err.message : String(err)));
        }
      })();
    });
  }

  async #feed(peer: RpcPeer, callId: string, input: AsyncIterable<unknown>, over: () => boolean): Promise<void> {
    let seq = 0;
    try {
      for await (const value of input) {
        if (over()) return;
        peer.notify("pluginHost.feed", { callId, seq: seq++, value });
      }
    } finally {
      if (!over()) peer.notify("pluginHost.feed", { callId, seq, end: true });
    }
  }

  async ensureStarted(pluginId: string): Promise<void> {
    for (;;) {
      const h = this.#hostedOf(pluginId);
      if (h === undefined) throw new ContractError("not_installed", `${pluginId} isn't installed`);
      if (h.state === "stopped") throw this.#stoppedError(pluginId, h);
      if (h.state === "running") return;
      const settled = new Promise<void>((resolve) => h.waiters.push(resolve));
      if (h.state === "idle") void this.#start(pluginId, h);
      await settled;
    }
  }

  async stop(pluginId: string, reason: string): Promise<void> {
    const h = this.#hostedOf(pluginId);
    if (h === undefined) return;
    await this.#stopModule(pluginId, h, "stop");
    this.#failCalls(h, new ContractError("plugin_stopped", `plugin stopped: ${reason}`));
    this.#set(pluginId, h, "stopped", reason);
  }

  async restart(pluginId: string): Promise<void> {
    const h = this.#hostedOf(pluginId);
    if (h === undefined) throw new ContractError("not_installed", `${pluginId} isn't installed`);
    if (h.timer) this.#o.clock.clearTimeout(h.timer);
    h.crashTimes = [];
    delete h.restartAt;
    this.#set(pluginId, h, "idle");
    await this.ensureStarted(pluginId);
  }

  async reload(pluginId: string): Promise<void> {
    const h = this.#hostedOf(pluginId);
    if (h === undefined) throw new ContractError("not_installed", `${pluginId} isn't installed`);
    const inFlight = [...h.calls];
    if (inFlight.length > 0) {
      await new Promise<void>((resolve) => this.#o.clock.setTimeout(resolve, RELOAD_GRACE_MS));
      for (const c of inFlight) if (h.calls.has(c)) c.reject(new ContractError("cancelled", "interrupted: the plugin reloaded"));
    }
    await this.#stopModule(pluginId, h, "reload");
    this.#set(pluginId, h, "idle");
    await this.ensureStarted(pluginId);
  }

  /** The plugin was removed: calls in flight and new ones fail `not_installed`. */
  async removed(pluginId: string): Promise<void> {
    const h = this.#hosted.get(pluginId);
    if (h === undefined) return;
    this.#failCalls(h, new ContractError("not_installed", `${pluginId} was removed`));
    await this.#stopModule(pluginId, h, "removed");
    this.#hosted.delete(pluginId);
    for (const w of h.waiters.splice(0)) w();
  }

  async openMcp(pluginId: string, server: string): Promise<McpChannel> {
    await this.ensureStarted(pluginId);
    const h = this.#hostedOf(pluginId)!;
    const peer = this.#peerOf(pluginId, h);
    const id = `mcp_${randomUUID()}`;
    const emit = new Listeners<Record<string, unknown>>();
    const pending = new Map<unknown, () => void>();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.#mcp.delete(id);
      for (const end of pending.values()) end();
      pending.clear();
    };
    this.#mcp.set(id, { emit, close, pending });
    try {
      await peer.request("pluginHost.mcpOpen", { pluginId, server, channel: id });
    } catch (err) {
      close();
      throw err;
    }
    return {
      send: (message, as?: Caller) => {
        if (closed) throw new ContractError("closed", "the MCP channel is closed");
        const copy = structuredClone(message);
        const params = copy.params as { _meta?: Record<string, unknown> } | undefined;
        if (params?._meta !== undefined) delete params._meta[MCP_INVOCATION_META];
        if (as !== undefined && typeof copy.method === "string" && "id" in copy) {
          const invocation = `call_${randomUUID()}`;
          const end = this.invocations.open(invocation, { pluginId, caller: as, ...(as.kind === "session" ? { session: as.sessionId } : {}) });
          pending.set(copy.id, () => {
            pending.delete(copy.id);
            end();
          });
          const p = (copy.params ?? (copy.params = {})) as { _meta?: Record<string, unknown> };
          p._meta = { ...(p._meta ?? {}), [MCP_INVOCATION_META]: invocation };
        }
        peer.notify("pluginHost.mcpMessage", { channel: id, message: copy });
      },
      onMessage: (fn) => emit.add(fn),
      close: () => {
        if (closed) return;
        close();
        peer.notify("pluginHost.mcpClose", { channel: id });
      },
      get closed() {
        return closed;
      },
    };
  }

  status(pluginId: string): HostedStatus {
    const h = this.#hosted.get(pluginId);
    if (h === undefined) return { pluginId, state: "idle", crashes: 0, ...(this.#o.record(pluginId) === undefined ? { reason: "not installed" } : {}) };
    return this.#statusOf(pluginId, h);
  }

  serveApi(router: ApiRouter): void {
    this.#router = router;
  }

  watch(fn: (status: HostedStatus) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  /** The worker crashed or missed the heartbeat: its calls fail, and it restarts after the backoff, or stops after the
   *  third crash in 10 minutes. */
  crash(pluginId: string, reason = "the worker crashed"): void {
    const h = this.#hosted.get(pluginId);
    if (h === undefined || h.state === "stopped") return;
    this.#failCalls(h, new ContractError("failed", `the plugin crashed: ${reason}`));
    const now = this.#o.clock.now();
    h.crashTimes = [...h.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (h.crashTimes.length >= CRASH_LIMIT) {
      delete h.restartAt;
      this.#set(pluginId, h, "stopped", `crashed ${CRASH_LIMIT} times in 10 minutes: ${reason}`);
      return;
    }
    const delay = crashBackoffMs(h.crashTimes.length);
    h.restartAt = now + delay;
    this.#set(pluginId, h, "restarting", reason);
    h.timer = this.#o.clock.setTimeout(() => {
      if (h.state === "restarting") void this.#start(pluginId, h);
    }, delay);
  }

  async #start(pluginId: string, h: Hosted): Promise<void> {
    const record = this.#o.record(pluginId);
    if (record === undefined) {
      this.#set(pluginId, h, "stopped", "not installed");
      return;
    }
    h.process = hostProcessFor(record);
    this.#set(pluginId, h, "starting");
    const params: StartParams = {
      pluginId, folder: record.folder, root: record.root ?? record.folder, entry: record.entry, runtime: record.runtime ?? "bun", dataFolder: record.dataFolder, process: h.process,
      ...(record.verified !== undefined ? { verified: record.verified } : {}),
    };
    try {
      await this.#peerOf(pluginId, h).request("pluginHost.start", params);
    } catch (err) {
      this.crash(pluginId, err instanceof Error ? err.message : String(err));
      return;
    }
    if (h.state !== "starting") return; // stopped or removed meanwhile
    delete h.restartAt;
    this.#set(pluginId, h, "running");
  }

  async #stopModule(pluginId: string, h: Hosted, why: "reload" | "stop" | "removed"): Promise<void> {
    if (h.timer) this.#o.clock.clearTimeout(h.timer);
    if (h.state !== "running" || h.peer === undefined || h.peer.closed) return;
    try {
      await h.peer.request("pluginHost.stop", { pluginId, reason: why, graceMs: 0 });
    } catch {
      // A failing stop doesn't keep the worker alive.
    }
  }

  #failCalls(h: Hosted, err: ContractError): void {
    for (const c of [...h.calls]) c.reject(err);
  }

  #stoppedError(pluginId: string, h: Hosted): ContractError {
    return new ContractError("plugin_stopped", `plugin stopped: ${h.reason ?? "stopped"}`, { pluginId });
  }

  #set(pluginId: string, h: Hosted, state: HostedState, reason?: string): void {
    h.state = state;
    if (reason === undefined) delete h.reason;
    else h.reason = reason;
    if (state === "running" || state === "stopped") for (const w of h.waiters.splice(0)) w();
    this.#listeners.emit(this.#statusOf(pluginId, h));
  }

  #statusOf(pluginId: string, h: Hosted): HostedStatus {
    const now = this.#o.clock.now();
    return {
      pluginId,
      state: h.state,
      crashes: h.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).length,
      ...(h.restartAt === undefined ? {} : { restartAt: h.restartAt }),
      ...(h.reason === undefined ? {} : { reason: h.reason }),
    };
  }
}
