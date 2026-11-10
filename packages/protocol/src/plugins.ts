// Clover protocol area: plugins (spec §5.1–§5.6, §5.9, §6.8). Owner: lane B (plan §4: the registry B-M1, the plugin
// host and its API B-M2, getting plugins in B-M3).
//
// The registry's view for clients (Settings, the plugin index browser, `clover plugin …`), commands for any client
// (`command.list`, `command.run`, §5.4), and the plugin host's channel to the daemon (§5.2). A plugin's own manifest,
// formats and catalogs are the plugin SDK's (`@waifucave/clover-plugin-sdk`); here a manifest travels as JSON.
import { z } from "zod";
import { utf16 } from "./strings";
import {
  AnyPluginId, BotId, Caller, MAX_CHILD_PLUGINS, CardId, ChangeResult, ComputerName, Empty, HostProcess, Ok, Scope, SemverVersion, Text,
  SessionId, Timestamp, TopPluginId, TreeHash,
} from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

// -------------------------------------------------------------------------------------------------
// Shapes
// -------------------------------------------------------------------------------------------------

/** What Settings shows for each plugin, with the reason (§5.1 "States"). */
export const PLUGIN_STATES = ["found", "refused", "invalid", "off", "waiting", "running", "stopped", "blocked"] as const;
export const PluginState = z.enum(PLUGIN_STATES);
export type PluginState = z.infer<typeof PluginState>;

/** Where a plugin's folder came from. `wrapped` is a plugin the core generated around a bare item (§5.1). */
export const PluginSource = z.enum(["bundled", "index", "npm", "local", "wrapped", "dev"]);
export type PluginSource = z.infer<typeof PluginSource>;

/** What the core wrapped into a plugin (§5.1 "wrapped automatically"). */
export const WRAP_KINDS = ["mcp-config", "mcp-url", "skill-folder", "agent-file", "claude-plugin"] as const;
export const WrapKind = z.enum(WRAP_KINDS);
export type WrapKind = z.infer<typeof WrapKind>;

/** Who wrote it, from the core's own record (§5.6); the manifest's `generated.by` is only a hint. */
export const PluginProvenance = z.object({
  by: z.enum(["user-app", "user-terminal", "bot", "migration", "found", "bundled"]),
  at: Timestamp,
  bot: BotId.optional(),
  /** A plugin the core generated around a bare item: what it was, and the parts of it Clover has no point for yet,
   *  which stay in the folder unused and which the OK names (§5.1). The core's own record, never the manifest's.
   *  `network: "any"`: the owner's ruling for a server the user brought (2026-11-10, §5.3): its local servers and hooks
   *  reach any host, fenced for files as any plugin, until its manifest declares `network:` hosts, when it is held to
   *  them like any other. The OK says so, `plugin.get` shows it, and the fence reads it: one fact. */
  wrapped: z.object({ from: WrapKind, unused: z.array(utf16(200, 1)).max(64).optional(), network: z.literal("any").optional() }).optional(),
});
export type PluginProvenance = z.infer<typeof PluginProvenance>;

/** Worked out from the manifest, never declared (§5.3). */
export const PluginClass = z.enum(["data", "web", "code"]);
export type PluginClass = z.infer<typeof PluginClass>;

/** One finding of the plugin SDK's validator (`validateManifest`, `clover plugin validate --json`). `refuses` says
 *  what the finding stops: the whole plugin, one contribution (a key of `contributes`), one entry of it, or nothing
 *  (a warning). `path` is a JSON pointer into the file. */
export const ValidationIssue = z.object({
  severity: z.enum(["error", "warning"]),
  refuses: z.enum(["plugin", "contribution", "entry", "none"]),
  code: utf16(64, 1),
  message: utf16(2000),
  file: utf16(1024),
  path: utf16(1024),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const PluginSummary = z.object({
  id: AnyPluginId,
  /** Set for a child plugin (`<parent>/<folder>`). */
  parent: TopPluginId.optional(),
  name: Text,
  version: utf16(256),
  state: PluginState,
  /** Why it is in that state: "waiting for `island.tab`", "plugin stopped: …", the revocation's reason. */
  reason: utf16(2000).optional(),
  waitingFor: z.array(utf16(256)).max(64).optional(),
  enabled: z.boolean(),
  source: PluginSource,
  class: PluginClass,
  treeHash: TreeHash.optional(),
  /** Tool prefix: `mcp__<namespace>__<Tool>` (§6.7). Children share their top-level plugin's. */
  namespace: utf16(40),
  scope: Scope,
  adult: z.boolean(),
  children: z.array(AnyPluginId).max(MAX_CHILD_PLUGINS),
  /** A development folder (§5.6), on this computer only. */
  dev: z.boolean(),
});
export type PluginSummary = z.infer<typeof PluginSummary>;

export const PluginDetail = PluginSummary.extend({
  /** The manifest as read (JSON with comments removed); the plugin SDK types it. */
  manifest: z.record(z.string(), z.unknown()),
  provenance: PluginProvenance,
  /** The capabilities the user GRANTED, not the ones the manifest declares (those are `manifest.capabilities`): what
   *  its OK covers, empty before the OK, after a refusal or a block. A client gates on this (lane F's message text). */
  capabilities: z.array(utf16(256)).max(256),
  /** The hosts its components can reach (§5.3). */
  networkHosts: z.array(utf16(256)).max(256),
  helperPermissions: z.array(utf16(64)).max(16),
  issues: z.array(ValidationIssue).max(500),
  /** Its last log lines (`logs/plugins/<id>.log`), shown when it stopped. */
  logTail: z.array(utf16(4000)).max(200),
  /** Computers ticked for `chosen` and for its local servers (§5.2, §9.1), by server name; `*` is its host half. */
  computers: z.record(z.string(), z.array(ComputerName)).optional(),
  pinned: z.boolean(),
});
export type PluginDetail = z.infer<typeof PluginDetail>;

/** Where to install a plugin from (§5.1). Installing only downloads a folder into the plugins directory. */
const IndexSource = z.object({ from: z.literal("index"), id: TopPluginId, version: SemverVersion.optional(), index: z.string().url().optional() });
const NpmSource = z.object({ from: z.literal("npm"), name: utf16(214, 1), version: utf16(256).optional() });

export const InstallSource = z.discriminatedUnion("from", [
  IndexSource,
  NpmSource,
  z.object({ from: z.literal("folder"), path: utf16(4096, 1) }),
  /** A bare item that the core wraps into a plugin (§5.1): a pasted MCP config, an MCP URL, a skill folder, an agent
   *  file or a Claude Code plugin folder. */
  z.object({ from: z.literal("wrap"), kind: WrapKind, value: utf16(1_000_000, 1) }),
]);
export type InstallSource = z.infer<typeof InstallSource>;

/** A command for the palette (§5.4): a plugin's public function, run as `<namespace>.<name>`. */
export const CommandView = z.object({
  name: utf16(128, 3),
  pluginId: AnyPluginId,
  description: Text,
  /** JSON Schema for its `args`. */
  args: z.record(z.string(), z.unknown()).optional(),
  /** Its default shortcut; a core shortcut or the user's own binding wins (§5.4). */
  key: utf16(64).optional(),
  runsOn: z.enum(["each", "main", "chosen"]).optional(),
});
export type CommandView = z.infer<typeof CommandView>;

/** An extension point, for Settings and for `Glossary` (§6.8): shape, schemas, occupants, waiting entries. */
export const PointView = z.object({
  name: utf16(128, 1),
  shape: z.enum(["single", "list", "keyed"]),
  /** `core` for the core's points (§5.3); otherwise the declaring entry. */
  declaredBy: z.union([z.literal("core"), z.object({ pluginId: AnyPluginId, entry: utf16(256) })]),
  spot: z.boolean(),
  fields: z.record(z.string(), z.unknown()).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  occupants: z.array(z.object({ pluginId: AnyPluginId, entry: utf16(256) })).max(1000),
  waiting: z.array(z.object({ pluginId: AnyPluginId, entry: utf16(256) })).max(1000),
  /** Filling it replaces UI we ship (§6.8). */
  replacesShipped: z.boolean(),
  private: z.boolean(),
  deprecated: Text.optional(),
  doc: Text.optional(),
});
export type PointView = z.infer<typeof PointView>;

/** One of a plugin's settings as Settings shows it (§5.4 "Settings", review S16): the manifest's field and its value.
 *  A `secret` field never carries its value over the wire, only whether one is stored. */
export const PluginSettingView = z.object({
  key: utf16(128, 1),
  type: z.enum(["string", "number", "boolean", "enum", "color", "secret"]),
  title: Text,
  description: Text.optional(),
  scope: z.enum(["account", "device", "bot"]),
  required: z.boolean(),
  /** An `enum` field's choices, as the manifest lists them: a value, or a value with its title (lane F's ask). */
  options: z.array(z.union([utf16(256, 1), z.object({ value: utf16(256, 1), title: Text })])).max(256).optional(),
  /** A `number` field's bounds, as the manifest sets them. */
  min: z.number().optional(),
  max: z.number().optional(),
  /** The value in effect: the user's, else the manifest's default. Never there for a `secret` field. */
  value: z.unknown().optional(),
  /** The user set it; for a `secret` field, a value is stored. */
  set: z.boolean(),
  /** A changed default waits for the user's OK (§5.6). */
  defaultPending: z.boolean().optional(),
});
export type PluginSettingView = z.infer<typeof PluginSettingView>;

/** One of a plugin's sign-ins (§5.1 "Sign-ins"), by its place in the manifest's `auth` list. */
export const PluginAuthView = z.object({
  index: z.number().int().min(0).max(31),
  method: z.enum(["api-key", "oauth-pkce", "custom", "core"]),
  /** The secret it fills. */
  secret: utf16(64).optional(),
  state: z.enum(["signed-out", "signed-in", "expired", "refreshing", "failed"]),
  /** Who is signed in, when the service says (an email, an account name). */
  account: utf16(320).optional(),
  reason: utf16(2000).optional(),
});
export type PluginAuthView = z.infer<typeof PluginAuthView>;

/** What the app's plugin runtime (lane E) needs to mount one plugin's UI: its layer's origin, its client module, its
 *  `ui` entries as the manifest has them, and its themes and string tables. Assets are served by hash (§5.1); URLs
 *  are the app runtime's scheme, which the daemon fills from `assetBase`. */
/** What a layer needs of a plugin (lane E's asks). The registry always sends `source`, `enabledAt`, `capabilities`,
 *  `css` and `networkHosts`; a view without them (an older daemon, a test's fake) means none of each. */
export const UiPluginView = z.object({
  pluginId: AnyPluginId,
  /** The manifest's name. */
  name: Text,
  treeHash: TreeHash,
  /** Where it came from (§5.5 rule 5: a bundled entry yields to none). */
  source: PluginSource.optional(),
  /** When it was last enabled, for rule 6's "the most recently enabled wins". */
  enabledAt: Timestamp.optional(),
  /** Its capabilities as the user OK'd them, which the layer's plugin API gates by (lane E's `needs`). */
  capabilities: z.array(utf16(300, 1)).max(256).optional(),
  /** Its stylesheets (`client.css`), cleaned, as asset paths under `assetBase`. */
  css: z.array(utf16(4096, 1)).max(32).optional(),
  /** The hosts its `network:` capabilities declare, for the layer's CSP and `Connection-Allowlist`. */
  networkHosts: z.array(utf16(300, 1)).max(256).optional(),
  /** For a bot's plugin: the bot's name, the theme its tab wears (one of `themes`) and the layout file its tab is
   *  arranged by (a file in its folder). */
  bot: z.object({ name: Text, theme: utf16(4096).optional(), layout: utf16(4096).optional() }).optional(),
  /** The layer's origin label: the id with `/` written `--` (§5.5). Everything under `clover` shares `clover`. */
  layer: utf16(128),
  assetBase: utf16(2048),
  /** The built ES module the layer loads (`CLIENT_BARE_IMPORTS` only as bare imports), under `assetBase`: the
   *  manifest's `client.entry`, or the registry's cached build of a TypeScript or TSX one. */
  clientEntry: utf16(4096).optional(),
  ui: z.array(z.record(z.string(), z.unknown())).max(500),
  themes: z.array(z.object({ id: utf16(128), file: utf16(4096) })).max(100),
  locales: z.array(z.object({ lang: utf16(35), file: utf16(4096) })).max(200),
  /** Bots whose tabs it dresses (`when.bot`, or the user's ticks, §5.5); `all` includes bots added later. */
  bots: z.union([z.literal("all"), z.array(BotId)]),
});
export type UiPluginView = z.infer<typeof UiPluginView>;

/** A development folder (§5.6): reloads on every change without asking, on this computer only, off after 24 hours
 *  unless renewed. */
export const DevFolderView = z.object({
  path: utf16(4096),
  pluginId: AnyPluginId.optional(),
  addedAt: Timestamp,
  expiresAt: Timestamp,
  lastReloadAt: Timestamp.optional(),
});

const IndexKey = z.string().regex(/^[0-9a-f]{64}$/);
export const IndexView = z.object({
  url: z.string().url(),
  name: utf16(256).optional(),
  /** The Ed25519 public keys (hex) the index is trusted under; any one verifies, so a key rotates by shipping the new
   *  one beside the old. The official index's ship in the app (§5.1). */
  keys: z.array(IndexKey).min(1).max(8),
  official: z.boolean(),
  /** When its last good copy was taken, and when that copy was signed (`issued`). */
  lastCheckedAt: Timestamp.optional(),
  issued: utf16(40).optional(),
  /** Its last good copy was signed more than 7 days ago (the controller's ruling D): Settings says so. */
  stale: z.boolean().optional(),
  /** Why the last fetch failed; its last good copy is still used. */
  error: utf16(300).optional(),
});

export const IndexEntryView = z.object({
  id: TopPluginId,
  index: z.string().url(),
  name: Text.optional(),
  description: Text.optional(),
  versions: z.array(z.object({ version: SemverVersion, hash: TreeHash })).max(1000),
  installed: SemverVersion.optional(),
  adult: z.boolean().optional(),
});

/** `Glossary` (§6.8) as the bridge serves it to an ACP agent (§9.3): searches and loads in one call. */
export const GlossaryItem = z.object({
  name: utf16(256),
  kind: z.enum(["tool", "skill", "agent", "plugin", "point"]),
  description: utf16(4000),
  pluginId: AnyPluginId.optional(),
});
export const GlossaryLoaded = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool"), name: utf16(256), inputSchema: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("skill"), name: utf16(256), instructions: utf16(200_000) }),
  z.object({ kind: z.literal("agent"), name: utf16(256) }),
  z.object({ kind: z.literal("missing"), name: utf16(256) }),
]);

// -------------------------------------------------------------------------------------------------
// Methods: clients
// -------------------------------------------------------------------------------------------------

const IdParams = z.object({ id: AnyPluginId });

export const PLUGINS_METHODS = {
  pluginList: defineMethod({
    name: "plugin.list", owner: "B", roles: ["app", "cli"],
    params: Empty,
    /** `adultConfirmed`: the user already confirmed they are 18 or older (§5.7), so Settings needn't ask again before an
     *  adult plugin is switched on (lane F's ask). The registry always sends it; absent reads as not confirmed. */
    result: z.object({ plugins: z.array(PluginSummary), adultConfirmed: z.boolean().optional() }),
    doc: "Every plugin and child plugin on this computer, with its state and reason, and whether the user confirmed they are 18 or older.",
  }),
  pluginGet: defineMethod({
    name: "plugin.get", owner: "B", roles: ["app", "cli"],
    params: IdParams, result: z.object({ plugin: PluginDetail }),
    doc: "One plugin: its manifest, provenance, capabilities, hosts, findings and last log lines.",
  }),
  pluginSetEnabled: defineMethod({
    /** Switching a `found` plugin on is a sensitive change (§5.5; F-M2's review, S2): it raises the plugin's sealed OK
     *  card (`{ applied: false, card }`) and never loads it directly, from any caller. Switching on a plugin the user
     *  OK'd and only switched off applies at once. Refused for a blocked, refused or invalid plugin, and for switching
     *  the bundled `clover` plugin off (it would turn off Settings itself). */
    name: "plugin.setEnabled", owner: "B", roles: ["app", "cli", "layer"], userOnly: true, change: "core",
    params: z.object({
      id: AnyPluginId, enabled: z.boolean(),
      /** For a plugin that dresses parts of bots' tabs: which bots, replacing its `when.bot` (§5.5). */
      bots: z.union([z.literal("all"), z.array(BotId)]).optional(),
    }),
    result: ChangeResult,
    doc: "Switches a plugin or child on or off; switching a parent off switches its children off (§5.1); a found plugin's switch is its OK card.",
  }),
  pluginSetScope: defineMethod({
    name: "plugin.setScope", owner: "B", roles: ["app", "cli", "layer"], userOnly: true, change: "core",
    params: z.object({ id: AnyPluginId, scope: Scope.nullable() }), result: ChangeResult,
    doc: "The user's override of a plugin's scope; null goes back to the manifest's (§5.1).",
  }),
  pluginSetComputers: defineMethod({
    name: "plugin.setComputers", owner: "B", roles: ["app", "cli", "layer"], userOnly: true, change: "core",
    params: z.object({
      id: AnyPluginId,
      /** A local server's name, or `*` for the host half's `chosen` computers. */
      target: utf16(128, 1),
      computers: z.array(ComputerName).max(256),
    }),
    result: ChangeResult,
    doc: "Ticks the computers a local server or a `chosen` host half runs on; Mirror ticks every computer (§9.1).",
  }),
  pluginRestart: defineMethod({
    name: "plugin.restart", owner: "B", roles: ["app", "cli"], userOnly: true,
    params: IdParams, result: Ok,
    doc: "Restarts a plugin that stopped after crashes (§5.1).",
  }),
  pluginLogs: defineMethod({
    name: "plugin.logs", owner: "B", roles: ["app", "cli", "layer"], capability: "logs.read",
    params: z.object({ id: AnyPluginId, lines: z.number().int().min(1).max(5000).optional() }),
    result: z.object({ lines: z.array(utf16(4000)) }),
    doc: "A plugin's log (`logs/plugins/<id>.log`), newest last.",
  }),
  pluginSettingsGet: defineMethod({
    name: "plugin.settings.get", owner: "B", roles: ["app", "cli"],
    params: z.object({ id: AnyPluginId, bot: BotId.optional() }),
    result: z.object({ settings: z.array(PluginSettingView).max(256) }),
    doc: "A plugin's settings with their values (a bot's, for `bot` settings); secret fields say only whether they are set.",
  }),
  pluginSettingsSet: defineMethod({
    name: "plugin.settings.set", owner: "B", roles: ["app", "cli", "layer"], userOnly: true, change: "core",
    params: z.object({
      id: AnyPluginId, key: utf16(128, 1),
      /** Null goes back to the default. A `secret` field's value goes into the credential store and never comes back. */
      value: z.unknown().nullable(),
      bot: BotId.optional(),
    }),
    result: ChangeResult,
    doc: "Sets one of a plugin's settings; bots can't (§9.1), and from a layer it is a sealed card (§5.5).",
  }),
  pluginAuthList: defineMethod({
    name: "plugin.auth.list", owner: "A", roles: ["app", "cli"],
    params: IdParams, result: z.object({ auth: z.array(PluginAuthView).max(32) }),
    doc: "A plugin's sign-ins and their state, for Settings and the welcome guide (§3.3, §5.1).",
  }),
  pluginAuthSignIn: defineMethod({
    name: "plugin.auth.signIn", owner: "A", roles: ["app", "cli"], userOnly: true,
    params: z.object({
      id: AnyPluginId, index: z.number().int().min(0).max(31),
      /** An `api-key` entry's key, which goes into the credential store and never comes back. */
      key: utf16(8192, 1).optional(),
    }),
    result: z.object({ state: PluginAuthView.shape.state, authorizeUrl: z.string().url().optional() }),
    doc: "Signs in with one `auth` entry: a key is stored; `oauth-pkce` returns the URL to open and the core finishes on the redirect; `custom` runs its handler on the refresher (§8.5).",
  }),
  pluginAuthSignOut: defineMethod({
    name: "plugin.auth.signOut", owner: "A", roles: ["app", "cli"], userOnly: true,
    params: z.object({ id: AnyPluginId, index: z.number().int().min(0).max(31) }), result: Ok,
    doc: "Signs out of one `auth` entry and deletes its secret everywhere.",
  }),
  pluginInstall: defineMethod({
    /** Whoever installs and from wherever (the app's plugin index, the CLI, a bot, a paste), the plugin lands `found`
     *  and the core raises its sealed OK card at once (`card`, §5.1; F-M2's review, S1): what runs, the capabilities,
     *  the hosts, the Windows and Linux warning and a checkbox per child. Its code runs only after the user's yes on
     *  that card; no install is its OK. */
    name: "plugin.install", owner: "B", roles: ["app", "cli", "layer"], userOnly: true, capability: "plugins.install",
    params: z.object({ source: InstallSource }),
    /** A layer installs from an index or npm only, never a folder on disk or a wrapped item (#179's review, check 2). */
    roleParams: { layer: z.object({ source: z.discriminatedUnion("from", [IndexSource, NpmSource]) }) },
    /** `more`: the other plugins one wrapped MCP config made (one per server), each with its own OK card. */
    result: z.object({
      id: TopPluginId, state: PluginState, treeHash: TreeHash.optional(), card: CardId.optional(),
      more: z.array(z.object({ id: TopPluginId, state: PluginState, treeHash: TreeHash.optional(), card: CardId.optional() })).max(31).optional(),
    }),
    doc: "Downloads or wraps a plugin into the plugins folder, where it is found: its OK is a sealed card, whoever installed it.",
  }),
  pluginRemove: defineMethod({
    name: "plugin.remove", owner: "B", roles: ["app", "cli"], userOnly: true,
    params: z.object({ id: TopPluginId }), result: Ok,
    doc: "Removes a top-level plugin everywhere; its data folder and synced store stay (§5.1).",
  }),
  pluginUpdate: defineMethod({
    name: "plugin.update", owner: "B", roles: ["app", "cli"], userOnly: true,
    params: z.object({ id: TopPluginId.optional() }),
    result: z.object({ updated: z.array(z.object({ id: TopPluginId, from: z.string(), to: z.string() })) }),
    doc: "Checks the indexes now and updates plugins that aren't pinned, forward only (§5.1).",
  }),
  pluginPin: defineMethod({
    name: "plugin.pin", owner: "B", roles: ["app", "cli", "layer"], userOnly: true, change: "core",
    params: z.object({ id: TopPluginId, pinned: z.boolean() }), result: ChangeResult,
    doc: "Pins an index plugin to its version, or lets it update again.",
  }),
  pluginRenameFolder: defineMethod({
    name: "plugin.renameFolder", owner: "B", roles: ["app"], userOnly: true,
    params: z.object({ folder: utf16(255, 1) }), result: z.object({ id: TopPluginId }),
    doc: "The one-click rename of a folder whose name isn't its manifest's id (§5.1).",
  }),
  pluginConfirmAdult: defineMethod({
    name: "plugin.confirmAdult", owner: "B", roles: ["app", "cli"], userOnly: true,
    params: Empty, result: Ok,
    doc: "The user confirms they are 18 or older, so adult plugins may be switched on (§5.7).",
  }),
  pluginDevList: defineMethod({
    name: "plugin.dev.list", owner: "B", roles: ["app", "cli"],
    params: Empty, result: z.object({ folders: z.array(DevFolderView) }),
    doc: "This computer's development folders (§5.6).",
  }),
  pluginDevAdd: defineMethod({
    name: "plugin.dev.add", owner: "B", roles: ["app", "cli"], userOnly: true, change: "sensitive",
    params: z.object({ path: utf16(4096, 1) }), result: ChangeResult,
    doc: "Adds a development folder: a sealed card unless the user adds it in their own terminal (§5.6).",
  }),
  pluginDevRemove: defineMethod({
    name: "plugin.dev.remove", owner: "B", roles: ["app", "cli"], userOnly: true,
    params: z.object({ path: utf16(4096, 1) }), result: Ok,
    doc: "Removes a development folder.",
  }),
  pluginDevRenew: defineMethod({
    name: "plugin.dev.renew", owner: "B", roles: ["app", "cli"], userOnly: true,
    params: z.object({ path: utf16(4096, 1) }), result: z.object({ expiresAt: Timestamp }),
    doc: "Keeps a development folder on for another 24 hours (§5.6).",
  }),
  pluginIndexList: defineMethod({
    name: "plugin.index.list", owner: "B", roles: ["app", "cli"],
    params: Empty, result: z.object({ indexes: z.array(IndexView) }),
    doc: "The indexes plugins come from; the official one first.",
  }),
  pluginIndexAdd: defineMethod({
    name: "plugin.index.add", owner: "B", roles: ["app", "cli"], userOnly: true, change: "core",
    params: z.object({ url: z.string().url(), keys: z.array(IndexKey).min(1).max(8) }), result: ChangeResult,
    doc: "Adds another index by URL with its key, after a warning (§5.1, §14.2 item 25).",
  }),
  pluginIndexRemove: defineMethod({
    name: "plugin.index.remove", owner: "B", roles: ["app", "cli"], userOnly: true,
    params: z.object({ url: z.string().url() }), result: Ok,
    doc: "Removes an index that isn't the official one.",
  }),
  pluginIndexSearch: defineMethod({
    name: "plugin.index.search", owner: "B", roles: ["app", "cli"],
    params: z.object({ query: utf16(256).optional(), limit: z.number().int().min(1).max(200).optional() }),
    result: z.object({ entries: z.array(IndexEntryView) }),
    doc: "Searches the indexes, for the plugin index browser.",
  }),
  pluginUi: defineMethod({
    name: "plugin.ui", owner: "B", roles: ["app"],
    params: Empty, result: z.object({ plugins: z.array(UiPluginView) }),
    doc: "Every running plugin's UI, for the app's plugin runtime to mount in layers (§5.5).",
  }),
  pluginLayerApi: defineMethod({
    name: "plugin.layer.api", owner: "B", roles: ["app"],
    params: z.object({
      /** The plugin of the mount the app bound the calling component to, never anything the component said. */
      pluginId: AnyPluginId,
      /** A plugin API call a component may make (the SDK's `API_CALLS`, `where` "ui" or "both"). */
      call: utf16(128, 1),
      /** The method's parameters in order, typed by the SDK's `ApiCallSignatures` (`layerApiCall` builds them):
       *  `host.call` takes the handler's name, its args and options. A listener can't be one. */
      args: z.array(z.unknown()).max(64),
      /** The session the component shows, for calls scoped to it. (No `bot`: nothing scopes a layer call to a bot yet,
       *  so the core takes none rather than ignore one, #333's review.) */
      session: SessionId.optional(),
    }),
    result: z.object({ result: z.unknown() }),
    doc: "A plugin component's plugin API call, which the app makes for it: as the user, through the core's capability gate.",
  }),
  pointList: defineMethod({
    name: "point.list", owner: "B", roles: ["app", "cli"],
    params: Empty, result: z.object({ points: z.array(PointView) }),
    doc: "Every extension point, the core's and those plugins declare, with occupants and waiting entries.",
  }),
  commandList: defineMethod({
    name: "command.list", owner: "B", roles: ["app", "cli", "remote"],
    params: Empty, result: z.object({ commands: z.array(CommandView) }),
    doc: "Every plugin command, for the palette (§5.4).",
  }),
  commandRun: defineMethod({
    name: "command.run", owner: "B", roles: ["app", "cli", "remote", "layer"],
    /** A plugin caller needs `call:<the target's top-level id>`, which its OK lists (§5.4). */
    capability: "call:*",
    params: z.object({ name: utf16(128, 3), args: z.unknown().optional() }),
    result: z.object({ result: z.unknown() }),
    doc: "Runs `<namespace>.<name>` at once, with no model turn; the handler is told who called (§5.4).",
  }),
  glossaryQuery: defineMethod({
    name: "glossary.query", owner: "B", roles: ["bridge"],
    params: z.object({
      query: z.union([utf16(1000), z.array(utf16(1000)).max(16)]).optional(),
      load: z.union([utf16(256), z.array(utf16(256)).max(64)]).optional(),
    }),
    result: z.object({ results: z.array(GlossaryItem), loaded: z.array(GlossaryLoaded) }),
    doc: "`Glossary` for an ACP agent through its bridge (§6.8, §9.3); bots call the tool in-process.",
  }),

  // -----------------------------------------------------------------------------------------------
  // The plugin host's channel (§5.2). One connection per plugin-host process, over the pipe the daemon started it
  // with and bound by its token to that process (`HostProcess`): the bundled `clover` tree's, the shared one every
  // other plugin's host halves share, and a Node or native plugin's own (the owner's answer to S4). The plugin host
  // speaks only this channel (review S3): a host half's plugin-API calls all go through `pluginHost.api`, whose
  // `pluginId` the host stamps from its own worker table (the worker that sent the call, never a value a worker
  // gives). The daemon refuses a call naming a plugin it didn't start in that connection's process
  // (`CLOVER_ERR.PROCESS_REFUSED`: a third-party worker presenting a `clover/*` id), checks it against the plugin
  // SDK's `API_CALLS`, the one gate, then acts as that plugin: the fence's `as`, a `plugin_message`'s `from`, a hold's
  // owner. A watch's values come back as `pluginHost.deliver`;
  // streams go by `pluginHost.chunk` (to the daemon) and `pluginHost.feed` (to a call's handler). Lane B fills in the
  // details at B-M2.
  // -----------------------------------------------------------------------------------------------

  pluginHostStart: defineMethod({
    name: "pluginHost.start", owner: "B", roles: ["plugin-host"], direction: "from-daemon",
    params: z.object({
      pluginId: AnyPluginId, folder: utf16(4096), entry: utf16(4096),
      runtime: z.enum(["bun", "node"]), dataFolder: utf16(4096),
      /** The process the host half runs in, which the core decides from the install record, never the plugin (S4). */
      process: HostProcess,
    }),
    result: Ok,
    doc: "Starts a plugin's host half: a worker in a shared process, or a process of its own.",
  }),
  pluginHostStop: defineMethod({
    name: "pluginHost.stop", owner: "B", roles: ["plugin-host"], direction: "from-daemon",
    params: z.object({ pluginId: AnyPluginId, reason: utf16(500), graceMs: z.number().int().min(0).max(60_000) }),
    result: Ok,
    doc: "Stops a host half; calls in flight get the grace period, then are recorded as interrupted (§5.1).",
  }),
  pluginHostInvoke: defineMethod({
    name: "pluginHost.invoke", owner: "B", roles: ["plugin-host"], direction: "from-daemon",
    params: z.object({
      callId: utf16(128, 1), pluginId: AnyPluginId,
      /** An export of `host.entry` (a handler, adapter, custom sign-in, …). */
      handler: utf16(256, 1),
      /** For an export that is an object of handlers (a service): the one to run. */
      method: utf16(128, 1).optional(),
      args: z.unknown(), caller: Caller,
      timeoutMs: z.number().int().min(1).max(600_000),
      /** The handler returns an async iterable (a model adapter's output, a voice's audio, review S16): each value
       *  comes back as `pluginHost.chunk`, in order, and this call's result is the iterable's return value. */
      stream: z.boolean().optional(),
      /** The handler also takes a stream (a voice's microphone audio): its pieces follow as `pluginHost.feed`. */
      input: z.boolean().optional(),
    }),
    result: z.object({ result: z.unknown() }),
    doc: "Calls a handler in the plugin's worker, telling it who called (§5.4).",
  }),
  pluginHostCancel: defineMethod({
    name: "pluginHost.cancel", owner: "B", roles: ["plugin-host"], direction: "from-daemon",
    params: z.object({ callId: utf16(128, 1) }), result: Ok,
    doc: "Cancels an invocation (an interrupt, a timeout, a stop).",
  }),
  pluginHostFeed: defineMethod({
    name: "pluginHost.feed", owner: "B", roles: ["plugin-host"], direction: "from-daemon",
    params: z.object({
      callId: utf16(128, 1),
      /** From 0, one more each time; the host hands the pieces to the handler in this order. */
      seq: z.number().int().min(0),
      value: z.unknown().optional(),
      /** The last piece: the handler's input iterable ends. */
      end: z.boolean().optional(),
    }),
    result: Ok,
    doc: "The next piece of a streamed call's input, for the handler's input iterable.",
  }),
  pluginHostDeliver: defineMethod({
    name: "pluginHost.deliver", owner: "B", roles: ["plugin-host"], direction: "from-daemon",
    params: z.object({ pluginId: AnyPluginId, subscription: utf16(128, 1), value: z.unknown() }),
    result: Ok,
    doc: "A value for one of a host half's watches (`points.watch`, `approvals.watch`, …); the host hands it only to that plugin's worker.",
  }),
  pluginHostApi: defineMethod({
    name: "pluginHost.api", owner: "B", roles: ["plugin-host"],
    params: z.object({
      /** Stamped by the plugin host from its worker table: the worker that made the call (review S3). */
      pluginId: AnyPluginId,
      /** The host's id for this call, which `pluginHost.chunk` names when an argument is a stream. */
      callId: utf16(128, 1),
      /** A plugin-API function by name (`points.entries`, `net.fetch`, …). The plugin SDK's catalog says which
       *  capability each one needs and where it exists; without them the call doesn't exist for that plugin (§5.4). */
      call: utf16(128, 1),
      /** The arguments, structured-clone data. A listener is replaced by a subscription the daemon answers through
       *  `pluginHost.deliver`; a streamed argument (`audio.play`'s audio) by the pieces that follow it. */
      args: z.unknown(),
      /** An argument is a stream, whose pieces follow as `pluginHost.chunk` with this `callId`. */
      stream: z.boolean().optional(),
      timeoutMs: z.number().int().min(1).max(600_000).optional(),
      /** The open call it was made while serving (R7): the `callId` of a `pluginHost.invoke`, or the id the daemon put
       *  on an MCP request (`_meta["clover/invocation"]`, which the host takes off before the plugin sees it). Stamped
       *  by the host from the handler's own context, never from the plugin. The daemon binds the caller from its own
       *  record of that call, so the call acts as that call's session, and refuses an id that isn't an open call to
       *  this plugin. Absent: the call acts as the plugin. */
      invocation: utf16(128, 1).optional(),
    }),
    result: z.object({ result: z.unknown() }),
    doc: "A plugin's host half calls the plugin API (§5.4). A watch's result is `{ subscription }`.",
  }),
  pluginHostChunk: defineMethod({
    name: "pluginHost.chunk", owner: "B", roles: ["plugin-host"],
    params: z.object({
      /** A streamed `pluginHost.invoke`'s id, or a `pluginHost.api` call's with a streamed argument. */
      callId: utf16(128, 1),
      seq: z.number().int().min(0),
      value: z.unknown().optional(),
      end: z.boolean().optional(),
    }),
    result: Ok,
    doc: "The next piece of a stream: a streamed handler's output, or a streamed argument of an API call.",
  }),
  // A plugin's `net.fetch` (§5.4 "The keyed fetch") across the plugin host: the request's head goes as
  // `pluginHost.fetch`, which answers the response's head; the bodies go in pieces within credit windows, each way.
  // The daemon enforces every limit (packages/core/src/plugin-host/fetch-wire.ts `FETCH_LIMITS`).
  pluginHostFetch: defineMethod({
    name: "pluginHost.fetch", owner: "B", roles: ["plugin-host"],
    params: z.object({
      /** Stamped by the plugin host from its worker table (review S3). */
      pluginId: AnyPluginId,
      /** The worker's id for this fetch, which the body messages name. One the daemon has open is refused. */
      fetchId: utf16(128, 1),
      url: utf16(16_384, 1),
      method: utf16(32, 1),
      /** Name and value pairs (at most 256, 64 KiB together). */
      headers: z.array(z.tuple([utf16(16_384), utf16(65_536)])).max(256),
      /** A body given whole (at most 16 MiB). */
      body: z.instanceof(Uint8Array).optional(),
      /** The body is a stream: its pieces follow as `pluginHost.fetchSend`, within `pluginHost.fetchSendCredit`. */
      upload: z.boolean().optional(),
      /** The keyed fetch's options (`auth`, `idleTimeoutMs`). */
      options: z.record(z.string(), z.unknown()).optional(),
      /** As `pluginHost.api`'s: the open call it was made while serving, stamped by the host. */
      invocation: utf16(128, 1).optional(),
    }),
    result: z.object({
      status: z.number().int().min(200).max(599),
      statusText: utf16(512),
      headers: z.array(z.tuple([utf16(16_384), utf16(65_536)])),
      /** A body follows as `pluginHost.fetchBody`. */
      body: z.boolean(),
    }),
    doc: "A plugin's net.fetch: the request's head; answers the response's head (§5.4).",
  }),
  pluginHostFetchSend: defineMethod({
    name: "pluginHost.fetchSend", owner: "B", roles: ["plugin-host"],
    params: z.object({
      pluginId: AnyPluginId, fetchId: utf16(128, 1),
      /** From 0, one more each piece. */
      seq: z.number().int().min(0),
      /** At most 64 KiB, within the credit the daemon gave. */
      bytes: z.instanceof(Uint8Array).optional(),
      end: z.boolean().optional(),
    }),
    result: Ok,
    doc: "The next piece of a fetch's streamed request body, or its end.",
  }),
  pluginHostFetchSendCredit: defineMethod({
    name: "pluginHost.fetchSendCredit", owner: "B", roles: ["plugin-host"], direction: "from-daemon",
    params: z.object({ fetchId: utf16(128, 1), bytes: z.number().int().min(1) }),
    result: Ok,
    doc: "More of a fetch's streamed request body the daemon takes.",
  }),
  pluginHostFetchBody: defineMethod({
    name: "pluginHost.fetchBody", owner: "B", roles: ["plugin-host"], direction: "from-daemon",
    params: z.object({
      fetchId: utf16(128, 1),
      seq: z.number().int().min(0),
      bytes: z.instanceof(Uint8Array).optional(),
      /** The body ended. */
      end: z.boolean().optional(),
      /** The fetch failed (its code, its message, the keyed fetch's code in `detail.fetch`). */
      error: z.object({ code: utf16(64), message: utf16(2000), detail: z.record(z.string(), z.unknown()).optional() }).optional(),
    }),
    result: Ok,
    doc: "The next piece of a fetch's response body, its end, or its failure: the last message of a fetch.",
  }),
  pluginHostFetchCredit: defineMethod({
    name: "pluginHost.fetchCredit", owner: "B", roles: ["plugin-host"],
    params: z.object({ pluginId: AnyPluginId, fetchId: utf16(128, 1), bytes: z.number().int().min(1) }),
    result: Ok,
    doc: "More of a fetch's response body the worker takes.",
  }),
  pluginHostFetchCancel: defineMethod({
    name: "pluginHost.fetchCancel", owner: "B", roles: ["plugin-host"],
    params: z.object({ pluginId: AnyPluginId, fetchId: utf16(128, 1) }),
    result: Ok,
    doc: "The plugin let go of a fetch (an abort, a cancelled body): the daemon aborts it upstream.",
  }),
  pluginHostUnwatch: defineMethod({
    name: "pluginHost.unwatch", owner: "B", roles: ["plugin-host"],
    params: z.object({ pluginId: AnyPluginId, subscription: utf16(128, 1) }), result: Ok,
    doc: "Ends one of a host half's watches; a worker's watches also end when it stops.",
  }),
  pluginHostState: defineMethod({
    name: "pluginHost.state", owner: "B", roles: ["plugin-host"],
    params: z.object({
      pluginId: AnyPluginId,
      state: z.enum(["starting", "running", "crashed", "stopped", "heartbeat-missed"]),
      reason: utf16(2000).optional(),
    }),
    result: Ok,
    doc: "The plugin host reports a worker's state; the registry applies the crash rules (§5.1).",
  }),
  pluginHostLog: defineMethod({
    name: "pluginHost.log", owner: "B", roles: ["plugin-host"],
    params: z.object({ pluginId: AnyPluginId, lines: z.array(utf16(4000)).max(500) }), result: Ok,
    doc: "A worker's log lines, for `logs/plugins/<id>.log`.",
  }),
} as const;

// -------------------------------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------------------------------

export const PluginChangedEvent = coreEvent("plugin_changed", {
  id: AnyPluginId, state: PluginState, enabled: z.boolean(),
  reason: utf16(2000).optional(), waitingFor: z.array(utf16(256)).max(64).optional(),
});
export const PluginRemovedEvent = coreEvent("plugin_removed", { id: AnyPluginId });
export const PluginUiChangedEvent = coreEvent("plugin_ui_changed", { pluginIds: z.array(AnyPluginId).max(1000) });
export const CommandsChangedEvent = coreEvent("commands_changed", {});
export const PluginLogEvent = coreEvent("plugin_log", { id: AnyPluginId, line: utf16(4000) });
/** A plugin's host half sent its components a message (`ui.send`): the app gives it to the components that listen
 *  (`host.on(event)`). */
export const PluginUiMessageEvent = coreEvent("plugin_ui_message", { pluginId: AnyPluginId, event: utf16(128, 1), value: z.unknown() });
export const DevFolderReloadedEvent = coreEvent("dev_folder_reloaded", {
  path: utf16(4096), pluginId: AnyPluginId.optional(), ok: z.boolean(), reason: utf16(2000).optional(),
});
export const PluginAuthChangedEvent = coreEvent("plugin_auth_changed", { id: AnyPluginId, auth: PluginAuthView });
/** A plugin was found on disk and waits for its OK, which is a sealed card (§5.1). */
export const PluginFoundEvent = coreEvent("plugin_found", { id: TopPluginId, folder: utf16(4096), card: CardId });

export const PLUGINS_EVENTS = {
  pluginChanged: defineEvent({
    type: "plugin_changed", owner: "B", roles: ["app", "cli"], schema: PluginChangedEvent,
    fixture: { type: "plugin_changed", ts: 1781270000000, id: "luna/tarot-panel", state: "waiting", enabled: true, reason: "waiting for `island.tab`", waitingFor: ["island.tab"] },
    doc: "A plugin's state, switch or reason changed.",
  }),
  pluginRemoved: defineEvent({
    type: "plugin_removed", owner: "B", roles: ["app", "cli"], schema: PluginRemovedEvent,
    fixture: { type: "plugin_removed", ts: 1781270000000, id: "luna" },
    doc: "A plugin's folder was removed.",
  }),
  pluginFound: defineEvent({
    type: "plugin_found", owner: "B", roles: ["app", "cli"], schema: PluginFoundEvent,
    fixture: { type: "plugin_found", ts: 1781270000000, id: "luna", folder: "/Users/me/.clover/plugins/luna", card: "card_0a1b2c3d" },
    doc: "A new folder in the plugins directory waits for the user's OK.",
  }),
  pluginAuthChanged: defineEvent({
    type: "plugin_auth_changed", owner: "A", roles: ["app", "cli"], schema: PluginAuthChangedEvent,
    fixture: { type: "plugin_auth_changed", ts: 1781270000000, id: "clover/model-openai", auth: { index: 0, method: "api-key", secret: "openai", state: "signed-in" } },
    doc: "One of a plugin's sign-ins changed state.",
  }),
  pluginUiChanged: defineEvent({
    type: "plugin_ui_changed", owner: "B", roles: ["app"], schema: PluginUiChangedEvent,
    fixture: { type: "plugin_ui_changed", ts: 1781270000000, pluginIds: ["luna", "luna/tarot-panel"] },
    doc: "These plugins' UI changed; the app re-reads `plugin.ui` and remounts them.",
  }),
  commandsChanged: defineEvent({
    type: "commands_changed", owner: "B", roles: ["app", "cli", "remote"], schema: CommandsChangedEvent,
    fixture: { type: "commands_changed", ts: 1781270000000 },
    doc: "The command list changed; clients re-read `command.list`.",
  }),
  pluginLog: defineEvent({
    type: "plugin_log", owner: "B", roles: ["app"], schema: PluginLogEvent, transient: true,
    fixture: { type: "plugin_log", ts: 1781270000000, id: "luna", line: "connected to the tarot service" },
    doc: "A plugin's new log line, for Settings while it is open.",
  }),
  pluginUiMessage: defineEvent({
    type: "plugin_ui_message", owner: "B", roles: ["app"], schema: PluginUiMessageEvent, transient: true,
    fixture: { type: "plugin_ui_message", ts: 1781270000000, pluginId: "luna", event: "drawn", value: { card: "The Fool" } },
    doc: "A plugin's host half sent its components a message (`ui.send`); the app relays it to their `host.on`.",
  }),
  devFolderReloaded: defineEvent({
    type: "dev_folder_reloaded", owner: "B", roles: ["app"], schema: DevFolderReloadedEvent,
    fixture: { type: "dev_folder_reloaded", ts: 1781270000000, path: "/Users/me/code/luna", pluginId: "luna", ok: true },
    doc: "A development folder reloaded; the tray lists each reload (§5.6).",
  }),
} as const;
