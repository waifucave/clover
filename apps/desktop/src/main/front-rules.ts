// Spec revision 19 (§3.5, ruling A; lane RT): a surface steps aside only for a FOCUSED window of the product (the presence
// this program reports to the engine: a window that is visible but not focused moves nothing), and never while the router
// has placed a card on it (`holdsPlacedCard`). The surfaces move to the background host with lane HS.
// Which surfaces stand aside while MOSS's own window is the one in front, by what each surface's manifest says (`window.front`).
// The Dispatch pill is a second place to type to a bot; with the window's composer in front it only covers the window's own
// composer and picker, so it says `steps-aside` and comes back when the window is closed, hidden, minimised, or another app is in
// front. The island stays: it is where cards and status show. Pure, so each transition is tested; the main process feeds it
// the window's state on every focus, blur, show, hide, minimise, restore and close.

export interface MainWindowState {
  /** The window exists (not closed). */
  exists: boolean;
  visible: boolean;
  minimized: boolean;
  /** The window has the keyboard focus, which another app being in front takes away. */
  focused: boolean;
}

/** MOSS's main window is the frontmost window: focused, visible and not minimised. */
export function mainWindowFront(s: MainWindowState): boolean {
  return s.exists && s.visible && !s.minimized && s.focused;
}

/** What the user has done to a surface that can be put away (a tray item that toggles it, a tap that summons it). `auto`: it
 *  shows when its part asks, and steps aside for the window in front if its manifest says `front: "steps-aside"`. `hidden`:
 *  put away (kept across restarts). `summoned`: brought up by a four-finger tap, over MOSS's own window too, until the next
 *  tap (not kept: a restart is `auto` again). */
export type PutAway = "auto" | "hidden" | "summoned";

/** What a surface's manifest says about the main window in front (`window.front`). */
export interface FrontRule {
  /** `front: "steps-aside"`: the surface leaves the screen while the main window is in front. */
  stepsAside: boolean;
  /** The router has placed a pending card on this surface (one that draws cards, `window.cards`): it stays. */
  holdsPlacedCard?: boolean;
}

/** Whether a surface may be shown right now: what it asked for, unless it steps aside for the window in front (it does not once
 *  summoned) or the user put it away. Nothing here names a plugin: a surface says what it does in its manifest. */
export function surfaceShown(rule: FrontRule, wantsVisible: boolean, main: MainWindowState, mode: PutAway = "auto"): boolean {
  if (mode === "hidden") return false;
  if (mode === "summoned") return wantsVisible;
  return wantsVisible && !(rule.stepsAside && rule.holdsPlacedCard !== true && mainWindowFront(main));
}

/** A four-finger tap toggles what the person sees: a surface on screen is put away, one that is not (put away, or stepped aside
 *  for the window in front) is summoned. */
export function afterTap(mode: PutAway, rule: FrontRule, wantsVisible: boolean, main: MainWindowState): PutAway {
  return surfaceShown(rule, wantsVisible, main, mode) ? "hidden" : "summoned";
}

/** The tray item: Hide while the surface is not put away, Show while it is. Show gives the surface back its usual behaviour (it
 *  still steps aside for the window in front if it does); a tap is what summons it over the window. */
export function afterTray(mode: PutAway): PutAway {
  return mode === "hidden" ? "auto" : "hidden";
}

/** Whether the app has a Dock icon (macOS "regular") rather than being an accessory: only while an ordinary window shows. The
 *  floating surfaces (island, pill) don't count: with only them up the app stays an accessory, so a press on one never makes
 *  MOSS the active app and they can stand over another app's full-screen Space. */
export function appIsRegular(windows: readonly { visible: boolean; surface: boolean }[]): boolean {
  return windows.some((w) => w.visible && !w.surface);
}
