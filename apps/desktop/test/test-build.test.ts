import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import { testBuildAppRefusal } from "../src/main/test-build";

// A test-marked app (scripts/test-build.ts): the mock keychain on, and its data under a home outside this account's.
// Paths in this OS's own form (`join`, `sep`), so the same cases hold on Windows and macOS.
describe("a test-marked app's start", () => {
  const root = process.platform === "win32" ? "C:\\" : "/";
  const account = join(root, "Users", "someone");
  const real = (p: string) => p.replace(/[\\/]+$/, "");
  test("starts with the mock keychain and a temp home", () => {
    expect(testBuildAppRefusal({ mockKeychain: true, home: join(root, "tmp", "run", ".clover"), account, real })).toBeUndefined();
    // A sibling whose name only starts with the account's is outside it.
    expect(testBuildAppRefusal({ mockKeychain: true, home: join(root, "Users", "someone-else", ".clover"), account, real })).toBeUndefined();
  });
  test("refuses where it would reach the login keychain or the live home", () => {
    expect(testBuildAppRefusal({ mockKeychain: false, home: join(root, "tmp", "run", ".clover"), account, real })).toContain("mock keychain is off");
    for (const home of [join(account, ".clover"), account, `${account}${sep}`, join(account, "x", "y"), ""]) {
      expect(testBuildAppRefusal({ mockKeychain: true, home, account, real })).toContain("inside this account's home");
    }
    expect(testBuildAppRefusal({ mockKeychain: false, home: "", account, real })).toContain("test-marked build");
  });
});
