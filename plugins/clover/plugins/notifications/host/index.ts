// The desktop notifications plugin's host half (clover/notifications). Its `notifiers` entry runs on each computer
// (`runsOn: "each"`, spec §5.2's table), so the banner shows on the screen in front of the user.
//
// Exports:
//   start(api) / stop()   the host half's lifecycle
//   notifier              the handler of this plugin's `notifiers` entry (clover.json): `notify` and `clear`

import { DEFAULT_PREFS, DesktopNotifier, type DesktopNotifications, type NotifierUpdate, type NotifyPrefs } from "../src/notifier";
import { setTranslator, type Translator } from "../src/strings";

/** What the host half needs from the plugin API (lane B's `PluginApi`, the parts it reads) and from the local app. */
export interface HostApi {
  bots?: { get(bot: string): Promise<{ name: string }> };
  /** The local app's OS notifications (lane E: a question for B and E, how a host plugin reaches them). */
  desktop?: DesktopNotifications;
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** The plugin API's `t`: this plugin's keys in the user's language. Absent, English. */
  t?: Translator;
  /** The plugin API's own settings (clover.json's `settings`): read once at start, then kept current from `watch`. */
  settings?: { get<T = unknown>(key: string): Promise<T | undefined>; watch(key: string | null, listener: (key: string) => void): () => void };
}

let current: DesktopNotifier | null = null;
let prefs: NotifyPrefs = { ...DEFAULT_PREFS };
let unwatch: (() => void) | null = null;
const PREF_KEYS = Object.keys(DEFAULT_PREFS) as (keyof NotifyPrefs)[];

async function readPref(api: HostApi, key: keyof NotifyPrefs): Promise<void> {
  const value = await api.settings?.get<unknown>(key).catch(() => undefined);
  prefs = { ...prefs, [key]: typeof value === "boolean" ? value : DEFAULT_PREFS[key] };
}

export async function start(api: HostApi): Promise<void> {
  if (current || !api.desktop) return;
  setTranslator(api.t ? (key, params) => api.t!(key, params) : null);
  prefs = { ...DEFAULT_PREFS };
  if (api.settings) {
    await Promise.all(PREF_KEYS.map((key) => readPref(api, key)));
    unwatch = api.settings.watch(null, (key) => {
      if ((PREF_KEYS as string[]).includes(key)) void readPref(api, key as keyof NotifyPrefs);
    });
  }
  const bots = api.bots;
  current = new DesktopNotifier({
    desktop: api.desktop,
    botName: bots ? async (bot) => (await bots.get(bot).catch(() => undefined))?.name : undefined,
    log: (level, message) => api.log[level](`desktop notifications: ${message}`),
    prefs: () => prefs,
  });
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
