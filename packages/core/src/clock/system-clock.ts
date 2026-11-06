// The system clock behind the Clock contract until the shared clock lands (H-M2): shared time is this computer's own
// wall clock, and timers run on the process's monotonic time. `status` says it isn't synced to a reference yet.
import type { Clock, ClockStatus, TimerHandle } from "../contracts/clock";

export class SystemClock implements Clock {
  #nextId = 1;
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>();

  now(): number {
    return Date.now();
  }

  monotonic(): number {
    return performance.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    const t = setTimeout(() => {
      this.#timers.delete(id);
      fn();
    }, Math.max(0, ms));
    this.#timers.set(id, t);
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    const t = this.#timers.get(handle.id);
    if (t !== undefined) clearTimeout(t);
    this.#timers.delete(handle.id);
  }

  status(): ClockStatus {
    return { reference: "public", offsetMs: 0, accuracyMs: 0, synced: false };
  }
}
