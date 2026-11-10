import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_BUILD_LABEL, TEST_BUILD_SENTINEL, testBuildDefine } from "../../../scripts/test-build";

/** A real compile of the main process, as scripts/build.ts does it: the define folds the test-only code out of a real
 *  build (neither the label nor the sentinel remains), and a test build has both. */
async function compile(test: boolean): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "clover-main-"));
  try {
    const r = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "src", "main", "index.ts")], outdir: out, target: "node", format: "esm", external: ["electron"], define: testBuildDefine(test) });
    expect(r.success).toBe(true);
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
});
