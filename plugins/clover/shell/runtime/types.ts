// What F's parts take from the app's plugin runtime and the core: lane B's declarations, imported (B-M0, #157):
// `@waifucave/clover-plugin-sdk` for the UI API and the plugin API, `@waifucave/clover-protocol` for the views. Only
// what B doesn't declare is F's here: `<Spot>`'s extra props, and the core methods the `clover` layer calls (some of
// them provisional, for the lanes named to settle). Lane E's `@waifucave/clover-plugin-sdk/ui` replaces `ui.ts`
// beside this file.
import type * as Sdk from "@waifucave/clover-plugin-sdk";
import type * as Proto from "@waifucave/clover-protocol";
import type { ReactNode } from "react";

// -------------------------------------------------------------------------------------------------
// The UI API (B's ui-api.ts)
// -------------------------------------------------------------------------------------------------

export type TokenValue = Sdk.TokenValue;
export type Unsubscribe = Sdk.Unsubscribe;
export type EntryProps<P = Record<string, unknown>> = Sdk.EntryProps<P>;
export type UiApi = Sdk.UiApi;
export type CardButtonProps = Sdk.CardButtonProps;
export type CardElementProps = Sdk.CardElementProps;
export type CardFieldProps = Sdk.CardFieldProps;
export type AppViewProps = Sdk.AppViewProps;

/** Which entry a component is (`EntryProps["entry"]`). */
export type EntryRef = Sdk.EntryProps["entry"];

/** A component, bound to React's types (B's `UiComponent` leaves the node type open). */
export type EntryComponent<P = any> = (props: EntryProps<P>) => ReactNode;

/** `<Spot>`'s props: B's `SpotElementProps`, with `key` as `spotKey` (React keeps `key` for itself and never hands it
 *  to a component: asked of B, as E's runtime does), plus two the parts need (asked of E):
 *  - `fallback`: what shows when nothing fills a single spot or a keyed cell, the declaring part's own rendering;
 *  - `only`: one entry of a list spot, by `<plugin-id>#<entry-id>`, for a part that draws them one at a time. */
export type SpotElementProps = Omit<Sdk.SpotElementProps, "key"> & {
  spotKey?: string;
  fallback?: ReactNode;
  only?: string;
};

// -------------------------------------------------------------------------------------------------
// The views (B's protocol)
// -------------------------------------------------------------------------------------------------

type Infer<T extends { parse(v: unknown): unknown }> = ReturnType<T["parse"]>;

export type SessionKind = Proto.SessionKind;
export type Level = Proto.Level;
export type ChangeResult = Proto.ChangeResult;
export type BotView = Proto.BotView;
export type BotState = BotView["state"];
export type UserLayerField = BotView["userLayer"][number];
export type UserLayerPatch = Proto.UserLayerPatch;
export type SessionStatus = Proto.SessionStatus;
export type SessionView = Proto.SessionView;
export type ComputerView = Proto.ComputerView;
export type DeviceView = Proto.DeviceView;
export type AccountView = Proto.AccountView;
export type PairingView = Infer<typeof Proto.PairingView>;
export type CardMeta = Proto.CardMeta;
export type FileStat = Proto.FileStat;
export type PluginState = Proto.PluginState;
export type PluginSummary = Proto.PluginSummary;
export type PluginDetail = Proto.PluginDetail;
export type IndexView = Infer<typeof Proto.IndexView>;
export type IndexEntryView = Infer<typeof Proto.IndexEntryView>;
export type ArchivedSessionView = Proto.ArchivedSessionView;
export type ThemeRef = Infer<typeof Proto.ThemeRef>;
export type UiSettings = Proto.UiSettings;

/** A bot as a part names it. */
export interface BotRef {
  id: string;
  name: string;
}

// -------------------------------------------------------------------------------------------------
// The plugin API (B's plugin-api.ts)
// -------------------------------------------------------------------------------------------------

export type PluginApi = Sdk.PluginApi;
export type PointEntry<T = Record<string, unknown>> = Sdk.PointEntry<T>;
export type TerminalInputEvent = Sdk.TerminalInputEvent;

/** An `avatar.packs` entry (B's points.ts): an avatar file with its format and portrait. */
export interface AvatarPackEntry {
  id: string;
  name?: string;
  file: string;
  format: string;
  portrait?: string;
  license?: string;
}

/** `files` with the watch lane J built (`filesWatch`, asked of B for `FilesApi`): the paths that changed under a
 *  folder, or a resync when the watch lost track. */
export type FilesWithWatch = NonNullable<PluginApi["files"]> & {
  watch?(path: string, listener: (e: { type: "changed"; paths: string[] } | { type: "resync" }) => void): Unsubscribe | Promise<Unsubscribe>;
};

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
