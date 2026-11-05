// Pure formatting. Absolute times only, so nothing on screen ticks by itself: the host re-renders
// with a new `now` when a relative phrase ("in 9 min") must move.
import type { ConversationFormat, SharedTime } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function dateParts(at: SharedTime, format: ConversationFormat): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: format.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** A calendar day in the formatting time zone, as `YYYY-MM-DD`. */
export function dayKey(at: SharedTime, format: ConversationFormat = {}): string {
  const { y, m, d } = dateParts(at, format);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "10:42" (or "10:42 AM", by locale). */
export function formatTime(at: SharedTime, format: ConversationFormat = {}): string {
  return new Intl.DateTimeFormat(format.locale, {
    timeZone: format.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

/** "Today", "Yesterday", "Monday, November 3", or with the year when it is not this year's. */
export function dayLabel(at: SharedTime, now: SharedTime, format: ConversationFormat = {}): string {
  const day = dayKey(at, format);
  if (day === dayKey(now, format)) return "Today";
  if (day === dayKey(now - 24 * HOUR, format)) return "Yesterday";
  const sameYear = dateParts(at, format).y === dateParts(now, format).y;
  return new Intl.DateTimeFormat(format.locale, {
    timeZone: format.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(new Date(at));
}

/** "4s", "12 min", "1 h 5 min". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  const h = Math.floor(ms / HOUR);
  const m = Math.round((ms - h * HOUR) / MINUTE);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Whole minutes from `now` until `at`, never below zero. */
export function minutesUntil(at: SharedTime, now: SharedTime): number {
  return Math.max(0, Math.ceil((at - now) / MINUTE));
}

/** The last segment of a path, `/` or `\` separated. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/** A URL's host, or the input when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Text cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The first line that holds something. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}
