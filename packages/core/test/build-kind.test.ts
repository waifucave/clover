import { expect, test } from "bun:test";
import { DIST_BUILD, DIST_BUILD_DEFINE, isCompiledBinary, noteIgnoredEnvOverride } from "../src/build-kind";

test("a core run from source is not a dist build (only build-daemon's define makes one)", () => {
  expect(DIST_BUILD).toBe(false);
  expect(DIST_BUILD_DEFINE).toBe("__CLOVER_DIST__=true");
});

test("compiled-binary paths on every OS, and a checkout's", () => {
  expect(isCompiledBinary("/$bunfs/root/clover-core")).toBe(true);
  expect(isCompiledBinary("B:/~BUN/root/clover-core.exe")).toBe(true);
  expect(isCompiledBinary("B:\\~BUN\\root\\clover-core.exe")).toBe(true);
  expect(isCompiledBinary("/Users/x/clover/packages/cli/src/main.ts")).toBe(false);
  expect(isCompiledBinary("C:\\src\\clover\\packages\\cli\\src\\main.ts")).toBe(false);
});

test("an ignored override is said once per variable", () => {
  const lines: string[] = [];
  noteIgnoredEnvOverride("CLOVER_TEST_ONCE_A", (l) => lines.push(l));
  noteIgnoredEnvOverride("CLOVER_TEST_ONCE_A", (l) => lines.push(l));
  noteIgnoredEnvOverride("CLOVER_TEST_ONCE_B", (l) => lines.push(l));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("ignoring CLOVER_TEST_ONCE_A");
});
