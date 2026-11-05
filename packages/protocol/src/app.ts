// Clover protocol area: the app and the pair (spec §3.1, §5.5, §5.8, §6.6). Owners: lane E (the app's side, the UI
// settings the app reads), lane C (the daemon's side of the pair, C-M1), lane D (voice), lane G (desktop
// notifications), lane M (updates). Pinned by lane B at M0; spike S7 (lane L) measured the pair on all three OSes,
// and spike S9 (lane E, layers) is still running, so the UI settings here are the least the spec needs.
//
// On desktops the app and the daemon are one always-on pair: starting either starts the other, the daemon restarts
// a crashed app (safe mode after three crashes in two minutes), and Quit stops both, first offering Hand over and
// quit on a computer running bots, routines or agents. A side that exits on purpose tells the other first.
import { z } from "zod";
import { utf16 } from "./strings";
import { AnyPluginId, BotId, CardId, ChangeResult, Empty, Ok, SessionId, Text, Timestamp } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

/** What stops if this computer quits now (§3.1). */
export const PairStatus = z.object({
  bots: z.array(BotId),
  routines: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  /** Another computer could take the bots (else they stay offline until this one is back). */
  canHandOver: z.boolean(),
  safeMode: z.boolean(),
  /** An update is downloaded and waits for an idle moment (§3.1). */
  updateReady: utf16(64).optional(),
});
export type PairStatus = z.infer<typeof PairStatus>;

/** A reference to one UI entry: `<plugin-id>` or `<plugin-id>#<entry-id>` (§5.5 `prefer`). */
export const EntryRef = utf16(300, 2).regex(/^[a-z][a-z0-9/-]*(#[A-Za-z0-9._-]+)?$/);
/** A theme, `<plugin-id>#<theme-id>` (§5.1 "Entry ids"). */
export const ThemeRef = utf16(300, 3).regex(/^[a-z][a-z0-9/-]*#[A-Za-z0-9._-]+$/);

/** The user's UI choices (§5.5), synced as account settings (§8.5). */
export const UiSettings = z.object({
  /** The user's pick in a single spot or keyed cell, for one bot or globally; `null` shows nothing there (a hide). */
  picks: z.array(z.object({ spot: utf16(128), key: utf16(256).optional(), bot: BotId.optional(), entry: EntryRef.nullable() })).max(10_000),
  /** Order and hidden entries of list spots. */
  lists: z.array(z.object({ spot: utf16(128), bot: BotId.optional(), order: z.array(EntryRef).max(1000), hidden: z.array(EntryRef).max(1000) })).max(1000),
  /** The base theme for bot tabs and the global theme; unset means `clover`'s base theme (§5.5). */
  baseTheme: ThemeRef.optional(),
  globalTheme: ThemeRef.optional(),
  /** The user's own overrides, the top of the theme stack. */
  overrides: z.object({ tokens: z.record(z.string(), utf16(1000)).optional(), css: utf16(200_000).optional() }).optional(),
  language: utf16(35).optional(),
  /** A pack chosen for a language when two translate the same keys (§5.5). */
  packs: z.record(z.string(), AnyPluginId).optional(),
});
export type UiSettings = z.infer<typeof UiSettings>;

export const APP_METHODS = {
  pairStatus: defineMethod({
    name: "pair.status", owner: "C", roles: ["app", "cli"],
    params: Empty, result: PairStatus,
    doc: "What would stop if this computer quit, for Quit's question (§3.1).",
  }),
  pairQuit: defineMethod({
    name: "pair.quit", owner: "C", roles: ["app", "cli"], userOnly: true,
    params: z.object({ handOver: z.boolean() }), result: Ok,
    doc: "Quits the app and the daemon; with `handOver`, releases the lease first so another computer takes the bots.",
  }),
  pairExiting: defineMethod({
    name: "pair.exiting", owner: "C", roles: ["app"],
    params: z.object({ reason: z.enum(["quit", "update", "restart"]) }), result: Ok,
    doc: "The app says it is leaving on purpose, so the daemon doesn't restart it (§3.1).",
  }),
  appShow: defineMethod({
    name: "app.show", owner: "E", roles: ["app"], direction: "from-daemon",
    params: z.object({
      what: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("window") }),
        z.object({ kind: z.literal("bot"), bot: BotId }),
        z.object({ kind: z.literal("session"), session: SessionId }),
        z.object({ kind: z.literal("card"), card: CardId }),
        z.object({ kind: z.literal("settings"), section: utf16(128).optional() }),
        z.object({ kind: z.literal("url"), url: z.string().url() }),
      ]),
    }),
    result: Ok,
    doc: "The daemon asks the app to open a window or a place in it (a sign-in page, a card from the CLI's `clover open`).",
  }),
  appQuit: defineMethod({
    name: "app.quit", owner: "E", roles: ["app"], direction: "from-daemon",
    params: z.object({ reason: z.enum(["quit", "update"]) }), result: Ok,
    doc: "The daemon tells the app it is stopping the pair (a Quit from the CLI, an update).",
  }),
  layerToken: defineMethod({
    name: "layer.token", owner: "C", roles: ["app"],
    params: z.object({ pluginId: AnyPluginId }), result: z.object({ token: utf16(4096, 1) }),
    doc: "A token for one plugin layer's connection (role `layer`), which the app's main process opens for it.",
  }),
  uiSettings: defineMethod({
    name: "ui.settings", owner: "E", roles: ["app"],
    params: Empty, result: UiSettings,
    doc: "The user's UI choices, which the app's plugin runtime applies.",
  }),
  uiSet: defineMethod({
    name: "ui.set", owner: "E", roles: ["app", "layer"], userOnly: true, change: "core",
    params: z.object({ patch: UiSettings.partial() }), result: ChangeResult,
    doc: "Changes the user's UI choices; from a layer other than `clover`'s it becomes a card (§5.5).",
  }),
  voiceListen: defineMethod({
    name: "voice.listen", owner: "D", roles: ["app"], userOnly: true,
    params: z.object({
      bot: BotId, utterance: utf16(128, 1), seq: z.number().int().nonnegative(),
      /** Audio the app recorded while push-to-talk was held (or listening was on), base64. */
      audio: utf16(2_000_000), format: z.enum(["pcm16-16k", "opus"]), final: z.boolean(),
    }),
    result: z.object({ text: utf16(100_000).optional() }),
    doc: "Push-to-talk audio for a bot's listening voice plugin, on the computer the user talks on (§6.6).",
  }),
  voicePlay: defineMethod({
    name: "voice.play", owner: "D", roles: ["app"], direction: "from-daemon",
    params: z.object({
      bot: BotId, session: SessionId, utterance: utf16(128, 1), seq: z.number().int().nonnegative(),
      audio: utf16(2_000_000), format: z.enum(["pcm16-24k", "mp3", "opus"]), final: z.boolean(),
    }),
    result: Ok,
    doc: "Speech for the app to play, which the avatar lip-syncs to (§6.6).",
  }),
  notifySend: defineMethod({
    name: "notify.send", owner: "G", roles: ["layer", "plugin-host"], capability: "notify",
    params: z.object({ title: Text, body: Text.optional(), session: SessionId.optional() }), result: Ok,
    doc: "A plugin sends the user a notification through the `notifiers` (§10).",
  }),
  appNotify: defineMethod({
    name: "app.notify", owner: "G", roles: ["app"], direction: "from-daemon",
    params: z.object({ id: utf16(128, 1), title: utf16(256), body: utf16(4000).optional(), session: SessionId.optional() }),
    result: Ok,
    doc: "A desktop notification, which the app shows for the bundled desktop notifier.",
  }),
  updateStatus: defineMethod({
    name: "update.status", owner: "M", roles: ["app", "cli"],
    params: Empty,
    result: z.object({ current: utf16(64), available: utf16(64).optional(), channel: utf16(32), ready: z.boolean() }),
    doc: "The app's and the daemon's version and the update waiting, if any.",
  }),
  updateApply: defineMethod({
    name: "update.apply", owner: "M", roles: ["app", "cli"], userOnly: true,
    params: Empty, result: z.object({ at: z.enum(["now", "when-idle"]) }),
    doc: "Installs the update once the daemon is between turns and no agent runs (§3.1).",
  }),
} as const;

export const UiSettingsChangedEvent = coreEvent("ui_settings_changed", { settings: UiSettings });
export const UpdateAvailableEvent = coreEvent("update_available", { version: utf16(64), ready: z.boolean(), at: Timestamp.optional() });

export const APP_EVENTS = {
  uiSettingsChanged: defineEvent({
    type: "ui_settings_changed", owner: "E", roles: ["app"], schema: UiSettingsChangedEvent,
    fixture: { type: "ui_settings_changed", ts: 1781270000000, settings: { picks: [{ spot: "composer", bot: "alpha", entry: "vn-composer" }], lists: [], language: "pt-BR" } },
    doc: "The user's UI choices changed, here or on another device.",
  }),
  updateAvailable: defineEvent({
    type: "update_available", owner: "M", roles: ["app", "cli"], schema: UpdateAvailableEvent,
    fixture: { type: "update_available", ts: 1781270000000, version: "1.111.2", ready: true },
    doc: "An update was found or is ready to install.",
  }),
} as const;
