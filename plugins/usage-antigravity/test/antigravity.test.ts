// The Antigravity source (spec §12 "Usage sources"): agy's own `/usage` parsed against the live-seen shape, the guard
// and its latch, the timeout back-off, not installed. A stub `outside` answers; no real `agy` ever runs.
import { describe, expect, test } from "bun:test";
import type { OutsideRun } from "@waifucave/moss-plugin-sdk";
import { AGY_USAGE_ARGS, agyGroupScope, judgeAgyUsage, windowsFromAgyUsage } from "../src/antigravity";
import { plan } from "../src/source";
import type { Outside } from "@waifucave/moss-plugin-sdk/usage-source";
import AGY_USAGE from "./shapes/agy-usage.json";

const NOW = Date.parse("2026-10-18T19:15:04Z");
const ok = (over: Partial<OutsideRun> = {}): OutsideRun => ({ code: 0, stdout: "", stderr: "", ...over });
const json = (o: unknown): string => JSON.stringify(o, null, 1);

/** A stub of `api.outside` that answers `/usage` with `usage()` and `--version` with `version()`, and counts calls. */
function stub(usage: () => OutsideRun | Error, version: () => string = () => "agy 1.0") {
  const calls: string[][] = [];
  const outside: Outside = {
    run: async (program, args) => {
      calls.push([program, ...(args ?? [])]);
      if (program !== "agy") throw new Error(`${program} isn't named`);
      if (args?.[0] === "--version") return ok({ stdout: `${version()}\n` });
      const r = usage();
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { outside, calls, usages: () => calls.filter((c) => c[1] === "-p").length };
}
const ctx = (outside: Outside) => ({ api: { outside } }) as never;
const args = (now = NOW, state?: unknown) => ({ now, reports: {}, ...(state === undefined ? {} : { state }) });

describe("agy's /usage, parsed", () => {
  test("each bucket is a window: used = 1 - remaining, its kind, reset and group", () => {
    const data = (AGY_USAGE.command as Record<string, unknown>).data;
    const windows = windowsFromAgyUsage(data, NOW, NOW);
    expect(windows.map((w) => [w.id, w.kind, w.windowMinutes, w.usedPercent, w.scope, w.stale])).toEqual([
      ["gemini-weekly", "weekly", 10_080, 27, "Gemini", false],
      ["gemini-5h", "five_hour", 300, 0, "Gemini", false],
      ["3p-weekly", "weekly", 10_080, 27, "Claude & GPT", false],
      ["3p-5h", "five_hour", 300, 0, "Claude & GPT", false],
    ]);
    expect(windows[0]!.resetsAt).toBe(Date.parse("2026-10-25T18:15:04Z"));
  });

  test("a group's name, shortly", () => {
    expect(agyGroupScope("Gemini Models")).toBe("Gemini");
    expect(agyGroupScope("Claude and GPT models")).toBe("Claude & GPT");
    expect(agyGroupScope("Open Weights")).toBe("Open Weights");
    expect(agyGroupScope(undefined)).toBeUndefined();
  });

  test("the guard: only the read-only command with no turn and no token is read; positive evidence is `guard`", () => {
    expect(judgeAgyUsage(AGY_USAGE, NOW).reading?.source).toBe("agy-cli");
    const variant = (f: (o: Record<string, any>) => void) => { const o = JSON.parse(JSON.stringify(AGY_USAGE)); f(o); return judgeAgyUsage(o, NOW).failure; };
    expect(variant((o) => { o.num_turns = 1; })).toBe("guard");
    expect(variant((o) => { o.usage.output_tokens = 3; })).toBe("guard");
    expect(variant((o) => { o.command.name = "chat"; })).toBe("guard");
    expect(variant((o) => { o.conversation_id = "c-1"; })).toBe("guard");
    expect(variant((o) => { delete o.command; })).toBe("guard");
    expect(variant((o) => { delete o.command; o.response = ""; })).toBe("no-command");
    expect(variant((o) => { delete o.command; o.status = "ERROR"; })).toBe("no-command");
    expect(variant((o) => { delete o.num_turns; })).toBe("unverified");
    expect(variant((o) => { delete o.usage; })).toBe("unverified");
    expect(variant((o) => { delete o.conversation_id; })).toBe("unverified");
    expect(variant((o) => { o.status = "ERROR"; })).toBe("error");
    expect(variant((o) => { o.command.data.groups = []; })).toBe("no-report");
  });
});

describe("the Antigravity plan", () => {
  test("agy's own /usage with EXACTLY the verified invocation; the reading is kept, its text is not", async () => {
    const s = stub(() => ok({ stdout: `Antigravity CLI 1.0 - a banner that is not JSON\n${json({ ...AGY_USAGE, response: "SECRET-ANSWER-91bc" })}\n` }));
    const r = await plan(args(), ctx(s.outside));
    expect(r.reading?.source).toBe("agy-cli");
    expect(r.keep).toBe(true);
    expect(r.reading?.windows.map((w) => [w.scope, w.kind, w.usedPercent])).toEqual([
      ["Gemini", "weekly", 27], ["Gemini", "five_hour", 0], ["Claude & GPT", "weekly", 27], ["Claude & GPT", "five_hour", 0],
    ]);
    expect(JSON.stringify(r).includes("SECRET")).toBe(false);
    expect(s.calls).toEqual([["agy", ...AGY_USAGE_ARGS]]);
  });

  for (const mutate of [
    (o: Record<string, any>) => { o.num_turns = 1; }, (o: Record<string, any>) => { o.usage.input_tokens = 1200; },
    (o: Record<string, any>) => { o.command.name = "chat"; }, (o: Record<string, any>) => { o.conversation_id = "conv-123"; },
    (o: Record<string, any>) => { delete o.command; },
  ]) {
    test(`a /usage that reached the model loop LATCHES the binary until its version changes: one warning, no content`, async () => {
      const bad = JSON.parse(JSON.stringify(AGY_USAGE)); bad.response = "SECRET-ANSWER-91bc"; mutate(bad);
      let version = "agy 1.0";
      const s = stub(() => ok({ stdout: json(bad) }), () => version);
      const first = await plan(args(), ctx(s.outside));
      expect(first.failure).toBe("guard");
      expect(first.reading).toBeUndefined();
      expect(first.log?.filter((l) => l.includes("not asked again until Antigravity changes"))).toHaveLength(1);
      expect(JSON.stringify(first.log).includes("SECRET")).toBe(false);
      // A restart an hour later (the state comes back from the core): still latched, nothing run but `--version`.
      const second = await plan(args(NOW + 3_600_000, first.state), ctx(s.outside));
      expect(second.failure).toBe("latched");
      expect(s.usages()).toBe(1);
      // agy updated: asked again.
      version = "agy 1.1";
      await plan(args(NOW + 7_200_000, first.state), ctx(s.outside));
      expect(s.usages()).toBe(2);
    });
  }

  for (const [name, run] of [
    ["no JSON", () => ok({ code: 1, stdout: "Error: not signed in\n" })],
    ["exit 1 after a reading", () => ok({ code: 1, stdout: json(AGY_USAGE) })],
    ["no command", () => ok({ stdout: json({ ...AGY_USAGE, command: undefined, response: "" }) })],
  ] as const) {
    test(`an ordinary failure (${name}) is a failure with no latch and no back-off`, async () => {
      const s = stub(run);
      const r = await plan(args(), ctx(s.outside));
      expect(r.reading).toBeUndefined();
      expect(r.failure).toBeDefined();
      expect(r.state).toBeNull();
      expect(r.retryAfterMs).toBeUndefined();
    });
  }

  test("a hung agy (it ignored its own --print-timeout) is not asked again for hours, and the back-off survives a restart", async () => {
    const s = stub(() => ok({ code: null, timedOut: true }));
    const first = await plan(args(), ctx(s.outside), { backoffMs: 6 * 3_600_000 });
    expect(first.failure).toBe("timeout");
    expect(first.retryAfterMs).toBe(6 * 3_600_000);
    const again = await plan(args(NOW + 3_600_000, first.state), ctx(s.outside));
    expect(again.failure).toBe("backoff");
    expect(s.usages()).toBe(1);
    await plan(args(NOW + 6 * 3_600_000 + 60_000, first.state), ctx(s.outside));
    expect(s.usages()).toBe(2);
  });

  test("not on this computer: no slot", async () => {
    const s = stub(() => new Error("agy isn't on your PATH"));
    expect(await plan(args(), ctx(s.outside))).toEqual({ notInstalled: true });
  });

  test("with no outside door (the manifest names no program) it says so and runs nothing", async () => {
    expect(await plan(args(), { api: {} } as never)).toEqual({ failure: "no-outside" });
  });
});
