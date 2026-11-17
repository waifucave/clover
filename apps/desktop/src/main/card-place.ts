// Where a pending card is drawn in this program (MOSS Code's window process, which draws the island too until lane HS moves
// it to the background host), one place at a time, by the ENGINE's router (spec revision 19, §3.5, ruling A, R1; lane RT):
// this main process reports its window's presence (`presence.report`: focused or not, which session or bot it shows) and
// follows the placement the engine sends back (`card_placed`, `card.placement`). The engine's place maps to this window's:
//   conversation  the window shows the card's session or bot: its conversation draws it in place;
//   strip         the window is focused and shows something else (or the card has no session): the window's own strip,
//                 drawn by the core (the app's own card page, docked inside the window), unless the conversation on screen
//                 already draws it;
//   island        no window of the product is focused: the island draws it; `elsewhere` cannot happen while this program
//                 draws the island, and is drawn there too, so a card is never left where nobody sees it.
// Until the engine has placed a card (an engine before lane RT's, or the beat before its first `card_placed`), the old
// window-local rule stands in (the owner's ruling, 2026-11-13: the island shows cards only while the window is not in front).
// The press gate follows the placement (`pressMatchesPlacement`), never window focus. Pure, so each placement and each move
// is tested; index.ts feeds it the engine's placement, the window's state and which cards its own frames asked for.
import { pressMatchesPlacement, type CardPlacement, type PresenceReport, type Showing } from "@waifucave/moss-protocol";

/** This program's one window, as it names itself to the router. */
export const MAIN_WINDOW = "main";

/** Where this program draws a card: its conversation, the window's own strip (`window`), or the island. */
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

/** The place for a card by the engine's placement (`placed`), or by the window-local rule while the engine has placed none. */
export function placeFromEngine(placed: CardPlacement | undefined, input: { front: boolean; drawnInWindow: boolean }): CardPlace {
  if (placed === undefined) return placeCard(input);
  if (placed.kind === "conversation") return "conversation";
  if (placed.kind === "strip") return input.drawnInWindow ? "conversation" : "window";
  return "island";
}

/** Whether a surface of the island may place a card's frames right now: only for a card the engine placed on the island (or,
 *  while it has placed none, while the window is not in front). */
export function islandMayDraw(placed: CardPlacement | undefined, front: boolean): boolean {
  if (placed === undefined) return !front;
  return placed.kind === "island" || placed.kind === "elsewhere";
}

/** Where a press came from in this program: the island's frame, the window (its conversation or its strip), or the app's own
 *  fallback card, the 2-second safety net shown when no surface put the buttons up (it answers wherever the card is placed:
 *  it is the one place left that shows it). */
export type PressSource = "island" | "window" | "fallback";

/** Whether a press is taken, by the engine's placement (`pressMatchesPlacement`): the island only for a card placed there, the
 *  window only for one placed in it. While the engine has placed none, the window-local rule: no island press while the
 *  window is in front. The sealed page's own gates (and the engine's own placement check at `card.answer`) still judge it. */
export function pressMayBeTaken(input: { from: PressSource; placed: CardPlacement | undefined; front: boolean }): boolean {
  if (input.from === "fallback") return true;
  if (input.placed === undefined) return !(input.from === "island" && input.front);
  const placed: CardPlacement = input.placed.kind === "elsewhere" ? { kind: "island" } : input.placed;
  return pressMatchesPlacement(placed, input.from === "island" ? { kind: "island" } : { kind: "window", program: "code", window: MAIN_WINDOW });
}

/** What the window shows that a card can belong to, from the shell's state: a bot's tab, or a coding session's or an agent's
 *  (`agent`, its id the session's). Settings over the tab, or any other page, shows none. */
export function showingOf(state: { tab: { kind: string; id?: string }; dialog?: string } | undefined): Showing | null {
  if (state === undefined || state.dialog === "settings" || state.tab.id === undefined || state.tab.id === "") return null;
  if (state.tab.kind === "bot") return { kind: "bot", id: state.tab.id };
  if (state.tab.kind === "agent") return { kind: "session", id: state.tab.id };
  return null;
}

/** This program's presence: its one window, focused (in front, its own card windows counting) or not, visible, and what it
 *  shows. No window: no window in the report. */
export function presenceOf(main: { exists: boolean; visible: boolean; minimized: boolean; front: boolean }, showing: Showing | null): PresenceReport {
  if (!main.exists) return { windows: [] };
  return { windows: [{ window: MAIN_WINDOW, focused: main.front, visible: main.visible && !main.minimized, showing }] };
}

/** What the front rules read of a window (Electron's BrowserWindow answers all four). */
export interface WatchedWindow { isDestroyed(): boolean; isFocused(): boolean; isVisible(): boolean; isMinimized(): boolean }

/** Whether MOSS is in front: its main window is up and not minimised, and the main window OR one of the app's own card windows
 *  has the focus. A card window is a window of its own, so a click on it blurs the main window: that is MOSS still in front. */
export function mossFront(main: WatchedWindow | undefined, cardWindows: Iterable<WatchedWindow | undefined>): { exists: boolean; visible: boolean; minimized: boolean; focused: boolean } {
  if (main === undefined || main.isDestroyed()) return { exists: false, visible: false, minimized: false, focused: false };
  let focused = main.isFocused();
  for (const w of cardWindows) if (w !== undefined && !w.isDestroyed() && w.isFocused()) focused = true;
  return { exists: true, visible: main.isVisible(), minimized: main.isMinimized(), focused };
}

/** The front state as the placement sees it. Going to the front is acted on at once; going out of it only once it has held for a
 *  beat (`settleMs`), because moving between two of MOSS's own windows is seen for an instant with neither focused. */
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

/** What a report's send came to: sent (the core answered), not served (an engine before lane RT's), or failed. */
export type PresenceSent = "sent" | "unserved" | "failed";

/** This program's presence reports (lane RT, §3.5), the part index.ts can't test: what is sent is the front watcher's SETTLED
 *  focus (a click between MOSS's own windows shows neither focused for an instant; reporting that would move the card from
 *  under the pointer), and a press waits for the placement it is made in. The core writes `card_placed` before its answer to
 *  `presence.report` on the same connection, so once a report's send resolves, every move it caused has been handled.
 *  `beforePress`: a focus change not reported yet is reported now (going to the front counts at once, as the watcher's does),
 *  and a report on its way is waited for. */
export class PresenceReporter {
  #settled = false;
  #lastFocused: boolean | undefined;
  #lastShowing = "null";
  #inFlight: Promise<void> | undefined;
  #unserved = false;

  constructor(private readonly o: {
    /** The window now: whether it exists, is visible, is minimised, and is in front this instant (unsettled). */
    read: () => { exists: boolean; visible: boolean; minimized: boolean; front: boolean };
    showing: () => Showing | null;
    send: (report: PresenceReport) => Promise<PresenceSent>;
    log?: (line: string) => void;
  }) {}

  /** The front watcher settled on `front`. */
  settled(front: boolean): void {
    this.#settled = front;
  }

  /** Whether what the window shows changed since the last report. */
  showingChanged(showing: Showing | null): boolean {
    return JSON.stringify(showing) !== this.#lastShowing;
  }

  /** A new connection: an earlier engine's "not served" no longer holds. */
  reconnected(): void {
    this.#unserved = false;
    this.#lastFocused = undefined;
  }

  report(): Promise<void> {
    const p = this.#send();
    this.#inFlight = p;
    void p.finally(() => { if (this.#inFlight === p) this.#inFlight = undefined; });
    return p;
  }

  async #send(): Promise<void> {
    if (this.#unserved) return;
    const st = this.o.read();
    const showing = st.exists ? this.o.showing() : null;
    const focused = this.#settled;
    const said = `${focused ? "focused" : "not focused"}, showing ${showing === null ? "nothing" : showing.kind}`;
    this.o.log?.(`presence: the window ${st.exists ? said : "closed"}`);
    this.#lastShowing = JSON.stringify(showing);
    this.#lastFocused = focused;
    const r = await this.o.send(presenceOf({ exists: st.exists, visible: st.visible, minimized: st.minimized, front: focused }, showing));
    if (r === "unserved") this.#unserved = true;
    if (r === "failed") this.#lastFocused = undefined;
  }

  async beforePress(): Promise<void> {
    if (this.o.read().front && !this.#settled) this.#settled = true;
    if (this.#lastFocused !== this.#settled) await this.report();
    else if (this.#inFlight !== undefined) await this.#inFlight.catch(() => undefined);
  }
}

/** The areas the app's own connection hears: the registry's, the app's, the cards' (`card_requested`, `card_resolved`) and
 *  where the engine's router places each card (`card_placed`, lane RT), and the release channel's. */
export const APP_EVENT_AREAS: readonly string[] = ["plugins", "app", "approvals", "surfaces", "release"];

/** On each connection: the cards' events subscribed FIRST, then the cards already waiting listed, each handed to
 *  `waiting`. A connection's calls are answered in order and `card.list` waits for the engine's late doors (its parts):
 *  listed first, the subscription sat behind it, and a card raised the moment the parts came up (the one-time copy's
 *  offer, raised at once on a fresh home) fell between the list's answer and the subscription, told to no connection.
 *  Subscribed first, a card raised after the subscription is told as `card_requested`, and one raised before the list's
 *  answer is in the list (a card in both is the caller's to take once). */
export async function subscribeThenListCards(client: { request<T>(method: string, params?: unknown): Promise<T> }, waiting: (card: unknown) => void): Promise<string[] | undefined> {
  await client.request("events.subscribe", { areas: [...APP_EVENT_AREAS] }).catch(() => undefined);
  const listed = await client.request<unknown>("card.list").catch(() => undefined);
  const cards = (listed as { cards?: unknown[] } | undefined)?.cards;
  for (const c of cards ?? []) waiting(c);
  // lane HS (the reviewer's S): the ids the engine still holds, for the caller to drop what it no longer does; none when the
  // list wasn't read (nothing is dropped on a failed read).
  return Array.isArray(cards) ? cards.map((c) => String((c as { id?: unknown } | null)?.id ?? "")).filter((id) => id !== "") : undefined;
}

/** The engine's placements as this program heard them (lane RT, §3.5): the last word on each card wins. A `card_placed` event
 *  always applies (the core sends one for every move after the program subscribed, in the order it made them); a
 *  `card.placement` snapshot only fills in a card no event has placed on this connection, because its answer can come after
 *  a newer event (the CI lane's plugin-app step 65: the card moved to the window's strip, a snapshot asked a moment before
 *  came back with the island 56 ms later and put the card there, the router saw no change to send, and the card sat with no
 *  surface drawing it). A new connection starts the book afresh. */
export class PlacementBook {
  readonly #places = new Map<string, CardPlacement>();
  #connection: unknown;

  /** The connection the book follows: a new one forgets what the last one said. */
  follow(connection: unknown): void {
    if (connection === this.#connection) return;
    this.#connection = connection;
    this.#places.clear();
  }

  /** A `card_placed` event: it wins. Returns whether the place changed. */
  placed(card: string, place: CardPlacement): boolean {
    const was = this.#places.get(card);
    this.#places.delete(card);
    this.#places.set(card, place);
    if (this.#places.size > 256) this.#places.delete(this.#places.keys().next().value!);
    return was === undefined || JSON.stringify(was) !== JSON.stringify(place);
  }

  /** A `card.placement` answer: only the cards no event has placed. Returns those it placed. */
  snapshot(placements: readonly { card: string; place: CardPlacement }[]): string[] {
    const took: string[] = [];
    for (const p of placements) if (!this.#places.has(p.card) && this.placed(p.card, p.place)) took.push(p.card);
    return took;
  }

  get(card: string): CardPlacement | undefined {
    return this.#places.get(card);
  }

  delete(card: string): void {
    this.#places.delete(card);
  }

  entries(): IterableIterator<[string, CardPlacement]> {
    return this.#places.entries();
  }
}
