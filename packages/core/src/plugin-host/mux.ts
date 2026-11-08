// A plugin-host process's own work (spec §5.2): one worker per plugin it was given, behind the one link to the daemon.
// It forwards the daemon's calls to the worker of the plugin they name, and the workers' calls to the daemon, stamping
// each API call with the plugin of the worker it came from (review S3), never the plugin the call names. A worker that
// dies, or doesn't answer the heartbeat for 30 seconds, is ended and reported (`pluginHost.state`); the daemon applies
// the crash rules. What a worker writes to its console becomes its plugin's log lines (`pluginHost.log`).
import { HEARTBEAT_TIMEOUT_MS } from "../contracts/plugin-host";
import { ContractError } from "../contracts/common";
import { portPeer, type RpcPeer } from "./link";
import type { StartParams } from "./runtime";

/** A worker the process started for one plugin. */
export interface WorkerHandle {
  peer: RpcPeer;
  terminate(): void;
  /** The worker ended on its own (an uncaught error, an exit). */
  onExit(fn: (reason: string) => void): void;
}

export interface HostMuxOptions {
  daemon: RpcPeer;
  spawnWorker(params: StartParams): WorkerHandle;
  /** How often the heartbeat runs; a worker that misses it for `HEARTBEAT_TIMEOUT_MS` is ended. */
  heartbeatMs?: number;
}

export class HostMux {
  readonly #o: HostMuxOptions;
  readonly #workers = new Map<string, { w: WorkerHandle; lastSeen: number; ending?: boolean }>();
  readonly #callOwner = new Map<string, string>();
  readonly #channelOwner = new Map<string, string>();
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(o: HostMuxOptions) {
    this.#o = o;
    const d = o.daemon;
    const to = (pluginId: string) => {
      const w = this.#workers.get(pluginId);
      if (w === undefined) throw new ContractError("plugin_stopped", `${pluginId} isn't running here`);
      return w.w.peer;
    };
    // The cheapest answer a host process gives with no plugin loaded: that it's up, on which Bun, with how many workers
    // (lane M's compiled-core probe).
    d.handle("pluginHost.ping", () => ({ ok: true, bun: Bun.version, workers: this.#workers.size }));
    d.handle("pluginHost.start", async (x: StartParams) => {
      if (!this.#workers.has(x.pluginId)) this.#spawn(x);
      try {
        return await to(x.pluginId).request("pluginHost.start", x);
      } catch (err) {
        this.#end(x.pluginId);
        throw err;
      }
    });
    d.handle("pluginHost.stop", async (x: { pluginId: string }) => {
      const w = this.#workers.get(x.pluginId);
      if (w === undefined) return { ok: true };
      w.ending = true;
      try {
        await w.w.peer.request("pluginHost.stop", x);
      } finally {
        this.#end(x.pluginId);
      }
      return { ok: true };
    });
    d.handle("pluginHost.invoke", async (x: { callId: string; pluginId: string }) => {
      this.#callOwner.set(x.callId, x.pluginId);
      try {
        return await to(x.pluginId).request("pluginHost.invoke", x);
      } finally {
        this.#callOwner.delete(x.callId);
      }
    });
    for (const m of ["pluginHost.cancel", "pluginHost.feed"]) {
      d.handle(m, (x: { callId: string }) => {
        const owner = this.#callOwner.get(x.callId);
        if (owner !== undefined) this.#workers.get(owner)?.w.peer.notify(m, x);
        return { ok: true };
      });
    }
    d.handle("pluginHost.deliver", (x: { pluginId: string }) => this.#workers.get(x.pluginId)?.w.peer.notify("pluginHost.deliver", x));
    d.handle("pluginHost.mcpOpen", (x: { pluginId: string; channel: string }) => {
      this.#channelOwner.set(x.channel, x.pluginId);
      return to(x.pluginId).request("pluginHost.mcpOpen", x);
    });
    for (const m of ["pluginHost.mcpMessage", "pluginHost.mcpClose"]) {
      d.handle(m, (x: { channel: string }) => {
        const owner = this.#channelOwner.get(x.channel);
        if (owner !== undefined) this.#workers.get(owner)?.w.peer.notify(m, x);
        if (m === "pluginHost.mcpClose") this.#channelOwner.delete(x.channel);
      });
    }
    this.#timer = setInterval(() => void this.#heartbeat(), o.heartbeatMs ?? 10_000);
    (this.#timer as { unref?: () => void }).unref?.();
    d.onClose(() => this.close());
  }

  close(): void {
    clearInterval(this.#timer);
    for (const id of [...this.#workers.keys()]) this.#end(id);
  }

  #spawn(x: StartParams): void {
    const w = this.#o.spawnWorker(x);
    const entry: { w: WorkerHandle; lastSeen: number; ending?: boolean } = { w, lastSeen: Date.now() };
    this.#workers.set(x.pluginId, entry);
    const d = this.#o.daemon;
    const pluginId = x.pluginId;
    // The worker's calls go to the daemon as its plugin's, whatever they say (S3).
    for (const m of ["pluginHost.api", "pluginHost.unwatch"]) {
      w.peer.handle(m, (p: Record<string, unknown>) => d.request(m, { ...p, pluginId }));
    }
    // A stream's chunk only for a call made to this worker's plugin (#322's review): never another plugin's call id.
    w.peer.handle("pluginHost.chunk", (p: { callId?: unknown }) => {
      if (typeof p?.callId === "string" && this.#callOwner.get(p.callId) === pluginId) d.notify("pluginHost.chunk", p);
    });
    for (const m of ["pluginHost.mcpMessage", "pluginHost.mcpClose"]) {
      w.peer.handle(m, (p: { channel: string }) => {
        if (this.#channelOwner.get(p.channel) === pluginId) d.notify(m, p);
      });
    }
    w.peer.handle("log", (p: { line: string }) => d.notify("pluginHost.log", { pluginId, lines: [String(p.line).slice(0, 4000)] }));
    w.onExit((reason) => {
      if (this.#workers.get(pluginId)?.w !== w) return;
      const ending = entry.ending === true;
      this.#end(pluginId);
      if (!ending) d.notify("pluginHost.state", { pluginId, state: "crashed", reason: reason.slice(0, 2000) });
    });
  }

  #end(pluginId: string): void {
    const e = this.#workers.get(pluginId);
    if (e === undefined) return;
    this.#workers.delete(pluginId);
    for (const [c, owner] of this.#callOwner) if (owner === pluginId) this.#callOwner.delete(c);
    for (const [c, owner] of this.#channelOwner) if (owner === pluginId) this.#channelOwner.delete(c);
    e.w.peer.close();
    e.w.terminate();
  }

  async #heartbeat(): Promise<void> {
    const now = Date.now();
    for (const [pluginId, e] of this.#workers) {
      if (now - e.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.#end(pluginId);
        this.#o.daemon.notify("pluginHost.state", { pluginId, state: "heartbeat-missed", reason: `no answer to the heartbeat for ${Math.round(HEARTBEAT_TIMEOUT_MS / 1000)} seconds` });
        continue;
      }
      void e.w.peer.request("ping", null).then(() => void (e.lastSeen = Date.now()), () => {});
    }
  }
}

/** A Bun worker for one plugin, running `worker-main.ts`. */
export function bunWorker(computer: string, entry = new URL("./worker-main.ts", import.meta.url).href): (x: StartParams) => WorkerHandle {
  return (x) => {
    // `cloverPluginRoot`: the folder the load guard pins this worker to (a host thread's guard requires it, and drops
    // it before the worker starts); never another plugin's.
    const worker = new Worker(entry, { workerData: { computer }, cloverPluginRoot: x.root ?? x.folder } as WorkerOptions);
    const exits: ((reason: string) => void)[] = [];
    worker.addEventListener("error", (e) => {
      for (const fn of exits) fn(`the worker failed: ${(e as ErrorEvent).message ?? "an error"}`);
    });
    worker.addEventListener("close", () => {
      for (const fn of exits) fn("the worker exited");
    });
    return {
      peer: portPeer(worker as unknown as Parameters<typeof portPeer>[0]),
      terminate: () => worker.terminate(),
      onExit: (fn) => void exits.push(fn),
    };
  };
}
