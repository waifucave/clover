// The plugin index browser's props: what the user searched for, what the indexes they added answered, and the
// indexes themselves (spec §5.1: plain lists the user added by URL; the owner's ruling, 2026-11-13: no official index,
// nothing signed). Installing asks for the plugin's OK, which is a sealed card (§5.6): the page says it waits on it.

export interface IndexResult {
  id: string;
  /** The index it came from: its URL, and its name when it has one. */
  index: string;
  indexName: string;
  name: string;
  description?: string;
  /** Its newest version. */
  version?: string;
  /** The version installed now, when it is. */
  installed?: string;
  /** Self-declared adult content (§5.7). */
  adult?: boolean;
}

export interface IndexSource {
  url: string;
  name?: string;
  lastCheckedAt?: number;
}

/** Where an install got to: asked for (its OK waits on a card), installed, or failed. */
export type InstallState = "asking" | "waiting" | "installed" | "failed";

export interface PluginIndexProps {
  /** Only its content, for the Plugins page's Find tab. */
  bare?: boolean;
  query: string;
  onQuery: (query: string) => void;
  onSearch: (query: string) => void;
  results: IndexResult[];
  /** Still searching. */
  searching?: boolean;
  indexes: IndexSource[];
  /** The user came from a placeholder: a spot (and key) no plugin fills. */
  looking?: { spot: string; key?: string };
  installs?: Record<string, InstallState>;
  onInstall: (result: IndexResult) => void;
  /** Settings' Plugins page, for what is installed. */
  onOpenInstalled?: () => void;
  /** The clock and how to show times. */
  now: number;
  format?: { locale: string; timeZone?: string };
}

// ---- the Plugins page: what is installed (page 1) ----

/** One installed plugin as the list shows it (from `plugin.list`; children under their parent). */
export interface InstalledPlugin {
  id: string;
  name: string;
  /** Its version; none for a wrapper that has none. */
  version?: string;
  /** Its description, for one line. */
  description?: string;
  /** Its picture: an image URL from its own files (the app's image-only route), or Clover's mark. */
  icon?: { url: string; /** It may have none to show (the app's `/_icon/` route): one that doesn't load is the puzzle. */ mayFail?: true } | "clover";
  /** Where it came from, in words ("From the plugin index"…). */
  source: string;
  state: "found" | "refused" | "invalid" | "off" | "waiting" | "running" | "stopped";
  reason?: string;
  enabled: boolean;
  dev: boolean;
  /** Its child plugins' names. */
  children: string[];
  /** The small labels for what it brings (Bot, Tools, Island tab…), from its contributions; its children's included. */
  labels?: string[];
  /** A plugin with a bot and parts beside it: their own switch (`plugin.setEnabled` with `part: "app"`), and what they are. */
  appParts?: { enabled: boolean; has: string[]; bot?: string };
  /** Each child with its own labels, for the detail. */
  parts?: { name: string; labels: string[] }[];
  /** Clover's own plugin this build can't run yet (the registry's `off` with `NOT_AVAILABLE_YET`): one plain line, a
   *  switch that can't be used, nothing to set, sign in to or read. */
  notYet?: true;
  /** Its parts (child plugins) this build can't run yet, by name. */
  notYetParts?: string[];
}

/** The list's groups, in order. */
export type InstalledGroup = "attention" | "on" | "off";

/** A setting as the detail shows it: a key's value never, only whether one is saved. */
export interface DetailSetting {
  key: string;
  title: string;
  secret: boolean;
  /** For a secret: a key is saved. */
  set?: boolean;
  /** For a plain one: its value, in words. */
  value?: string;
  /** For a plain one the page can change: the control it gets and the value as the core holds it. A bot's setting (one
   *  value per bot) and a key have none here. */
  control?: SettingControl;
  /** Changing it may ask on a sealed card first (its value feeds what the plugin runs or reaches). */
  asks?: boolean;
}

/** A plain setting's control: text (a string or a color), a number in its bounds, a switch, or a choice. */
export type SettingControl =
  | { kind: "text"; value: string; color?: boolean }
  | { kind: "number"; value: number | undefined; min?: number; max?: number }
  | { kind: "switch"; value: boolean }
  | { kind: "select"; value: string; options: { value: string; title: string }[] };

/** A sign-in as the detail shows it. */
export interface DetailSignIn {
  index: number;
  method: "api-key" | "oauth-pkce" | "custom" | "core";
  signedIn: boolean;
  account?: string;
  state: string;
}

/** One plugin opened: what it is, where it came from, what it may do and gives, its settings, sign-ins and log. */
export interface PluginDetailView extends InstalledPlugin {
  /** Who added it and how ("You added it in the app."), from the core's record. */
  provenance: string;
  /** What its OK granted, in plain words. */
  oks: string[];
  /** The tools it gives the bots, by name. */
  tools: string[];
  /** Its MCP servers, by name. */
  servers: string[];
  settings: DetailSetting[];
  signIns: DetailSignIn[];
  log: string[];
  pinned: boolean;
  /** It comes from an index or npm, so updates reach it. */
  updates: boolean;
  /** Its agent definitions, by name. */
  agents: string[];
  /** It holds `notify` (its OK granted it) and isn't Clover's own tree: its notifications can be muted here. */
  notifies: boolean;
  /** Its notifications are muted (lane D's `notify.mutes`). */
  muted: boolean;
  /** Self-declared adult content (§5.7). */
  adult?: boolean;
  /** The files and folders the user picked for it. */
  grants?: GrantRow[];
  /** Each command that names a default key, and what became of it (bound, or why not). */
  commandKeys?: { name: string; key: string; bound: boolean; note: string }[];
}

/** A file or folder the user picked for a plugin (`plugin.grant.list`). */
export interface GrantRow {
  token: string;
  path: string;
  kind: "file" | "folder";
  access: "read" | "write";
}

/** A development folder (`plugin.dev.list`). */
export interface DevRow {
  path: string;
  pluginId?: string;
  addedAt: number;
  expiresAt: number;
  lastReloadAt?: number;
}

export interface InstalledProps {
  plugins: InstalledPlugin[];
  query: string;
  onQuery: (query: string) => void;
  onOpen: (id: string) => void;
  /** Switches only a plugin's parts beside its bot (`plugin.setEnabled` with `part: "app"`). */
  onAppParts?: (id: string, on: boolean) => void;
  loading?: boolean;
}

/** What a button press in the detail got to: asked on a card, done, or why it didn't. */
export interface DetailStatus {
  tone: "info" | "danger";
  text: string;
}

export interface DetailProps {
  plugin: PluginDetailView;
  onBack: () => void;
  onSwitch: (on: boolean) => void;
  onAppParts?: (on: boolean) => void;
  onRestart: () => void;
  onRemove: () => void;
  /** Removes it and deletes its data too (`plugin.remove` with `deleteData`). */
  onRemoveWithData?: () => void;
  /** Opens the app's own key dialog for a secret setting or a key sign-in. */
  onKey: (target: { key: string } | { index: number }) => void;
  onSignIn: (index: number) => void;
  onSignOut: (index: number) => void;
  /** Holds its updates back on this computer (none offered), or lets them through (an index or npm plugin's). */
  onPin?: (pinned: boolean) => void;
  /** Mutes its notifications, or lets them through (lane D's `notify.setMuted`). */
  onMute?: (muted: boolean) => void;
  /** Changes one of its plain settings (`plugin.settings.set`; null puts the default back). */
  onSetting?: (key: string, value: unknown, asks: boolean) => void;
  /** The user said they are 18 or older already. */
  adultConfirmed?: boolean;
  onConfirmAdult?: () => void;
  /** Takes a picked file or folder back (`plugin.grant.remove`). */
  onGrantRemove?: (token: string) => void;
  status?: DetailStatus;
}

/** The page's tabs. */
export type PluginsTab = "installed" | "add" | "updates" | "find" | "indexes";

/** A newer version, as the Updates tab shows it. */
export interface UpdateRow {
  id: string;
  name: string;
  from: string;
  to: string;
  why: string;
  pinned: boolean;
}

export interface UpdatesProps {
  updates: UpdateRow[];
  checking?: boolean;
  onCheck: () => void;
  onApply: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  status?: DetailStatus;
}

/** An index, as the Indexes tab shows it. */
export interface IndexRow {
  url: string;
  name?: string;
  lastCheckedAt?: number;
  error?: string;
}

export interface IndexesProps {
  indexes: IndexRow[];
  /** Its health in words: checked when, a failed fetch. */
  health: (index: IndexRow) => string;
  onAdd: (url: string) => void;
  onRemove: (url: string) => void;
  status?: DetailStatus;
}

/** What the picker is choosing: a Clover plugin's folder, or a bare item Clover wraps into one. */
export type PickKind = "folder" | "claude-plugin" | "skill-folder" | "agent-file";

/** An install the Add tab asks for. A picked item is its token from main's picker, never a path. */
export type AddSource =
  | { from: "picked"; kind: PickKind; token: string }
  | { from: "npm"; name: string; version?: string }
  | { from: "wrap"; kind: "mcp-config" | "mcp-url"; value: string };

export interface AddProps {
  /** The item main's picker gave: its token and its name. */
  picked?: { kind: PickKind; token: string; name: string };
  onPick: (kind: PickKind, what: "folder" | "file") => void;
  onInstall: (source: AddSource) => void;
  onFind: () => void;
  busy?: boolean;
  status?: DetailStatus;
  /** The development folders (`plugin.dev.list`), the one main's picker just gave, and what the page does with them. */
  devFolders?: DevRow[];
  devPicked?: { token: string; name: string };
  onDevPick?: () => void;
  onDevAdd?: (token: string) => void;
  onDevRemove?: (path: string) => void;
  onDevRenew?: (path: string) => void;
  now?: number;
  format?: { locale: string; timeZone?: string };
}
