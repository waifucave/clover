// The window's side of MOSS's fixed bridge (shared/view.ts `MossBridge`, preload.ts): the only way the page reaches
// anything. There is no generic call.
import type { MossBridge } from "../shared/view";

declare global {
  interface Window {
    moss?: MossBridge;
  }
}

export function bridge(): MossBridge {
  const b = window.moss;
  if (b === undefined) throw new Error("MOSS's bridge isn't here");
  return b;
}

/** A time beside a row or a bubble: "now", minutes, the hour today, the day this week, else the date. A time to come
 *  (a routine's next run) is its hour today, else its day and hour. */
export function shortTime(at: number, now: number = Date.now()): string {
  const d = now - at;
  if (d < -60_000) {
    const then = new Date(at);
    const hour = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return then.toDateString() === new Date(now).toDateString() ? hour : `${then.toLocaleDateString([], { weekday: "short" })} ${hour}`;
  }
  if (d < 60_000) return "now";
  if (d < 60 * 60_000) return `${Math.floor(d / 60_000)}m`;
  const then = new Date(at);
  const today = new Date(now);
  if (then.toDateString() === today.toDateString()) return then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d < 6 * 24 * 60 * 60_000) return then.toLocaleDateString([], { weekday: "short" });
  return then.toLocaleDateString([], { month: "short", day: "numeric" });
}
