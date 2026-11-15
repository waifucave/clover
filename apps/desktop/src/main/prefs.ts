// The app's own small choices that live on this computer and outlast a restart (not the daemon's settings: they are about
// this machine's windows). One JSON file in the app's data folder. A missing or damaged file reads as the defaults, and
// a write that fails is only logged: a choice that isn't kept is a nuisance, never a crash.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface AppPrefs {
  /** The first version's switch, from when the Dispatch pill was the one surface that could be put away: read once, and applied to
   *  every surface that has a tray toggle (then cleared into `hiddenSurfaces`). */
  pillHidden: boolean;
  /** The surfaces the user put away from the tray (or by the four-finger tap), by entry ref (`<plugin>#<entry>`): each stays away until shown again. */
  hiddenSurfaces: string[];
  /** The four-finger tap that toggles the pill (where the app has the helper for it). On unless turned off. */
  fourFingerTap: boolean;
  /** The app's one mute over every plugin's sound (the bots' voices and the background parts' alike), from the tray. Off unless turned on. */
  soundMuted: boolean;
}

export const DEFAULT_PREFS: AppPrefs = { pillHidden: false, hiddenSurfaces: [], fourFingerTap: true, soundMuted: false };

export function readPrefs(file: string): AppPrefs {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      pillHidden: typeof raw.pillHidden === "boolean" ? raw.pillHidden : DEFAULT_PREFS.pillHidden,
      hiddenSurfaces: Array.isArray(raw.hiddenSurfaces) ? raw.hiddenSurfaces.filter((x): x is string => typeof x === "string").slice(0, 64) : [],
      fourFingerTap: typeof raw.fourFingerTap === "boolean" ? raw.fourFingerTap : DEFAULT_PREFS.fourFingerTap,
      soundMuted: typeof raw.soundMuted === "boolean" ? raw.soundMuted : DEFAULT_PREFS.soundMuted,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** The first version's `pillHidden` switch, applied to a surface that has a tray toggle (`toggled`: its ref): that surface is put away,
 *  and the old switch is cleared. Anything else, and a prefs with the old switch off, comes back as it was. No plugin is named: the
 *  surface that carries the Dispatch pill today is whichever one a tray toggle names. */
export function withLegacyHidden(prefs: AppPrefs, toggled: string): AppPrefs {
  if (!prefs.pillHidden) return prefs;
  return { ...prefs, pillHidden: false, hiddenSurfaces: [...new Set([...prefs.hiddenSurfaces, toggled])] };
}

export function writePrefs(file: string, prefs: AppPrefs, log: (line: string) => void = () => undefined): void {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    log(`prefs: not saved (${err instanceof Error ? err.message : String(err)})`);
  }
}
