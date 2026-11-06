// Contract: PluginHost (spec §3.2 "Plugin host", §5.1 "Live changes" and "Crashes and logs", §5.2, §5.4 "Limits").
// Owner: lane B.
//
// Two plugin-host processes per computer, separate from the daemon (the owner's answer to S4, amending §5.2's one
// shared host): the bundled `clover` tree's host halves run in a process of their own, and every other plugin's share
// the other one, each plugin in its own worker; Node or native plugins get a process of their own. The core decides
// the process from the install record (`hostProcessFor`), never from anything a plugin claims. The daemon calls into
// them; it never runs plugin code itself.
//
// What it promises:
// * `invoke` runs a handler (an export of `host.entry`) with structured-clone arguments and result, the caller, and a
//   limit: 10 seconds by default, at most 10 minutes. Tool calls, hooks, `confirm` and the keyed fetch set their own.
//   An export may be an object of handlers, a service (a `webhook.ingress` entry, a notifier): `method` names the one
//   to run (`resolveHandler`).
// * A call to a stopped plugin fails at once with `plugin_stopped` and the reason; a handler the module doesn't
//   export, or a method its object lacks, fails with `not_installed`; a call past its limit with `timeout`; an aborted
//   one with `cancelled`.
// * A crashed worker restarts after 1 second, the delay doubling up to 1 minute. After 3 crashes in 10 minutes the
//   plugin stops on this computer until the user restarts it. A worker that misses the heartbeat for 30 seconds
//   counts as crashed. Calls running when a worker crashes fail with `failed` ("the plugin crashed").
// * On reload the worker is replaced: calls in flight get a grace period, then fail as interrupted (`cancelled`).
// * `host` MCP servers are reached as a raw JSON-RPC channel (the in-process transport the plugin SDK gives them).
// * A plugin's own calls into the plugin API come back to the core through `serveApi`, which checks capabilities.
//   The host stamps each call's `pluginId` from its own worker table, the worker that made the call, never from
//   anything the worker says (review S3); across the pipe it is `pluginHost.api`'s `pluginId`, on a connection bound
//   to its process. The core's router refuses a call whose plugin doesn't run in the process it came from, so a
//   third-party worker presenting a `clover/*` id is refused, and honours the account token and `keys.*` only from
//   the `clover` process (`guardApiRouter`, S4).
// * Who a plugin's API call acts for (ruling R7): a call the plugin makes while it serves a call from the core (a tool
//   call, a hook) acts as that call's caller, the session that made the tool call. The core binds it from its own
//   record of the call it made: the host carries the call's id with each API call made inside it (`ApiCall.invocation`,
//   the `ctx.api` the handler got, or in a `host` MCP server the `tools/call` the host runs inside the call), and the
//   core looks the caller up by that id. The core never trusts a caller the plugin supplies: no `_meta` caller, no
//   argument. An MCP request the core sends carries the id as `_meta["clover/invocation"]`, which the host takes off
//   before the server sees it, and an id that isn't an open call to that plugin is refused. A call made outside any
//   (a timer, a `start` task) acts as the plugin.
// * `stream` runs a handler that returns an async iterable (a model adapter's output, a voice's audio; review S16):
//   values arrive in order, the iterable's return value ends the stream, and `input` feeds a handler that takes one
//   (a voice's microphone audio) as `ctx.input`. The limits, cancelling, crashes and reloads are `invoke`'s.
import { BUNDLED_ROOT_PLUGIN, type Caller, type HostProcess, type PluginSource } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "./common";

export const PLUGIN_CALL_TIMEOUT_MS = 10_000;
export const PLUGIN_CALL_MAX_TIMEOUT_MS = 600_000;
export const CRASH_RESTART_FIRST_MS = 1_000;
export const CRASH_RESTART_MAX_MS = 60_000;
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 10 * 60_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/** How long calls in flight get when a worker is replaced (§5.1 "a grace period"); lane B's choice. */
export const RELOAD_GRACE_MS = 5_000;

/** What the core knows of an installed plugin, from its own install record: never what the plugin says of itself. */
export interface InstallRecord {
  id: string;
  source: PluginSource;
  /** The manifest's `host.runtime`. */
  runtime?: "bun" | "node";
}

/** The process a host half runs in (the owner's answer to S4): a Node or native plugin's own; the `clover` process for
 *  the bundled `clover` tree (installed with the app, top-level id `clover`); the shared one for every other. */
export function hostProcessFor(plugin: InstallRecord): HostProcess {
  if (plugin.runtime === "node") return "own";
  const top = plugin.id.includes("/") ? plugin.id.slice(0, plugin.id.indexOf("/")) : plugin.id;
  return plugin.source === "bundled" && top === BUNDLED_ROOT_PLUGIN ? "clover" : "shared";
}

/** The `auth` name of the account token (the plugin SDK's `WAIFUCAVE_AUTH`). */
const ACCOUNT_AUTH = "waifucave";

/** Whether a plugin-API call is one the core honours only from the `clover` process: the account token
 *  (`net.fetch` with `auth: "waifucave"`) and the core's key pairs (`keys.*`). */
export function cloverProcessOnly(path: string, args: readonly unknown[]): boolean {
  if (path.startsWith("keys.")) return true;
  if (path !== "net.fetch") return false;
  const opts = args[2];
  return typeof opts === "object" && opts !== null && (opts as { auth?: unknown }).auth === ACCOUNT_AUTH;
}

/** The process checks every router sits behind (S4): a call whose plugin the core didn't start in the process it came
 *  from is refused (`refused`), as is a `clover`-only call from any other process; the rest go to `router`, which
 *  checks capabilities. `recordOf` reads the core's install records. */
export function guardApiRouter(router: ApiRouter, recordOf: (pluginId: string) => InstallRecord | undefined): ApiRouter {
  return async (call) => {
    const record = recordOf(call.pluginId);
    if (record === undefined || hostProcessFor(record) !== call.process) {
      throw new ContractError("refused", `${call.pluginId} doesn't run in the ${call.process} process`);
    }
    if (call.process !== "clover" && cloverProcessOnly(call.path, call.args)) {
      throw new ContractError("refused", `${call.path} is honoured only from the clover process`);
    }
    return router(call);
  };
}

/** The exports a host module keeps for the host itself, never callable as handlers. */
export const RESERVED_EXPORTS: ReadonlySet<string> = new Set(["start", "stop", "mcp"]);

/** The function a call runs, with what it runs on: the export itself, or with `method`, one function of an exported
 *  object, its own or its class's, never one every object has (`toString`, `constructor`). `undefined` when there is
 *  none, which `invoke` reports as `not_installed`. */
export function resolveHandler(
  module: Readonly<Record<string, unknown>>,
  handler: string,
  method?: string,
): { fn: (args: unknown, ctx: unknown) => unknown; self: unknown } | undefined {
  if (RESERVED_EXPORTS.has(handler) || !Object.hasOwn(module, handler)) return undefined;
  const exported = module[handler];
  if (method === undefined) return typeof exported === "function" ? { fn: exported as (a: unknown, c: unknown) => unknown, self: undefined } : undefined;
  if (exported === null || typeof exported !== "object" || method === "constructor") return undefined;
  for (let o: object | null = exported; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    if (!Object.hasOwn(o, method)) continue;
    const fn = (o as Record<string, unknown>)[method];
    return typeof fn === "function" ? { fn: fn as (a: unknown, c: unknown) => unknown, self: exported } : undefined;
  }
  return undefined;
}

/** The delay before the n-th restart (n from 1): 1 s, 2 s, 4 s … up to 1 minute. */
export function crashBackoffMs(n: number): number {
  return Math.min(CRASH_RESTART_MAX_MS, CRASH_RESTART_FIRST_MS * 2 ** Math.max(0, n - 1));
}

export interface InvokeRequest {
  pluginId: string;
  /** The export's name, as the manifest names it. */
  handler: string;
  /** For an export that is an object of handlers: which one (the plugin API's `points.call` `method`). */
  method?: string;
  /** Structured-clone data. */
  args: unknown;
  /** Whom the call is for, as the core decided it; API calls the plugin makes while serving it act as this (R7). */
  caller: Caller;
  /** The session the call is for (a tool call's, a hook's). */
  session?: string;
  /** Default `PLUGIN_CALL_TIMEOUT_MS`; clamped to `PLUGIN_CALL_MAX_TIMEOUT_MS` unless `ownLimit`. */
  timeoutMs?: number;
  /** Tool calls, hooks, `confirm` and the keyed fetch keep their own limits (§5.4): `timeoutMs` is used as given. */
  ownLimit?: boolean;
  signal?: AbortSignal;
}

/** A streamed call: `invoke`'s request, with the handler's input stream when it takes one. */
export interface StreamRequest extends InvokeRequest {
  input?: AsyncIterable<unknown>;
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

/** The key an MCP request from the core carries its call's id under (R7): set by the core, taken off by the host
 *  before the plugin's server sees the request. */
export const MCP_INVOCATION_META = "clover/invocation";

/** One `host` MCP server's end of the in-process transport: raw JSON-RPC messages. A `tools/call` the core sends
 *  carries `_meta[MCP_INVOCATION_META]` with the caller it is for (`McpChannel.send`'s `as`); the plugin API calls the
 *  server makes while handling it act as that caller (R7). */
export interface McpChannel {
  /** `as`: for a request, whom it is for (a tool call's session); the host binds the API calls made while serving it. */
  send(message: Record<string, unknown>, as?: Caller): void;
  onMessage(fn: (message: Record<string, unknown>) => void): Unsubscribe;
  close(): void;
  readonly closed: boolean;
}

/** How the core answers a plugin's own plugin-API call (`storage.synced.get`, `net.fetch` …). It checks the plugin's
 *  capabilities (the SDK's `API_CALLS` table) and refuses a call the plugin may not make. `pluginId` is the one the
 *  host stamped. A listener reaches the router as a function and a streamed argument as an async iterable; across
 *  the pipe they are a subscription (`pluginHost.deliver`) and pieces (`pluginHost.chunk`). The router builds each
 *  plugin's `net.fetch` when it takes the plugin's install record, placing keys by the SDK's `keyPlacementsFor` over
 *  its `auth` entries: a placement off the closed list refuses that build, so the plugin has no fetch at all, rather
 *  than failing a request (lane A's kit, `placement-closed-list`). A request's `idleTimeoutMs` is held to 1 s - 30 min
 *  (`clampKeyedIdleTimeoutMs`). */
export type ApiRouter = (call: {
  pluginId: string;
  process: HostProcess;
  path: string;
  args: unknown[];
  /** Whom the call acts for: the caller of the core's call it was made in, which the core looked up by that call's id
   *  (R7), or the plugin itself; never anything the plugin said. */
  caller: Caller;
}) => Promise<unknown>;

export interface PluginHost {
  /** The computer this host runs on. */
  readonly computer: string;
  invoke<R = unknown>(req: InvokeRequest): Promise<R>;
  /** A handler that returns an async iterable: its values in order, then its return value. */
  stream<T = unknown, R = unknown>(req: StreamRequest): AsyncGenerator<T, R, undefined>;
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
