// FakePluginHost: host modules defined in the test, run in-process, with the host's limits, crash backoff, reloads and
// MCP channels on an injected clock. A handler's `ctx.api` routes every plugin-API call to the router the core
// serves (`serveApi`), as the real host's worker does over its pipe; callbacks reach the router as functions.
import type { Caller } from "@waifucave/clover-protocol";
import type { Clock, TimerHandle } from "../clock";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import {
  CRASH_LIMIT, CRASH_WINDOW_MS, PLUGIN_CALL_MAX_TIMEOUT_MS, PLUGIN_CALL_TIMEOUT_MS, RELOAD_GRACE_MS, crashBackoffMs, resolveHandler,
  type ApiRouter, type HostedState, type HostedStatus, type InvokeRequest, type McpChannel, type PluginHost, type StreamRequest,
} from "../plugin-host";
import type { HandlerContext, HostModule, McpServerTransport, PluginApi } from "../sdk-types";

interface Call {
  reject: (err: unknown) => void;
}

interface Hosted {
  module: HostModule;
  /** A module defined while the old one runs: it takes over at the next start, as a new worker would. */
  next?: HostModule;
  state: HostedState;
  crashTimes: number[];
  reason?: string;
  restartAt?: number;
  timer?: TimerHandle;
  calls: Set<Call>;
  waiters: (() => void)[];
}


export class FakePluginHost implements PluginHost {
  readonly computer: string;
  readonly #clock: Clock;
  readonly #hosted = new Map<string, Hosted>();
  readonly #listeners = new Listeners<HostedStatus>();
  #router: ApiRouter = async ({ path }) => {
    throw new ContractError("refused", `no plugin API is served in this test (${path})`);
  };

  constructor(opts: { clock: Clock; computer?: string }) {
    this.#clock = opts.clock;
    this.computer = opts.computer ?? "Studio";
  }

  /** Installs a plugin's host module. For a plugin already running, the new module takes over at its next start
   *  (a reload, a restart, or after a crash), as a new worker would; the running one keeps serving until then. */
  define(pluginId: string, module: HostModule): void {
    const h = this.#hosted.get(pluginId);
    if (!h) this.#hosted.set(pluginId, { module, state: "idle", crashTimes: [], calls: new Set(), waiters: [] });
    else if (h.state === "idle" || h.state === "stopped") h.module = module;
    else h.next = module;
  }

  /** The plugin was removed: calls in flight and new ones fail `not_installed`. */
  undefine(pluginId: string): void {
    const h = this.#hosted.get(pluginId);
    if (!h) return;
    this.#failCalls(h, new ContractError("not_installed", `${pluginId} was removed`));
    if (h.timer) this.#clock.clearTimeout(h.timer);
    this.#hosted.delete(pluginId);
    for (const w of h.waiters.splice(0)) w();
  }

  invoke<R = unknown>(req: InvokeRequest): Promise<R> {
    const h = this.#hosted.get(req.pluginId);
    if (!h) return Promise.reject(new ContractError("not_installed", `${req.pluginId} isn't installed`));
    if (h.state === "stopped") return Promise.reject(this.#stoppedError(req.pluginId, h));
    if (req.signal?.aborted) return Promise.reject(new ContractError("cancelled", "the call was cancelled"));
    const limit = req.ownLimit ? (req.timeoutMs ?? PLUGIN_CALL_TIMEOUT_MS) : Math.min(req.timeoutMs ?? PLUGIN_CALL_TIMEOUT_MS, PLUGIN_CALL_MAX_TIMEOUT_MS);
    const abort = new AbortController();
    return new Promise<R>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.#clock.clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        h.calls.delete(call);
        fn();
      };
      const call: Call = {
        reject: (err) =>
          finish(() => {
            abort.abort(err);
            reject(err);
          }),
      };
      const onAbort = () => call.reject(new ContractError("cancelled", "the call was cancelled"));
      // The limit covers waiting for a restart too.
      const timer = this.#clock.setTimeout(() => call.reject(new ContractError("timeout", `${req.pluginId}.${req.handler} ran past ${limit} ms`)), limit);
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
        const target = resolveHandler(h.module, req.handler, req.method);
        if (!target) {
          const name = req.method === undefined ? req.handler : `${req.handler}.${req.method}`;
          call.reject(new ContractError("not_installed", `${req.pluginId} has no handler \`${name}\``));
          return;
        }
        const ctx: HandlerContext = {
          caller: req.caller,
          ...(req.session === undefined ? {} : { session: req.session }),
          computer: this.computer,
          signal: abort.signal,
          deadline: this.#clock.now() + limit,
          api: this.#apiFor(req.pluginId, req.caller),
        };
        try {
          const result = await target.fn.call(target.self, structuredClone(req.args), ctx);
          const copy = structuredClone(result) as R;
          finish(() => resolve(copy));
        } catch (err) {
          call.reject(err instanceof ContractError ? err : new ContractError("failed", err instanceof Error ? err.message : String(err)));
        }
      })();
    });
  }

  async *stream<T = unknown, R = unknown>(req: StreamRequest): AsyncGenerator<T, R, undefined> {
    const h = this.#hosted.get(req.pluginId);
    if (!h) throw new ContractError("not_installed", `${req.pluginId} isn't installed`);
    if (h.state === "stopped") throw this.#stoppedError(req.pluginId, h);
    if (req.signal?.aborted) throw new ContractError("cancelled", "the call was cancelled");
    const limit = req.ownLimit ? (req.timeoutMs ?? PLUGIN_CALL_TIMEOUT_MS) : Math.min(req.timeoutMs ?? PLUGIN_CALL_TIMEOUT_MS, PLUGIN_CALL_MAX_TIMEOUT_MS);
    const abort = new AbortController();
    let failed: (err: unknown) => void = () => {};
    const failure = new Promise<never>((_resolve, reject) => {
      failed = reject;
    });
    failure.catch(() => {});
    const call: Call = {
      reject: (err) => {
        abort.abort(err);
        failed(err);
      },
    };
    const onAbort = () => call.reject(new ContractError("cancelled", "the call was cancelled"));
    const timer = this.#clock.setTimeout(() => call.reject(new ContractError("timeout", `${req.pluginId}.${req.handler} ran past ${limit} ms`)), limit);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    h.calls.add(call);
    let iterator: AsyncIterator<unknown, unknown> | undefined;
    try {
      await Promise.race([this.ensureStarted(req.pluginId), failure]);
      const target = resolveHandler(h.module, req.handler, req.method);
      if (!target) throw new ContractError("not_installed", `${req.pluginId} has no handler \`${req.method === undefined ? req.handler : `${req.handler}.${req.method}`}\``);
      const ctx: HandlerContext = {
        caller: req.caller,
        ...(req.session === undefined ? {} : { session: req.session }),
        computer: this.computer,
        signal: abort.signal,
        deadline: this.#clock.now() + limit,
        api: this.#apiFor(req.pluginId, req.caller),
        ...(req.input === undefined ? {} : { input: req.input }),
      };
      const out = (await Promise.race([Promise.resolve(target.fn.call(target.self, structuredClone(req.args), ctx)), failure])) as AsyncIterable<unknown> | undefined;
      if (out === null || typeof out !== "object" || typeof (out as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
        throw new ContractError("failed", `${req.pluginId}.${req.handler} returned no stream`);
      }
      iterator = out[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), failure]);
        if (next.done) return structuredClone(next.value) as R;
        yield structuredClone(next.value) as T;
      }
    } catch (err) {
      throw err instanceof ContractError ? err : new ContractError("failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.#clock.clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      h.calls.delete(call);
      if (!abort.signal.aborted) abort.abort(new ContractError("cancelled", "the stream ended"));
      void iterator?.return?.(undefined);
    }
  }

  async ensureStarted(pluginId: string): Promise<void> {
    for (;;) {
      const h = this.#hosted.get(pluginId);
      if (!h) throw new ContractError("not_installed", `${pluginId} isn't installed`);
      if (h.state === "stopped") throw this.#stoppedError(pluginId, h);
      if (h.state === "running") return;
      const settled = new Promise<void>((resolve) => h.waiters.push(resolve));
      if (h.state === "idle") void this.#start(pluginId, h);
      await settled;
    }
  }

  async stop(pluginId: string, reason: string): Promise<void> {
    const h = this.#hosted.get(pluginId);
    if (!h) return;
    await this.#stopModule(h, "stop");
    this.#failCalls(h, new ContractError("plugin_stopped", `plugin stopped: ${reason}`));
    this.#set(pluginId, h, "stopped", reason);
  }

  async restart(pluginId: string): Promise<void> {
    const h = this.#hosted.get(pluginId);
    if (!h) throw new ContractError("not_installed", `${pluginId} isn't installed`);
    if (h.timer) this.#clock.clearTimeout(h.timer);
    h.crashTimes = [];
    delete h.restartAt;
    this.#set(pluginId, h, "idle");
    await this.ensureStarted(pluginId);
  }

  async reload(pluginId: string): Promise<void> {
    const h = this.#hosted.get(pluginId);
    if (!h) throw new ContractError("not_installed", `${pluginId} isn't installed`);
    const inFlight = [...h.calls];
    if (inFlight.length > 0) {
      await new Promise<void>((resolve) => this.#clock.setTimeout(resolve, RELOAD_GRACE_MS));
      for (const c of inFlight) if (h.calls.has(c)) c.reject(new ContractError("cancelled", "interrupted: the plugin reloaded"));
    }
    await this.#stopModule(h, "reload");
    this.#set(pluginId, h, "idle");
    await this.ensureStarted(pluginId);
  }

  async openMcp(pluginId: string, server: string): Promise<McpChannel> {
    await this.ensureStarted(pluginId);
    const h = this.#hosted.get(pluginId)!;
    const serve = h.module.mcp?.[server];
    if (!serve) throw new ContractError("not_installed", `${pluginId} serves no MCP server \`${server}\``);
    const toCore = new Listeners<Record<string, unknown>>();
    let closed = false;
    const transport: McpServerTransport = {
      start: async () => {},
      send: async (message) => {
        const copy = structuredClone(message);
        if (!closed) queueMicrotask(() => toCore.emit(copy));
      },
      close: async () => {
        if (closed) return;
        closed = true;
        transport.onclose?.();
      },
    };
    const channel: McpChannel = {
      send: (message) => {
        if (closed) throw new ContractError("closed", "the MCP channel is closed");
        const copy = structuredClone(message);
        queueMicrotask(() => transport.onmessage?.(copy));
      },
      onMessage: (fn) => toCore.add(fn),
      close: () => {
        if (closed) return;
        closed = true;
        transport.onclose?.();
      },
      get closed() {
        return closed;
      },
    };
    await serve(transport, this.#apiFor(pluginId, { kind: "core" }));
    return channel;
  }

  status(pluginId: string): HostedStatus {
    const h = this.#hosted.get(pluginId);
    if (!h) return { pluginId, state: "idle", crashes: 0, reason: "not installed" };
    return this.#statusOf(pluginId, h);
  }

  serveApi(router: ApiRouter): void {
    this.#router = router;
  }

  watch(fn: (status: HostedStatus) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  /** The worker crashed, or missed the heartbeat for 30 seconds: calls running in it fail, and it restarts after the
   *  backoff, or stops after the third crash in 10 minutes. */
  crash(pluginId: string, reason = "the worker crashed"): void {
    const h = this.#hosted.get(pluginId);
    if (!h || h.state === "stopped") return;
    this.#failCalls(h, new ContractError("failed", `the plugin crashed: ${reason}`));
    const now = this.#clock.now();
    h.crashTimes = [...h.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (h.crashTimes.length >= CRASH_LIMIT) {
      delete h.restartAt;
      this.#set(pluginId, h, "stopped", `crashed ${CRASH_LIMIT} times in 10 minutes: ${reason}`);
      return;
    }
    const delay = crashBackoffMs(h.crashTimes.length);
    h.restartAt = now + delay;
    this.#set(pluginId, h, "restarting", reason);
    h.timer = this.#clock.setTimeout(() => {
      if (h.state === "restarting") void this.#start(pluginId, h);
    }, delay);
  }

  async #start(pluginId: string, h: Hosted): Promise<void> {
    if (h.next) {
      h.module = h.next;
      delete h.next;
    }
    this.#set(pluginId, h, "starting");
    try {
      await h.module.start?.(this.#apiFor(pluginId, { kind: "core" }));
    } catch (err) {
      this.crash(pluginId, `start failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (h.state !== "starting") return; // stopped or removed meanwhile
    delete h.restartAt;
    this.#set(pluginId, h, "running");
  }

  async #stopModule(h: Hosted, why: "reload" | "stop"): Promise<void> {
    if (h.timer) this.#clock.clearTimeout(h.timer);
    if (h.state !== "running") return;
    try {
      await h.module.stop?.(why);
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
    const now = this.#clock.now();
    return {
      pluginId,
      state: h.state,
      crashes: h.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).length,
      ...(h.restartAt === undefined ? {} : { restartAt: h.restartAt }),
      ...(h.reason === undefined ? {} : { reason: h.reason }),
    };
  }

  /** A plugin API whose every call, at any depth, goes to the router by its dotted path. */
  #apiFor(pluginId: string, caller: Caller): PluginApi {
    const router = () => this.#router;
    const make = (path: string[]): unknown =>
      new Proxy(() => {}, {
        get: (_t, prop) => (typeof prop === "string" && prop !== "then" ? make([...path, prop]) : undefined),
        apply: (_t, _this, args: unknown[]) => router()({ pluginId, path: path.join("."), args, caller }),
      });
    return make([]) as PluginApi;
  }
}
