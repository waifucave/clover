// Where a pending permission card is drawn, one place at a time (the owner's ruling, 2026-11-13: "island should only show when
// the app window is not foreground"). While Clover's main window is in front the island shows none, and the window draws the
// card: in the conversation on screen when that conversation draws it, else in the app's own card. While it is not in front the
// island draws it. Pure, so each placement and each move is tested; index.ts feeds it the window's state and which cards the
// main window's own frames asked for.

export type CardPlace = "conversation" | "window" | "island";

/** The place for a card now. `drawnInWindow`: a part of the main window (its conversation) has asked for the card's frames, so
 *  it is drawn there in place; a card no part of the window draws (a plugin OK from the Plugins page or the CLI, the card of a
 *  conversation that isn't the one on screen) is the app's own card. */
export function placeCard(input: { front: boolean; drawnInWindow: boolean }): CardPlace {
  if (!input.front) return "island";
  return input.drawnInWindow ? "conversation" : "window";
}

const WHY: Record<CardPlace, string> = {
  conversation: "shown in the conversation (window foreground)",
  window: "shown in the window's own card (window foreground, no conversation draws it)",
  island: "shown on the island (window not foreground)",
};

/** The one log line for a card's place: where it went and why, or where it moved from and to. Ids and words of the app only. */
export function placeLine(cardId: string, now: CardPlace, before?: CardPlace): string {
  return before === undefined ? `card: ${cardId} ${WHY[now]}` : `card: ${cardId} moved to ${now === "island" ? "the island (window not foreground)" : now === "conversation" ? "the conversation (window foreground)" : "the window's own card (window foreground)"} from ${before === "island" ? "the island" : before === "conversation" ? "the conversation" : "the window's own card"}`;
}

/** Whether a surface of the island may place a card's frames or take a press right now: never while the window is in front. */
export function islandMayDraw(front: boolean): boolean {
  return !front;
}
