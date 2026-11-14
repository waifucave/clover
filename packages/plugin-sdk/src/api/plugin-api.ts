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
  type BotView, type Caller, type CardMeta, type CommandView, type ComputerView, type CloverWindow, type DeviceView, type FileStat, type HostProcess,
  type HoldTarget, type HoldView, type InstallSource, type MemoryEntry, type PlanReading, type PluginState, type RoutineRunView, type RoutineView,
  type Screenshot, type SessionView, type TabOwner, type TabView, type UsageRow, type Viewport, BUNDLED_ROOT_PLUGIN,
  topPluginIdOf,
} from "@waifucave/clover-protocol";

import type { AvatarApi, AvatarReport } from "../catalogs/avatar-cues";

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
  /** Whom the call is for, as the core recorded it when it made the call (R7): for a tool call or a hook, the session
   *  that made it; never anything the plugin or the model wrote (no `_meta` caller). */
  readonly caller: Caller;
  /** The session the call is for, when it is for one (a tool call's, a hook's). */
  readonly session?: string;
  /** The computer this handler runs on. */
  readonly computer: string;
  /** Aborted when the call is cancelled, interrupted, or runs out of time. */
  readonly signal: AbortSignal;
  /** When the call runs out of time, in the shared clock's milliseconds. */
  readonly deadline: number;
  /** The plugin API bound to this call (R7): what the plugin calls through it while serving a tool call acts as that
   *  call's session, so the core's own checks (a tab's owner, a hold, the fence) apply to the session, not to the
   *  plugin. The plugin host carries the call's id with each such call and the core binds the caller from its own
   *  record of the call. In a `host` MCP server, which gets no context, the host runs each `tools/call` inside its
   *  call, so `api` calls awaited from that handler act the same way; a call from work started outside it (a timer, a
   *  `start` task) acts as the plugin. */
  readonly api: HostPluginApi;
  /** A streamed call's input, when the caller streams one (a voice's microphone audio). */
  readonly input?: AsyncIterable<unknown>;
}

/** How a plugin-API call fails: it rejects with an error whose `code` is the contract's (`held`, `not_yours`,
 *  `point_stale`, `stalled`, `fenced`, `refused`, `not_found`…, as the core's `ContractError` codes) and whose
 *  `detail`, when there is one, holds no secret. On the wire it is the JSON-RPC error's `data.code` and `data.detail`
 *  (L's question). */
export interface PluginApiError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** A handler: any export of `host.entry` that a manifest names (§5.3 "Every handler, adapter, custom sign-in and
 *  component is an export of host or client"). */
export type Handler<A = unknown, R = unknown> = (args: A, ctx: HandlerContext) => R | Promise<R>;

/** A handler whose caller streams its result (a model adapter's output, a voice's audio): it returns an async
 *  iterable, an async generator most simply, whose values reach the caller in order and whose return value ends it. */
export type StreamHandler<A = unknown, T = unknown, R = void> = (args: A, ctx: HandlerContext) => AsyncIterable<T> | AsyncGenerator<T, R, undefined>;

/** A handler export may also be an object of handlers, a service whose caller names the one it calls: the webhook
 *  trigger calls a `webhook.ingress` entry's `register`, `next` and `ack` (`points.call`'s `method`), and the core
 *  calls a notifier's `notify` and `clear`. A plain function is called when no method is named. */
export type HandlerObject = { readonly [method: string]: Handler<any, any> };
export type HandlerExport = Handler<any, any> | HandlerObject;

/** A `notifiers` entry's handler (§10): an object of handlers the core calls on the main computer (or where the
 *  entry's `runsOn` says), `notify` when something happens that the user hasn't seen and `clear` when they catch up.
 *  Provisional for lanes D and I. */
export interface NotifierHandler {
  notify(update: NotifierUpdate, ctx: NotifierContext): void | Promise<void>;
  /** The user caught up: everything is seen. */
  clear(args: undefined, ctx: NotifierContext): void | Promise<void>;
}

/** A notifier's context. `desktop` is the local app's notifications on the computer the notifier runs on (lane G's
 *  ask: a `runsOn: "each"` notifier reaches its own computer's app), present only for the bundled `clover` tree's
 *  notifiers; the core sends them as `app.notify`. The same calls are `PluginApi.desktop` in that tree's process. */
export interface NotifierContext extends HandlerContext {
  readonly desktop?: DesktopNotifications;
}

export interface DesktopNotifications {
  /** Shows or replaces the banner with this id, on this computer's app. `shown: false` when no app is connected here,
   *  or the core held it back: a plugin's notification never shows while an approval card waits on this computer.
   *  `silent`: no sound (the user's setting). A banner has no buttons: a click only brings the app forward. */
  show(banner: { id: string; title: string; body?: string; session?: string; urgent?: boolean; silent?: boolean }): Promise<{ shown: boolean }>;
  /** Closes one banner, or every banner this notifier showed. */
  close(id?: string): Promise<void>;
}

/** A `pill.target` entry's handler (lane G's ask): the user's own words, sent from the Dispatch pill to this entry.
 *  The pill sends only from a real key press or click (`useUserSend`). The words are the user's to this plugin; what
 *  the plugin does with them is its own, and a turn it starts with them is the plugin's (`conversation.send`), never
 *  the user's. */
export interface PillTargetHandler {
  send(args: { text: string; device?: string }, ctx: HandlerContext): void | Promise<void>;
}

/** What the core tells a notifier. It never holds a message's, a card's, a question's or a tool's text, a file or a
 *  memory: only what happened, where, and the count. `notification` is there only for `kind: "notification"`, with
 *  what a plugin's `notify.send` (or the core's own notice) asked to show. A notifier whose service is off the user's
 *  computers sends that service no content at all: waifucave push sends `{ badge: unseen }` alone. */
export interface NotifierUpdate {
  /** One more for each update on this computer. The core coalesces: while a `notify` call runs, a newer update
   *  replaces the one waiting, so a notifier may see gaps and always ends on the latest (lane D's review). */
  seq: number;
  kind: "message" | "card" | "question" | "routine-result" | "agent-finished" | "notification";
  /** How many updates the user hasn't seen, as the core counts them; always sent. */
  unseen: number;
  bot?: string;
  session?: string;
  /** When it happened, on the shared clock. */
  at: number;
  notification?: { title: string; body?: string };
  /** For `kind: "routine-result"`: whether the run failed (an error, a timeout, a refusal, stopped or cut off), so a
   *  notifier can leave out the ones that went well (lane G's `routineFailed`). */
  failed?: boolean;
  /** Who the update is from, always (#179's review): `clover` (name "Clover") for the core's own (a message, a card, a
   *  question, a routine's result, an agent finishing, its own notices), or the plugin that called `notify.send`, by id
   *  and name (lane G's ask). `bundled` is false for a plugin outside the bundled `clover` tree: a notifier shows its
   *  notification marked as a plugin's ("Home, a plugin: …"), never as Clover's or a bot's, so no plugin named like a
   *  bot ("Luna") speaks as one. */
  sender: { pluginId: string; name: string; bundled: boolean };
}

/** What an `island.line` entry's handler returns (`points.call` of the entry's `handler`, no args): the line it wants on the
 *  island now, or nothing (`undefined` or `null`) for none. The island draws it in its own style, so every field is only
 *  data the island checks again: `text` is plain text (no markup; control characters become spaces; cut at 80 characters
 *  with an ellipsis), `icon` one of the island's named icons (`bolt`, `check`, `clock`, `info`, `sync`, `link`; any other
 *  name draws no icon), `progress` a number from 0 to 1 (clamped; anything else draws no bar), and `bot` the id of the bot
 *  the line is about (an id that doesn't look like one is dropped). The line's id is its entry's. A handler that takes more
 *  than 1.5 seconds, or throws, shows no line that time. */
export interface IslandLine {
  text: string;
  icon?: string;
  progress?: number;
  bot?: string;
}
/** An `island.line` entry's handler: called with no arguments, as the plugin. */
export type IslandLineHandler = (args: undefined, ctx: HandlerContext) => Promise<IslandLine | null | undefined> | IslandLine | null | undefined;

/** A `webhook.ingress` entry's handler (§7): an object of handlers the webhook trigger calls through `points.call`
 *  with `method`. Provisional for lanes D (the trigger) and I (the forwarder). Webhooks reach the trigger by pull:
 *  `next` waits up to `waitMs` (at most `WEBHOOK_NEXT_WAIT_MAX_MS`), and the trigger sets that call's `timeoutMs` to
 *  `waitMs` plus `WEBHOOK_NEXT_GRACE_MS`, inside the plugin API's 10-minute cap. Delivery is at least once: the
 *  trigger keeps the ids it has run, and acks or drops every delivery promptly. */
export interface WebhookIngressHandler {
  /** A webhook routine this computer holds. The trigger passes `webhookKeyHash(key)`, so the routine's key never
   *  enters an ingress plugin. `conflict`: another computer holds it, unless `takeover`. */
  register(args: { routine: string; keyHash: string; takeover?: boolean }, ctx: HandlerContext): Promise<{ url: string } | { conflict: { device: string } }>;
  /** `released: false` when another computer holds the routine, which is no error and no nack (lane I's B1). */
  unregister(args: { routine: string }, ctx: HandlerContext): Promise<{ released: boolean }>;
  /** Each routine with the deliveries the service dropped for it (a full queue, an expired one; lane I's S7), so the
   *  trigger can say runs were missed. */
  list(args: undefined, ctx: HandlerContext): Promise<{ routines: { id: string; device: string; held: boolean; dropped: number }[] }>;
  /** A long poll: up to `max` deliveries (default 16, at most 64) and `WEBHOOK_NEXT_MAX_BYTES` of bodies, waiting up
   *  to `waitMs` for the first. A body is at most `WEBHOOK_BODY_MAX_BYTES`. */
  next(args: { max?: number; waitMs?: number }, ctx: HandlerContext): Promise<{ deliveries: WebhookDelivery[] }>;
  /** Taken: the service deletes them. */
  ack(args: { ids: string[] }, ctx: HandlerContext): Promise<Record<string, never>>;
  /** Refused: the service deletes them too. */
  drop(args: { ids: string[] }, ctx: HandlerContext): Promise<Record<string, never>>;
}

export interface WebhookDelivery {
  /** Stable across repeats, so the trigger drops a delivery it has already run. */
  id: string;
  routine: string;
  /** When the service received it, for the missed-run rule (§7). */
  receivedAt: number;
  method: string;
  query: string;
  headers: [string, string][];
  ip?: string;
  body: Uint8Array;
  /** Outside text: the bot sees it marked untrusted (§7). */
  untrusted: true;
}

/** A routine's id as an ingress takes it, and the long poll's limits. */
export const WEBHOOK_ROUTINE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const WEBHOOK_NEXT_WAIT_MAX_MS = 300_000;
export const WEBHOOK_NEXT_GRACE_MS = 10_000;
export const WEBHOOK_NEXT_MAX = 64;
/** One delivery's body, and one `next`'s bodies together: 64 deliveries of 1 MiB. */
export const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;
export const WEBHOOK_NEXT_MAX_BYTES = WEBHOOK_NEXT_MAX * WEBHOOK_BODY_MAX_BYTES;

/** A `relays` entry's handler (§8.3): an object of handlers the link layer calls on each device that uses the relay.
 *  A relay plugin never touches the traffic: the core dials the endpoints it names, and everything through them stays
 *  end-to-end encrypted, so the relay sees which devices talk and how much, never what. Sync mail (§6.5) is sealed
 *  for its device before it reaches the plugin. Provisional for lane H (H-M2). */
export interface RelayHandler {
  /** Where this device reaches the relay, best first. */
  endpoints(args: undefined, ctx: HandlerContext): Promise<{ endpoints: RelayEndpoint[] }>;
  /** A relay this computer serves (the cloud computer relay): start or stop serving it here. */
  serve?(args: { on: boolean }, ctx: HandlerContext): Promise<{ endpoints: RelayEndpoint[] }>;
  /** Sync mail for a device that is never on with the sender: keep a sealed blob until `expiresAt`. */
  putMail?(args: { to: string; id: string; sealed: Uint8Array; expiresAt: number }, ctx: HandlerContext): Promise<Record<string, never>>;
  /** A device's mail, oldest first; taken mail stays until `ackMail`. `device` is the taking device's id, which the core
   *  passes (lane I's ask: a phone or a browser has no tree name). */
  takeMail?(args: { device: string; max?: number }, ctx: HandlerContext): Promise<{ mail: { id: string; sealed: Uint8Array }[] }>;
  ackMail?(args: { ids: string[] }, ctx: HandlerContext): Promise<Record<string, never>>;
}

export interface RelayEndpoint {
  /** `iroh`: an iroh relay URL; `websocket`: a relay that carries the link over WebSockets (the Cloudflare one). */
  kind: "iroh" | "websocket";
  url: string;
  region?: string;
  /** When `url` stops working (a ticket in it runs out, lane I's ask), in the shared clock's milliseconds: the core asks
   *  `endpoints()` again before then, and at once after the relay refuses it. */
  expiresAt?: number;
}

/** A `companions` entry's handler (§10): the daemon-side half of a remote client (the iOS app, the web page), called
 *  on the main. The client reaches the core on the core's own link, as a paired device with the core's fixed list of
 *  calls (`remote`, or `web` for the web page); a companion can't widen that list, and cards and their answers never
 *  pass through it. What it adds is what the client needs around the link. Provisional for lanes H and I. */
export interface CompanionHandler {
  /** A paired device of this companion came online or went away. */
  presence(args: { device: string; role: "remote" | "web"; online: boolean }, ctx: HandlerContext): Promise<void>;
  /** What the pairing screen shows for this companion's clients, given the core's pairing code: a URL to open on
   *  the other device (the web page's), or a QR payload. */
  pairing?(args: { code: string; expiresAt: number }, ctx: HandlerContext): Promise<{ url?: string; qr?: string }>;
}

/** What `register` takes in place of a routine's key: base64url (no padding) of SHA-256 over
 *  `clover hook key v1|<key>`, as the waifucave forwarder's service stores it. */
export async function webhookKeyHash(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`clover hook key v1|${key}`)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What `host.entry` may export besides its handlers. `mcp` serves the plugin's `host` MCP servers by name, each on
 *  the in-process transport the SDK provides (§5.3 "Handlers"); `start` runs when the host half starts, `stop` before
 *  it is replaced or stopped (§5.1 "Live changes"). */
/** The plugin API as a host half gets it: every call crosses to the core, so the component-only `t` and
 *  `conversation.answer` aren't there (calling them is a type error; the core refuses them too: they are `ui` in
 *  `API_CALLS`).
 *
 *  Reading a member the plugin API doesn't have (`api.env`, `api.log`, `api.settings.nope`) throws a TypeError that
 *  names it, at once. To feature-test, use `in`, which never throws: `"files" in api` and `"get" in api.settings` are
 *  true for a call a host half can make (or an area holding one), and false for anything else, a call the catalog marks
 *  not served yet included (`"memory" in api` is false in this build); the core still decides each call (your
 *  capabilities, your process). Don't write `if (api.foo)` for a member that may not exist.
 *
 *  Symbols and a closed list of keys that other code reads on any object read as undefined, at any depth, and never
 *  throw: promises and serialising (`then`, `catch`, `finally`, `toJSON`, `toString`, `valueOf`); inspection
 *  (`inspect`, `constructor`, `prototype`, `__proto__`, `$$typeof`, `nodeType`, `nodeName`, `tagName`, `length`,
 *  `name`, `displayName`, `caller`, `arguments`); ES-module interop (`__esModule`, `default`); and test frameworks'
 *  equality and spies (`asymmetricMatch`, `toAsymmetricMatcher`, `_isMockFunction`, `getMockName`, `mock`,
 *  `mockImplementation`, `calls`, and Immutable.js's `@@__IMMUTABLE_…@@` keys). So `await api`, `console.log(api)`,
 *  `expect({ api }).toEqual({ api })` and a bundle's `import * as ns` are safe. A call's `bind`, `call` and `apply`
 *  work, and `JSON.stringify(api)` gives undefined; `api` is calls, not data, so `structuredClone(api)` fails as
 *  cloning any function does. `api.plugin` is plain data. */
export type HostPluginApi = Omit<PluginApi, "t" | "conversation"> & {
  /** `answer` is a component's alone (the user's own answer): a host half never answers a question as the user. */
  readonly conversation?: Partial<Omit<ConversationApi, "answer">>;
};

export interface HostModule {
  start?(api: HostPluginApi): void | Promise<void>;
  stop?(reason: "reload" | "stop" | "removed"): void | Promise<void>;
  mcp?: Record<string, (transport: McpServerTransport, api: HostPluginApi) => void | Promise<void>>;
  /** What the plugin's components may call (`host.call(name, args)`), by name: `export const ui = { setCatalog }`.
   *  Default-deny: a component reaches only this table, never the module's other exports (its tool, hook, command
   *  and trigger handlers), and each call runs as the plugin, never the user. */
  ui?: Record<string, (args: unknown, ctx: HandlerContext) => unknown>;
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
  /** This device's id (`DeviceRecord.id`), which phones and browsers have too (lane I's ask). Optional until B-M2's
   *  host fills it, so the stand-ins already on main still type-check. */
  readonly device?: string;
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

/** The keyed fetch (§5.4), the same door as lane A's reference `createKeyedFetch` (clover-sdk), and held to its
 *  conformance kit (`runKeyedFetchConformance`):
 *  1. only the plugin's `network:` hosts, `https:` only (plain `http:` only to this computer's loopback);
 *  2. the core adds the key or token where the `auth` entry's `placement` says, from a fixed list (`keyed-fetch.ts`;
 *     default `Authorization: Bearer …`), never where the caller says; a request that sets that header itself fails
 *     `credential_header`, and every response comes back with each header that holds the key taken out;
 *  3. redirects are followed by hand: each hop held to rule 1, a hop to another origin drops the key;
 *  4. no time limit while data flows either way: only `idle_timeout` ends a request, after 5 minutes of silence or
 *     the request's own `idleTimeoutMs` (held to 1 s - 30 min, `clampKeyedIdleTimeoutMs`);
 *  5. a 401 gets one retry with a newer token from the refresher (a higher generation), when the body can be resent.
 *  Failures carry a closed code (`KEYED_FETCH_ERROR_CODES`) and never a key, a token or a response body. */
export interface NetApi {
  fetch(url: string, init?: RequestInit, opts?: KeyedFetchOptions): Promise<Response>;
}

/** There is no per-call placement: where the key goes is the `auth` entry's own `placement` (§5.9, lane A's B1). */
export interface KeyedFetchOptions {
  /** The `auth` entry whose key or token goes in, by its `secret` name, or `"waifucave"` (`WAIFUCAVE_AUTH`); `false`
   *  adds none. Left out: the plugin's one entry when it has exactly one, none when it has none, and `ambiguous_auth`
   *  when it has several. */
  auth?: string | false;
  /** How long silence (no data either way) may last before `idle_timeout`: held to 1 s - 30 min (a shorter one is
   *  raised, a longer one lowered); absent, five minutes. Lane A's interface v1 has the same option. */
  idleTimeoutMs?: number;
}

/** Lane A's codes, plus `no_account`: `auth: "waifucave"` with no waifucave account signed in on this computer. */
export const KEYED_FETCH_ERROR_CODES = [
  "host_not_declared", "insecure_url", "redirect_refused", "unknown_auth", "ambiguous_auth", "no_credential", "no_account",
  "credential_header", "idle_timeout", "aborted", "network", "refused",
] as const;
export type KeyedFetchErrorCode = (typeof KEYED_FETCH_ERROR_CODES)[number];

/** The `auth` name that adds this computer's waifucave account token (lane H mints it), the key to every computer
 *  (§8.1). No manifest may name a secret `waifucave`. The rules:
 *  * only plugins of the `clover` tree may use it (the forwarder, push), and only from the `clover` process, which the
 *    core decides from the install record (the owner's answer to S4); for any other it is no entry of theirs
 *    (`unknown_auth`);
 *  * only `https://` URLs on a `waifucave.com` host in the plugin's `network:` capabilities (`mayUseWaifucaveAuth`);
 *    any other URL fails `refused`;
 *  * each request gets a token minted for its host alone, never the account's own credential; a redirect to another
 *    host drops it (rule 3). The core mints it from the account session, which never syncs between computers; its
 *    claims are `iss`, `aud` (exactly the request's host), `sub` (the account), `dev` (this computer), `iat`, `exp` and
 *    `jti`; it lives at most 5 minutes and is cached per host (the core's `mintedTokenSource`);
 *  * plugin code never reads it: it exists only in the request the core sends;
 *  * after a 401 the core mints a newer one and retries once (rule 5);
 *  * with no account signed in, the fetch fails `no_account` at once, and the plugin waits for the account rather than
 *    retrying on a timer. */
export const WAIFUCAVE_AUTH = "waifucave";
/** The domain whose hosts take the waifucave token: `hooks.waifucave.com`, `push.waifucave.com`. */
export const WAIFUCAVE_DOMAIN = "waifucave.com";

/** Where the waifucave token may go: the domain's `https` hosts, or in a development profile the local emulators'
 *  exact origins, `http` allowed (`http://127.0.0.1:8787`); the core's own setting, never a plugin's. */
export type WaifucaveTarget = { domain: string } | { origins: readonly string[] };

/** Whether a plugin may fetch `url` with `auth: "waifucave"`: a `clover` plugin, calling from the `clover` process
 *  (`from`, the process its connection is bound to; a component is `ui`). Its `network:` capability is checked as for
 *  any fetch. */
export function mayUseWaifucaveAuth(
  pluginId: string,
  url: string,
  from: HostProcess | "ui",
  target: WaifucaveTarget = { domain: WAIFUCAVE_DOMAIN },
): boolean {
  if (from !== "clover" || topPluginIdOf(pluginId) !== BUNDLED_ROOT_PLUGIN) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  if ("origins" in target) return target.origins.some((o) => URL.canParse(o) && new URL(o).origin === u.origin);
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  return h === target.domain || h.endsWith(`.${target.domain}`);
}

/** Only a process of the plugin's own that must sign with a secret (AWS SigV4, §5.2) reads it; a worker can't, and
 *  neither can a layer. */
export interface SecretsApi {
  get(name: string): Promise<string | undefined>;
}

/** Key pairs the core keeps for a plugin on this computer, whose private halves never leave the core: in the secret
 *  store, never synced, one set per computer, kept when the plugin is removed (as its data folder is) until `delete`.
 *  For a host half that must receive what was sealed to this computer, as the waifucave forwarder does, without
 *  holding a secret a worker could leak. Only from the `clover` process (the owner's answer to S4): the core honours
 *  `open` there alone, so the other calls are the `clover` tree's too, since a pair no one can open with is no use. */
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
  /** Every session's view as it changes: a new one (a coding session started from the CLI, another window or a bot's agent), a status change, a title. */
  watch(listener: (session: SessionView) => void): Unsubscribe;
  history(session: string, page: { before?: number; limit: number }): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }>;
  /** A follow whose replay can't read the session's history ends with one `{ type: "follow_ended", reason }` event. */
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
  /** A trigger of this plugin's fired for a routine its handler was armed for (`TriggerHandler.arm`): the routine runs
   *  on this computer. Host halves only, and only for a trigger `type` the plugin's own `triggers` entry has; needs no
   *  capability (its card says it starts routines). `payload` (at most `ROUTINE_FIRE_PAYLOAD_MAX` characters) reaches
   *  the run as text marked as the trigger's, never as the user's. */
  fire(routine: string, type: string, payload?: string): Promise<void>;
}

/** The longest payload a trigger hands a routine's run (`RoutinesApi.fire`), in characters. */
export const ROUTINE_FIRE_PAYLOAD_MAX = 64 * 1024;

/** A `triggers` entry's handler (§7): an object the routine engine calls with `method`, as the core (never a user). A
 *  routine file that names the trigger's `type` arms it with its fields; the plugin then watches whatever it watches
 *  and calls `api.routines.fire(routine, type, payload?)` when it should run, with the API its `start` was given (a
 *  call's own `ctx.api` ends with the call). The engine arms each such routine on the
 *  computer that holds its file, and arms it again whenever the plugin's host half starts (a restart, an update, a
 *  crash), so `arm` replaces what it had for that routine. */
export interface TriggerHandler {
  /** Start watching for a routine. Throws when the fields don't read; the engine notes it on the routine. */
  arm(args: { routine: string; type: string; fields: Record<string, unknown> }, ctx: HandlerContext): Promise<void> | void;
  /** Stop: the routine is gone, paused, changed (armed again after), or names the trigger no more. */
  disarm(args: { routine: string; type: string }, ctx: HandlerContext): Promise<void> | void;
}

/** `computers.read` gives the registry; `computers.control` gives holds, the user-working mark, Clover's own windows
 *  and the action signal (§9.2), whose OK says "controls the screen and input of your computers". */
export interface ComputersApi {
  list(): Promise<ComputerView[]>;
  get(name: string): Promise<ComputerView>;
  watch(listener: (computer: ComputerView) => void): Unsubscribe;
  holds(computer: string): Promise<{ holds: HoldView[]; userWorking: boolean }>;
  /** A hold for the session whose tool call the plugin is serving (R7): the core takes the session from the call it
   *  bound, never from the plugin (#179's review, S1). Outside a tool call the hold is the plugin's own. */
  takeHold(computer: string, target: HoldTarget): Promise<{ held: true; hold: HoldView } | { held: false; reason: "held-by-other" | "user-working" | "computer-offline"; by?: string }>;
  releaseHold(holdId: string): Promise<void>;
  setUserWorking(computer: string, on: boolean, target?: HoldTarget): Promise<void>;
  /** For the bound session too, as `takeHold` is. */
  setActionRunning(computer: string, running: boolean): Promise<void>;
  cloverWindows(computer: string): Promise<CloverWindow[]>;
}

/** The stage's own call (bundled `clover` tree, components only): which renderer drew a bot's figure, what its model has
 *  and where it stands; `undefined` clears it. */
export interface AvatarReportApi {
  report(bot: string, report: AvatarReport | undefined): Promise<void>;
}

/** `devices.read`: the user's devices, for the island's Devices tab and the like: names, kinds, links, online state
 *  and which one is the main (review S16). */
export interface DevicesApi {
  list(): Promise<DeviceView[]>;
  watch(listener: (device: DeviceView) => void): Unsubscribe;
}

/** `approvals`: which cards are pending and where, never their text, and only the cards of the plugin's own bot (the
 *  bundled `clover` tree: all). A component places one with the UI API's `<Card id>` and its parts. `watch` hands the
 *  whole pending list each time it changes. */
export interface ApprovalsApi {
  pending(): Promise<CardMeta[]>;
  watch(listener: (cards: CardMeta[]) => void): Unsubscribe;
}

/** `files`: the folder tree (§9.1), inside the fence. Paths are tree paths (`home/<Computer>/…`). `noFollow` (lane J's
 *  `tree/nofollow.ts`, tree protocol 1.1) follows no link anywhere on the way, refusing one, and reads only a plain file
 *  reached without one: for a viewer of files a runner may have left a link among. A computer on an older build can't
 *  honour it, so the call is refused (`unsupported`) rather than sent. */
export interface FilesApi {
  stat(path: string, opts?: { noFollow?: boolean }): Promise<FileStat | null>;
  readText(path: string, opts?: { offset?: number; length?: number; noFollow?: boolean }): Promise<string>;
  readBytes(path: string, opts?: { offset?: number; length?: number; noFollow?: boolean }): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array, opts?: { createDirs?: boolean }): Promise<void>;
  list(path: string): Promise<FileStat[]>;
  /** The real path of a file or folder the user picked in this plugin's page (`grant:<uuid>`, or `grant:<uuid>/<path>`
   *  under a picked folder), for a program the host half starts (ffmpeg takes paths). The host half only, never the
   *  page; another plugin's pick is refused. Its own processes' fence opens the same path. */
  path(path: string): Promise<string>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  move(from: string, to: string): Promise<void>;
  glob(pattern: string, opts: { cwd: string; limit?: number }): Promise<{ paths: string[]; truncated: boolean }>;
  grep(pattern: string, opts: { cwd: string; glob?: string; ignoreCase?: boolean; limit?: number }): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>;
  /** Changes under a folder (lane J's ask, for a code session's Files panel): the tree paths that changed, coalesced,
   *  or `resync` when the holder's watch dropped and the folder must be listed again. The unsubscribe ends it. */
  watch(path: string, listener: (event: { type: "changed"; paths: string[] } | { type: "resync" }) => void): Promise<Unsubscribe>;
  /** Files the user hands a plugin: components only, so absent in a host half (the page asks; the app's own dialog shows; the user chooses). Each pick
   *  needs the user's own key press or click in the page, and returns TOKENS, never paths: a token is `grant:<uuid>`, bound to
   *  this plugin. The page passes a token to its host half (`host.call`), which uses it as the path of `files.stat`,
   *  `readText`, `readBytes`, `write` and `list` (a folder grant also as `grant:<uuid>/<relative path>`), and, host half only,
   *  `files.path(token)` (lane A's) for the real path to hand its own process (ffmpeg). An open grant is read-only; a save grant is
   *  write on that one file (and reads it); a folder picked for writing carries read too. The core keeps the grants
   *  (`plugin.grant.add/remove/list`, app role) until the user removes one in Settings or the plugin is removed, and refuses
   *  places no plugin may hold (the Clover home, secrets, the plugins folder, the user's home itself) with a reason. */
  pickOpen?(opts?: { multiple?: boolean; filters?: FilePickFilter[] }): Promise<FilePickResult>;
  pickFolder?(opts?: { forWriting?: boolean }): Promise<FilePickResult>;
  pickSave?(opts?: { suggestedName?: string; filters?: FilePickFilter[] }): Promise<FilePickResult>;
  /** The page's media URL for a file grant it holds a read on (an open grant, or a save grant): a `<video>`, `<audio>` or
   *  `<img>` takes it directly, served from the plugin's own layer origin with HTTP range support. Pure: the grant is
   *  checked when the URL is fetched, so a token of another plugin's, a folder's or a removed one's fetches nothing. */
  url?(token: string): string;
  /** A drop of files or folders on the page, as tokens like a pick's (the app reads the paths of a real drop in its own code; a
   *  page's script can't make one up). The page opts in to receiving drops the usual way, by cancelling `dragover`. */
  onDrop?(listener: (grants: FileGrant[], refused?: string) => void): Unsubscribe;
}

/** One native-dialog filter: a label and plain extensions (`mp4`, no dot). */
export interface FilePickFilter { name: string; extensions: string[] }
/** What a pick hands the page: never a path. */
export interface FileGrant { token: string; name: string; kind: "file" | "folder"; access: "read" | "write" | "readwrite"; size?: number }
export type FilePickResult = { grants: FileGrant[] } | { cancelled: true };

/** `terminal`: the user's terminals on their computers (lane F's request; lane J's PTY), for the component that draws
 *  one. Only the bundled `clover` tree holds it (`bundledOnly`, review T1); its OK says it runs commands on the user's
 *  computers, and a computer at read-only never opens one for a plugin (`refused`). Components only.
 *  What reaches a terminal is not written by the component: lane E's runtime derives it from trusted input events.
 *  `input` takes the `keydown` or `paste` event itself; a trusted key press becomes its bytes, and a trusted paste goes
 *  through the paste door, which takes the clipboard's text, brackets it when the program turned bracketed paste on,
 *  and asks the user before one of more than one line goes. An untrusted or made-up event sends nothing. */
/** `plugins.install`, bundled-only (the plugin index browser): what it installs lands found, with its sealed OK card, and
 *  never runs before the user's OK (F-M2's review, S1). Components only. */
export interface PluginsApi {
  install(source: InstallSource): Promise<{ id: string; state: PluginState; card?: string }>;
}

/** Where the window is now: what `shell.state` answers and `shell.watch` hears. Never a draft, a message or a path. */
export interface ShellState {
  /** The tab showing: a bot's (`bot`, with `id`), a coding session's or an agent's (`agent`), `settings`, `plugins`, an app (`app`, its `opens` key), `archive`, a bot's editor (`bot-editor`). */
  readonly tab: { readonly kind: "bot" | "agent" | "settings" | "plugins" | "app" | "archive" | "bot-editor" | "other"; readonly id?: string };
  /** The bot whose tab shows, if one does. */
  readonly bot?: string;
  /** A window over the tab: `settings` while Settings shows over it (the tab under it stays `tab`). */
  readonly dialog?: "settings";
  /** The sidebar: rested as a rail of icons, and which side it shows (the bots' or the code's). */
  readonly sidebar: { readonly collapsed: boolean; readonly side: "bots" | "code" };
  /** The panels of the tab: the views open now, and the ones it offers. */
  readonly panels: { readonly open: readonly string[]; readonly available: readonly string[] };
  /** How far the window's own native controls (the traffic lights) reach from the top left, in CSS pixels: nothing drawn may sit under them. */
  readonly safeArea: { readonly left: number; readonly top: number };
}

/** An app button the sidebar offers: its title, icon (a file URL) and the `main`/`panel` key it opens. */
export interface ShellApp {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
}

/** The signed-in account the sidebar shows beside its settings gear. `name` is empty when nobody is signed in. */
export interface ShellAccount {
  readonly name: string;
  readonly detail?: string;
}

/** Where `shell.go` takes the window. */
export type ShellTarget =
  | { readonly bot: string }
  | { readonly session: string }
  | { readonly side: "bots" | "code" }
  | { readonly app: string }
  | { readonly page: "plugins" | "archive" };

/**
 * The window itself: what a plugin that draws its own bar, its own sidebar or its own controls asks of the app, so
 * the app never has to draw a plugin's styles for it. The reads (`shell.read`) answer with where the window is; the acts
 * (`shell.control`) are the user's own: each one counts only inside the user's own key press or click in the frame that
 * calls it (any other is refused and does nothing), and none of them changes anything but the window's own place. Components
 * only. What they reach is the window of the tab the plugin's bot shows (an act for another bot's tab is refused).
 */
export interface ShellApi {
  state(): Promise<ShellState>;
  watch(listener: (state: ShellState) => void): Unsubscribe;
  /** The app buttons of the sidebar (`sidebar.app`), in its order. */
  apps(): Promise<readonly ShellApp[]>;
  /** The account row of the sidebar: who is signed in (`name`) and which computer this is when that differs (`detail`). Its press is `openSettings`. */
  account(): Promise<ShellAccount>;
  /** The bot's editor (the pencil): this tab's bot by default. */
  openBotEditor(bot?: string): Promise<void>;
  /** A panel view of this tab (`session`, `browser`, ...): open it, close it, or whichever the other. */
  openPanel(view: string): Promise<void>;
  closePanel(view: string): Promise<void>;
  togglePanel(view: string): Promise<void>;
  /** Rest the sidebar as a rail of icons (`true`) or open it (`false`); `toggleSidebar` is the other of the two. */
  setSidebar(collapsed: boolean): Promise<void>;
  toggleSidebar(): Promise<void>;
  /** Show a bot's tab, a session's, the code side or the bots' side, an app, or the Plugins or Archive page. */
  go(target: ShellTarget): Promise<void>;
  /** The settings screen, at a section if it has one. */
  openSettings(section?: string): Promise<void>;
  /** Says which of the window's two essential handles this plugin's own controls offer while its frame is shown: the sidebar's toggle (`sidebar`: its
   *  top bar draws the button that folds and opens the window's sidebar) and a region that drags the window (`drag`). With no bar, the shell adds its own
   *  minimal handle for each one nothing offers, so the user is never stranded. It never drops the window's sidebar, which looks the same on every tab. */
  provide(parts: readonly ("sidebar" | "drag")[]): Promise<void>;
  /** From a press on a region this plugin marks: the window follows the pointer until it lets go (a bar of its own that drags the window). */
  dragWindow(): Promise<void>;
}

export interface TerminalApi {
  /** In a folder of the tree on that computer (its home folder by default); `session` shows it in that panel. */
  open(opts: { computer: string; cwd?: string; session?: string; cols: number; rows: number }): Promise<{ terminalId: string }>;
  input(terminalId: string, event: TerminalInputEvent): Promise<void>;
  /** Output as it comes, and `exited` once the shell ends. */
  onData(terminalId: string, fn: (data: string, exited?: { code: number | null }) => void): Unsubscribe;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  close(terminalId: string): Promise<void>;
}

/** A DOM `keydown` `KeyboardEvent` or `paste` `ClipboardEvent` from the terminal's own element, as the browser
 *  dispatched it; typed loosely, since the SDK carries no DOM types. */
export interface TerminalInputEvent {
  readonly type: "keydown" | "paste";
  readonly isTrusted: boolean;
}

/** `browser`: the Clover Browser's API (§12.1); DevTools calls pass only allowlisted domains. */
/** A plugin's calls carry the plugin as their caller, or, while it serves a tool call, that call's session (R7).
 *
 *  Whose tabs a call may open (#179's review, S1): acting as itself, a plugin opens tabs only in its own partition
 *  (`owner: { kind: "plugin", plugin }` with its own id); serving a tool call, only for that session or the session's
 *  own bot; and the person's own partition (`user`) only for a session the user gave its card (ruling R10). Anything
 *  else is refused.
 *
 *  On a tab the user holds, a session's calls and a plugin's own code are refused (`held`). Only a layer's command that
 *  the app saw come from the user's own click or key in that layer passes, so a view's back button works while held
 *  (L's question). A layer's calls carry `{ kind: "plugin", pluginId }`, never the user. `computer` is a computer's
 *  name, as `api.plugin.computer` gives this one. */
export interface BrowserApi {
  /** Whose tool call this is (the bundled `clover` tree's host halves): the session the core bound to it, its kind and
   *  its bot. A call made outside a tool call is refused. */
  toolCaller(): Promise<{ kind: "session"; sessionId: string; sessionKind: string; bot?: string }>;
  tabs(filter?: { owner?: TabOwner; computer?: string }): Promise<TabView[]>;
  /** Opens a tab headless, or shown at once in the view `show` names (L's question). */
  open(opts: { owner: TabOwner; url?: string; computer?: string; show?: { view: string; viewport: Viewport } }): Promise<TabView>;
  close(tab: string): Promise<void>;
  navigate(tab: string, url: string): Promise<TabView>;
  show(tab: string, view: string, viewport: Viewport): Promise<TabView>;
  hide(tab: string): Promise<TabView>;
  screenshot(tab: string, opts?: { format?: "png" | "jpeg" | "webp"; quality?: number }): Promise<Screenshot>;
  /** Resolves with the DevTools method's own result, unwrapped. */
  cdp<R = unknown>(tab: string, method: string, params?: Record<string, unknown>, opts?: { viewport?: Viewport }): Promise<R>;
  onCdpEvent(tab: string, listener: (method: string, params: unknown) => void): Unsubscribe;
  /** A tab's changes, and its close, as the core's `BrowserChange` (L's question). */
  watch(listener: (change: { type: "changed"; tab: TabView } | { type: "closed"; id: string; computer: string; by: "user" | "page" | "crash" | "api" }) => void): Unsubscribe;
}

export interface UsageApi {
  /** `bot` and `session` keep one bot's or one session's rows (lane D's filters, as `usage.rows` has them). */
  rows(query: { since: number; until?: number; computer?: string; source?: UsageRow["source"]; bot?: string; session?: string; cursor?: string; limit?: number }): Promise<{ rows: UsageRow[]; next?: string }>;
  plans(): Promise<PlanReading[]>;
  /** `day` is the UTC date; a row with no bot or session groups under `-`. */
  summary(query: { from: number; to: number; groupBy: "source" | "model" | "bot" | "computer" | "day" | "session"; bot?: string; session?: string }): Promise<{ key: string; inputTokens: number; outputTokens: number; costUsd?: number }[]>;
  watch(listener: (since: number) => void): Unsubscribe;
}

/** Logs: the last `lines` lines (default 200, at most 2,000), and each line from now on. A plugin's own tree's (its own
 *  id or a child's, as its Settings page shows them) with no capability; with `logs.read`, Clover's own (`"core"`) and
 *  any other plugin's. */
export interface LogsApi {
  read(source: "core" | { plugin: string }, opts?: { lines?: number }): Promise<string[]>;
  follow(source: "core" | { plugin: string }, listener: (line: string) => void): Unsubscribe;
}

/** `notify`: a notification to the user through the notifiers (§10), always under the plugin's own name. The core
 *  holds it to a rate per plugin (`NOTIFY_PER_MINUTE`, `NOTIFY_PER_HOUR`), drops it when the user muted the plugin, and
 *  refuses it while an approval card waits on this computer. A title of at most 120 characters and a body of at most
 *  400 are shown; no buttons, a click only brings the app forward. `session` is not taken yet. */
export interface NotifyApi {
  send(notification: { title: string; body?: string; session?: string }): Promise<void>;
}

/** `audio`: the app plays a plugin's audio as a bot's speech (the plugin's own bot's unless `opts.bot` names another live
 *  bot), and hands it the user's push-to-talk audio for every bot as it comes (§6.6). The OK says it "hears what you say to your bots with push-to-talk, and can play sound, including as your bots' voices".
 *  `play`'s `done` settles when the last piece is handed to the app, not when the app finishes playing it. */
/** `speech`: the active voice mode's own door to this device's player, the one sink (§6.6). Any other plugin, an
 *  inactive voice mode included, is refused (`modes` excepted). */
export interface SpeechApi {
  /** One piece of a bot's speech to the player: pcm16-24k (16-bit little-endian mono at 24 kHz), the last `final`.
   *  `utterance` is the mode's own name for it (`[A-Za-z0-9_-]`, at most 64). The last piece's answer waits until the
   *  player says the utterance ended (`ended: true`), or until its length and a few seconds have passed (`false`): when
   *  it resolves, the next sound may start. Other pieces answer `null`. */
  piece(p: { bot: string; session: string; utterance: string; data: Uint8Array; final: boolean }): Promise<{ ended: boolean } | null>;
  /** Plays a sound a plugin offered as a bot's voice (`audio.play`; its ticket from `VoiceModeHandler.offer`): its
   *  pieces so far and those still coming. Resolves once it ended on the player (or its deadline passed), with how long
   *  it sounds. */
  play(req: { ticket: string }): Promise<SpeechDone>;
  /** Ends what an utterance (or everything a bot) is sounding now; its last piece goes, so the player knows. */
  stop(req: { utterance?: string; bot?: string }): Promise<void>;
  /** The voice modes on and running here, and which is active. */
  modes(): Promise<{ pluginId: string; id: string; name: string; active: boolean }[]>;
}

export interface SpeechDone {
  bytes: number;
  /** How long it sounds (pcm16-24k: two bytes a sample at 24 kHz). */
  seconds: number;
  /** Stopped before its end. */
  cut: boolean;
  /** The player said it ended; `false` when its deadline passed with no word from it (no window, say). */
  ended: boolean;
}

/** One provider on `voices` (§6.6), as a voice mode sees it. */
export interface VoiceProviderView {
  pluginId: string;
  id: string;
  name: string;
  speak: boolean;
  listen: boolean;
}

/** `voices`: the providers' endpoints (§6.6), for a plugin with `voices.use` and for any voice mode. A provider
 *  plugin's `voices` entry is its endpoint; the core carries the calls (as it carries `points.call`) and places no key:
 *  the provider's own keyed fetch does, and the caller sees only audio and text, its own data: nothing sounds through
 *  these (the player is the active voice mode's, `speech`). At most VOICES_CALLS_PER_PLUGIN open at once a plugin;
 *  each use is logged with the caller's id. */
export interface VoicesApi {
  providers(): Promise<VoiceProviderView[]>;
  /** `text` (or, for the active voice mode, a reply's `ticket`, whose text stays in the core) said by `provider` with
   *  `voice`. A ticket's bot gets the user's provider check first. Each piece of audio (pcm16-24k) comes to
   *  `listener` as it is made, then `done` (or `error`); the returned function cancels. */
  speak(provider: string, req: { ticket?: string; text?: string; voice?: string; model?: string }, listener: (e: { audio?: Uint8Array; done?: { bytes: number }; error?: string }) => void): Unsubscribe;
  /** Opens `provider`'s listening under the caller's own `id` (for the active voice mode, a push-to-talk utterance's,
   *  from `VoiceModeHandler.listenStart`); the caller feeds it (`feed`), and what it heard comes to `listener`. */
  listen(provider: string, req: { id: string; format: "pcm16-16k" | "opus" }, listener: (e: { text?: string; error?: string }) => void): Unsubscribe;
  /** One piece of an open listening, the last `final`. */
  feed(id: string, data: Uint8Array, final: boolean): Promise<void>;
}

/** What the core calls on the active voice mode's handler (its `voiceModes` entry's `handler`, an exported object). */
export interface VoiceModeHandler {
  /** A bot's reply to say: at its turn's end, or `asked` by the user's speak button; `voice` is the bot's voice choice.
   *  The text stays in the core: the ticket goes to `voices.speak`. `queued`: it waits its turn. */
  reply(args: { ticket: string; bot: string; session: string; asked: boolean; voice: { provider: string; voice: string; model?: string } }): Promise<{ queued: boolean }>;
  /** The user's stop on a bot: what it says ends, and what it has waiting goes. */
  stop(args: { bot: string }): Promise<void>;
  /** The user holds push-to-talk on this device: whatever sounds stops and nothing starts until the last piece.
   *  `voice` is the bot's voice choice; the mode opens a provider's listening for `utterance` (`voices.listen`). */
  listenStart(args: { bot: string; utterance: string; format: "pcm16-16k" | "opus"; voice: { provider: string; voice: string; model?: string } }): Promise<void>;
  /** One push-to-talk piece; the mode feeds it on. On the last (`final`) it answers what the provider heard. */
  listenPiece(args: { bot: string; utterance: string; data: Uint8Array; final: boolean }): Promise<{ text?: string }>;
  /** A push-to-talk utterance ended without its last piece (the app went away): resume. */
  listenEnd(args: { bot: string; utterance: string }): Promise<void>;
  /** A plugin plays sound as a bot's voice (`audio.play`): its ticket, to play in its turn (`speech.play`). */
  offer(args: { ticket: string; bot: string; from: string }): Promise<void>;
}

export interface AudioApi {
  play(audio: { format: "pcm16-24k" | "mp3" | "opus"; data: Uint8Array | AsyncIterable<Uint8Array> }, opts?: { bot?: string }): Promise<{ stop(): void; done: Promise<void> }>;
  onRecording(listener: (chunk: { utterance: string; format: "pcm16-16k" | "opus"; data: Uint8Array; final: boolean }) => void): Unsubscribe;
}

// -------------------------------------------------------------------------------------------------
// The object
// -------------------------------------------------------------------------------------------------

/** Members the catalog lists that no side serves yet (`ApiCallInfo.notYet` in `catalogs/api-calls.ts`): typed absent,
 *  so calling one is a type error, and the core refuses it with why ("isn't available yet"). The area's own interface
 *  keeps their shape for when they are served. */
export type NotYet<T, K extends keyof T = keyof T> = Omit<T, K> & { readonly [P in K]?: never };

export interface PluginApi {
  readonly plugin: PluginSelf;
  readonly points: PointsApi;
  /** Its own tree's commands, and another plugin's with `call:<its top-level id>` (§5.4). */
  readonly commands: CommandsApi;
  /** In components: their own host half. */
  readonly host: HostApi;
  /** In host halves: their components. */
  readonly ui: UiSendApi;
  readonly storage: StorageApi;
  readonly net: NetApi;
  /** Only in a process of the plugin's own (§5.2). */
  readonly secrets?: SecretsApi;
  /** The `clover` process's per-computer keys: the plugin's own X25519 pairs, whose private half stays in the core. */
  readonly keys?: KeysApi;
  readonly settings: SettingsApi;
  /** A sealed card that says it comes from this plugin, with its name, id and source and the text; returns only the
   *  user's answer, and no plugin can read or answer it. Denied after 10 minutes unanswered. */
  confirm(text: string): Promise<boolean>;
  /** `confirm`, with the card's id for a record that names it (lane I's ask: `PairingProof`'s `{ via: "code", card }`).
   *  A separate call, so `if (await confirm(...))` never meets an object, which is always true. */
  confirmCard?(text: string): Promise<{ allowed: boolean; card: string }>;
  /** A string from the plugin's own keys, in the user's language (§5.5). In components only: a host half's API
   *  (`HostPluginApi`) has no `t`, and the core refuses it there. */
  t(key: string, params?: Record<string, string | number>): string;

  /** `conversation.read`, `conversation.post`: each gives its own members. */
  readonly conversation?: Partial<ConversationApi>;
  /** Its own bot's memory with no capability (a bot plugin); every bot's with `memory.read`. Read-only. */
  readonly memory: MemoryApi;
  readonly bots?: BotsApi;
  /** Its own bot's routines with no capability (a bot plugin); every bot's with `routines.read`. Read-only, but for
   *  `fire`, a host half's own triggers. */
  readonly routines: RoutinesApi;
  /** `computers.read`, `computers.control`: each gives its own members. */
  readonly computers?: Partial<ComputersApi>;
  readonly devices?: DevicesApi;
  /** Components only, with `approvals`: the cards that wait for this plugin's own bot, without their text. */
  readonly approvals?: ApprovalsApi;
  readonly files?: FilesApi;
  /** The bundled `clover` tree's host halves only (its Browser tool, for the session a tool call serves): `tabs`, `open`,
   *  `close`, `navigate`, `screenshot`, `cdp` (the tool's own nine DevTools methods) and `caller`. `show`, `hide`,
   *  `onCdpEvent` and `watch` are the person's panel's (a component's), not a host half's; a third-party plugin's `browser` isn't served. */
  readonly browser?: NotYet<BrowserApi, "show" | "hide" | "onCdpEvent" | "watch">;
  /** Components only. `shell.read`, `shell.control`: each gives its own members. */
  readonly shell?: Partial<ShellApi>;
  /** Components only. */
  readonly terminal?: TerminalApi;
  /** Components only, of the bundled `clover` tree. */
  readonly plugins?: PluginsApi;
  /** `usage.read`: the usage rows and plan readings, read-only. */
  readonly usage?: UsageApi;
  /** Its own tree's logs with no capability; Clover's and every other plugin's with `logs.read`. */
  readonly logs: LogsApi;
  readonly notify?: NotifyApi;
  /** `audio`: the app plays its audio as a bot's speech (its own bot's unless `opts.bot`), and it hears push-to-talk. */
  readonly audio?: AudioApi;
  /** The active voice mode's player door (§6.6); refused to every other plugin. */
  readonly speech?: SpeechApi;
  /** The voice providers' endpoints, for the active voice mode (§6.6). */
  readonly voices?: VoicesApi;
  /** `avatar.read`, `avatar.control`: the plugin's own bot's figure, each call by its capability. */
  readonly avatar?: Partial<AvatarApi> & Partial<AvatarReportApi>;
  /** Only the bundled `clover` tree's process: this computer's desktop notifications, for its notifier. */
  readonly desktop?: DesktopNotifications;
}
