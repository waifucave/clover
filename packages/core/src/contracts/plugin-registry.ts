// Contract: PluginRegistry (spec §3.2 "Plugin registry", §5.1, §5.3, §5.4 "How it works", §5.6). Owner: lane B.
//
// The registry watches the plugins folder, asks before loading a found plugin, reads manifests without running
// anything, starts each contribution once its extension point exists, stops dependents first, and reloads live. The
// rest of the core reads contributions from it: the turn loop its hooks, tool dispatch its MCP servers, the app's
// plugin runtime its UI entries, the routine engine its triggers, the links their relays.
//
// What it promises:
// * States are Settings' (§5.1): found (waiting for its OK), refused, invalid, off, waiting (for a point or a
//   setting), running, stopped (after crashes, set by the plugin host) or blocked (revoked), each with a reason.
// * A child is switched on and off by itself, and switching its parent off switches it off (§5.1).
// * An entry whose point is missing waits ("waiting for `island.tab`"), and starts when the point appears. A UI spot
//   exists while the entry that declares it is active (§5.4); `app.root`, `app.surface` and `bot.tab` are the app's.
// * Entry ids other plugins refer to (a model provider, voice, agent backend, trigger type, computer provider) are
//   unique among enabled plugins: on a clash only that entry is refused, and the plugin enabled first, by the synced
//   list's order, keeps the id (§5.1 "Entry ids"). Commands are unique within their namespace (§5.4).
// * Change events come in dependency order: when something stops, the entries that depended on it change before the
//   plugin that declared their point does; when something starts, the declarer comes first (§5.4).
// * A well-known name's point is recorded with the catalog's declaration (the plugin SDK's `catalogPointDecl`),
//   whatever its declarer wrote, so its `keep` and `needs` hold (review S2): `conversation.message` keeps `approval`.
// * A point declared `private` takes entries only from its declarer's own tree; another plugin's entry is refused.
// * Only one enabled plugin may use a namespace (§6.7): a later one, by the synced list's order, stays off and says
//   whose it is.
// * The OK is bound to the tree the card showed (review S7): `approve` refuses with `changed` when the folder's tree
//   hash is no longer the one passed, and the app shows a new card. After its OK, a folder change that hits a trigger
//   or changes what runs (§5.6 "When the app asks again") waits for a new OK; another data edit applies at once,
//   except a change to card styling (§5.5), which applies to everything but approval cards: they keep the styling of
//   the tree last OK'd (`okHash`) until the user OKs it.
import type { PluginProvenance, PluginState, PluginSummary, ValidationIssue } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";
import type { CoreEntries, Manifest, PointDecl } from "./sdk-types";

export interface PluginRecord extends PluginSummary {
  /** The folder on this computer. */
  folder: string;
  /** The tree hash the user last OK'd (an install through the app is its OK); `treeHash` is the folder now. */
  okHash?: string;
  /** A change to its card styling waits for its OK: approval cards keep the styling of `okHash`. */
  cardStylingHeld?: boolean;
  /** As validated: refused contributions and entries left out; undefined when the plugin itself is refused. */
  manifest: Manifest | undefined;
  capabilities: readonly string[];
  issues: readonly ValidationIssue[];
  provenance: PluginProvenance;
}

export type ContributionState = "active" | "waiting" | "refused";

export interface Contribution<T = unknown> {
  point: string;
  pluginId: string;
  /** Where the entry is in the manifest: `models/0`, `mcpServers/blender`, `ui/2`, `luna.cards/1`, `bot`. */
  ref: string;
  /** Its id where its point has one: the provider, voice, backend or computer provider id, the trigger type, the
   *  server's name, a command's `<namespace>.<name>`, a `ui` or theme entry's id. */
  entryId?: string;
  /** A keyed entry's key (`ui` entries' `key`, a trigger's type). */
  key?: string;
  value: T;
  state: ContributionState;
  /** "waiting for `island.tab`", "`fish` is taken by `fish-audio`". */
  reason?: string;
}

export interface RegisteredPoint {
  name: string;
  shape: PointDecl["shape"];
  /** `core` for the core's points; otherwise the entry that declares it. */
  declaredBy: "core" | { pluginId: string; ref: string };
  /** Has `props`: a UI spot, filled through `ui` (§5.4). */
  spot: boolean;
  /** It exists now: its declaring entry is active. */
  active: boolean;
  /** The catalog's declaration for a well-known name (review S2), whatever the declarer wrote; the declarer's for any
   *  other point. */
  decl?: PointDecl;
}

/** `changed`: the folder is no longer the tree the card showed, so nothing was approved (review S7). */
export type ApproveResult = "approved" | "changed";

export type RegistryChange =
  | { type: "plugin"; id: string; state: PluginState }
  | { type: "entries"; point: string }
  | { type: "removed"; id: string };

export interface PluginRegistry {
  list(): PluginRecord[];
  get(id: string): PluginRecord | undefined;
  /** A point's entries from every plugin that is on, in the synced list's order, whatever their state. */
  entries<P extends keyof CoreEntries>(point: P): Contribution<CoreEntries[P]>[];
  entries(point: string): Contribution[];
  points(): RegisteredPoint[];
  /** The user's switch (§5.1). */
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** The user's OK for a found plugin, or for a change waiting for one: one card covers a plugin and its children, with
   *  a checkbox each (§5.1). `treeHash` is the tree the card showed; `selection` the children's checkboxes. */
  approve(id: string, treeHash: string, selection?: Readonly<Record<string, boolean>>): Promise<ApproveResult>;
  /** The user refused it; it stays off until its folder changes. */
  refuse(id: string): Promise<void>;
  watch(fn: (change: RegistryChange) => void): Unsubscribe;
}

/** The entry field each core point keeps unique among enabled plugins (§5.1 "Entry ids"); the plugin SDK's catalog
 *  (`CORE_POINTS[].uniqueBy`) says the same, which a test checks. */
export const UNIQUE_ENTRY_FIELD: Readonly<Partial<Record<keyof CoreEntries, string>>> = {
  models: "provider",
  agentBackends: "id",
  triggers: "type",
  voices: "id",
  computerProviders: "id",
};

/** The spots the app's own plugin runtime declares (§5.3 "App core points"). Every other spot is a plugin's. */
export const CORE_SPOTS: readonly string[] = ["app.root", "app.surface", "bot.tab"];
