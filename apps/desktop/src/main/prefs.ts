// The app's own small choices that live on this computer and outlast a restart (not the daemon's settings: they are about
// this machine's windows). One JSON file in the app's data folder. A missing or damaged file reads as the defaults, and
// a write that fails is only logged: a choice that isn't kept is a nuisance, never a crash.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface AppPrefs {
  /** The Dispatch pill put away from the tray (or by the four-finger tap): it stays away until shown again. */
  pillHidden: boolean;
  /** The four-finger tap that toggles the pill (where the app has the helper for it). On unless turned off. */
  fourFingerTap: boolean;
}

export const DEFAULT_PREFS: AppPrefs = { pillHidden: false, fourFingerTap: true };

export function readPrefs(file: string): AppPrefs {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      pillHidden: typeof raw.pillHidden === "boolean" ? raw.pillHidden : DEFAULT_PREFS.pillHidden,
      fourFingerTap: typeof raw.fourFingerTap === "boolean" ? raw.fourFingerTap : DEFAULT_PREFS.fourFingerTap,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
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
