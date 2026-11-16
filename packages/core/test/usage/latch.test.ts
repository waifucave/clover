// The Claude Code source's safety rails (spec §12 "Usage sources"), FAKE executables only: the `/usage` latch (only a
// model-loop answer latches; an ordinary error is retried after the throttle), the latch kept per build of the program (its
// `--version`), and the hard bounds on the invocation.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService, type LegacyServiceDeps } from "./sources-harness";
import { CLAUDE_USAGE_ARGS } from "../../../../plugins/usage-claude-code/src/claude-code";
import { fakeClaude, tempDir } from "./fixtures";

const pricer = new UsagePricer();
const NOW = Date.now();

function service(over: Partial<LegacyServiceDeps> & { db?: UsageDb; home?: string } = {}) {
  const home = over.home ?? tempDir("home");
  const db = over.db ?? new UsageDb(join(home, "usage", "usage.db"));
  const logs: string[] = [];
  const svc = new UsageService({
    db, pricer, tracking: () => ({ codex: true, claudeCode: true, antigravity: true, opencode: true }), codexExecutable: () => undefined, claudeExecutable: () => undefined,
    mossCodexWindows: () => [],  ingestEveryMs: 0, planWaitMs: 20_000,
    log: { warn: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`), info: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`) },
    ...over,
  });
  return { home, db, svc, logs };
}

function marks(markerPath: string): Array<{ argv: string[]; cwd: string; env: string[] }> {
  // Claude Code's hourly `auth status` (the plan's name) is not a `/usage` run: not counted here.
  return existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((m: { argv: string[] }) => m.argv[0] !== "auth") : [];
}

/** The source's latch, as the core keeps it between calls (`usage-plan:claude-code`). */
const latched = (db: UsageDb): { version: string; reason: string } | undefined =>
  (db.sourceState("usage-plan:claude-code")?.v as { latched?: { version: string; reason: string } } | null | undefined)?.latched;

describe("the /usage latch", () => {
  test("a plain is_error (logged out, offline) is an ordinary failure: cached for the throttle — one spawn — then retried, never latched", async () => {
    const fake = fakeClaude(tempDir("bin"), "is-error");
    let now = NOW;
    const { svc, db, logs } = service({ claudeExecutable: () => fake.path, now: () => now });
    expect((await svc.sourcePlan("claude-code")).source).toBe("none");
    now += 60_000;
    expect((await svc.sourcePlan("claude-code")).source).toBe("none");
    expect(marks(fake.markerPath)).toHaveLength(1);
    expect(latched(db)).toBeUndefined();
    expect(logs.some((l) => l.includes("claude /usage gave no plan reading: error"))).toBe(true);
    now += 5 * 60_000;
    await svc.sourcePlan("claude-code");
    expect(marks(fake.markerPath)).toHaveLength(2);
  });

  test("a model-loop answer latches the binary in usage.db: a restart does not ask again, an updated binary does", async () => {
    const bin = tempDir("bin");
    const fake = fakeClaude(bin, "cost");
    const home = tempDir("home");
    let now = NOW;
    const first = service({ home, claudeExecutable: () => fake.path, now: () => now });
    await first.svc.sourcePlan("claude-code");
    expect(latched(first.db)?.reason).toBe("guard");
    first.db.close();
    // A restart: a new service on the same usage.db.
    now += 3_600_000;
    const second = service({ home, db: new UsageDb(join(home, "usage", "usage.db")), claudeExecutable: () => fake.path, now: () => now });
    expect((await second.svc.sourcePlan("claude-code")).source).toBe("none");
    expect(marks(fake.markerPath)).toHaveLength(1);
    // Claude Code updated (its `--version` changed): asked again.
    writeFileSync(`${fake.path}.version`, "2.1.999 (Claude Code)");
    now += 3_600_000;
    await second.svc.sourcePlan("claude-code");
    expect(marks(fake.markerPath)).toHaveLength(2);
  });

  test("a run that shows a model turn and then hangs (killed) or exits without a result latches too", async () => {
    for (const mode of ["model-turn-hang", "tool-use-exit"] as const) {
      const fake = fakeClaude(tempDir("bin"), mode);
      const { svc, db } = service({ claudeExecutable: () => fake.path, claudeCliTimeoutMs: 1_500 });
      expect((await svc.sourcePlan("claude-code")).source).toBe("none");
      expect(latched(db)?.reason).toBe("guard-model-turn");
    }
  });

  test("the invocation carries the hard bounds: at most one turn, no tools", () => {
    const args = [...CLAUDE_USAGE_ARGS];
    expect(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 2)).toEqual(["--max-turns", "1"]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args).not.toContain("--bare");
  });

  test("a result naming no command (an early startup error, 0 turns, 0 cost) is ordinary: never latched", async () => {
    const fake = fakeClaude(tempDir("bin"), "no-local-command");
    const { svc, db } = service({ claudeExecutable: () => fake.path });
    expect((await svc.sourcePlan("claude-code")).source).toBe("none");
    expect(latched(db)).toBeUndefined();
  });

  test("the latch is keyed by the program's version text, never its path", () => {
    const fake = fakeClaude(tempDir("bin"), "cost");
    writeFileSync(`${fake.path}.version`, "2.1.300 (Claude Code)");
    return (async () => {
      const { svc, db } = service({ claudeExecutable: () => fake.path });
      await svc.sourcePlan("claude-code");
      const l = latched(db)!;
      expect(l.version).toBe("2.1.300 (Claude Code)");
      expect(JSON.stringify(db.sourceState("usage-plan:claude-code")).includes(fake.path)).toBe(false);
    })();
  });
});

describe("~/.claude.json", () => {
  test("is never read: a plan cache there answers nothing when the program does not", async () => {
    const claudeHome = tempDir("claude");
    writeFileSync(join(claudeHome, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { five_hour: { utilization: 40 } }, oauthAccount: { token: "DECOY_TOKEN_VALUE" } }));
    const fake = fakeClaude(tempDir("bin"), "is-error");
    const { svc, logs } = service({ claudeExecutable: () => fake.path, claudeHome });
    const plan = await svc.sourcePlan("claude-code");
    expect(plan.source).toBe("none");
    expect(JSON.stringify([plan, logs]).includes("DECOY_TOKEN_VALUE")).toBe(false);
  });
});
