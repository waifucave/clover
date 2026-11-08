// scripts/platform-tests.ts: which test files run on macOS (`*.darwin.test.ts`) and which on Linux, and the check
// that keeps a macOS-only test from sitting, unmarked, in a file that runs on Linux.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  configProblems, gatesOnDarwin, isClearCrash, isDarwinTest, macosFiles, parseArgs, parseConfig, parseJunit, runProblems, select, shardOf, slowestTests,
  skipProblems, testFiles, usesDarwinOnly, windowsConfigProblems, windowsSelection,
} from "./platform-tests";

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

  test("its arguments: a root, one side, and Linux's shard and lists", () => {
    expect(parseArgs(["--root", "scripts", "--darwin"])).toEqual({ root: "scripts", cwd: undefined, darwin: true, windows: false, shard: undefined, config: undefined, checkKnownFailures: false, list: false, timeoutMs: undefined, slowest: 0 });
    expect(parseArgs(["--root", "scripts", "--darwin", "--timeout", "20000", "--slowest", "10"])).toMatchObject({ timeoutMs: 20000, slowest: 10 });
    expect(() => parseArgs(["--root", "scripts", "--darwin", "--timeout", "20s"])).toThrow(/positive whole number/);
    expect(() => parseArgs(["--root", "scripts", "--darwin", "--slowest", "0"])).toThrow(/positive whole number/);
    expect(parseArgs(["--root", "packages/core", "--cwd", "packages/core", "--not-darwin", "--shard", "2/3", "--config", "c.json", "--check-known-failures", "--list"]))
      .toEqual({ root: "packages/core", cwd: "packages/core", darwin: false, windows: false, shard: { k: 2, n: 3 }, config: "c.json", checkKnownFailures: true, list: true, timeoutMs: undefined, slowest: 0 });
    expect(() => parseArgs(["--darwin"])).toThrow(/--root/);
    expect(() => parseArgs(["--root", "scripts"])).toThrow(/exactly one/);
    expect(() => parseArgs(["--root", "scripts", "--darwin", "--not-darwin"])).toThrow(/exactly one/);
    expect(() => parseArgs(["--root", "x", "--not-darwin", "--shard", "4/3"])).toThrow(/K\/N/);
    expect(() => parseArgs(["--root", "x", "--darwin", "--shard", "1/3"])).toThrow(/Linux/);
    expect(parseArgs(["--root", "x", "--windows"])).toMatchObject({ windows: true, darwin: false });
    expect(() => parseArgs(["--root", "x", "--windows", "--not-darwin"])).toThrow(/exactly one/);
    expect(() => parseArgs(["--root", "x", "--windows", "--shard", "1/2"])).toThrow(/Linux/);
  });

  test("--windows: the windowsFiles patterns over the Linux files; its lists reviewed like Linux's", () => {
    const linux = ["test/runtime-sdk/turn-loop/units.test.ts", "test/runtime-sdk/turn-loop/driver.e2e.test.ts", "test/sessions/store.test.ts", "test/other.test.ts"];
    expect(windowsSelection(linux, ["test/runtime-sdk/turn-loop/**", "test/sessions/*.test.ts"])).toEqual(linux.slice(0, 3));
    const cfg = parseConfig(JSON.stringify({
      windowsFiles: ["test/runtime-sdk/turn-loop/**", "test/nothing/**"],
      windowsKnownFailures: { "test/runtime-sdk/turn-loop/driver.e2e.test.ts": { owner: "C", cause: "no Windows sandbox" }, "test/other.test.ts": { owner: "A", cause: "c" } },
      windowsSkips: { "test/runtime-sdk/turn-loop/units.test.ts": "r" },
    }));
    expect(windowsConfigProblems(cfg, linux)).toEqual([
      "windowsFiles has test/nothing/**, which matches no test file Linux runs",
      "windowsKnownFailures lists test/other.test.ts, which --windows doesn't run (not matched by windowsFiles, or no longer a test file)",
    ]);
    expect(() => parseConfig(JSON.stringify({ windowsKnownFailures: { "x.test.ts": { owner: "C" } } }))).toThrow(/windowsKnownFailures.*owner and a cause/);
    expect(() => parseConfig(JSON.stringify({ windowsFiles: [""] }))).toThrow(/patterns/);
    // Skips are reviewed against windowsSkips, not linuxSkips.
    const ran = new Map([["a.test.ts", { tests: 2, skipped: 1, failures: 0 }]]);
    const skipCfg = parseConfig(JSON.stringify({ linuxSkips: { "a.test.ts": "r" } }));
    expect(skipProblems(["a.test.ts"], ran, skipCfg, () => "", true)).toEqual(["a.test.ts skipped 1 of 2 tests on Windows: mark its macOS tests (darwinTest/darwinDescribe or *.darwin.test.ts), or review the skip in windowsSkips"]);
  });

  test("Linux's shards deal every file once, in path order", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"];
    const parts = [1, 2, 3].map((k) => shardOf(files, k, 3));
    expect(parts).toEqual([["a", "d", "g"], ["b", "e"], ["c", "f"]]);
    expect(parts.flat().sort()).toEqual(files);
  });

  test("the macOS job takes the *.darwin.test.ts files and the mixed ones that import the helper", () => {
    const src: Record<string, string> = {
      "a.darwin.test.ts": "", "b.test.ts": 'import { darwinTest } from "../helpers/darwin-only";', "c.test.ts": "import { test } from \"bun:test\";",
    };
    expect(macosFiles(Object.keys(src), (f) => src[f]!)).toEqual(["a.darwin.test.ts", "b.test.ts"]);
    expect(usesDarwinOnly(src["b.test.ts"]!)).toBe(true);
  });

  test("the reviewed lists: entries need an owner, a cause or a reason, name Linux files, and go stale loudly", () => {
    expect(() => parseConfig(JSON.stringify({ linuxKnownFailures: { "x.test.ts": { owner: "A" } } }))).toThrow(/owner and a cause/);
    expect(() => parseConfig(JSON.stringify({ linuxSkips: { "x.test.ts": "" } }))).toThrow(/reason/);
    const q = `"${"dar"}${"win"}"`;
    const src: Record<string, string> = {
      "gated.test.ts": `test.skipIf(process.platform !== ${q})("x", () => {});`,
      "marked.test.ts": `import { darwinTest } from "./helpers/darwin-only";\ntest.skipIf(process.platform !== ${q})("x", () => {});`,
      "plain.test.ts": "test(\"x\", () => {});",
    };
    const cfg = parseConfig(JSON.stringify({ linuxKnownFailures: { "gone.test.ts": { owner: "A", cause: "c" } }, darwinGateAllowed: { "plain.test.ts": "r" } }));
    expect(configProblems(cfg, Object.keys(src), (f) => src[f]!)).toEqual([
      "linuxKnownFailures lists gone.test.ts, which is not a test file Linux runs (moved, renamed or marked .darwin?)",
      "gated.test.ts gates tests on darwin but runs on Linux: name it *.darwin.test.ts, or mark its macOS tests with darwinTest/darwinDescribe (test/helpers/darwin-only.ts)",
      "darwinGateAllowed lists plain.test.ts, which no longer looks like a darwin gate: remove the entry",
    ]);
  });

  test("Linux's skips: only a marked file or a reviewed one may skip or run nothing, and a review that skipped nothing is stale", () => {
    const xml = [
      '<testsuites name="bun test" tests="9">',
      '  <testsuite name="a.test.ts" file="a.test.ts" tests="3" assertions="3" failures="0" skipped="1" time="0">',
      '    <testsuite name="inner" file="a.test.ts" tests="3" skipped="1" failures="0">',
      '    </testsuite>',
      '  </testsuite>',
      '  <testsuite name="b.test.ts" file="b.test.ts" tests="4" failures="0" skipped="0" time="0">',
      '  </testsuite>',
      '  <testsuite name="c.test.ts" file="c.test.ts" tests="2" failures="0" skipped="2" time="0">',
      '  </testsuite>',
      '</testsuites>',
    ].join("\n");
    const ran = parseJunit(xml);
    expect(ran.get("a.test.ts")).toEqual({ tests: 3, skipped: 1, failures: 0 });
    expect(ran.size).toBe(3);
    const src: Record<string, string> = { "a.test.ts": "", "b.test.ts": "", "c.test.ts": 'import { darwinTest } from "./helpers/darwin-only";', "d.test.ts": "" };
    const cfg = parseConfig(JSON.stringify({ linuxSkips: { "b.test.ts": "r" } }));
    expect(skipProblems(Object.keys(src), ran, cfg, (f) => src[f]!)).toEqual([
      "a.test.ts skipped 1 of 3 tests on Linux: mark its macOS tests (darwinTest/darwinDescribe or *.darwin.test.ts), or review the skip in linuxSkips",
      "linuxSkips lists b.test.ts, which skipped nothing on Linux: remove the entry",
      "d.test.ts ran no tests on Linux: mark its macOS tests (darwinTest/darwinDescribe or *.darwin.test.ts), or review the skip in linuxSkips",
    ]);
  });

  test("a todo is pending on every OS, not a Linux skip: it doesn't count as skipped", () => {
    const xml = [
      '<testsuites name="bun test" tests="5">',
      '  <testsuite name="t.test.ts" file="t.test.ts" tests="3" failures="0" skipped="2" time="0">',
      '    <testsuite name="Tree" file="t.test.ts" tests="3" failures="0" skipped="2">',
      '      <testcase name="ok" file="t.test.ts" />',
      '      <testcase name="later" file="t.test.ts">',
      '        <skipped message="TODO" />',
      '      </testcase>',
      '      <testcase name="gated" file="t.test.ts">',
      '        <skipped />',
      '      </testcase>',
      '    </testsuite>',
      '  </testsuite>',
      '  <testsuite name="u.test.ts" file="u.test.ts" tests="2" failures="0" skipped="1" time="0">',
      '    <testcase name="pending" file="u.test.ts">',
      '      <skipped message="TODO" />',
      '    </testcase>',
      '  </testsuite>',
      '  <testsuite name="e.test.ts" file="e.test.ts" tests="0" failures="0" skipped="0" time="0" />',
      '</testsuites>',
    ].join("\n");
    const ran = parseJunit(xml);
    expect(ran.get("t.test.ts")).toEqual({ tests: 3, skipped: 1, failures: 0 });
    expect(ran.get("u.test.ts")).toEqual({ tests: 2, skipped: 0, failures: 0 });
    expect(ran.get("e.test.ts")).toEqual({ tests: 0, skipped: 0, failures: 0 });
  });

  test("the slowest tests, from bun's JUnit report: slowest first, named by file, suite and test", () => {
    const xml = [
      '<testsuites name="bun test" tests="4">',
      '  <testsuite name="a.test.ts" file="a.test.ts" tests="3" failures="0" skipped="0" time="6">',
      '    <testsuite name="sync.config" file="a.test.ts" tests="2" failures="0" skipped="0" time="5.2">',
      '      <testcase name="a real daemon serves &quot;the effort&quot;" classname="sync.config" time="5.129" file="a.test.ts" line="3" assertions="2" />',
      '      <testcase name="quick" classname="sync.config" time="0.004" file="a.test.ts" line="9" assertions="1" />',
      '    </testsuite>',
      '    <testcase name="top level" classname="" time="0.8" file="a.test.ts" line="20" assertions="1">',
      '      <skipped message="TODO" />',
      '    </testcase>',
      '  </testsuite>',
      '  <testsuite name="b.test.ts" file="b.test.ts" tests="1" failures="0" skipped="0" time="2">',
      '    <testcase name="mid" classname="B" time="2.25" file="b.test.ts" line="1" assertions="1" />',
      '  </testsuite>',
      '</testsuites>',
    ].join("\n");
    expect(slowestTests(xml, 3)).toEqual([
      { seconds: 5.129, test: 'a.test.ts > sync.config > a real daemon serves "the effort"' },
      { seconds: 2.25, test: "b.test.ts > B > mid" },
      { seconds: 0.8, test: "a.test.ts > top level" },
    ]);
    expect(slowestTests(xml, 10)).toHaveLength(4);
  });

  test("a clear Bun crash is exit 133 or a signal with no summary", () => {
    expect(isClearCrash(133, "")).toBe(true);
    expect(isClearCrash(null, "")).toBe(true);
    expect(isClearCrash(133, "Ran 3 tests across 1 file.")).toBe(false);
    expect(isClearCrash(1, "")).toBe(false);
  });

  test("the core's reviewed lists match its tree: every Linux file that gates on darwin is marked or reviewed", () => {
    const root = join(repo, "packages", "core");
    const rel = (f: string) => f.slice("packages/core/".length);
    const linux = select(testFiles(repo, "packages/core"), false).map(rel);
    const cfg = parseConfig(readFileSync(join(root, "test", "platform-ci.json"), "utf8"));
    expect(configProblems(cfg, linux, (f) => readFileSync(join(root, f), "utf8"))).toEqual([]);
    // Each Linux and Windows known failure names its owner lane and its cause.
    for (const e of [...Object.values(cfg.linuxKnownFailures), ...Object.values(cfg.windowsKnownFailures)]) expect(e.owner).toMatch(/^[A-M]$/);
    expect(windowsConfigProblems(cfg, linux)).toEqual([]);
  });
});
