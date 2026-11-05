// The plugin API (spec §5.4), as TypeScript declarations. Every host half and every component gets one `PluginApi`
// object from the plugin SDK, and nothing in it names a kind of plugin. Each capability gates a fixed set of calls
// (the catalog in `catalogs/api-calls.ts`); without the capability those calls don't exist for that plugin, so the
// members they live on are optional here. Lane B implements it at B-M2 (the plugin host); in UI layers lane E's
// runtime (`src/ui/`, E-M1) hands it over, without the parts §5.5 keeps from layers (no secrets, no data folder, no
// card answers).
//
// Limits (§5.4): arguments and results are structured-clone data. A call times out after 10 seconds unless the caller
// sets a longer limit, up to 10 minutes (tool calls, hooks, `confirm` and the keyed fetch keep their own limits), and
// a call to a stopped plugin fails at once with the reason.
//
// A host half's `console` output goes to its plugin's log, which `logs.read` reads; there is no log call. Development
// overrides (another service origin, say) are the plugin's own settings, never environment variables, which the
// plugin host doesn't pass on.
import {
  type BotView, type Caller, type CardMeta, type CommandView, type ComputerView, type CloverWindow, type FileStat,
  type HoldTarget, type HoldView, type MemoryEntry, type PlanReading, type RoutineRunView, type RoutineView,
  type Screenshot, type SessionView, type TabOwner, type TabView, type UsageRow, type Viewport, BUNDLED_ROOT_PLUGIN,
  topPluginIdOf,
} from "@waifucave/clover-protocol";

export type Unsubscribe = () => void;

/** A plugin-API call's default limit, and the longest a caller may set. */
export const API_CALL_TIMEOUT_MS = 10_000;
export const API_CALL_MAX_TIMEOUT_MS = 600_000;
/** A plugin's synced store holds up to 1 MB (§5.4 "Storage"). */
export const SYNCED_STORE_LIMIT_BYTES = 1024 * 1024;
/** `confirm` is denied after 10 minutes unanswered (§5.4). */
export const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

export interface CallOptions {
  /** Default 10 seconds, at most 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Who called and for what, handed to every command, tool and point handler (§5.4 "The caller"). */
export interface HandlerContext {
  readonly caller: Caller;
  /** The session the call is for, when it is for one (a tool call's, a hook's). */
  readonly session?: string;
  /** The computer this handler runs on. */
  readonly computer: string;
  /** Aborted when the call is cancelled, interrupted, or runs out of time. */
  readonly signal: AbortSignal;
  /** When the call runs out of time, in the shared clock's milliseconds. */
  readonly deadline: number;
  readonly api: PluginApi;
}

/** A handler: any export of `host.entry` that a manifest names (§5.3 "Every handler, adapter, custom sign-in and
 *  component is an export of host or client"). */
export type Handler<A = unknown, R = unknown> = (args: A, ctx: HandlerContext) => R | Promise<R>;

/** A handler export may also be an object of handlers, a service whose caller names the one it calls: the webhook
 *  trigger calls a `webhook.ingress` entry's `register`, `next` and `ack` (`points.call`'s `method`), and the core
 *  calls a notifier's `notify` and `clear`. A plain function is called when no method is named. */
export type HandlerObject = { readonly [method: string]: Handler<any, any> };
export type HandlerExport = Handler<any, any> | HandlerObject;

/** A `notifiers` entry's handler (§10), an object of handlers that the core calls on the main computer. Provisional
 *  for lanes D and I: the core's update carries no content, only what happened and where, since a notifier's service
 *  may be outside the user's computers (waifucave push sends only a count). */
export interface NotifierHandler {
  notify(update: NotifierUpdate, ctx: HandlerContext): void | Promise<void>;
  /** The user caught up: everything is seen. */
  clear(args: undefined, ctx: HandlerContext): void | Promise<void>;
}

export interface NotifierUpdate {
  kind: "message" | "card" | "question" | "routine-result" | "agent-finished" | "notification";
  /** How many updates the user hasn't seen, as the core counts them. */
  unseen: number;
  bot?: string;
  session?: string;
  /** When it happened, on the shared clock. */
  at: number;
}

/** What `host.entry` may export besides its handlers. `mcp` serves the plugin's `host` MCP servers by name, each on
 *  the in-process transport the SDK provides (§5.3 "Handlers"); `start` runs when the host half starts, `stop` before
 *  it is replaced or stopped (§5.1 "Live changes"). */
export interface HostModule {
  start?(api: PluginApi): void | Promise<void>;
  stop?(reason: "reload" | "stop" | "removed"): void | Promise<void>;
  mcp?: Record<string, (transport: McpServerTransport, api: PluginApi) => void | Promise<void>>;
  [handler: string]: unknown;
}

/** The in-process transport a `host` MCP server is built on, with the official MCP SDK (`Transport`'s shape). */
export interface McpServerTransport {
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

// -------------------------------------------------------------------------------------------------
// Always there
// -------------------------------------------------------------------------------------------------

export interface PluginSelf {
  readonly id: string;
  readonly namespace: string;
  readonly version: string;
  /** The computer this half runs on. */
  readonly computer: string;
}

/** One entry of a point, with its paths turned into asset URLs (§5.4 "Points"). */
export interface PointEntry<T = Record<string, unknown>> {
  readonly pluginId: string;
  /** Its `id`, or its index in the contributing list. */
  readonly entryId: string;
  readonly key?: string;
  readonly value: T;
}

/** A declarer reads its point's entries, hears them change, and calls an entry's handler, which runs in the
 *  contributor's worker on the declarer's computer. A plugin's events are points too. */
export interface PointsApi {
  entries<T = Record<string, unknown>>(point: string): Promise<PointEntry<T>[]>;
  watch<T = Record<string, unknown>>(point: string, listener: (entries: PointEntry<T>[]) => void): Unsubscribe;
  /** Calls the handler an entry names in `field` (a field whose format is `handler`); `method` picks one handler of a
   *  handler object, and the call fails `not_installed` when the export has no such function. */
  call<R = unknown>(point: string, entry: { pluginId: string; entryId: string }, field: string, args?: unknown, opts?: CallOptions & { method?: string }): Promise<R>;
}

/** Commands (§5.4): another plugin's run only with `call:<plugin-id>`, which the OK lists. A call to a plugin that
 *  isn't installed fails at once with "not installed". */
export interface CommandsApi {
  run<R = unknown>(name: string, args?: unknown, opts?: CallOptions): Promise<R>;
  list(): Promise<CommandView[]>;
}

/** A component calls its own host half's handlers and hears what the host half sends it. The call runs on the
 *  component's computer, unless `platforms` leaves it out; then on the main (§5.4 "Its own host"). */
export interface HostApi {
  call<R = unknown>(name: string, args?: unknown, opts?: CallOptions): Promise<R>;
  on(event: string, listener: (data: unknown) => void): Unsubscribe;
}

/** A host half reaches its components' `host.on` (§5.4 "Its components"). */
export interface UiSendApi {
  send(event: string, data?: unknown): void;
}

/** A plugin's synced store: up to 1 MB, kept when the plugin is removed, outside the plugin folder (§5.4). */
export interface SyncedStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  watch(listener: (key: string) => void): Unsubscribe;
}

export interface StorageApi {
  /** `<home>/plugin-data/<id>/` on this computer: never synced, kept on removal, fenced from bots' writes. Host
   *  halves only. */
  readonly dataFolder?: string;
  readonly synced: SyncedStore;
}

/** The keyed fetch (§5.4): through the core, which adds the named `auth` entry's key or token (the only one, by
 *  default), reaches only the plugin's `network:` hosts, refuses a redirect elsewhere, streams both ways with no time
 *  limit while data flows, and after a 401 gets a newer token from the refresher and retries once. `auth` names an
 *  entry by its `secret`, or is `"waifucave"` (`WAIFUCAVE_AUTH`). */
export interface NetApi {
  fetch(url: string, init?: RequestInit, opts?: { auth?: string }): Promise<Response>;
}

/** The `auth` name that adds this computer's waifucave account token (lane H), which no manifest may use as a secret's
 *  name. Only plugins of the `clover` tree may use it (the forwarder, push), and only towards waifucave's own hosts in
 *  their `network:` capabilities: the core adds a token it mints for that host (its `aud`), good for minutes, never
 *  the account's own credential; any other use is refused. */
export const WAIFUCAVE_AUTH = "waifucave";
/** The domain whose hosts take the waifucave token: `hooks.waifucave.com`, `push.waifucave.com`. */
export const WAIFUCAVE_DOMAIN = "waifucave.com";

/** Whether a plugin may fetch `host` with `auth: "waifucave"`; its `network:` capability is checked as for any
 *  fetch. */
export function mayUseWaifucaveAuth(pluginId: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return topPluginIdOf(pluginId) === BUNDLED_ROOT_PLUGIN && (h === WAIFUCAVE_DOMAIN || h.endsWith(`.${WAIFUCAVE_DOMAIN}`));
}

/** Only a process of the plugin's own that must sign with a secret (AWS SigV4, §5.2) reads it; a worker can't, and
 *  neither can a layer. */
export interface SecretsApi {
  get(name: string): Promise<string | undefined>;
}

/** Key pairs the core keeps for a plugin on this computer, whose private halves never leave the core: in the secret
 *  store, never synced, one set per computer, kept when the plugin is removed (as its data folder is) until `delete`.
 *  For a host half that must receive what was sealed to this computer, as the waifucave forwarder does, without
 *  holding a secret a worker could leak. Host halves only. */
export interface KeysApi {
  /** The named X25519 key pair's public key (32 bytes, raw), made on first use. */
  publicKey(name: string): Promise<Uint8Array>;
  /** Opens an HPKE message sealed to that key (RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
   *  AES-256-GCM) and returns its plaintext. Fails `not_found` for a key never made, `invalid` when it doesn't open. */
  open(name: string, sealed: { enc: Uint8Array; ciphertext: Uint8Array; info?: Uint8Array; aad?: Uint8Array }): Promise<Uint8Array>;
  /** Drops the pair: what was sealed to it can't be opened again. */
  delete(name: string): Promise<void>;
}
/** A key's name, and how many one plugin may keep on a computer. */
export const KEY_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const KEYS_PER_PLUGIN_MAX = 16;

/** The plugin's own settings, from its host half or its components alike; a plugin changes only its own values. A
 *  `bot`-scoped setting has one value per bot. */
export interface SettingsApi {
  get<T = unknown>(key: string, opts?: { bot?: string }): Promise<T | undefined>;
  watch(key: string | null, listener: (key: string) => void): Unsubscribe;
  set(key: string, value: unknown, opts?: { bot?: string }): Promise<void>;
}

// -------------------------------------------------------------------------------------------------
// Behind a capability
// -------------------------------------------------------------------------------------------------

/** `conversation.read` gives the reads; `conversation.post` gives `note` and `send`, whose turn is the plugin's,
 *  never the user's. Sealed card fields never reach a plugin. */
export interface ConversationApi {
  list(filter?: { bot?: string; kinds?: SessionView["kind"][] }): Promise<SessionView[]>;
  get(session: string): Promise<SessionView>;
  history(session: string, page: { before?: number; limit: number }): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }>;
  follow(session: string, listener: (event: Record<string, unknown>) => void, opts?: { since?: number }): Unsubscribe;
  note(session: string, note: { label?: string; text: string }): Promise<void>;
  send(session: string, text: string): Promise<void>;
  answer(session: string, callId: string, answers: Record<string, string>): Promise<void>;
}

export interface MemoryApi {
  list(bot: string): Promise<MemoryEntry[]>;
  read(bot: string, path: string): Promise<string>;
}

export interface BotsApi {
  list(): Promise<BotView[]>;
  get(bot: string): Promise<BotView>;
  watch(listener: (bot: BotView) => void): Unsubscribe;
}

export interface RoutinesApi {
  list(filter?: { bot?: string }): Promise<RoutineView[]>;
  runs(routine: string, page?: { cursor?: string; limit?: number }): Promise<{ runs: RoutineRunView[]; next?: string }>;
}

/** `computers.read` gives the registry; `computers.control` gives holds, the user-working mark, Clover's own windows
 *  and the action signal (§9.2), whose OK says "controls the screen and input of your computers". */
export interface ComputersApi {
  list(): Promise<ComputerView[]>;
  get(name: string): Promise<ComputerView>;
  watch(listener: (computer: ComputerView) => void): Unsubscribe;
  holds(computer: string): Promise<{ holds: HoldView[]; userWorking: boolean }>;
  takeHold(computer: string, target: HoldTarget, opts?: { session?: string }): Promise<{ held: true; hold: HoldView } | { held: false; reason: "held-by-other" | "user-working" | "computer-offline"; by?: string }>;
  releaseHold(holdId: string): Promise<void>;
  setUserWorking(computer: string, on: boolean, target?: HoldTarget): Promise<void>;
  setActionRunning(computer: string, running: boolean, opts?: { session?: string }): Promise<void>;
  cloverWindows(computer: string): Promise<CloverWindow[]>;
}

/** `approvals`: which cards are pending and where, never their text. A component places one with the UI API's
 *  `<Card id>` and its parts. */
export interface ApprovalsApi {
  pending(): Promise<CardMeta[]>;
  watch(listener: (cards: CardMeta[]) => void): Unsubscribe;
}

/** `files`: the folder tree (§9.1), inside the fence. Paths are tree paths (`home/<Computer>/…`). */
export interface FilesApi {
  stat(path: string): Promise<FileStat | null>;
  readText(path: string, opts?: { offset?: number; length?: number }): Promise<string>;
  readBytes(path: string, opts?: { offset?: number; length?: number }): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array, opts?: { createDirs?: boolean }): Promise<void>;
  list(path: string): Promise<FileStat[]>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  move(from: string, to: string): Promise<void>;
  glob(pattern: string, opts: { cwd: string; limit?: number }): Promise<{ paths: string[]; truncated: boolean }>;
  grep(pattern: string, opts: { cwd: string; glob?: string; limit?: number }): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>;
}

/** `browser`: the Clover Browser's API (§12.1); DevTools calls pass only allowlisted domains. */
export interface BrowserApi {
  tabs(filter?: { owner?: TabOwner; computer?: string }): Promise<TabView[]>;
  open(opts: { owner: TabOwner; url?: string; show?: boolean; computer?: string }): Promise<TabView>;
  close(tab: string): Promise<void>;
  navigate(tab: string, url: string): Promise<TabView>;
  show(tab: string, view: string, viewport: Viewport): Promise<TabView>;
  hide(tab: string): Promise<TabView>;
  screenshot(tab: string, opts?: { format?: "png" | "jpeg" | "webp"; quality?: number }): Promise<Screenshot>;
  cdp<R = unknown>(tab: string, method: string, params?: Record<string, unknown>, opts?: { viewport?: Viewport }): Promise<R>;
  onCdpEvent(tab: string, listener: (method: string, params: unknown) => void): Unsubscribe;
  watch(listener: (tab: TabView) => void): Unsubscribe;
}

export interface UsageApi {
  rows(query: { since: number; until?: number; computer?: string; source?: UsageRow["source"]; cursor?: string; limit?: number }): Promise<{ rows: UsageRow[]; next?: string }>;
  plans(): Promise<PlanReading[]>;
  summary(query: { from: number; to: number; groupBy: "source" | "model" | "bot" | "computer" | "day" }): Promise<{ key: string; inputTokens: number; outputTokens: number; costUsd?: number }[]>;
  watch(listener: (since: number) => void): Unsubscribe;
}

export interface LogsApi {
  read(source: "core" | { plugin: string }, opts?: { lines?: number }): Promise<string[]>;
  follow(source: "core" | { plugin: string }, listener: (line: string) => void): Unsubscribe;
}

export interface NotifyApi {
  send(notification: { title: string; body?: string; session?: string }): Promise<void>;
}

/** `audio`: the app records and plays audio and hands it to plugins (§6.6). It records only while push-to-talk is
 *  held, unless the user turns listening on; the OK says it "can hear your microphone". Provisional for lanes D and E. */
export interface AudioApi {
  play(audio: { format: "pcm16-24k" | "mp3" | "opus"; data: Uint8Array | AsyncIterable<Uint8Array> }, opts?: { bot?: string }): Promise<{ stop(): void; done: Promise<void> }>;
  onRecording(listener: (chunk: { utterance: string; format: "pcm16-16k" | "opus"; data: Uint8Array; final: boolean }) => void): Unsubscribe;
}

// -------------------------------------------------------------------------------------------------
// The object
// -------------------------------------------------------------------------------------------------

export interface PluginApi {
  readonly plugin: PluginSelf;
  readonly points: PointsApi;
  readonly commands: CommandsApi;
  /** In components: their own host half. */
  readonly host: HostApi;
  /** In host halves: their components. */
  readonly ui: UiSendApi;
  readonly storage: StorageApi;
  readonly net: NetApi;
  /** Only in a process of the plugin's own (§5.2). */
  readonly secrets?: SecretsApi;
  /** Only in host halves. */
  readonly keys?: KeysApi;
  readonly settings: SettingsApi;
  /** A sealed card that says it comes from this plugin, with its name, id and source and the text; returns only the
   *  user's answer, and no plugin can read or answer it. Denied after 10 minutes unanswered. */
  confirm(text: string): Promise<boolean>;
  /** A string from the plugin's own keys, in the user's language (§5.5). */
  t(key: string, params?: Record<string, string | number>): string;

  /** `conversation.read`, `conversation.post`: each gives its own members. */
  readonly conversation?: Partial<ConversationApi>;
  readonly memory?: MemoryApi;
  readonly bots?: BotsApi;
  readonly routines?: RoutinesApi;
  /** `computers.read`, `computers.control`: each gives its own members. */
  readonly computers?: Partial<ComputersApi>;
  readonly approvals?: ApprovalsApi;
  readonly files?: FilesApi;
  readonly browser?: BrowserApi;
  readonly usage?: UsageApi;
  readonly logs?: LogsApi;
  readonly notify?: NotifyApi;
  readonly audio?: AudioApi;
}
