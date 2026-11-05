// Contract: Clock (spec §6.4 "The shared clock"). Owner: lane H.
//
// Messages are ordered by send order on one shared clock. The main computer keeps its time from public time servers;
// every other device measures its offset from the main over the persistent link, the way NTP does, and stamps
// messages in that shared time, accurate to about half the round trip. Ties go by device id, and while the main is
// offline the takeover device is the reference.
//
// Every contract that waits takes a Clock, so a test drives the 10-minute card rule, crash backoff, lease expiry and
// timeouts with `FakeClock.advance` instead of waiting.
import type { ClockView } from "@waifucave/clover-protocol";

/** This device's view of the shared clock: `reference` is the device it follows, `public` on the main itself. Before
 *  the first measurement `synced` is false and the offset is 0. */
export type ClockStatus = ClockView;

export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  /** Shared time: milliseconds since the Unix epoch, on the reference's clock. */
  now(): number;
  /** This process's monotonic milliseconds, for durations; it never jumps when the shared time is corrected. */
  monotonic(): number;
  /** Runs `fn` after `ms` of monotonic time. */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  status(): ClockStatus;
}

/** A message's place in send order (§6.4). */
export interface Stamp {
  /** Shared time of sending. */
  t: number;
  /** The sending device, which breaks ties. */
  device: string;
}

/** Send order: by shared time, then by device id. */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  return a.device < b.device ? -1 : a.device > b.device ? 1 : 0;
}
