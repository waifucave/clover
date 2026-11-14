// Her room's size: her tab's width, the window's less the window's own sidebar beside it (Bots doesn't offer a bot the sidebar,
// so it is there on her tab as on every tab), in the same steps her layout's container queries take on the scene (tab/layout.css).
import type { ShellState } from "@waifucave/clover-plugin-sdk";

/** What the window's own sidebar takes beside her tab: the stock sidebar's width, and its rail's when folded, each with its rule. */
export const SIDEBAR_OPEN_PX = 248;
export const SIDEBAR_FOLDED_PX = 81;

/** Her tab's width: the window's, less the window's own sidebar beside it (open or folded, as the window says; open until it says). */
export function tabWidth(windowWidth: number, win: Pick<ShellState, "sidebar"> | undefined): number {
  return windowWidth - (win === undefined ? SIDEBAR_OPEN_PX : win.sidebar.collapsed ? SIDEBAR_FOLDED_PX : SIDEBAR_OPEN_PX);
}

/** Her room's size for her tab's width: the same steps as her layout's. */
export const roomSize = (tab: number): "narrow" | "mid" | "wide" => (tab <= 900 ? "narrow" : tab <= 1100 ? "mid" : "wide");
