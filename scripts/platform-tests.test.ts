// scripts/platform-tests.ts: which test files run on macOS (`*.darwin.test.ts`) and which on Linux, and the check
// that keeps a macOS-only test from sitting, unmarked, in a file that runs on Linux.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatesOnDarwin, isDarwinTest, parseArgs, runProblems, select, testFiles } from "./platform-tests";

const repo = join(import.meta.dir, "..");

describe("platform-tests", () => {
  test("a *.darwin.test.ts file is macOS's, every other test file Linux's", () => {
    expect(isDarwinTest("scripts/embed-runtimes.darwin.test.ts")).toBe(true);
    expect(isDarwinTest("scripts/layout.test.ts")).toBe(false);
    expect(isDarwinTest("scripts/darwin.test.ts")).toBe(false);
    const files = ["a.test.ts", "b.darwin.test.ts", "c/d.test.ts"];
    expect(select(files, true)).toEqual(["b.darwin.test.ts"]);
    expect(select(files, false)).toEqual(["a.test.ts", "c/d.test.ts"]);
  });

  test("the scripts' macOS tests are the reviewed few, and the rest run on Linux", () => {
    const files = testFiles(repo, "scripts");
    expect(select(files, true)).toEqual([
      "scripts/build-winter.darwin.test.ts", "scripts/cowork-native-bundle.darwin.test.ts", "scripts/cu-live/generic.darwin.test.ts",
      "scripts/embed-computer-helper.darwin.test.ts", "scripts/embed-cowork-native.darwin.test.ts", "scripts/embed-headless-helper.darwin.test.ts",
      "scripts/embed-runtimes.darwin.test.ts",
    ]);
    expect(select(files, false)).toContain("scripts/platform-tests.test.ts");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  test("no test file that runs on Linux gates tests on macOS (it would run nowhere)", () => {
    const unmarked = select(testFiles(repo, "scripts"), false).filter((f) => gatesOnDarwin(readFileSync(join(repo, f), "utf8")));
    expect(unmarked).toEqual([]);
    // The examples spell the platform out of pieces, so this file doesn't trip its own check.
    const q = `"${"dar"}${"win"}"`;
    expect(gatesOnDarwin(`test.skipIf(process.platform !== ${q})("x", () => {});`)).toBe(true);
    expect(gatesOnDarwin(`describe.if(process.platform === ${q.replaceAll('"', "'")})('x', () => {});`)).toBe(true);
    expect(gatesOnDarwin(`if (process.platform !== ${q}) return;`)).toBe(true);
    expect(gatesOnDarwin('expect(target).toBe("darwin-arm64");')).toBe(false);
    expect(gatesOnDarwin('test.skipIf(process.platform === "win32")("x", () => {});')).toBe(false);
  });

  test("a run fails when it selected nothing, bun failed, or bun ran fewer files than it was given", () => {
    expect(runProblems(0, "Ran 12 tests across 3 files. [1.00s]", 3)).toEqual([]);
    expect(runProblems(0, "Ran 0 tests across 0 files.", 0)).toContain("no test files were selected");
    expect(runProblems(1, "Ran 12 tests across 3 files.", 3)).toEqual(["bun test exited 1"]);
    expect(runProblems(null, "", 3)).toEqual(["bun test exited on a signal", 'bun printed no "Ran N tests across M files" summary']);
    expect(runProblems(0, "Ran 10 tests across 2 files.", 3)).toEqual(["bun ran 2 files, fewer than the 3 selected: files were dropped"]);
  });

  test("its arguments: a root, and one side", () => {
    expect(parseArgs(["--root", "scripts", "--darwin"])).toEqual({ root: "scripts", darwin: true, list: false });
    expect(parseArgs(["--root", "scripts", "--not-darwin", "--list"])).toEqual({ root: "scripts", darwin: false, list: true });
    expect(() => parseArgs(["--darwin"])).toThrow(/--root/);
    expect(() => parseArgs(["--root", "scripts"])).toThrow(/exactly one/);
    expect(() => parseArgs(["--root", "scripts", "--darwin", "--not-darwin"])).toThrow(/exactly one/);
  });
});
