import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FENCED_SPAWN_NOT_YET, hookSpawner, RUN_AS_USER, type FencedRun } from "../../src/fence/spawn";

const win = process.platform === "win32";
const base = (command: string, extra: Partial<FencedRun> = {}): FencedRun => ({
  command, cwd: realpathSync(mkdtempSync(join(tmpdir(), "clover-spawn-"))), timeoutMs: 10_000,
  env: win ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: process.env.PATH ?? "" } : { PATH: "/usr/bin:/bin" },
  who: { sessionId: "s1", pluginId: "p", hook: "h" }, ...extra,
});

describe("the hook door per OS (the controller's ruling: as the plugin host)", () => {
  test("macOS: the fenced door, closed until the fenced process lands; Windows and Linux: run as the user", async () => {
    expect(hookSpawner("macos")).toBe(FENCED_SPAWN_NOT_YET);
    expect((await hookSpawner("macos").run(base("true"))).kind).toBe("refused");
    expect(hookSpawner("linux")).toBe(RUN_AS_USER);
    expect(hookSpawner("windows")).toBe(RUN_AS_USER);
    const fenced = { available: true, run: async () => ({ kind: "refused" as const, reason: "x" }) };
    expect(hookSpawner("macos", fenced)).toBe(fenced);
    expect(hookSpawner("linux", fenced)).toBe(RUN_AS_USER);
  });

  test.skipIf(win)("as the user: JSON on stdin, its stdout and stderr, exit code 2, in its folder, with only the env given", async () => {
    const r = base(`cat; echo "$(pwd)|\${HOME:-none}" >&2; exit 2`, { stdin: '{"event":"PreToolUse"}' });
    const out = await RUN_AS_USER.run(r);
    expect(out).toEqual({ kind: "exited", code: 2, stdout: '{"event":"PreToolUse"}', stderr: `${r.cwd}|none\n` });
  });

  test.skipIf(win)("as the user: a hook past its limit is ended with what it started", async () => {
    const started = Date.now();
    const out = await RUN_AS_USER.run(base("sleep 30 & sleep 30", { timeoutMs: 200 }));
    expect(out.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  test.skipIf(win)("as the user: a background job holding its pipes doesn't hold the answer", async () => {
    const out = await RUN_AS_USER.run(base(`sleep 30 & printf '{"decision":"block"}'`));
    expect(out).toMatchObject({ kind: "exited", code: 0, stdout: '{"decision":"block"}' });
  }, 30_000);

  test.skipIf(!win)("Windows: cmd runs the line as written, quotes included, and gives its exit code", async () => {
    const out = await RUN_AS_USER.run(base(`echo "a b" & exit /b 2`));
    expect(out.kind).toBe("exited");
    expect(out.kind === "exited" && out.code).toBe(2);
    expect(out.kind === "exited" && out.stdout.trim()).toBe('"a b"');
    const t = await RUN_AS_USER.run(base("ping -n 30 127.0.0.1 >nul", { timeoutMs: 300 }));
    expect(t.kind).toBe("timeout");
  }, 30_000);

  test("a run cancelled before it starts is refused", async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await RUN_AS_USER.run(base("true", { signal: ac.signal }))).kind).toBe("refused");
  });
});
