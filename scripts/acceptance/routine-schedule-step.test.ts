// The scheduled routine row's verdict, held without a run: a run its schedule made, finished, from a side thread, with
// that side thread's reply, passes; anything short of it is named. The tag the routine carries is one the fake answers.
import { describe, expect, test } from "bun:test";
import { parseSpec } from "../../packages/core/src/routines/spec";
import { newestDirective } from "./fake-anthropic";
import { FULL_STEPS } from "./steps";
import { OAUTH_SIGN_IN_STEP } from "./code-adapter-step";
import { ROUTINE_SCHEDULE, routineTag, scheduledRunWrong, SCHEDULED_ROUTINE_STEP, type RunSeen } from "./routine-schedule-step";

const tag = routineTag("a1b2c3d4");
const base = { id: "r_abcdefgh", createdAt: 1_000, tag, mainSession: "b_alpha_main" };
const done: RunSeen = { routine: "r_abcdefgh", session: "s_side_1", startedAt: 16_000, endedAt: 18_000, outcome: "done", summary: `ACCEPTANCE-REPLY-OK ${tag}` };

describe("the scheduled routine's verdict", () => {
  test("a done run from a side thread with its reply passes", () => {
    expect(scheduledRunWrong({ ...base, runs: [done] })).toBeUndefined();
    expect(scheduledRunWrong({ ...base, runs: [{ ...done, outcome: "skipped", summary: "Fired while its last run was still going." }, done] })).toBeUndefined();
  });
  test("each miss is named", () => {
    expect(scheduledRunWrong({ ...base, runs: [] })).toContain("no run of r_abcdefgh");
    expect(scheduledRunWrong({ ...base, runs: [{ ...done, startedAt: 500 }] })).toContain("no run of r_abcdefgh");
    expect(scheduledRunWrong({ ...base, runs: [{ ...done, routine: "r_other" }] })).toContain("no run");
    expect(scheduledRunWrong({ ...base, runs: [{ ...done, outcome: "failed", summary: "boom" }] })).toBe("its runs are failed (boom), none done");
    expect(scheduledRunWrong({ ...base, runs: [{ ...done, endedAt: undefined }] })).toContain("no end time");
    expect(scheduledRunWrong({ ...base, runs: [{ ...done, session: "none" }] })).toContain("not a side thread");
    expect(scheduledRunWrong({ ...base, runs: [{ ...done, session: base.mainSession }] })).toContain("not a side thread");
    expect(scheduledRunWrong({ ...base, runs: [{ ...done, summary: "ACCEPTANCE-REPLY-OK" }] })).toContain("isn't its side thread's reply");
  });
  test("the schedule reads as an interval within the wait, and the tag is a directive the fake answers", () => {
    expect(parseSpec(ROUTINE_SCHEDULE)).toEqual({ kind: "interval", ms: 15_000 });
    expect(tag).toMatch(/^ACCEPTANCE-TAG-[A-Z0-9]+$/);
    expect(newestDirective(`<routine name="Scheduled probe" id="r_1">\n${tag}\n</routine>`).startsWith(`${tag}\n`)).toBe(true);
  });
  test("the row sits after the oauth row", () => {
    expect(FULL_STEPS.indexOf(SCHEDULED_ROUTINE_STEP)).toBe(FULL_STEPS.indexOf(OAUTH_SIGN_IN_STEP) + 1);
  });
});
