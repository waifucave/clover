// Which capability each plugin-API call needs, and where it exists (spec §5.4 "Capabilities": "each one gates a fixed
// set of calls and live events, listed in the plugin SDK's reference"). The plugin host gates `pluginHost.api` calls
// by this table (B-M2); the UI runtime does the same in layers (lane E). `satisfies` keeps it exactly in step with
// `PluginApi`: a call added there and missing here, or the reverse, fails the typecheck.
import type {
  ApprovalsApi, AudioApi, SpeechApi, VoicesApi, AvatarReportApi, BotsApi, DesktopNotifications, BrowserApi, CommandsApi, ComputersApi, ConversationApi, DevicesApi, FilesApi, HostApi, KeysApi,
  LogsApi, MemoryApi, NetApi, NotifyApi, PluginApi, PluginsApi, PointsApi, RoutinesApi, SecretsApi, SettingsApi, SyncedStore,
  ShellApi, TerminalApi, UiSendApi, UsageApi,
} from "../api/plugin-api";
import type { HostProcess } from "@waifucave/clover-protocol";
import type { AvatarApi } from "./avatar-cues";

type Fn = (...args: never[]) => unknown;
type FnKeys<T> = { [K in keyof T & string]-?: NonNullable<T[K]> extends Fn ? K : never }[keyof T & string];

/** Every call of the plugin API, by its dotted path. */
export type ApiCallPath =
  | FnKeys<PluginApi>
  | `points.${FnKeys<PointsApi>}` | `commands.${FnKeys<CommandsApi>}` | `host.${FnKeys<HostApi>}` | `ui.${FnKeys<UiSendApi>}`
  | `storage.synced.${FnKeys<SyncedStore>}` | `net.${FnKeys<NetApi>}` | `secrets.${FnKeys<SecretsApi>}` | `keys.${FnKeys<KeysApi>}`
  | `settings.${FnKeys<SettingsApi>}` | `conversation.${FnKeys<ConversationApi>}` | `memory.${FnKeys<MemoryApi>}`
  | `bots.${FnKeys<BotsApi>}` | `routines.${FnKeys<RoutinesApi>}` | `computers.${FnKeys<ComputersApi>}` | `devices.${FnKeys<DevicesApi>}`
  | `approvals.${FnKeys<ApprovalsApi>}` | `files.${FnKeys<FilesApi>}` | `browser.${FnKeys<BrowserApi>}` | `terminal.${FnKeys<TerminalApi>}`
  | `plugins.${FnKeys<PluginsApi>}` | `shell.${FnKeys<ShellApi>}`
  | `usage.${FnKeys<UsageApi>}` | `logs.${FnKeys<LogsApi>}` | `notify.${FnKeys<NotifyApi>}` | `audio.${FnKeys<AudioApi>}` | `speech.${FnKeys<SpeechApi>}` | `voices.${FnKeys<VoicesApi>}`
  | `desktop.${FnKeys<DesktopNotifications>}` | `avatar.${FnKeys<AvatarApi>}` | `avatar.${FnKeys<AvatarReportApi>}`;

/** How many notifications a plugin may send in a minute, and in an hour (`notify.send`, its host half and its layer
 *  together). */
export const NOTIFY_PER_MINUTE = 3;
export const NOTIFY_PER_HOUR = 20;

export interface ApiCallInfo {
  /** The capability it needs; `call:*` is `call:<the target's top-level id>`, `network:*` the URL's host. */
  readonly capability?: string;
  /** Host halves in any process; only a host half in a process of the plugin's own (`own`, never a worker of a shared
   *  process); only the `clover` process (the owner's answer to S4); components (UI layers); or both. */
  readonly where: "host" | "own" | "clover" | "ui" | "both";
  /** Listed, but no side serves it yet: why. The core refuses it with this reason ("isn't available yet"), whatever the
   *  plugin's capabilities, and the SDK's `PluginApi` types it as absent, so calling it is a type error. */
  readonly notYet?: string;
}

/** Where a call comes from: a component, or a host half in the process the core started it in (`HostProcess`). */
export type ApiCaller = "ui" | HostProcess;

const both = (capability?: string): ApiCallInfo => (capability ? { capability, where: "both" } : { where: "both" });
/** A call the catalog lists that no side serves yet (`ApiCallInfo.notYet`). */
const notYet = (info: ApiCallInfo, why: string): ApiCallInfo => ({ ...info, notYet: why });
/** The Clover Browser's calls: the bundled tree's Browser tool (its host half, for the session whose tool call it serves) and
 *  the bundled panel (its component, for the person). The core serves no other plugin's. */
const BROWSER: ApiCallInfo = { capability: "browser", where: "both" };

export const API_CALLS = {
  confirm: both(), confirmCard: both(),
  // A component's own keys in the user's language (§5.5: components read them through `t`). A host half has none: its
  // calls cross to the core, and `t` answers at once with a string, which only a component's runtime can (`useT`).
  t: { where: "ui" },
  "points.entries": both(), "points.watch": both(), "points.call": both(),
  /** Its own tree's commands with no capability; another plugin's with `call:<its top-level id>`. */
  "commands.run": both("call:*"), "commands.list": both(),
  "host.call": { where: "ui" }, "host.on": { where: "ui" },
  "ui.send": { where: "host" },
  /** A layer reads its own store (`plugin.layer.call`) and hears its changes (`plugin_store_changed`); only its host half
   *  writes it, so what a component hands over is checked by the plugin's own code first. */
  "storage.synced.get": both(), "storage.synced.keys": both(),
  "storage.synced.set": { where: "host" }, "storage.synced.delete": { where: "host" }, "storage.synced.watch": { where: "host" },
  "net.fetch": both("network:*"),
  /** Only a process of the plugin's own; never a worker of a shared process, never a layer (§5.2). */
  "secrets.get": { where: "own" },
  /** Only the `clover` process (S4): a bundled plugin's own per-computer key pairs, whose private half stays in the core. */
  "keys.publicKey": { where: "clover" }, "keys.open": { where: "clover" }, "keys.delete": { where: "clover" },
  "settings.get": both(), "settings.watch": both(), "settings.set": both(),
  "conversation.list": both("conversation.read"), "conversation.get": both("conversation.read"),
  "conversation.history": both("conversation.read"), "conversation.watch": both("conversation.read"), "conversation.follow": both("conversation.read"),
  "conversation.note": both("conversation.post"), "conversation.send": both("conversation.post"), /** A component's only, and only as the user's own answer (the conversation part answers the question card the user filled
   *  in, through the app's `session.answer`): no host half answers a question as the user. */
  "conversation.answer": { capability: "conversation.post", where: "ui" },
  /** A bot plugin's own bot's memory needs no capability; any other bot's needs `memory.read`, which the core checks per
   *  bot (the coordinator's ruling: what the OK card says decides). Read-only. */
  "memory.list": both(), "memory.read": both(),
  "bots.list": both("bots.read"), "bots.get": both("bots.read"), "bots.watch": both("bots.read"),
  /** A bot plugin's own bot's routines need no capability; every bot's need `routines.read`, checked per bot. */
  "routines.list": both(), "routines.runs": both(),
  /** A host half's own trigger firing a routine it was armed for: no capability, the core checks the plugin contributes
   *  that trigger type (its card says it starts routines). */
  "routines.fire": { where: "host" },
  "computers.list": both("computers.read"), "computers.get": both("computers.read"), "computers.watch": both("computers.read"),
  "computers.holds": both("computers.control"), "computers.takeHold": { capability: "computers.control", where: "host" },
  "computers.releaseHold": { capability: "computers.control", where: "host" }, "computers.setUserWorking": { capability: "computers.control", where: "host" },
  "computers.setActionRunning": { capability: "computers.control", where: "host" }, "computers.cloverWindows": { capability: "computers.control", where: "host" },
  "devices.list": both("devices.read"), "devices.watch": both("devices.read"),
  /** Components only, with `approvals`: which cards wait for this plugin's own bot (the bundled `clover` tree: all), ids and
   *  places, never a card's text. A host half has no cards: they are the user's, and a sealed frame is a component's. */
  "approvals.pending": { capability: "approvals", where: "ui" }, "approvals.watch": { capability: "approvals", where: "ui" },
  "files.stat": both("files"), "files.readText": both("files"), "files.readBytes": both("files"), "files.write": both("files"),
  "files.list": both("files"), "files.remove": both("files"), "files.move": both("files"), "files.glob": both("files"), "files.grep": both("files"),
  "files.watch": both("files"),
  "files.path": { capability: "files", where: "host" },
  /** The pickers and the media URL: a component's (the page asks the app's own dialog, gesture-bound). Lane A adds the host
   *  half's `files.path` (a grant's real path, never a page's) beside them. */
  "files.pickOpen": { capability: "files", where: "ui" }, "files.pickFolder": { capability: "files", where: "ui" }, "files.pickSave": { capability: "files", where: "ui" },
  "files.url": { capability: "files", where: "ui" }, "files.onDrop": { capability: "files", where: "ui" },
  /** The bundled `clover` tree's host halves only, for a tool call they serve (the Browser tool): the session that call
   *  is for drives the Clover Browser, under its own rules; the bundled panel's component acts for the person and alone
   *  places a tab in a view and hears the tabs change. A third-party plugin's `browser` isn't served: raw DevTools on the
   *  person's signed-in pages is more than an OK card's one line can carry. */
  "browser.toolCaller": { capability: "browser", where: "host" }, "browser.tabs": BROWSER, "browser.open": BROWSER,
  "browser.close": BROWSER, "browser.navigate": BROWSER,
  "browser.show": BROWSER, "browser.hide": BROWSER, "browser.screenshot": BROWSER, "browser.cdp": BROWSER,
  /** Components only: a listener can't cross a call, so the panel hears the tabs change as the core's `tab_changed` and
   *  `tab_closed` events; a page's DevTools events (`onCdpEvent`) are a component's watch, the panel's alone, of the `Page.*` events. */
  "browser.watch": { capability: "browser", where: "ui" }, "browser.onCdpEvent": { capability: "browser", where: "ui" },
  /** Components only, of the bundled `clover` tree: what reaches a terminal the runtime derives from trusted events. */
  "terminal.open": { capability: "terminal", where: "ui" }, "terminal.input": { capability: "terminal", where: "ui" },
  "terminal.onData": { capability: "terminal", where: "ui" }, "terminal.resize": { capability: "terminal", where: "ui" },
  "terminal.close": { capability: "terminal", where: "ui" },
  /** Components only (a layer's own frames in a bot's tab or filling a sidebar or bar spot): the window itself. The reads answer where it is; the acts
   *  count only inside the user's own key press or click in the calling frame (the Plugins page's rule). */
  "shell.state": { capability: "shell.read", where: "ui" }, "shell.watch": { capability: "shell.read", where: "ui" }, "shell.apps": { capability: "shell.read", where: "ui" }, "shell.account": { capability: "shell.read", where: "ui" },
  "shell.openBotEditor": { capability: "shell.control", where: "ui" }, "shell.openPanel": { capability: "shell.control", where: "ui" },
  "shell.closePanel": { capability: "shell.control", where: "ui" }, "shell.togglePanel": { capability: "shell.control", where: "ui" },
  "shell.setSidebar": { capability: "shell.control", where: "ui" }, "shell.toggleSidebar": { capability: "shell.control", where: "ui" },
  "shell.go": { capability: "shell.control", where: "ui" }, "shell.openSettings": { capability: "shell.control", where: "ui" }, "shell.dragWindow": { capability: "shell.control", where: "ui" }, "shell.provide": { capability: "shell.control", where: "ui" },
  /** Components only, of the bundled `clover` tree (the plugin index browser). */
  "plugins.install": { capability: "plugins.install", where: "ui" },
  /** Lane D's usage rows and this computer's plan readings, read-only. */
  "usage.rows": both("usage.read"), "usage.plans": both("usage.read"),
  "usage.summary": both("usage.read"), "usage.watch": both("usage.read"),
  /** A plugin's own tree's logs need no capability; Clover's own (`"core"`) and any other plugin's need `logs.read`,
   *  which the core checks per source (the coordinator's ruling: what the OK card says decides). */
  "logs.read": both(), "logs.follow": both(),
  "notify.send": both("notify"),
  /** This computer's own notifications (the local app's `app.notify`): only the bundled `clover` tree's process, for its
   *  desktop notifier (§10). Any other plugin reaches the user through `notify.send`, under the core's rules (its name
   *  shown, its rate, the user's mute, never while a card waits). */
  "desktop.show": { where: "clover" }, "desktop.close": { where: "clover" },
  /** A bot plugin's figure: its own bot only (the bot whose id is the plugin's top-level id), from its components and its
   *  host half alike. The renderer's side is the stage's: only the bundled `clover` tree reports what it drew. */
  "avatar.cue": both("avatar.control"), "avatar.catalogue": both("avatar.read"), "avatar.box": both("avatar.read"), "avatar.watch": both("avatar.read"),
  "avatar.report": { capability: "avatar.report", where: "ui" },
  /** The app plays a plugin's audio as a bot's speech; push-to-talk audio reaches the plugin as it comes. */
  "audio.play": both("audio"), "audio.onRecording": both("audio"),
  /** The active voice mode's door to the player (§6.6): no capability (its `voiceModes` entry, its OK card's lines
   *  and the user's choice in Settings › Voice decide), refused to any plugin that isn't the active voice; `modes` is
   *  any voice mode's and Clover's pages'. The providers' endpoints (`voices.*`): `voices.use`, which a voice mode holds
   *  by being one (the router counts its `voiceModes` entry as the grant); a reply's ticket is the active mode's alone. */
  "speech.piece": { where: "host" }, "speech.play": { where: "host" }, "speech.stop": { where: "host" }, "speech.modes": both(),
  "voices.providers": both("voices.use"), "voices.speak": { capability: "voices.use", where: "host" }, "voices.listen": { capability: "voices.use", where: "host" },
  "voices.feed": { capability: "voices.use", where: "host" },
} as const satisfies Record<ApiCallPath, ApiCallInfo>;

/** Whether a plugin with these capabilities has a call, where it runs (§5.4: without the capability, the call doesn't
 *  exist for that plugin). `target` is the command's plugin for `commands.run`, the URL's host for `net.fetch`. */
export function apiCallAllowed(call: string, where: ApiCaller, capabilities: readonly string[], target?: { plugin?: string; host?: string; port?: number }, allowNetwork?: (caps: readonly string[], host: string, port?: number) => boolean): boolean {
  const info = (API_CALLS as Record<string, ApiCallInfo>)[call];
  if (!info) return false;
  const reaches = info.where === "both"
    || info.where === where
    || (info.where === "host" && where !== "ui");
  if (!reaches) return false;
  if (info.capability === undefined) return true;
  if (info.capability === "call:*") return target?.plugin !== undefined && capabilities.includes(`call:${target.plugin.split("/")[0]}`);
  if (info.capability === "network:*") return target?.host !== undefined && allowNetwork !== undefined && allowNetwork(capabilities, target.host, target.port);
  return capabilities.includes(info.capability);
}
