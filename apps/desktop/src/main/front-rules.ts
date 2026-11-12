// Which surfaces stand aside while Clover's own window is the one in front. The pill is a second place to type to a bot; with
// the window's composer in front it only covers the window's own composer and picker, so it steps aside and comes back
// when the window is closed, hidden, minimised, or another app is in front. The island stays: it is where cards and
// status show. Pure, so each transition is tested; the main process feeds it the window's state on every focus, blur,
// show, hide, minimise, restore and close.

export interface MainWindowState {
  /** The window exists (not closed). */
  exists: boolean;
  visible: boolean;
  minimized: boolean;
  /** The window has the keyboard focus, which another app being in front takes away. */
  focused: boolean;
}

/** Clover's main window is the frontmost window: focused, visible and not minimised. */
export function mainWindowFront(s: MainWindowState): boolean {
  return s.exists && s.visible && !s.minimized && s.focused;
}

/** The Dispatch pill's plugin: the one surface the user can put away or summon (tray item, four-finger tap). */
export const PILL_PLUGIN = "clover/pill";
/** The plugin ids whose surface steps aside while the main window is in front. */
export const STEPS_ASIDE = new Set(["clover/pill"]);

/** What the user has done to the pill. `auto`: it shows when its part asks and steps aside for the window in front. `hidden`:
 *  put away (kept across restarts). `summoned`: brought up by a four-finger tap, over Clover's own window too, until the next
 *  tap (not kept: a restart is `auto` again). */
export type PillMode = "auto" | "hidden" | "summoned";

/** Whether a surface may be shown right now: what it asked for, unless it steps aside for the window in front (the pill does
 *  not step aside once summoned) or the user put the pill away. */
export function surfaceShown(pluginId: string, wantsVisible: boolean, main: MainWindowState, pill: PillMode = "auto"): boolean {
  if (pluginId === PILL_PLUGIN) {
    if (pill === "hidden") return false;
    if (pill === "summoned") return wantsVisible;
  }
  return wantsVisible && !(STEPS_ASIDE.has(pluginId) && mainWindowFront(main));
}

/** A four-finger tap toggles what the person sees: a pill on screen is put away, one that is not (put away, or stepped aside
 *  for the window in front) is summoned. */
export function pillAfterTap(mode: PillMode, wantsVisible: boolean, main: MainWindowState): PillMode {
  return surfaceShown(PILL_PLUGIN, wantsVisible, main, mode) ? "hidden" : "summoned";
}

/** The tray item: Hide while the pill is not put away, Show while it is. Show gives the pill back its usual behaviour (it still
 *  steps aside for the window in front); a tap is what summons it over the window. */
export function pillAfterTray(mode: PillMode): PillMode {
  return mode === "hidden" ? "auto" : "hidden";
}

/** Whether the app has a Dock icon (macOS "regular") rather than being an accessory: only while an ordinary window shows. The
 *  floating surfaces (island, pill) don't count: with only them up the app stays an accessory, so a press on one never makes
 *  Clover the active app and they can stand over another app's full-screen Space. */
export function appIsRegular(windows: readonly { visible: boolean; surface: boolean }[]): boolean {
  return windows.some((w) => w.visible && !w.surface);
}
