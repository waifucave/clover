// The desktop notifications plugin's host half (clover/notifications). Its `notifiers` entry runs on each computer
// (`runsOn: "each"`, spec §5.2's table), so the banner shows on the screen in front of the user.
//
// Exports:
//   start(api) / stop()   the host half's lifecycle
//   notifier              the handler of this plugin's `notifiers` entry (clover.json): `notify` and `clear`

import type { BotsApi, HostPluginApi, SettingsApi } from "@waifucave/clover-plugin-sdk";
import { englishOf } from "../src/names";
import { DEFAULT_PREFS, DesktopNotifier, type DesktopNotice, type DesktopNotifications, type NotifierUpdate, type NotifyPrefs } from "../src/notifier";
import { setTranslator } from "../src/strings";

/** What the host half needs from the plugin API (lane B's `PluginApi`, the parts it reads) and from the local app. */
export interface HostApi {
  bots?: Pick<BotsApi, "get">;
  /** This computer's app's notifications: the plugin API's `desktop` door (the SDK's `DesktopNotifications`), which
   *  only the bundled `clover` tree's process reaches. The app itself shows nothing while it is in front showing the
   *  session, so this notifier asks no `showing` of it. */
  desktop?: HostPluginApi["desktop"];
  /** The plugin API's own settings (clover.json's `settings`): read once at start, then kept current from `watch`. */
  settings?: Pick<SettingsApi, "get" | "watch">;
}

let current: DesktopNotifier | null = null;
let prefs: NotifyPrefs = { ...DEFAULT_PREFS };
let unwatch: (() => void) | null = null;
const PREF_KEYS = Object.keys(DEFAULT_PREFS) as (keyof NotifyPrefs)[];

async function readPref(api: HostApi, key: keyof NotifyPrefs): Promise<void> {
  const value = await api.settings?.get<unknown>(key).catch(() => undefined);
  prefs = { ...prefs, [key]: typeof value === "boolean" ? value : DEFAULT_PREFS[key] };
}

/** A line in this plugin's log: a host half's console is its log (the plugin API has no log call). */
function logLine(level: "info" | "warn" | "error", message: string): void {
  (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(message);
}

export async function start(api: HostApi): Promise<void> {
  if (current || !api.desktop) return;
  // A host half has no `t` (the plugin API's is a component's: `HostPluginApi`): its banners are in its own English
  // table; the app's parts translate their own words.
  setTranslator(null);
  prefs = { ...DEFAULT_PREFS };
  if (api.settings) {
    await Promise.all(PREF_KEYS.map((key) => readPref(api, key)));
    unwatch = api.settings.watch(null, (key) => {
      if ((PREF_KEYS as string[]).includes(key)) void readPref(api, key as keyof NotifyPrefs);
    });
  }
  const bots = api.bots;
  current = new DesktopNotifier({
    desktop: desktopOf(api.desktop),
    botName: bots ? async (bot) => englishOf((await bots.get(bot).catch(() => undefined))?.name) : undefined,
    log: (level, message) => logLine(level, `desktop notifications: ${message}`),
    prefs: () => prefs,
  });
}

/** The door as the notifier takes it: a click opens the session (when there is one), no sound when `silent`. */
function desktopOf(door: NonNullable<HostApi["desktop"]>): DesktopNotifications {
  return {
    show: async (n: DesktopNotice) => {
      await door.show({
        id: n.id, title: n.title, ...(n.body === undefined ? {} : { body: n.body }),
        ...(n.open?.session === undefined ? {} : { session: n.open.session }),
        ...(n.urgent ? { urgent: true } : {}), ...(n.silent ? { silent: true } : {}),
      });
    },
    close: (id: string) => door.close(id),
  };
}

export async function stop(): Promise<void> {
  current = null;
  unwatch?.();
  unwatch = null;
  prefs = { ...DEFAULT_PREFS };
  setTranslator(null);
}

export const notifier = {
  async notify(update: NotifierUpdate): Promise<void> {
    await current?.notify(update);
  },
  async clear(): Promise<void> {
    await current?.clear();
  },
};
