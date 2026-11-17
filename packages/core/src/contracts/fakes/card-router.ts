// FakeCardRouter: the placement rules of ruling A over a clock, so a test drives a report's expiry with `advance`.
import { PRESENCE_TTL_MS, pressMatchesPlacement, type CardPlacement, type PresenceReport, type PressPlace, type RoutedCard, type WindowPresence, type WindowProgram } from "@waifucave/moss-protocol";
import type { Clock, TimerHandle } from "../clock";
import { Listeners, type Unsubscribe } from "../common";
import type { CardRouter, PlacementChange } from "../card-router";

interface HeldReport {
  program: WindowProgram;
  report: PresenceReport;
  timer: TimerHandle;
  /** The order reports came in: the newest wins a tie. */
  seq: number;
}

const same = (a: CardPlacement | undefined, b: CardPlacement): boolean => JSON.stringify(a) === JSON.stringify(b);

export class FakeCardRouter implements CardRouter {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #reports = new Map<number, HeldReport>();
  readonly #cards = new Map<string, { card: RoutedCard; place: CardPlacement }>();
  readonly #listeners = new Listeners<PlacementChange>();
  #host = true;
  #seq = 0;

  constructor(opts: { clock: Clock; ttlMs?: number; hostLive?: boolean }) {
    this.#clock = opts.clock;
    this.#ttlMs = opts.ttlMs ?? PRESENCE_TTL_MS;
    this.#host = opts.hostLive ?? true;
  }

  report(from: { connId: number; program: WindowProgram }, report: PresenceReport): { ttlMs: number } {
    const old = this.#reports.get(from.connId);
    if (old) this.#clock.clearTimeout(old.timer);
    const timer = this.#clock.setTimeout(() => this.dropped(from.connId), this.#ttlMs);
    this.#reports.set(from.connId, { program: from.program, report, timer, seq: ++this.#seq });
    this.#replace();
    return { ttlMs: this.#ttlMs };
  }

  dropped(connId: number): void {
    const old = this.#reports.get(connId);
    if (!old) return;
    this.#clock.clearTimeout(old.timer);
    this.#reports.delete(connId);
    this.#replace();
  }

  hostLive(live: boolean): void {
    this.#host = live;
    this.#replace();
  }

  /** The one focused and visible window of the product, if any (the latest report wins a tie: a `Map` keeps a key's first
   *  place, so the order is the reports' own sequence number). A card with no session goes to it too, never to the window
   *  that asked (`askedFrom` is not read: the controller's ruling 1). */
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

  #replace(): void {
    for (const [id, held] of this.#cards) {
      const place = this.#placeOf(held.card);
      if (same(held.place, place)) continue;
      const before = held.place;
      held.place = place;
      this.#listeners.emit({ card: id, place, before });
    }
  }

  pending(card: RoutedCard): CardPlacement {
    const place = this.#placeOf(card);
    this.#cards.set(card.id, { card, place });
    this.#listeners.emit({ card: card.id, place });
    return place;
  }

  resolved(id: string): void {
    this.#cards.delete(id);
  }

  placementOf(id: string): CardPlacement | undefined {
    return this.#cards.get(id)?.place;
  }

  list(): { card: string; place: CardPlacement }[] {
    return [...this.#cards].map(([card, h]) => ({ card, place: h.place }));
  }

  mayPress(id: string, from: PressPlace): boolean {
    const place = this.#cards.get(id)?.place;
    // As the engine's (lane HS, B2): an `elsewhere` card takes MOSS Code's window's press (its fallback card's place).
    if (place?.kind === "elsewhere" && from.kind === "window" && from.program === "code") return true;
    return place !== undefined && pressMatchesPlacement(place, from);
  }

  watch(fn: (change: PlacementChange) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}
