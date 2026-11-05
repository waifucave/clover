import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OTHER_INSTALL_HOMES } from "@waifucave/clover-core";
import { assertSafeTestHome, makeTempHome, UnsafeHomeError } from "../src/homes";

describe("temp homes", () => {
  test("a fresh home under the test process's temp root, with its env, removed by cleanup", () => {
    const a = makeTempHome({ name: "alpha one" });
    const b = makeTempHome();
    expect(a.home).not.toBe(b.home);
    expect(a.home.startsWith(tmpdir())).toBe(true);
    expect(a.home).toContain("clover-home-alpha-one-");
    expect(a.env).toEqual({ CLOVER_HOME: a.home, CLOVER_PROFILE: "dist" });
    a.cleanup();
    a.cleanup();
    expect(existsSync(a.home)).toBe(false);
    b.cleanup();
  });

  test("never inside a live install's folder, the agents' folders, or the user's home itself", () => {
    // A stand-in user home: the real one is never looked at.
    const fakeUserHome = mkdtempSync(join(tmpdir(), "clover-fake-user-"));
    for (const dir of [".clover", ".clover-dev", ...OTHER_INSTALL_HOMES.map((o) => o.dir), ".claude", ".claude.json.d"]) {
      expect(() => assertSafeTestHome(join(fakeUserHome, dir, "x"), fakeUserHome)).toThrow(UnsafeHomeError);
    }
    expect(() => assertSafeTestHome(fakeUserHome, fakeUserHome)).toThrow(UnsafeHomeError);
    expect(() => assertSafeTestHome(join(fakeUserHome, "projects", "x"), fakeUserHome)).not.toThrow();
    expect(() => assertSafeTestHome(join(tmpdir(), "anything"), fakeUserHome)).not.toThrow();
  });

  test("a link into a protected folder is refused by where it leads", () => {
    const fakeUserHome = mkdtempSync(join(tmpdir(), "clover-fake-user-"));
    mkdirSync(join(fakeUserHome, ".clover"));
    const link = join(mkdtempSync(join(tmpdir(), "clover-link-")), "innocent");
    symlinkSync(join(fakeUserHome, ".clover"), link);
    expect(() => assertSafeTestHome(join(link, "home"), fakeUserHome)).toThrow(/inside ~\/\.clover/);
  });
});
