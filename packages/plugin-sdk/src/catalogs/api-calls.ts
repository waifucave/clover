// Which capability each plugin-API call needs, and where it exists (spec §5.4 "Capabilities": "each one gates a fixed
// set of calls and live events, listed in the plugin SDK's reference"). The plugin host gates `pluginHost.api` calls
// by this table (B-M2); the UI runtime does the same in layers (lane E). `satisfies` keeps it exactly in step with
// `PluginApi`: a call added there and missing here, or the reverse, fails the typecheck.
import type {
  ApprovalsApi, AudioApi, BotsApi, BrowserApi, CommandsApi, ComputersApi, ConversationApi, DevicesApi, FilesApi, HostApi, KeysApi,
  LogsApi, MemoryApi, NetApi, NotifyApi, PluginApi, PointsApi, RoutinesApi, SecretsApi, SettingsApi, SyncedStore,
  UiSendApi, UsageApi,
} from "../api/plugin-api";

type Fn = (...args: never[]) => unknown;
type FnKeys<T> = { [K in keyof T & string]-?: NonNullable<T[K]> extends Fn ? K : never }[keyof T & string];

/** Every call of the plugin API, by its dotted path. */
export type ApiCallPath =
  | FnKeys<PluginApi>
  | `points.${FnKeys<PointsApi>}` | `commands.${FnKeys<CommandsApi>}` | `host.${FnKeys<HostApi>}` | `ui.${FnKeys<UiSendApi>}`
  | `storage.synced.${FnKeys<SyncedStore>}` | `net.${FnKeys<NetApi>}` | `secrets.${FnKeys<SecretsApi>}` | `keys.${FnKeys<KeysApi>}`
  | `settings.${FnKeys<SettingsApi>}` | `conversation.${FnKeys<ConversationApi>}` | `memory.${FnKeys<MemoryApi>}`
  | `bots.${FnKeys<BotsApi>}` | `routines.${FnKeys<RoutinesApi>}` | `computers.${FnKeys<ComputersApi>}` | `devices.${FnKeys<DevicesApi>}`
  | `approvals.${FnKeys<ApprovalsApi>}` | `files.${FnKeys<FilesApi>}` | `browser.${FnKeys<BrowserApi>}`
  | `usage.${FnKeys<UsageApi>}` | `logs.${FnKeys<LogsApi>}` | `notify.${FnKeys<NotifyApi>}` | `audio.${FnKeys<AudioApi>}`;

export interface ApiCallInfo {
  /** The capability it needs; `call:*` is `call:<the target's top-level id>`, `network:*` the URL's host. */
  readonly capability?: string;
  /** Host halves, only a host half in a process of the plugin's own (never a worker of a shared process), components
   *  (UI layers), or both. */
  readonly where: "host" | "own-process" | "ui" | "both";
}

/** Where a call comes from: a component, a host half in a shared process, or one in a process of its own. */
export type ApiCaller = "ui" | "host" | "own-process";

const both = (capability?: string): ApiCallInfo => (capability ? { capability, where: "both" } : { where: "both" });

export const API_CALLS = {
  confirm: both(),
  t: both(),
  "points.entries": both(), "points.watch": both(), "points.call": both(),
  "commands.run": both("call:*"), "commands.list": both(),
  "host.call": { where: "ui" }, "host.on": { where: "ui" },
  "ui.send": { where: "host" },
  "storage.synced.get": both(), "storage.synced.set": both(), "storage.synced.delete": both(), "storage.synced.keys": both(), "storage.synced.watch": both(),
  "net.fetch": both("network:*"),
  /** Only a process of the plugin's own; never a worker of a shared process, never a layer (§5.2). */
  "secrets.get": { where: "own-process" },
  /** The private halves stay in the core, so any host half may keep key pairs; never a layer. */
  "keys.publicKey": { where: "host" }, "keys.open": { where: "host" }, "keys.delete": { where: "host" },
  "settings.get": both(), "settings.watch": both(), "settings.set": both(),
  "conversation.list": both("conversation.read"), "conversation.get": both("conversation.read"),
  "conversation.history": both("conversation.read"), "conversation.follow": both("conversation.read"),
  "conversation.note": both("conversation.post"), "conversation.send": both("conversation.post"), "conversation.answer": both("conversation.post"),
  "memory.list": both("memory.read"), "memory.read": both("memory.read"),
  "bots.list": both("bots.read"), "bots.get": both("bots.read"), "bots.watch": both("bots.read"),
  "routines.list": both("routines.read"), "routines.runs": both("routines.read"),
  "computers.list": both("computers.read"), "computers.get": both("computers.read"), "computers.watch": both("computers.read"),
  "computers.holds": both("computers.control"), "computers.takeHold": { capability: "computers.control", where: "host" },
  "computers.releaseHold": { capability: "computers.control", where: "host" }, "computers.setUserWorking": { capability: "computers.control", where: "host" },
  "computers.setActionRunning": { capability: "computers.control", where: "host" }, "computers.cloverWindows": { capability: "computers.control", where: "host" },
  "devices.list": both("devices.read"), "devices.watch": both("devices.read"),
  "approvals.pending": both("approvals"), "approvals.watch": both("approvals"),
  "files.stat": both("files"), "files.readText": both("files"), "files.readBytes": both("files"), "files.write": both("files"),
  "files.list": both("files"), "files.remove": both("files"), "files.move": both("files"), "files.glob": both("files"), "files.grep": both("files"),
  "browser.tabs": both("browser"), "browser.open": both("browser"), "browser.close": both("browser"), "browser.navigate": both("browser"),
  "browser.show": both("browser"), "browser.hide": both("browser"), "browser.screenshot": both("browser"), "browser.cdp": both("browser"),
  "browser.onCdpEvent": both("browser"), "browser.watch": both("browser"),
  "usage.rows": both("usage.read"), "usage.plans": both("usage.read"), "usage.summary": both("usage.read"), "usage.watch": both("usage.read"),
  "logs.read": both("logs.read"), "logs.follow": both("logs.read"),
  "notify.send": both("notify"),
  "audio.play": both("audio"), "audio.onRecording": both("audio"),
} as const satisfies Record<ApiCallPath, ApiCallInfo>;

/** Whether a plugin with these capabilities has a call, where it runs (§5.4: without the capability, the call doesn't
 *  exist for that plugin). `target` is the command's plugin for `commands.run`, the URL's host for `net.fetch`. */
export function apiCallAllowed(call: string, where: ApiCaller, capabilities: readonly string[], target?: { plugin?: string; host?: string; port?: number }, allowNetwork?: (caps: readonly string[], host: string, port?: number) => boolean): boolean {
  const info = (API_CALLS as Record<string, ApiCallInfo>)[call];
  if (!info) return false;
  const reaches = info.where === "both"
    || info.where === where
    || (info.where === "host" && where === "own-process");
  if (!reaches) return false;
  if (info.capability === undefined) return true;
  if (info.capability === "call:*") return target?.plugin !== undefined && capabilities.includes(`call:${target.plugin.split("/")[0]}`);
  if (info.capability === "network:*") return target?.host !== undefined && allowNetwork !== undefined && allowNetwork(capabilities, target.host, target.port);
  return capabilities.includes(info.capability);
}
