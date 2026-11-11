// The plugin index browser's props: what the user searched for, what the indexes they added answered, and the
// indexes themselves (spec §5.6, open question 25's answer: an official curated index, and others added by URL with a
// warning). Installing asks for the plugin's OK, which is a sealed card (§5.6): the page says it waits on it.

export interface IndexResult {
  id: string;
  /** The index it came from: its URL, and its name when it has one. */
  index: string;
  indexName: string;
  official: boolean;
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
  official: boolean;
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
  version: string;
  /** Where it came from, in words ("From the plugin index"…). */
  source: string;
  state: "found" | "refused" | "invalid" | "off" | "waiting" | "running" | "stopped" | "blocked";
  reason?: string;
  enabled: boolean;
  dev: boolean;
  /** Its child plugins' names. */
  children: string[];
}

/** The list's groups, in order. */
export type InstalledGroup = "revoked" | "attention" | "on" | "off";

/** A setting as the detail shows it: a key's value never, only whether one is saved. */
export interface DetailSetting {
  key: string;
  title: string;
  secret: boolean;
  /** For a secret: a key is saved. */
  set?: boolean;
  /** For a plain one: its value, in words. */
  value?: string;
}

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
  description?: string;
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
  /** It holds `notify` (its OK granted it): its notifications can be muted here. */
  notifies: boolean;
  /** Its notifications are muted (lane D's `notify.mutes`). */
  muted: boolean;
  /** It was revoked and the user may run it anyway (on a sealed warning card). */
  revoked?: boolean;
}

export interface InstalledProps {
  plugins: InstalledPlugin[];
  query: string;
  onQuery: (query: string) => void;
  onOpen: (id: string) => void;
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
  onRestart: () => void;
  onRemove: () => void;
  /** Opens the app's own key dialog for a secret setting or a key sign-in. */
  onKey: (target: { key: string } | { index: number }) => void;
  onSignIn: (index: number) => void;
  onSignOut: (index: number) => void;
  /** Runs a revoked plugin anyway: its warning card first. */
  onRunAnyway: () => void;
  /** Holds its updates back on this computer, or lets them through (an index or npm plugin's). */
  onPin?: (pinned: boolean) => void;
  /** Mutes its notifications, or lets them through (lane D's `notify.setMuted`). */
  onMute?: (muted: boolean) => void;
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
  official: boolean;
  lastCheckedAt?: number;
  stale?: boolean;
  error?: string;
  revocations?: { lastCheckedAt?: number; stale?: boolean; error?: string };
}

export interface IndexesProps {
  indexes: IndexRow[];
  /** Its health in words: checked when, a failed fetch, a stale copy, its revocation list. */
  health: (index: IndexRow) => string;
  onAdd: (url: string, key: string) => void;
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
}
