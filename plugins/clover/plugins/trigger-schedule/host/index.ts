// The schedule trigger's host half (clover/trigger-schedule, spec §7). Owner: lane D.
//
// It owns the schedule grammar (src/spec.ts: `every 15m` and 5-field cron, carried over as it was) and its time-zone math
// (src/zone.ts). The core's routine engine runs that code in-process to arm and fire a routine's schedules, so a
// schedule never waits on a plugin call; this handler serves the same answers to anyone asking through `points.call`
// (the bot editor's "next run", a routine card), with the same code.
//
// Exports:
//   schedule   the handler of this plugin's `triggers` entry: `check`, `next` and `missed`
import { parseSpec, nextRunAt, type RoutineSpec } from "../src/spec";
import { firesBetween, isTimeZone, nextRunInZone } from "../src/zone";

/** A routine file's schedule trigger, `- schedule: "<spec>"`. */
export interface ScheduleFields {
  schedule: string;
}

/** The most fires `missed` lists. */
export const MISSED_LIMIT_MAX = 1000;

function read(fields: unknown): RoutineSpec {
  const s = (fields as Partial<ScheduleFields> | null | undefined)?.schedule;
  if (typeof s !== "string" || s.length > 200) throw new TypeError("a schedule trigger is `schedule: <spec>`, at most 200 characters");
  return parseSpec(s);
}

function zone(timezone: unknown): string | undefined {
  if (timezone === undefined) return undefined;
  if (typeof timezone !== "string" || !isTimeZone(timezone)) throw new TypeError(`"${String(timezone).slice(0, 60)}" isn't a time zone this computer knows`);
  return timezone;
}

/** When a spec fires next after `after`: in `timezone` for a cron line, by its period for an interval. */
function nextAfter(spec: RoutineSpec, after: number, timezone: string | undefined): number {
  if (spec.kind === "interval" || timezone === undefined) return nextRunAt(spec, after);
  return nextRunInZone(spec, after, timezone);
}

export const schedule = {
  /** Whether a routine file's schedule reads, and how to say it. */
  check(args: { fields: unknown }): { ok: true; summary: string } | { ok: false; reason: string } {
    try {
      const spec = read(args.fields);
      const text = (args.fields as ScheduleFields).schedule.trim();
      return { ok: true, summary: spec.kind === "interval" ? text : `cron ${text}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
  /** The next fire after `after` (ms), in the routine's time zone. */
  next(args: { fields: unknown; after: number; timezone?: string }): { at: number } {
    if (!Number.isFinite(args.after)) throw new TypeError("`after` is a time in milliseconds");
    return { at: nextAfter(read(args.fields), args.after, zone(args.timezone)) };
  },
  /** The fires a cron line had between `after` and `until` (a computer that was off), at most `limit`. An interval
   *  has no fixed times, so it lists none: the engine runs it once on wake by its own rule. */
  missed(args: { fields: unknown; after: number; until: number; timezone: string; limit?: number }): { at: number[] } {
    const spec = read(args.fields);
    const tz = zone(args.timezone);
    if (tz === undefined) throw new TypeError("`timezone` is needed for missed fires");
    if (spec.kind === "interval") return { at: [] };
    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 100)), MISSED_LIMIT_MAX);
    return { at: firesBetween(spec, args.after, args.until, tz, limit) };
  },
};
