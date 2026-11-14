// Her tab's geometry, shared by her room and her controls (two frames of her plugin) so they never drift apart: her tab's width
// (the window's less the window's own sidebar beside it: Bots doesn't offer a bot the sidebar, so it is there on her tab as on
// every tab), her room's size in the same steps her layout's container queries take on the scene (tab/layout.css), and where
// her controls start (clear of the window's own buttons when they reach into her tab).

/** What her geometry reads of the window's state (`shell.state()`, the SDK's `ShellState`; spelled out here so her tab's tests need no SDK). */
export interface WindowSides {
  readonly sidebar: { readonly collapsed: boolean; readonly width?: number };
  readonly safeArea: { readonly left: number };
}

/** What the window's own sidebar takes beside her tab until the window says its measured width: the stock sidebar's width,
 *  and its rail's when folded, each with its rule. */
export const SIDEBAR_OPEN_PX = 248;
export const SIDEBAR_FOLDED_PX = 81;

/** The sidebar's width beside her tab: the window's measured one, else the stock one for its fold (open until it says). */
export function sidebarWidth(win: Pick<WindowSides, "sidebar"> | undefined): number {
  if (win?.sidebar.width !== undefined) return win.sidebar.width;
  return win !== undefined && win.sidebar.collapsed ? SIDEBAR_FOLDED_PX : SIDEBAR_OPEN_PX;
}

/** Her tab's width: the window's, less the window's own sidebar beside it. */
export function tabWidth(windowWidth: number, win: Pick<WindowSides, "sidebar"> | undefined): number {
  return windowWidth - sidebarWidth(win);
}

/** Her room's steps, the same as her layout's container queries on the scene: a tab of 1000 px or more is her wide room
 *  (the window the app opens, 1280 with the sidebar open, is one), 800 or less her narrow band, mid between. */
export const WIDE_MIN_PX = 1000;
export const NARROW_MAX_PX = 800;
export const roomSize = (tab: number): "narrow" | "mid" | "wide" => (tab <= NARROW_MAX_PX ? "narrow" : tab < WIDE_MIN_PX ? "mid" : "wide");

/** Her own margin at her tab's left edge. */
export const EDGE_PX = 16;

/** How far the window's own buttons reach into her tab from its left edge: `safeArea.left` (window coordinates) less the
 *  sidebar beside her tab. None when the sidebar, open or folded to its rail, already lies under them (macOS's stock one
 *  always does), and none on a system that draws them at the other end. */
export function safeLeft(win: WindowSides | undefined): number {
  return win === undefined ? 0 : Math.max(0, win.safeArea.left - sidebarWidth(win));
}

/** Where her controls start from her tab's left edge (her sidebar toggle first), and so where her room's compact title
 *  lines up beside it. */
export const controlsInset = (win: WindowSides | undefined): number => EDGE_PX + safeLeft(win);

/** Her sidebar toggle's width and the gap after it: her compact title starts this far past `controlsInset`. */
export const TOGGLE_PX = 38;
export const TOGGLE_GAP_PX = 14;
