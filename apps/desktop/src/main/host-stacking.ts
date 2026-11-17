// R12's host half (spec revision 19, §5.5 "A click counts only while no other window overlaps the button"; lane HS): THE
// one rule for third-party on-screen parts. While any card is pending on this computer (whichever program draws it: MOSS's
// window, MOSS Code's, or the host's island), every on-screen part of a plugin but the bundled tree's own is hidden, so
// nothing a plugin paints can sit over a sealed button, whatever click region it declares (the overlap check reads
// windows, not what a click-through part paints); it comes back when no card is pending. The program that draws the
// screen's surfaces (the host; MOSS Code's window while no host runs) holds them, so this is the one place it is decided.
// And that program tells the engine where its surfaces are (`host.surfaces`), for the product's own-windows list.
// Pure: no Electron import (test/host-stacking.test.ts).
import type { MossWindow } from "@waifucave/moss-protocol";

/** The bundled tree's plugin: its surfaces (the island, the pill, the voice player) are the sealed windows' own. */
export const TREE_PLUGIN = "moss";

/** Whether a surface stands down: any plugin's on-screen part but the tree's, while any card is pending on this computer. */
export function overlayStandsDown(surface: { pluginId: string }, cardPending: boolean): boolean {
  return cardPending && surface.pluginId !== TREE_PLUGIN;
}

/** The surfaces on the screen now as the engine keeps them: visible ones only, at most the protocol's 64. */
export function surfacesReport(wins: readonly { id: string; visible: boolean; bounds: { x: number; y: number; width: number; height: number } }[]): MossWindow[] {
  return wins.filter((w) => w.visible).slice(0, 64).map((w) => ({ id: w.id.slice(0, 128), x: w.bounds.x, y: w.bounds.y, width: Math.max(0, w.bounds.width), height: Math.max(0, w.bounds.height) }));
}
