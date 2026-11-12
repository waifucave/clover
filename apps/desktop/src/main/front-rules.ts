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

/** The plugin ids whose surface steps aside while the main window is in front. */
/** The Dispatch pill's plugin: the one surface the user can put away (tray item, four-finger tap). */
export const PILL_PLUGIN = "clover/pill";
export const STEPS_ASIDE = new Set(["clover/pill"]);

/** Whether a surface may be shown right now: what it asked for, unless it steps aside for the window in front. */
export function surfaceShown(pluginId: string, wantsVisible: boolean, main: MainWindowState, pillHidden = false): boolean {
  if (pillHidden && pluginId === PILL_PLUGIN) return false;
  return wantsVisible && !(STEPS_ASIDE.has(pluginId) && mainWindowFront(main));
}
