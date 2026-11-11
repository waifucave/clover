// The desktop notifications plugin's host half (clover/notifications). Its `notifiers` entry runs on each computer
// (`runsOn: "each"`, spec §5.2's table), so the banner shows on the screen in front of the user.
//
// Exports:
//   start(api) / stop()   the host half's lifecycle
//   notifier              the handler of this plugin's `notifiers` entry (clover.json): `notify` and `clear`

import { DEFAULT_PREFS, DesktopNotifier, type DesktopNotice, type DesktopNotifications, type NotifierUpdate, type NotifyPrefs } from "../src/notifier";
import { setTranslator, type Translator } from "../src/strings";

/** What the host half needs from the plugin API (lane B's `PluginApi`, the parts it reads) and from the local app. */
export interface HostApi {
  bots?: { get(bot: string): Promise<{ name: string }> };
  /** This computer's app's notifications: the plugin API's `desktop` door (the SDK's `DesktopNotifications`), which
   *  only the bundled `clover` tree's process reaches. The app itself shows nothing while it is in front showing the
   *  session, so this notifier asks no `showing` of it. */
  desktop?: {
    show(banner: { id: string; title: string; body?: string; session?: string; urgent?: boolean; silent?: boolean }): Promise<{ shown: boolean }>;
    close(id?: string): Promise<void>;
  };
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

/** The plugin API's `t` as a translator, only where it answers at once with a string. In a host half the API's members
 *  cross to the core, so a `t` there gives a promise (and the core serves none to a host half yet): those words are
 *  English, and the promise is let go quietly. */
function hostTranslator(t: Translator | undefined): Translator | null {
  if (t === undefined) return null;
  return (key, params) => {
    let v: unknown;
    try {
      v = t(key, params);
    } catch {
      return key;
    }
    if (typeof v === "string") return v;
    if (v instanceof Promise) v.catch(() => undefined);
    return key;
  };
}

/** A line in this plugin's log: a host half's console is its log (the plugin API has no log call). */
function logLine(level: "info" | "warn" | "error", message: string): void {
  (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(message);
}

export async function start(api: HostApi): Promise<void> {
  if (current || !api.desktop) return;
  setTranslator(hostTranslator(api.t));
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
    botName: bots ? async (bot) => (await bots.get(bot).catch(() => undefined))?.name : undefined,
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
