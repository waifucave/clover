// R12's host half (spec revision 19, §5.5 "A click counts only while no other window overlaps the button"; lane HS):
// while a card is pending in the program that draws it (the island holding it, or its own card shown), a plugin's
// overlay (a floating surface of any plugin but the bundled tree's own, which may be always on top too) is hidden, so
// nothing a plugin draws can sit over a sealed button; it comes back when no card is pending there. And the program
// that draws the screen's surfaces tells the engine where they are (`host.surfaces`), for the product's own-windows list.
// Pure: no Electron import (test/host-stacking.test.ts).
import type { MossWindow } from "@waifucave/moss-protocol";

/** The bundled tree's plugin: its surfaces (the island, the pill, the voice player) are the sealed windows' own. */
export const TREE_PLUGIN = "moss";

/** Whether a surface stands down while a card is pending in this program: a plugin's overlay, never the tree's. */
export function overlayStandsDown(surface: { pluginId: string; floats: boolean }, cardShownHere: boolean): boolean {
  return cardShownHere && surface.floats && surface.pluginId !== TREE_PLUGIN;
}

/** The surfaces on the screen now as the engine keeps them: visible ones only, at most the protocol's 64. */
export function surfacesReport(wins: readonly { id: string; visible: boolean; bounds: { x: number; y: number; width: number; height: number } }[]): MossWindow[] {
  return wins.filter((w) => w.visible).slice(0, 64).map((w) => ({ id: w.id.slice(0, 128), x: w.bounds.x, y: w.bounds.y, width: Math.max(0, w.bounds.width), height: Math.max(0, w.bounds.height) }));
}
