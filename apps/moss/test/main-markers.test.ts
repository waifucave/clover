import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_BUILD_LABEL, TEST_BUILD_SENTINEL, TEST_ONLY_APP_STRINGS, TEST_ONLY_MOSS_APP_STRINGS, testBuildDefine } from "../../../scripts/test-build";

/** A real compile of MOSS's main process, as its build does it: the define folds the test-only code out of a real build. */
function compile(testBuild: boolean): string {
  const out = mkdtempSync(join(tmpdir(), "moss-app-main-"));
  try {
    // In a process of its own, so no other test's module mocks reach the compile.
    const define = Object.entries(testBuildDefine(testBuild)).flatMap(([k, v]) => ["--define", `${k}=${v}`]);
    const r = Bun.spawnSync([process.execPath, "build", join(import.meta.dir, "..", "src", "main", "index.ts"), "--outdir", out, "--target", "node", "--format", "esm", "--external", "electron", "--no-macros", ...define], { cwd: join(import.meta.dir, "..") });
    expect(r.exitCode).toBe(0);
    return readdirSync(out).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe("MOSS's main process and the test-only code", () => {
  test("a real build carries no test-only name of either app, nor the label or the test-only branch; a test build reads every one of MOSS's own", () => {
    const real = compile(false);
    expect(real.includes(TEST_BUILD_LABEL)).toBe(false);
    expect(real.includes(TEST_BUILD_SENTINEL)).toBe(false);
    for (const t of [...TEST_ONLY_APP_STRINGS, ...TEST_ONLY_MOSS_APP_STRINGS]) expect([t, real.includes(t)]).toEqual([t, false]);
    const marked = compile(true);
    // The test twin's gate needs both in the built app (try 16's twin build stopped on the missing label).
    expect(marked.includes(TEST_BUILD_LABEL)).toBe(true);
    expect(marked.includes(TEST_BUILD_SENTINEL)).toBe(true);
    // A name on MOSS's list that its test build no longer reads is stale: take it off the list.
    for (const t of TEST_ONLY_MOSS_APP_STRINGS) expect([t, marked.includes(t)]).toEqual([t, true]);
  }, 180_000);
});
