// FakeClock: time moves only when a test says so. `advance` fires every timer that falls due, in order, including
// timers set while it runs. Timers run on monotonic time, so `correct` (a sync moving the shared time) never fires or
// delays one.
import type { Clock, ClockStatus, TimerHandle } from "../clock";

interface Timer {
  id: number;
  /** Due, in monotonic ms. */
  at: number;
  seq: number;
  fn: () => void;
}

/** 2026-06-12, a fixed start so fixtures and logs read the same in every run. */
export const FAKE_EPOCH_MS = 1_781_270_000_000;

export class FakeClock implements Clock {
  #now: number;
  #mono = 0;
  #seq = 0;
  #nextId = 1;
  readonly #timers = new Map<number, Timer>();
  #status: ClockStatus;

  constructor(opts: { start?: number; status?: Partial<ClockStatus> } = {}) {
    this.#now = opts.start ?? FAKE_EPOCH_MS;
    this.#status = { reference: "public", offsetMs: 0, accuracyMs: 0, synced: true, ...opts.status };
  }

  now(): number {
    return this.#now;
  }

  monotonic(): number {
    return this.#mono;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { id, at: this.#mono + Math.max(0, ms), seq: this.#seq++, fn });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle.id);
  }

  status(): ClockStatus {
    return { ...this.#status };
  }

  setStatus(status: Partial<ClockStatus>): void {
    this.#status = { ...this.#status, ...status };
  }

  /** Moves both clocks forward, firing due timers in order of their due time, then of when they were set. A timer a
   *  firing timer sets is fired too if it falls due within the same advance. */
  advance(ms: number): void {
    const end = this.#mono + Math.max(0, ms);
    for (;;) {
      let due: Timer | undefined;
      for (const t of this.#timers.values()) {
        if (t.at > end) continue;
        if (!due || t.at < due.at || (t.at === due.at && t.seq < due.seq)) due = t;
      }
      if (!due) break;
      this.#timers.delete(due.id);
      this.#now += due.at - this.#mono;
      this.#mono = due.at;
      due.fn();
    }
    this.#now += end - this.#mono;
    this.#mono = end;
  }

  /** A sync moved the shared time. The monotonic clock and every timer stay as they were. */
  correct(toNow: number): void {
    this.#now = toNow;
  }

  /** How many timers wait. */
  pending(): number {
    return this.#timers.size;
  }
}

/** Lets promise callbacks run: the fakes settle through microtasks. */
export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Advances a fake clock in steps, letting promises settle between them, so code that awaits between timers (a
 *  restart after a backoff, then a call) runs as it would in real time. */
export async function advanceAndSettle(clock: FakeClock, ms: number, stepMs = ms): Promise<void> {
  let left = Math.max(0, ms);
  await flush();
  while (left > 0) {
    const step = Math.min(stepMs, left);
    clock.advance(step);
    left -= step;
    await flush();
  }
}
