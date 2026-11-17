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

/** Whether a surface stands down: any plugin's on-screen part but the tree's, while any card is pending on this computer,
 *  except the one that holds a pending card's sealed frames (`holdsCard`: the card's drawer, whoever's plugin fills the
 *  island's point; the controller's ruling). What this defends against is a second WINDOW over the buttons, which the sealed
 *  page's own reading cannot see; a part painting over frames inside its own surface is caught by that reading. The
 *  exemption is only against being hidden: the press's overlap check still reads every other window. */
export function overlayStandsDown(surface: { pluginId: string }, cardPending: boolean, holdsCard = false): boolean {
  return cardPending && surface.pluginId !== TREE_PLUGIN && !holdsCard;
}

/** Whether a surface is the island's drawer for a pending card it holds, and so not stood down (the controller's ruling; the
 *  reviewer's B1): it is the island drawer (`cards`: the plugin holds `approvals.all` and the surface declares `window.cards`),
 *  and it holds a sealed frame of a pending card the ROUTER placed on this program's island that it may draw now
 *  (`mayDraw`: `cardSurfaceMayDraw`). A part with plain `approvals` that minted frames of its own bot's card is no drawer: it
 *  stands down while any card is pending, its own included (that card is drawn where the router placed it). */
export function drawerExempt(surface: { cards: boolean }, heldCards: readonly string[], placedOnIsland: (cardId: string) => boolean, mayDraw: (cardId: string) => boolean): boolean {
  return surface.cards && heldCards.some((id) => placedOnIsland(id) && mayDraw(id));
}

/** The surfaces on the screen now as the engine keeps them: visible ones only, at most the protocol's 64. */
export function surfacesReport(wins: readonly { id: string; visible: boolean; bounds: { x: number; y: number; width: number; height: number } }[]): MossWindow[] {
  return wins.filter((w) => w.visible).slice(0, 64).map((w) => ({ id: w.id.slice(0, 128), x: w.bounds.x, y: w.bounds.y, width: Math.max(0, w.bounds.width), height: Math.max(0, w.bounds.height) }));
}
