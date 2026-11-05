// What is on top, born from the housing — ported from the Swift reference's `IslandQueue`. Pure state with an
// injected clock (seconds); the island schedules ONE wake-up at `nextDeadline`, none while nothing is due.
//
//   - Cards do not stack: a new card REPLACES the current one, which compacts (the strip's waiting count
//     and Needs you).
//   - …unless the current one is HOVERED or typed into (or counts down by itself): the newcomer waits as
//     a small pill just below it, and expands when the current one clears or compacts, or when the user
//     CLICKS it — which tucks the current one away.
//   - Cards that self-compact do so after `selfCompactAfter` when not hovered, and stay pending until
//     answered anywhere (`resolve`).
//   - A card that counts down by itself (its deadline is its answer) is never compacted: nothing would
//     draw it while it runs. A second one waits its turn (`inLine`, oldest first).

export interface QueueEntry {
  readonly id: string;
  readonly selfCompacts: boolean;
  /** When it compacts by itself; null: never. */
  compactAt: number | null;
}

export class IslandQueue {
  static readonly selfCompactAfter = 6;
  static readonly hoverLeaveGrace = 1.5;

  current: QueueEntry | null = null;
  waiting: QueueEntry | null = null;
  /** Compacted cards, oldest first. Never one that counts down by itself. */
  compacted: QueueEntry[] = [];
  /** Cards that count down by themselves, behind the one on top and the one waiting. */
  inLine: QueueEntry[] = [];
  currentHovered = false;
  currentTyping = false;

  get currentHeld(): boolean {
    return this.currentHovered || this.currentTyping;
  }

  get isEmpty(): boolean {
    return !this.current && !this.waiting && this.compacted.length === 0 && this.inLine.length === 0;
  }

  get ids(): Set<string> {
    const out = new Set([...this.compacted.map((e) => e.id), ...this.inLine.map((e) => e.id)]);
    if (this.current) out.add(this.current.id);
    if (this.waiting) out.add(this.waiting.id);
    return out;
  }

  /** When the queue next does something by itself; null when nothing is due. */
  get nextDeadline(): number | null {
    if (!this.current || this.currentHeld) return null;
    return this.current.compactAt;
  }

  clone(): IslandQueue {
    const q = new IslandQueue();
    q.current = this.current && { ...this.current };
    q.waiting = this.waiting && { ...this.waiting };
    q.compacted = this.compacted.map((e) => ({ ...e }));
    q.inLine = this.inLine.map((e) => ({ ...e }));
    q.currentHovered = this.currentHovered;
    q.currentTyping = this.currentTyping;
    return q;
  }

  private entry(id: string, selfCompacts: boolean, now: number): QueueEntry {
    return { id, selfCompacts, compactAt: selfCompacts ? now + IslandQueue.selfCompactAfter : null };
  }

  /** A card arrives on top. One the queue already holds stays where it is. */
  arrive(id: string, selfCompacts: boolean, now: number): void {
    if (this.ids.has(id)) return;
    this.place(this.entry(id, selfCompacts, now));
  }

  private place(next: QueueEntry): void {
    if (!next.selfCompacts && this.inLine.length > 0) {
      this.inLine.push(next);
      return;
    }
    const cur = this.current;
    if (!cur) {
      this.current = next;
      this.currentHovered = false;
      this.currentTyping = false;
      return;
    }
    if (this.currentHeld || !cur.selfCompacts) {
      this.putInWaitingSlot(next);
      return;
    }
    this.compact(cur);
    this.currentHovered = false;
    this.currentTyping = false;
    const w = this.waiting;
    if (w && !w.selfCompacts && !next.selfCompacts) {
      this.current = w;
      this.waiting = next;
    } else {
      this.current = next;
    }
  }

  private putInWaitingSlot(next: QueueEntry): void {
    const old = this.waiting;
    if (!old) {
      this.waiting = next;
      return;
    }
    if (!old.selfCompacts && next.selfCompacts) this.compact(next);
    else if (!old.selfCompacts && !next.selfCompacts) this.inLine.push(next);
    else {
      this.compact(old);
      this.waiting = next;
    }
  }

  hoverCurrent(hovered: boolean, now: number): void {
    if (!this.current || hovered === this.currentHovered) return;
    this.currentHovered = hovered;
    if (!hovered) this.graceAfterRelease(now);
  }

  typingCurrent(typing: boolean, now: number): void {
    if (!this.current || typing === this.currentTyping) return;
    this.currentTyping = typing;
    if (!typing) this.graceAfterRelease(now);
  }

  private graceAfterRelease(now: number): void {
    const cur = this.current;
    if (this.currentHeld || !cur || cur.compactAt === null || cur.compactAt >= now + IslandQueue.hoverLeaveGrace) return;
    this.current = { ...cur, compactAt: now + IslandQueue.hoverLeaveGrace };
  }

  /** The clock: self-compacts the current card when due (and unheld); then the waiting one expands. */
  tick(now: number): void {
    const cur = this.current;
    if (!cur || this.currentHeld || cur.compactAt === null || now < cur.compactAt) return;
    this.compact(cur);
    this.current = null;
    this.promoteWaiting(now);
  }

  /** The user clicked the waiting pill: the current card tucks away, the waiting one expands. */
  clickWaiting(now: number): void {
    const w = this.waiting;
    if (!w) return;
    this.waiting = null;
    const cur = this.current;
    if (cur) {
      if (cur.selfCompacts) this.compact(cur);
      else this.waiting = cur;
    }
    this.current = this.entry(w.id, w.selfCompacts, now);
    this.refillWaiting();
    this.currentHovered = false;
    this.currentTyping = false;
  }

  /** Answered anywhere, or no longer pending: gone from every place. */
  resolve(id: string, now: number): void {
    this.compacted = this.compacted.filter((e) => e.id !== id);
    this.inLine = this.inLine.filter((e) => e.id !== id);
    if (this.waiting?.id === id) {
      this.waiting = null;
      this.refillWaiting();
    }
    if (this.current?.id === id) {
      this.current = null;
      this.currentHovered = false;
      this.currentTyping = false;
      this.promoteWaiting(now);
    }
  }

  /** Straight into the compacted set (it was on top before and comes back after being hidden). */
  addCompacted(id: string, selfCompacts: boolean, now: number): void {
    if (this.ids.has(id)) return;
    if (selfCompacts) this.compacted.push({ id, selfCompacts: true, compactAt: null });
    else this.place(this.entry(id, false, now));
  }

  private promoteWaiting(now: number): void {
    let next: QueueEntry | null = null;
    if (this.waiting) {
      next = this.waiting;
      this.waiting = null;
    } else if (this.inLine.length > 0) {
      next = this.inLine.shift()!;
    }
    if (!next) return;
    this.current = this.entry(next.id, next.selfCompacts, now);
    this.currentHovered = false;
    this.currentTyping = false;
    this.refillWaiting();
  }

  private refillWaiting(): void {
    if (this.waiting || this.inLine.length === 0) return;
    this.waiting = this.inLine.shift()!;
  }

  private compact(e: QueueEntry): void {
    if (!e.selfCompacts) {
      if (this.current?.id !== e.id && this.waiting?.id !== e.id && !this.inLine.some((x) => x.id === e.id)) this.inLine.push(e);
      return;
    }
    this.compacted = this.compacted.filter((x) => x.id !== e.id);
    this.compacted.push({ id: e.id, selfCompacts: true, compactAt: null });
  }
}
