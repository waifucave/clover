// What F's parts take from the app's plugin runtime and the core, in the shapes lane B declares them (B-M0 on
// `lane/b-m0`: `packages/plugin-sdk/src/api/{ui-api,plugin-api}.ts`, `packages/plugin-sdk/src/catalogs/spots.ts` and
// the views and methods in `packages/protocol/src/{sessions,plugins,computers,devices,app,approvals,usage}.ts`).
//
// Copied, not imported: B's #157 isn't merged, and no published package carries these yet. Only the parts of each
// shape F's parts read are here. When B's packages land, this file becomes imports from them, and lane E's
// `@waifucave/clover-plugin-sdk/ui` replaces `ui.ts` beside it.
import type { ReactNode } from "react";

// -------------------------------------------------------------------------------------------------
// The UI API (ui-api.ts)
// -------------------------------------------------------------------------------------------------

export type TokenValue = string | number;
export type Unsubscribe = () => void;

/** Which entry a component is. */
export interface EntryRef {
  readonly pluginId: string;
  readonly id: string;
  readonly spot: string;
  readonly key?: string;
}

/** What every entry's component gets: its spot's props, the part's resolved tokens, and which entry it is. */
export interface EntryProps<P = Record<string, unknown>> {
  readonly props: P;
  readonly tokens: Readonly<Record<string, TokenValue>>;
  readonly entry: EntryRef;
}

export type EntryComponent<P = any> = (props: EntryProps<P>) => ReactNode;

/** `<Spot>`'s props. B declares `key`, which React keeps for itself and never hands a component, so here it is
 *  `spotKey` (a question for B and E). `fallback` shows when nothing fills a single spot or a keyed cell: the declaring
 *  part's own rendering, such as a message kind no plugin restyles (also a question for B and E). */
export interface SpotElementProps {
  name: string;
  spotKey?: string;
  props?: Record<string, unknown>;
  fallback?: ReactNode;
  /** One entry of a list spot, by `<plugin-id>#<entry-id>`, for a part that lays its entries out one at a time
   *  (Settings' added sections). Also a question for E. */
  only?: string;
}

/** The kinds of session (`SessionKind`, common.ts). */
export type SessionKind = "bot" | "side-thread" | "agent" | "coding";

/** Levels, lowest first (`LEVELS`, common.ts). */
export const LEVELS = ["read-only", "ask", "ask-risky", "accept-edits", "automatic"] as const;
export type Level = (typeof LEVELS)[number];

/** A change the core either made, or turned into a sealed card that waits for the user (`ChangeResult`). */
export type ChangeResult = { applied: true } | { applied: false; card: string };

// -------------------------------------------------------------------------------------------------
// Views (protocol)
// -------------------------------------------------------------------------------------------------

export interface BotRef {
  id: string;
  name: string;
}

export type BotState = "idle" | "thinking" | "asleep" | "paused";
export type UserLayerField = "name" | "instructions" | "model" | "effort" | "voice" | "avatar" | "theme" | "layout";

export interface BotView {
  id: string;
  name: string;
  portrait?: string;
  model: string;
  effort?: string;
  voice?: { provider: string; voice: string; model?: string };
  theme?: string;
  /** The fields the user layer sets over the plugin's. */
  userLayer: UserLayerField[];
  state: BotState;
  computer?: string;
  mainSession: string;
}

/** A change to a bot's user layer: `null` clears a field (Reset), absent leaves it. */
export interface UserLayerPatch {
  name?: string | null;
  instructions?: string | null;
  model?: string | null;
  effort?: string | null;
  voice?: { provider: string; voice: string; model?: string } | null;
  avatar?: { file: string; format: string; portrait?: string } | null;
  theme?: string | null;
  layout?: string | null;
}

export type SessionStatus = "starting" | "ready" | "prompting" | "cancelling" | "idle" | "stopped" | "failed";

export interface SessionView {
  id: string;
  kind: SessionKind;
  bot?: string;
  parent?: string;
  computer: string;
  title?: string;
  status: SessionStatus;
  failure?: "sign-in" | "crashed" | "stalled" | "error";
  startedAt: number;
  updatedAt: number;
  /** An agent's or coding session's backend (`agentBackends` id). */
  backend?: string;
  model?: string;
  effort?: string;
  /** Its root folder in the tree (`home/<Computer>/…`). */
  root?: string;
  needsYou?: { cards: number; questions: number };
}

export interface ComputerView {
  name: string;
  device: string;
  os: "macos" | "windows" | "linux";
  level: Level;
  state: "online" | "offline" | "asleep";
  /** How this computer reaches it: `self` is this one. */
  link?: "self" | "lan" | "direct" | "relay";
  isMain: boolean;
  agents: string[];
}

export interface DeviceView {
  id: string;
  name: string;
  kind: "computer" | "phone" | "web";
  runsCore: boolean;
  computer?: string;
  online: boolean;
  isThis: boolean;
  isMain: boolean;
  addedAt: number;
}

export interface AccountView {
  signedIn: boolean;
  provider?: "email" | "discord" | "google";
  user?: { id: string; email?: string; name?: string };
}

/** A pairing without an account (`PairingView`, devices.ts): a code or QR, then the four words. */
export interface PairingView {
  pairingId: string;
  code?: string;
  qr?: string;
  words?: string[];
  expiresAt: number;
}

/** A pending card as a plugin hears it: never its text (`CardMeta`). */
export interface CardMeta {
  id: string;
  kind: "tool" | "agent-permission" | "plugin-ok" | "change" | "confirm" | "elicitation";
  computer: string;
  session?: string;
  bot?: string;
  options: { id: string; kind: "approve" | "deny"; remember?: "always" }[];
}

export interface FileStat {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  modifiedAt: number;
  executable: boolean;
}

export const PLUGIN_STATES = ["found", "refused", "invalid", "off", "waiting", "running", "stopped", "blocked"] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];

export interface PluginSummary {
  id: string;
  parent?: string;
  name: string;
  version: string;
  state: PluginState;
  reason?: string;
  waitingFor?: string[];
  enabled: boolean;
  source: "bundled" | "index" | "npm" | "local" | "wrapped" | "dev";
  class: "data" | "web" | "code";
  adult: boolean;
  children: string[];
  dev: boolean;
}

export interface PluginDetail extends PluginSummary {
  provenance: { by: "user-app" | "user-terminal" | "bot" | "migration" | "found" | "bundled"; at: number; bot?: string };
  capabilities: string[];
  networkHosts: string[];
  logTail: string[];
}

export interface IndexView {
  url: string;
  name?: string;
  key: string;
  official: boolean;
  lastCheckedAt?: number;
}

export interface IndexEntryView {
  id: string;
  index: string;
  name?: string;
  description?: string;
  versions: { version: string; hash: string }[];
  installed?: string;
  adult?: boolean;
}

/** A session from the app Clover replaces, in the archive view (`ArchivedSessionView`). */
export interface ArchivedSessionView {
  id: string;
  title?: string;
  mode: "code" | "chat" | "dispatch";
  project?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messages: number;
}

export interface ThemeRef {
  pluginId: string;
  id: string;
}

/** The user's UI choices (`UiSettings`, app.ts): picks in single spots and keyed cells, list order and hidden
 *  entries, the themes and the language. `entry` is `<plugin-id>#<entry-id>`. */
export interface UiSettings {
  picks: { spot: string; key?: string; bot?: string; entry: string | null }[];
  lists: { spot: string; bot?: string; order: string[]; hidden: string[] }[];
  baseTheme?: ThemeRef;
  globalTheme?: ThemeRef;
  language?: string;
}

// -------------------------------------------------------------------------------------------------
// The plugin API (plugin-api.ts), the members F's components use
// -------------------------------------------------------------------------------------------------

/** One entry of a point, its paths turned into asset URLs (`PointEntry`, plugin-api.ts). */
export interface PointEntry<T = Record<string, unknown>> {
  readonly pluginId: string;
  readonly entryId: string;
  readonly key?: string;
  readonly value: T;
}

/** An `avatar.packs` entry (points.ts): an avatar file with its format and portrait. */
export interface AvatarPackEntry {
  id: string;
  name?: string;
  file: string;
  format: string;
  portrait?: string;
  license?: string;
}

export interface PluginApi {
  readonly plugin: { readonly id: string; readonly computer: string };
  t(key: string, params?: Record<string, string | number>): string;
  readonly settings: {
    get<T = unknown>(key: string, opts?: { bot?: string }): Promise<T | undefined>;
    set(key: string, value: unknown, opts?: { bot?: string }): Promise<void>;
    watch(key: string | null, listener: (key: string) => void): Unsubscribe;
  };
  readonly commands: { run<R = unknown>(name: string, args?: unknown): Promise<R> };
  /** A declarer reads its point's entries (`avatar.packs` for the bot editor). */
  readonly points: {
    entries<T = Record<string, unknown>>(point: string): Promise<PointEntry<T>[]>;
    watch<T = Record<string, unknown>>(point: string, listener: (entries: PointEntry<T>[]) => void): Unsubscribe;
  };
  readonly bots?: {
    list(): Promise<BotView[]>;
    get(bot: string): Promise<BotView>;
    watch(listener: (bot: BotView) => void): Unsubscribe;
  };
  readonly conversation?: {
    list?(filter?: { bot?: string; kinds?: SessionKind[] }): Promise<SessionView[]>;
    get?(session: string): Promise<SessionView>;
    history?(session: string, page: { before?: number; limit: number }): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }>;
    follow?(session: string, listener: (event: Record<string, unknown>) => void, opts?: { since?: number }): Unsubscribe;
    answer?(session: string, callId: string, answers: Record<string, string>): Promise<void>;
  };
  readonly computers?: {
    list?(): Promise<ComputerView[]>;
    watch?(listener: (computer: ComputerView) => void): Unsubscribe;
  };
  readonly devices?: {
    list(): Promise<DeviceView[]>;
    watch(listener: (device: DeviceView) => void): Unsubscribe;
  };
  readonly approvals?: {
    pending(): Promise<CardMeta[]>;
    watch(listener: (cards: CardMeta[]) => void): Unsubscribe;
  };
  readonly files?: {
    list(path: string): Promise<FileStat[]>;
    readText(path: string): Promise<string>;
    grep(pattern: string, opts: { cwd: string; limit?: number }): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>;
    /** Changes under a folder (lane J's `filesWatch`, asked of B for `FilesApi`): the paths that changed, or a
     *  resync when the watch lost track. */
    watch?(path: string, listener: (e: { type: "changed"; paths: string[] } | { type: "resync" }) => void): Unsubscribe | Promise<Unsubscribe>;
  };
  readonly terminal?: {
    open(opts: { computer: string; cwd?: string; session?: string; cols: number; rows: number }): Promise<{ terminalId: string }>;
    write(terminalId: string, data: string, opts?: { paste?: boolean }): Promise<void>;
    onData(terminalId: string, fn: (data: string, exited?: { code: number | null }) => void): Unsubscribe;
    resize(terminalId: string, cols: number, rows: number): Promise<void>;
    close(terminalId: string): Promise<void>;
  };
  readonly logs?: {
    read(source: "core" | { plugin: string }, opts?: { lines?: number }): Promise<string[]>;
  };
}

// -------------------------------------------------------------------------------------------------
// The clover layer's core client
// -------------------------------------------------------------------------------------------------

/** The core methods F's parts call, by name, with their params and results. Only the `clover` layer calls them
 *  directly (its role is the app's, §5.5): a change to the core's settings applies at once, and a sensitive one comes
 *  back as a card. How a component reaches this client is a question for B and E (`useCore` here). */
export interface CoreMethods {
  "bot.setUserLayer": { params: { id: string; patch: UserLayerPatch }; result: ChangeResult };
  "session.send": { params: { id: string; message: { text: string; clientMessageId: string; sentAt?: number } }; result: { seq: number } };
  "session.interrupt": { params: { id: string }; result: { ok: true } };
  "session.stop": { params: { id: string }; result: { ok: true } };
  "session.setModel": { params: { id: string; model: string; effort?: string }; result: { ok: true } };
  "computer.setLevel": { params: { name: string; level: Level }; result: ChangeResult };
  "device.revoke": { params: { id: string }; result: ChangeResult };
  "device.pair.begin": { params: Record<string, never>; result: PairingView };
  "device.pair.join": { params: { code: string }; result: PairingView };
  "device.pair.confirm": { params: { pairingId: string; words: string[] }; result: ChangeResult };
  "device.pair.cancel": { params: { pairingId: string }; result: { ok: true } };
  "main.set": { params: { device: string }; result: ChangeResult };
  "account.status": { params: Record<string, never>; result: AccountView };
  "plugin.list": { params: Record<string, never>; result: { plugins: PluginSummary[] } };
  /** Every running plugin's UI: its themes and string tables, for Settings' theme and language pickers. */
  "plugin.ui": { params: Record<string, never>; result: { plugins: { pluginId: string; themes: { id: string; file: string }[]; locales: { lang: string; file: string }[] }[] } };
  "plugin.get": { params: { id: string }; result: { plugin: PluginDetail } };
  "plugin.setEnabled": { params: { id: string; enabled: boolean }; result: ChangeResult };
  "plugin.restart": { params: { id: string }; result: { ok: true } };
  "plugin.logs": { params: { id: string; lines?: number }; result: { lines: string[] } };
  "plugin.install": { params: { source: { from: "index"; id: string; version?: string; index?: string } }; result: { id: string; state: PluginState } };
  "plugin.index.list": { params: Record<string, never>; result: { indexes: IndexView[] } };
  "plugin.index.search": { params: { query?: string; limit?: number }; result: { entries: IndexEntryView[] } };
  "ui.settings": { params: Record<string, never>; result: UiSettings };
  "ui.set": { params: { patch: Partial<UiSettings> }; result: ChangeResult };
  // Provisional: what a session's column shows that B's API has no call for yet. The owners named settle them.
  /** A coding session's changes against their base, and the pull requests they became (lane D). */
  "session.changes": { params: { id: string }; result: { label: string; added: number; removed: number; files: number; prs: { id: string; title: string; repo: string; number: number; state: "open" | "draft" | "merged" }[] } | null };
  /** A coding session's diff against a base, per file with its hunks (lane D; the panel's `DiffFile` shape). */
  "session.diff": { params: { id: string; target?: string }; result: { base: string; target: string; targets: string[]; files: unknown[]; notice?: string } };
  /** Opens a pull request for a coding session's changes (lane D). */
  "session.createPr": { params: { id: string }; result: { ok: true } };
  /** What a session made for the user to read: pages, files, images (lane D). */
  "session.outputs": { params: { id: string; limit?: number }; result: { items: { id: string; name: string; kind: "page" | "file" | "image" }[]; more: number } };
  /** How much of the model's context a session uses (lanes A and D). */
  "session.context": { params: { id: string }; result: { used: number; tokens?: number; window?: number } | null };
  /** The MCP connectors a session has, and how many need signing in again (lane A). */
  "session.connectors": { params: { id: string }; result: { total: number; needSignIn: number } };
  /** The inherited model catalog; its Clover shape is lane A's and B's to settle. */
  "models.catalog": { params: Record<string, never>; result: { models: { id: string; label?: string; name?: string; provider?: string }[] } };
  "archive.list": { params: { query?: string; before?: number; limit?: number }; result: { sessions: ArchivedSessionView[]; more: boolean } };
  "archive.history": { params: { id: string; cursor?: string; limit?: number }; result: { events: unknown[]; cursor?: string } };
}

export type CoreMethod = keyof CoreMethods;

export interface CoreClient {
  call<M extends CoreMethod>(method: M, params: CoreMethods[M]["params"]): Promise<CoreMethods[M]["result"]>;
  /** A core event: `ui_settings_changed`, `card_pending`, `session_changed`… */
  on(event: string, listener: (event: Record<string, unknown>) => void): Unsubscribe;
}
