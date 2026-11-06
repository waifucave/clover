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
export type UiPluginView = Infer<typeof Proto.UiPluginView>;
/** Lane H's `pairing_changed`: a pairing moved on (waiting, words, card, done, failed, expired). */
export type PairingChanged = Infer<typeof Proto.PairingChangedEvent>;
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
/** A method as lane B's protocol defines it: what a caller passes, and what comes back. */
type FromB<S extends { params: { _zod: { input: unknown } }; result: { _zod: { output: unknown } } }> = {
  params: S["params"]["_zod"]["input"];
  result: S["result"]["_zod"]["output"];
};

/** The core methods the parts call: B's, then the provisional ones B's protocol has no call for yet. */
export interface CoreMethods {
  "bot.setUserLayer": FromB<typeof Proto.SESSIONS_METHODS.botSetUserLayer>;
  "session.send": FromB<typeof Proto.SESSIONS_METHODS.sessionSend>;
  "agent.backends": FromB<typeof Proto.AGENTS_METHODS.agentBackends>;
  "agent.start": FromB<typeof Proto.AGENTS_METHODS.agentStart>;
  "session.interrupt": FromB<typeof Proto.SESSIONS_METHODS.sessionInterrupt>;
  "session.stop": FromB<typeof Proto.SESSIONS_METHODS.sessionStop>;
  "session.setModel": FromB<typeof Proto.SESSIONS_METHODS.sessionSetModel>;
  "computer.setLevel": FromB<typeof Proto.COMPUTERS_METHODS.computerSetLevel>;
  "device.revoke": FromB<typeof Proto.DEVICES_METHODS.deviceRevoke>;
  "device.pair.begin": FromB<typeof Proto.DEVICES_METHODS.devicePairBegin>;
  "device.pair.join": FromB<typeof Proto.DEVICES_METHODS.devicePairJoin>;
  "device.pair.confirm": FromB<typeof Proto.DEVICES_METHODS.devicePairConfirm>;
  "device.pair.cancel": FromB<typeof Proto.DEVICES_METHODS.devicePairCancel>;
  "main.set": FromB<typeof Proto.DEVICES_METHODS.mainSet>;
  "account.status": FromB<typeof Proto.DEVICES_METHODS.accountStatus>;
  "plugin.list": FromB<typeof Proto.PLUGINS_METHODS.pluginList>;
  "plugin.ui": FromB<typeof Proto.PLUGINS_METHODS.pluginUi>;
  "plugin.get": FromB<typeof Proto.PLUGINS_METHODS.pluginGet>;
  "plugin.settings.get": FromB<typeof Proto.PLUGINS_METHODS.pluginSettingsGet>;
  "plugin.settings.set": FromB<typeof Proto.PLUGINS_METHODS.pluginSettingsSet>;
  "plugin.setEnabled": FromB<typeof Proto.PLUGINS_METHODS.pluginSetEnabled>;
  "plugin.restart": FromB<typeof Proto.PLUGINS_METHODS.pluginRestart>;
  "plugin.logs": FromB<typeof Proto.PLUGINS_METHODS.pluginLogs>;
  "plugin.install": FromB<typeof Proto.PLUGINS_METHODS.pluginInstall>;
  "plugin.confirmAdult": FromB<typeof Proto.PLUGINS_METHODS.pluginConfirmAdult>;
  "command.list": FromB<typeof Proto.PLUGINS_METHODS.commandList>;
  "command.run": FromB<typeof Proto.PLUGINS_METHODS.commandRun>;
  "plugin.index.list": FromB<typeof Proto.PLUGINS_METHODS.pluginIndexList>;
  "plugin.index.search": FromB<typeof Proto.PLUGINS_METHODS.pluginIndexSearch>;
  "ui.settings": FromB<typeof Proto.APP_METHODS.uiSettings>;
  "ui.set": FromB<typeof Proto.APP_METHODS.uiSet>;
  "archive.list": FromB<typeof Proto.SESSIONS_METHODS.archiveList>;
  "archive.history": FromB<typeof Proto.SESSIONS_METHODS.archiveHistory>;
  // Provisional: what a session's column shows that B's API has no call for yet. The owners named settle them.
  /** A coding session's changes against their base (lane D). */
  "session.changes": { params: { id: string }; result: { label: string; added: number; removed: number; files: number } | null };
  /** A coding session's diff against a base, per file with its hunks (lane D; the panel's `DiffFile` shape). */
  "session.diff": { params: { id: string; target?: string }; result: { base: string; target: string; targets: string[]; files: unknown[]; notice?: string } };
  /** How much of the model's context a session uses (lanes A and D). */
  "session.context": { params: { id: string }; result: { used: number; tokens?: number; window?: number } | null };
  /** The MCP connectors a session has, and how many need signing in again (lane A). */
  "session.connectors": { params: { id: string }; result: { total: number; needSignIn: number } };
  /** The inherited model catalog; its Clover shape is lane A's and B's to settle. */
  "models.catalog": { params: Record<string, never>; result: { models: { id: string; label?: string; name?: string; provider?: string }[] } };
}

export type CoreMethod = keyof CoreMethods;

export interface CoreClient {
  call<M extends CoreMethod>(method: M, params: CoreMethods[M]["params"]): Promise<CoreMethods[M]["result"]>;
  /** A core event: `ui_settings_changed`, `card_pending`, `session_changed`… */
  on(event: string, listener: (event: Record<string, unknown>) => void): Unsubscribe;
}
