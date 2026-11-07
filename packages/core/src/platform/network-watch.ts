// A network change or a wake, for the links' re-dial (`networkChanged()`, lane H; spec §8.2). Portable and cheap: the
// interfaces' addresses are compared every few seconds, and a wake shows as the timer firing far later than asked
// (the machine slept through it). One timer, unref'd, so it never keeps the daemon up; 0.2 wakeups a second at the
// default, well under the idle-wakeup budget.
import { networkInterfaces } from "node:os";

export interface NetworkWatchOptions {
  everyMs?: number;
  /** How late a tick may be before it counts as a wake. */
  wakeAfterMs?: number;
  now?: () => number;
  /** Test seam: the current addresses. */
  addresses?: () => string;
}

function fingerprint(): string {
  const out: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal) out.push(`${name}=${a.address}`);
  }
  return out.sort().join(",");
}

/** Calls `onChange(reason)` on an address change or a wake; returns the stop. */
export function watchNetwork(onChange: (reason: "addresses" | "wake") => void, o: NetworkWatchOptions = {}): () => void {
  const every = o.everyMs ?? 5_000;
  const wakeAfter = o.wakeAfterMs ?? 15_000;
  const now = o.now ?? Date.now;
  const read = o.addresses ?? fingerprint;
  let last = read();
  let at = now();
  const timer = setInterval(() => {
    const t = now();
    const late = t - at > every + wakeAfter;
    at = t;
    const next = read();
    if (late) { last = next; onChange("wake"); return; }
    if (next !== last) { last = next; onChange("addresses"); }
  }, every);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
