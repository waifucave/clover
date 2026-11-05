// Contract: PluginHost (spec §3.2 "Plugin host", §5.1 "Live changes" and "Crashes and logs", §5.2, §5.4 "Limits").
// Owner: lane B.
//
// One plugin-host process per computer, separate from the daemon, with each plugin's host half in its own worker
// (Node or native plugins in a process of their own). The daemon calls into it; it never runs plugin code itself.
//
// What it promises:
// * `invoke` runs a handler (an export of `host.entry`) with structured-clone arguments and result, the caller, and a
//   limit: 10 seconds by default, at most 10 minutes. Tool calls, hooks, `confirm` and the keyed fetch set their own.
// * A call to a stopped plugin fails at once with `plugin_stopped` and the reason; a handler the module doesn't
//   export fails with `not_installed`; a call past its limit with `timeout`; an aborted one with `cancelled`.
// * A crashed worker restarts after 1 second, the delay doubling up to 1 minute. After 3 crashes in 10 minutes the
//   plugin stops on this computer until the user restarts it. A worker that misses the heartbeat for 30 seconds
//   counts as crashed. Calls running when a worker crashes fail with `failed` ("the plugin crashed").
// * On reload the worker is replaced: calls in flight get a grace period, then fail as interrupted (`cancelled`).
// * `host` MCP servers are reached as a raw JSON-RPC channel (the in-process transport the plugin SDK gives them).
// * A plugin's own calls into the plugin API come back to the core through `serveApi`, which checks capabilities.
import type { Caller } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

export const PLUGIN_CALL_TIMEOUT_MS = 10_000;
export const PLUGIN_CALL_MAX_TIMEOUT_MS = 600_000;
export const CRASH_RESTART_FIRST_MS = 1_000;
export const CRASH_RESTART_MAX_MS = 60_000;
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 10 * 60_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/** How long calls in flight get when a worker is replaced (§5.1 "a grace period"); lane B's choice. */
export const RELOAD_GRACE_MS = 5_000;

/** The delay before the n-th restart (n from 1): 1 s, 2 s, 4 s … up to 1 minute. */
export function crashBackoffMs(n: number): number {
  return Math.min(CRASH_RESTART_MAX_MS, CRASH_RESTART_FIRST_MS * 2 ** Math.max(0, n - 1));
}

export interface InvokeRequest {
  pluginId: string;
  /** The export's name, as the manifest names it. */
  handler: string;
  /** Structured-clone data. */
  args: unknown;
  caller: Caller;
  /** The session the call is for (a tool call's, a hook's). */
  session?: string;
  /** Default `PLUGIN_CALL_TIMEOUT_MS`; clamped to `PLUGIN_CALL_MAX_TIMEOUT_MS` unless `ownLimit`. */
  timeoutMs?: number;
  /** Tool calls, hooks, `confirm` and the keyed fetch keep their own limits (§5.4): `timeoutMs` is used as given. */
  ownLimit?: boolean;
  signal?: AbortSignal;
}

export type HostedState = "idle" | "starting" | "running" | "restarting" | "stopped";

export interface HostedStatus {
  pluginId: string;
  state: HostedState;
  /** Crashes inside the current 10-minute window. */
  crashes: number;
  /** When the next restart is due, on the shared clock. */
  restartAt?: number;
  reason?: string;
}

/** One `host` MCP server's end of the in-process transport: raw JSON-RPC messages. */
export interface McpChannel {
  send(message: Record<string, unknown>): void;
  onMessage(fn: (message: Record<string, unknown>) => void): Unsubscribe;
  close(): void;
  readonly closed: boolean;
}

/** How the core answers a plugin's own plugin-API call (`storage.synced.get`, `net.fetch` …). It checks the plugin's
 *  capabilities (the SDK's `API_CALLS` table) and refuses a call the plugin may not make. */
export type ApiRouter = (call: { pluginId: string; path: string; args: unknown[]; caller: Caller }) => Promise<unknown>;

export interface PluginHost {
  /** The computer this host runs on. */
  readonly computer: string;
  invoke<R = unknown>(req: InvokeRequest): Promise<R>;
  /** Starts the plugin's host half if it isn't running (its `start` export runs first). */
  ensureStarted(pluginId: string): Promise<void>;
  /** Stops it on this computer, until `restart`. */
  stop(pluginId: string, reason: string): Promise<void>;
  /** The user's restart: clears the crash count. */
  restart(pluginId: string): Promise<void>;
  /** Replaces the worker after a folder change (§5.1 "Live changes"). */
  reload(pluginId: string): Promise<void>;
  openMcp(pluginId: string, server: string): Promise<McpChannel>;
  status(pluginId: string): HostedStatus;
  serveApi(router: ApiRouter): void;
  watch(fn: (status: HostedStatus) => void): Unsubscribe;
}
