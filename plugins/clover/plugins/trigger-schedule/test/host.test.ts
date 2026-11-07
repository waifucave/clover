// clover/trigger-schedule's handler: the grammar and the time-zone math it owns, as callers see them.
import { describe, expect, test } from "bun:test";
import { schedule } from "../host/index";

const at = (iso: string) => Date.parse(iso);

describe("the schedule trigger", () => {
  test("check reads an interval and a cron line, and says why one doesn't read", () => {
    expect(schedule.check({ fields: { schedule: "every 15m" } })).toEqual({ ok: true, summary: "every 15m" });
    expect(schedule.check({ fields: { schedule: "0 8 * * 1-5" } })).toEqual({ ok: true, summary: "cron 0 8 * * 1-5" });
    const bad = schedule.check({ fields: { schedule: "0 25 * * *" } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toContain("hour");
    expect(schedule.check({ fields: {} }).ok).toBe(false);
    expect(schedule.check({ fields: { schedule: "x".repeat(201) } }).ok).toBe(false);
  });

  test("next fires a cron line in the routine's zone, not the computer's", () => {
    // 08:00 in London during British Summer Time is 07:00 UTC.
    expect(schedule.next({ fields: { schedule: "0 8 * * *" }, after: at("2026-07-01T06:00:00Z"), timezone: "Europe/London" }).at).toBe(at("2026-07-01T07:00:00Z"));
    expect(schedule.next({ fields: { schedule: "0 8 * * *" }, after: at("2026-07-01T06:00:00Z"), timezone: "Asia/Tokyo" }).at).toBe(at("2026-07-01T23:00:00Z"));
    expect(schedule.next({ fields: { schedule: "every 30m" }, after: 1_000, timezone: "Europe/London" }).at).toBe(1_000 + 30 * 60_000);
    expect(() => schedule.next({ fields: { schedule: "0 8 * * *" }, after: 0, timezone: "Mars/Olympus" })).toThrow("time zone");
  });

  test("missed lists a cron line's fires while the computer was off, skips the spring-forward gap, and none for an interval", () => {
    const fires = schedule.missed({ fields: { schedule: "30 1 * * *" }, after: at("2026-03-27T12:00:00Z"), until: at("2026-03-30T12:00:00Z"), timezone: "Europe/London" }).at;
    // 01:30 on 29 March doesn't exist in London (clocks go 01:00 → 02:00).
    expect(fires).toEqual([at("2026-03-28T01:30:00Z"), at("2026-03-30T00:30:00Z")]);
    expect(schedule.missed({ fields: { schedule: "every 1h" }, after: 0, until: 10 * 3_600_000, timezone: "UTC" }).at).toEqual([]);
    expect(schedule.missed({ fields: { schedule: "* * * * *" }, after: 0, until: 10 * 3_600_000, timezone: "UTC", limit: 5 }).at).toHaveLength(5);
  });
});
