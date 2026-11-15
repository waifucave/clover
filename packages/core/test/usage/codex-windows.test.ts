// The plan windows Codex sessions report (`usage/codex-windows.ts`): the runtime's `rate_limit_event` frames, handed over
// by the projector and still never persisted, kept as the latest per window kind. Nothing is estimated.
import { describe, expect, test } from "bun:test";
import type { ProtocolSdkMessage } from "../../src/projector/types";
import { PlanWindowReports, epochMs } from "../../src/usage/codex-windows";
import { accept, makeProjector } from "../projector/harness";

describe("PlanWindowReports", () => {
  test("keeps the LATEST report per window kind, resets in ms, only the named scalars, per provider", () => {
    const r = new PlanWindowReports(() => 1_000);
    r.noteRateLimit("s1", { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: 1_900_000_000, secret: "x" } as never, "codex-oauth");
    r.noteRateLimit("s2", { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.82, resetsAt: 1_900_000_100 }, "codex-oauth");
    r.noteRateLimit("s2", { status: "allowed", rateLimitType: "seven_day", utilization: 0.1 }, "codex-oauth");
    r.noteRateLimit("s3", { rateLimitType: "seven_day" }, "codex-oauth"); // no status: ignored
    r.noteRateLimit("s4", { status: "allowed", rateLimitType: "five_hour" }, "other");
    expect(r.windowsFor("codex-oauth")).toEqual([
      { rateLimitType: "five_hour", status: "allowed_warning", utilization: 0.82, resetsAt: 1_900_000_100_000, at: 1_000, sessionId: "s2", provider: "codex-oauth" },
      { rateLimitType: "seven_day", status: "allowed", utilization: 0.1, at: 1_000, sessionId: "s2", provider: "codex-oauth" },
    ]);
    expect(r.windowsFor("nobody")).toEqual([]);
  });

  test("is bounded", () => {
    const r = new PlanWindowReports();
    for (let i = 0; i < 40; i++) r.noteRateLimit("s", { status: "allowed", rateLimitType: `k${i}` }, "codex-oauth");
    expect(r.windowsFor("codex-oauth").length).toBeLessThanOrEqual(16);
  });

  test("epochMs: the runtime's resetsAt is unix seconds; junk is dropped", () => {
    expect(epochMs(1_900_000_000)).toBe(1_900_000_000_000);
    expect(epochMs(-1)).toBeUndefined();
    expect(epochMs("1")).toBeUndefined();
  });

  test("the pinned runtime's own report (status + resetsAt in seconds, no utilization) becomes a window with no fill", () => {
    const r = new PlanWindowReports(() => 5);
    r.noteRateLimit("s1", { status: "rejected", resetsAt: Math.round(1_900_000_000_500 / 1000) }, "codex-oauth");
    expect(r.windowsFor("codex-oauth")).toEqual([{ status: "rejected", resetsAt: 1_900_000_001_000, at: 5, sessionId: "s1", provider: "codex-oauth" }]);
  });
});

describe("the projector hands a rate_limit_event to onRateLimit and still persists nothing", () => {
  test("onRateLimit gets the frame's rate_limit_info; a throwing handler is swallowed", () => {
    const seen: Record<string, unknown>[] = [];
    const { projector } = makeProjector({ onRateLimit: (info) => { seen.push(info); } });
    const frame = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1 }, uuid: "u", session_id: "s" } as unknown as ProtocolSdkMessage;
    expect(accept(projector, frame)).toEqual([]);
    expect(accept(projector, frame)).toEqual([]);
    expect(seen).toEqual([
      { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1 },
      { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 1 },
    ]);
    const { projector: throwing } = makeProjector({ onRateLimit: () => { throw new Error("boom"); } });
    expect(accept(throwing, frame)).toEqual([]);
  });
});
