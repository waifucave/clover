// Schedules in a routine's own time zone (spec §7 "Time zone": schedules use the routine's zone, which defaults to the
// user's, never the computer's clock zone, which matters when the main is a cloud computer on UTC). Owner: lane D.
// Part of clover/trigger-schedule, which owns the schedule grammar; the core's routine engine runs it in-process.
//
// The inherited grammar (spec.ts: `every 15m`, 5-field cron) is kept as it is; this computes a cron's next fire in a
// named IANA zone instead of the host's local time. Wall-clock times are walked as naive dates and turned into instants
// through the zone's offset:
// * a wall time the zone skips (the spring-forward gap) has no instant and is passed over;
// * a wall time the zone has twice (the fall-back hour) fires once, at its first instant.
import { parseSpec, type CronField, type RoutineSpec } from "./spec";

const MINUTE_MS = 60_000;
/** As spec.ts: eight years covers the longest gap between February 29ths. */
const MAX_SCAN_MS = 2922 * 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether `timeZone` is a zone this runtime knows (`Europe/London`, `UTC`). */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time at `instant` in `timeZone`, as a naive date (its UTC fields are the wall's fields). */
export function wallOf(instant: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/** The first instant whose wall-clock time in `timeZone` is `wall` (a naive date), or undefined when the zone skips it. */
export function instantOf(wall: number, timeZone: string): number | undefined {
  const offsetAt = (t: number) => wallOf(t, timeZone) - Math.floor(t / 1000) * 1000;
  const first = wall - offsetAt(wall);
  const candidates = new Set([first, wall - offsetAt(first), wall - offsetAt(first - 3_600_000), wall - offsetAt(first + 3_600_000)]);
  const hits = [...candidates].filter((t) => wallOf(t, timeZone) === wall).sort((a, b) => a - b);
  return hits[0];
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

function dayMatches(spec: Extract<RoutineSpec, { kind: "cron" }>, wall: Date): boolean {
  if (!fieldMatches(spec.mon, wall.getUTCMonth() + 1)) return false;
  if (spec.dom.any && spec.dow.any) return true;
  if (spec.dom.any) return fieldMatches(spec.dow, wall.getUTCDay());
  if (spec.dow.any) return fieldMatches(spec.dom, wall.getUTCDate());
  return fieldMatches(spec.dom, wall.getUTCDate()) || fieldMatches(spec.dow, wall.getUTCDay());
}

/** The next fire strictly after `fromMs`: an interval from `fromMs`, a cron at its next matching minute in `timeZone`. */
export function nextRunInZone(spec: RoutineSpec, fromMs: number, timeZone: string): number {
  if (spec.kind === "interval") return fromMs + spec.ms;
  const startWall = wallOf(fromMs, timeZone);
  let wall = Math.floor(startWall / MINUTE_MS) * MINUTE_MS;
  const deadline = startWall + MAX_SCAN_MS;
  while (wall <= deadline) {
    const d = new Date(wall);
    if (!dayMatches(spec, d)) {
      wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!fieldMatches(spec.h, d.getUTCHours())) {
      wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (fieldMatches(spec.m, d.getUTCMinutes())) {
      const at = instantOf(wall, timeZone);
      if (at !== undefined && at > fromMs) return at;
    }
    wall += MINUTE_MS;
  }
  throw new TypeError(`cron spec is unsatisfiable: no matching time within 8 years of ${new Date(fromMs).toISOString()} in ${timeZone}`);
}

/** Every fire in (`afterMs`, `untilMs`], oldest first, at most `limit` (the runs a computer that was off missed). */
export function firesBetween(spec: RoutineSpec, afterMs: number, untilMs: number, timeZone: string, limit = 1000): number[] {
  const out: number[] = [];
  let at = afterMs;
  while (out.length < limit) {
    at = nextRunInZone(spec, at, timeZone);
    if (at > untilMs) break;
    out.push(at);
  }
  return out;
}

export { parseSpec };
