// The engine's router (spec revision 19, §3.5 "The router and presence"; G2, ruling A, R1, item 119; contract
// `contracts/card-router.ts`). Lane RT. One live place per computer for each pending card, from the presence each window
// program's main process reports (`presence.report`):
//
// * The focused and visible window of the product draws every pending card: in its conversation when it shows the card's
//   session or bot, otherwise in its own strip, drawn by the core. A card with no session goes to that focused window's
//   strip too, whichever window asked for it (the controller's ruling 1 of 2026-11-17).
// * With no window focused, the island draws it while something draws the island (the background host; until lane HS
//   builds it, today's `code` window, which mounts the screen itself). With nothing, it is `elsewhere`: it waits for a
//   device or the CLI, and every device still shows it (item 91).
// * A report holds `PRESENCE_TTL_MS` or until its connection drops; a connection's new report replaces its last. Two
//   reports that both claim a focused window (one is stale by a beat): the newest report wins.
// * Any change places every pending card again, and `watch` hears each card that moved, with where it was.
// * After an engine restart there are no reports: cards go to the island until one arrives.
//
// Presence decides only WHERE a card is drawn, never who may answer: a press still needs the sealed frame's own checks
// (§5.5). `mayPress` follows the placement (`pressMatchesPlacement`): the island takes a press only for a card placed
// there, a window only for one placed in it. Its `from` is the server's, from the connection (`ipc/moss.ts`), never
// from what a call says.
import { PRESENCE_TTL_MS, pressMatchesPlacement, type CardPlacement, type PresenceReport, type PressPlace, type RoutedCard, type WindowPresence, type WindowProgram } from "@waifucave/moss-protocol";
import type { Clock, TimerHandle } from "../contracts/clock";
import { Listeners, type Unsubscribe } from "../contracts/common";
import type { CardRouter, PlacementChange } from "../contracts/card-router";

interface HeldReport {
  program: WindowProgram;
  report: PresenceReport;
  timer: TimerHandle;
  /** The order reports came in: the newest wins a tie between two focused windows. */
  seq: number;
}

const samePlace = (a: CardPlacement | undefined, b: CardPlacement): boolean => {
  if (a === undefined || a.kind !== b.kind) return false;
  if ((a.kind === "conversation" || a.kind === "strip") && (b.kind === "conversation" || b.kind === "strip")) return a.program === b.program && a.window === b.window;
  return true;
};

export class EngineCardRouter implements CardRouter {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #reports = new Map<number, HeldReport>();
  readonly #cards = new Map<string, { card: RoutedCard; place: CardPlacement }>();
  readonly #listeners = new Listeners<PlacementChange>();
  #host: boolean;
  #seq = 0;
  // lane HS: start. Whether a window of the product is focused and visible now: the host's island hides its strip line
  // then, as a window's own island does (the owner's ruling: the island only when MOSS isn't in front).
  readonly #fronts = new Listeners<boolean>();
  #front = false;
  // lane HS: end

  constructor(opts: { clock: Clock; ttlMs?: number; hostLive?: boolean }) {
    this.#clock = opts.clock;
    this.#ttlMs = opts.ttlMs ?? PRESENCE_TTL_MS;
    this.#host = opts.hostLive ?? true;
  }

  report(from: { connId: number; program: WindowProgram }, report: PresenceReport): { ttlMs: number } {
    const old = this.#reports.get(from.connId);
    if (old) this.#clock.clearTimeout(old.timer);
    const timer = this.#clock.setTimeout(() => this.dropped(from.connId), this.#ttlMs);
    this.#reports.set(from.connId, { program: from.program, report: structuredClone(report), timer, seq: ++this.#seq });
    this.#place();
    return { ttlMs: this.#ttlMs };
  }

  dropped(connId: number): void {
    const old = this.#reports.get(connId);
    if (!old) return;
    this.#clock.clearTimeout(old.timer);
    this.#reports.delete(connId);
    this.#place();
  }

  hostLive(live: boolean): void {
    if (this.#host === live) return;
    this.#host = live;
    this.#place();
  }

  /** The windows a connection's own live report names (the server's check that a press came from the window a card is
   *  placed in); empty without one. */
  windowsOf(connId: number): { program: WindowProgram; window: string; focused: boolean }[] {
    const r = this.#reports.get(connId);
    return r === undefined ? [] : r.report.windows.map((w) => ({ program: r.program, window: w.window, focused: w.focused && w.visible }));
  }

  /** The one focused and visible window of the product, if any: the newest report's, then its first such window. */
  #focused(): { program: WindowProgram; w: WindowPresence } | undefined {
    let found: { program: WindowProgram; w: WindowPresence; seq: number } | undefined;
    for (const r of this.#reports.values()) {
      if (found !== undefined && r.seq < found.seq) continue;
      const w = r.report.windows.find((x) => x.focused && x.visible);
      if (w !== undefined) found = { program: r.program, w, seq: r.seq };
    }
    return found;
  }

  #placeOf(card: RoutedCard): CardPlacement {
    const f = this.#focused();
    if (f) {
      const s = f.w.showing;
      const shows = s !== null && ((s.kind === "session" && card.session !== undefined && s.id === card.session) || (s.kind === "bot" && card.bot !== undefined && s.id === card.bot));
      return { kind: shows ? "conversation" : "strip", program: f.program, window: f.w.window };
    }
    return this.#host ? { kind: "island" } : { kind: "elsewhere" };
  }

  #place(): void {
    for (const [id, held] of this.#cards) {
      const place = this.#placeOf(held.card);
      if (samePlace(held.place, place)) continue;
      const before = held.place;
      held.place = place;
      this.#listeners.emit({ card: id, place: { ...place }, before: { ...before } });
    }
    // lane HS: start. After the cards' moves, so a card placed in the window is heard before the island is told the window is in front.
    const front = this.#focused() !== undefined;
    if (front !== this.#front) { this.#front = front; this.#fronts.emit(front); }
    // lane HS: end
  }

  // lane HS: start
  /** Whether a window of the product is focused and visible now (by the same reports that place the cards). */
  front(): boolean {
    return this.#front;
  }

  /** Hears each change of `front()`. */
  watchFront(fn: (front: boolean) => void): Unsubscribe {
    return this.#fronts.add(fn);
  }
  // lane HS: end

  pending(card: RoutedCard): CardPlacement {
    const known = this.#cards.get(card.id);
    if (known !== undefined) return { ...known.place };
    const place = this.#placeOf(card);
    this.#cards.set(card.id, { card: { ...card }, place });
    this.#listeners.emit({ card: card.id, place: { ...place } });
    return { ...place };
  }

  resolved(id: string): void {
    this.#cards.delete(id);
  }

  placementOf(id: string): CardPlacement | undefined {
    const p = this.#cards.get(id)?.place;
    return p === undefined ? undefined : { ...p };
  }

  list(): { card: string; place: CardPlacement }[] {
    return [...this.#cards].map(([card, h]) => ({ card, place: { ...h.place } }));
  }

  mayPress(id: string, from: PressPlace): boolean {
    const place = this.#cards.get(id)?.place;
    if (place === undefined) return false;
    // lane HS (the reviewer's B2, never nowhere): a card placed `elsewhere` (nothing draws the island: no host, or one the
    // engine gave up on) is shown on MOSS Code's window's own fallback card, the one place left on this computer, so a press
    // from that window is taken. MOSS draws no such card (it waits for MOSS to come forward), and the sealed frame's own
    // press checks still judge the press.
    if (place.kind === "elsewhere" && from.kind === "window" && from.program === "code") return true;
    return pressMatchesPlacement(place, from);
  }

  watch(fn: (change: PlacementChange) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}
