import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_BUILD_LABEL, TEST_BUILD_SENTINEL, TEST_ONLY_APP_STRINGS, acceptanceBuildDefine, testBuildDefine } from "../../../scripts/test-build";

/** A real compile of the main process, as scripts/build.ts does it: the define folds the test-only code out of a real
 *  build (neither the label nor the sentinel remains), and a test build has both. */
async function compile(test: boolean, acceptance = false): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "clover-main-"));
  try {
    // In a process of its own, so no other test's module mocks reach the compile.
    const define = Object.entries({ ...testBuildDefine(test), ...acceptanceBuildDefine(acceptance) }).flatMap(([k, v]) => ["--define", `${k}=${v}`]);
    const r = Bun.spawnSync([process.execPath, "build", join(import.meta.dir, "..", "src", "main", "index.ts"), "--outdir", out, "--target", "node", "--format", "esm", "--external", "electron", "--no-macros", ...define], { cwd: join(import.meta.dir, "..") });
    expect(r.exitCode).toBe(0);
    return readdirSync(out).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe("the app's main bundle and the test-build markers", () => {
  test("a real build carries neither the label nor the sentinel; a test build carries both", async () => {
    const real = await compile(false);
    expect(real.includes(TEST_BUILD_LABEL)).toBe(false);
    expect(real.includes(TEST_BUILD_SENTINEL)).toBe(false);
    const test = await compile(true);
    expect(test.includes(TEST_BUILD_LABEL)).toBe(true);
    expect(test.includes(TEST_BUILD_SENTINEL)).toBe(true);
  }, 120_000);

  test("a real build reads neither CLOVER_TEST_ANSWER_KEY nor CLOVER_TEST_SEALED_PRESS; the test build and the source acceptance's build read both", async () => {
    const real = await compile(false);
    for (const t of TEST_ONLY_APP_STRINGS) expect([t, real.includes(t)]).toEqual([t, false]);
    const test = await compile(true);
    for (const t of TEST_ONLY_APP_STRINGS) expect([t, test.includes(t)]).toEqual([t, true]);
    const acceptance = await compile(false, true);
    for (const t of TEST_ONLY_APP_STRINGS) expect([t, acceptance.includes(t)]).toEqual([t, true]);
    // The acceptance build isn't a test build: no label, no test-only branch.
    expect(acceptance.includes(TEST_BUILD_LABEL)).toBe(false);
    expect(acceptance.includes(TEST_BUILD_SENTINEL)).toBe(false);
  }, 180_000);
});
