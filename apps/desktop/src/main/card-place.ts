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

/** Whether a press is taken: a press from the island's frame is not while Clover is in front; a press from anywhere else (the
 *  app's own card, a conversation's frame) is taken by the sealed page's own gates alone. */
export function pressMayBeTaken(input: { fromIsland: boolean; front: boolean }): boolean {
  return !(input.fromIsland && input.front);
}

/** What the front rules read of a window (Electron's BrowserWindow answers all four). */
export interface WatchedWindow { isDestroyed(): boolean; isFocused(): boolean; isVisible(): boolean; isMinimized(): boolean }

/** Whether Clover is in front: its main window is up and not minimised, and the main window OR one of the app's own card windows
 *  has the focus. A card window is a window of its own, so a click on it blurs the main window: that is Clover still in front. */
export function cloverFront(main: WatchedWindow | undefined, cardWindows: Iterable<WatchedWindow | undefined>): { exists: boolean; visible: boolean; minimized: boolean; focused: boolean } {
  if (main === undefined || main.isDestroyed()) return { exists: false, visible: false, minimized: false, focused: false };
  let focused = main.isFocused();
  for (const w of cardWindows) if (w !== undefined && !w.isDestroyed() && w.isFocused()) focused = true;
  return { exists: true, visible: main.isVisible(), minimized: main.isMinimized(), focused };
}

/** The front state as the placement sees it. Going to the front is acted on at once; going out of it only once it has held for a
 *  beat (`settleMs`), because moving between two of Clover's own windows is seen for an instant with neither focused. */
export class FrontWatcher {
  #last = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly o: { read: () => boolean; changed: (front: boolean) => void; settleMs: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }) {}
  /** Any focus, blur, show, hide or close of the windows that count. */
  event(): void {
    const now = this.o.read();
    if (now === this.#last) { this.#cancel(); return; }
    if (now) { this.#cancel(); this.#last = true; this.o.changed(true); return; }
    if (this.#timer !== undefined) return;
    this.#timer = (this.o.setTimer ?? setTimeout)(() => {
      this.#timer = undefined;
      if (this.o.read() || !this.#last) return;
      this.#last = false;
      this.o.changed(false);
    }, this.o.settleMs);
  }
  #cancel(): void {
    if (this.#timer !== undefined) (this.o.clearTimer ?? clearTimeout)(this.#timer);
    this.#timer = undefined;
  }
}
