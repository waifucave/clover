import { describe, expect, test } from "bun:test";
import { testBuildAppRefusal } from "../src/main/test-build";

// A test-marked app (scripts/test-build.ts): the mock keychain on, and its data under a home outside this account's.
describe("a test-marked app's start", () => {
  const account = "/Users/someone";
  const real = (p: string) => p.replace(/\/+$/, "");
  test("starts with the mock keychain and a temp home", () => {
    expect(testBuildAppRefusal({ mockKeychain: true, home: "/tmp/run/.clover", account, real })).toBeUndefined();
    expect(testBuildAppRefusal({ mockKeychain: true, home: "/Users/someone-else/.clover", account, real })).toBeUndefined();
  });
  test("refuses where it would reach the login keychain or the live home", () => {
    expect(testBuildAppRefusal({ mockKeychain: false, home: "/tmp/run/.clover", account, real })).toContain("mock keychain is off");
    for (const home of ["/Users/someone/.clover", "/Users/someone", "/Users/someone/", "/Users/someone/x/y", ""]) {
      expect(testBuildAppRefusal({ mockKeychain: true, home, account, real })).toContain("inside this account's home");
    }
    expect(testBuildAppRefusal({ mockKeychain: false, home: "", account, real })).toContain("test-marked build");
  });
});
