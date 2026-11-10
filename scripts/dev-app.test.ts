// scripts/dev-app.ts's plan. Nothing here builds or opens the app: a window on this screen is CI's alone (plan §8).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeDevAppPlan, DEV_APP_BUNDLE, devAppPlan, devAppSignSteps, devAppStale, electronBinaryMissing } from "./dev-app";
import { appRequirement } from "../packages/core/src/bundled-identities";

const plan = (argv: string[], platform: NodeJS.Platform = "linux", env: NodeJS.ProcessEnv = {}) => devAppPlan({ argv, env, platform, userHome: "/home/u" });

describe("the dev app's plan", () => {
  test("builds, then runs apps/desktop under Electron on ~/.clover-dev with the dev profile, on every OS", () => {
    for (const [platform, os] of [["darwin", "macos"], ["linux", "linux"], ["win32", "windows"]] as const) {
      expect(plan([], platform)).toEqual({
        os,
        home: "/home/u/.clover-dev",
        build: true,
        args: ["apps/desktop"],
        env: { CLOVER_HOME: "/home/u/.clover-dev", CLOVER_PROFILE: "dev" },
        dryRun: false,
      });
    }
  });

  test("the flags, and Electron's arguments after them or after a --", () => {
    expect(plan(["--no-build"]).build).toBe(false);
    expect(plan(["--dry-run", "--no-build"])).toMatchObject({ dryRun: true, build: false });
    expect(plan(["--", "--no-build"]).args).toEqual(["apps/desktop", "--no-build"]);
    expect(plan(["--inspect=9229"]).args).toEqual(["apps/desktop", "--inspect=9229"]);
  });

  test("the dev home's own refusals: never the dist home", () => {
    expect(() => plan([], "linux", { CLOVER_HOME: "/home/u/.clover" })).toThrow("dist home");
    expect(plan([], "linux", { CLOVER_HOME: "/tmp/h" }).home).toBe("/tmp/h");
  });

  test("--dry-run says what would run, as which identity", () => {
    const lines = describeDevAppPlan(plan(["--dry-run"]), "/x/electron");
    expect(lines).toEqual([
      "dev:app: the plan on linux (dry run: nothing is built or opened)",
      "  home     /home/u/.clover-dev",
      "  build    (in apps/desktop) bun run build",
      "  run      /x/electron apps/desktop",
      "  as       Clover Dev (com.waifucave.clover.dev), CLOVER_HOME=/home/u/.clover-dev CLOVER_PROFILE=dev",
    ]);
  });
});

describe("macOS: the dev app's signed copy (the daemon's app check takes only a signed Clover Dev)", () => {
  test("--dry-run names the copy it signs and runs", () => {
    const lines = describeDevAppPlan(plan(["--dry-run"], "darwin"), "/x/electron");
    expect(lines[3]).toBe(`  sign     ${DEV_APP_BUNDLE} (a copy of Electron.app as com.waifucave.clover.dev, signed with the dev identity of team 37N77U9RSZ), unless it is already`);
    expect(lines[4]).toBe(`  run      ${DEV_APP_BUNDLE}/Contents/MacOS/Electron apps/desktop`);
  });

  test("copy, rename, sign the nested code inside out, sign the app as com.waifucave.clover.dev, check the daemon's requirement", () => {
    const hash = "A".repeat(40);
    const steps = devAppSignSteps({
      source: "/n/Electron.app", target: "/r/dist/dev/app/Clover Dev.app", identityHash: hash, teamId: "37N77U9RSZ", entitlements: "/r/e.plist",
      nested: ["Electron Helper.app", "Squirrel.framework", "Electron Framework.framework", "Electron Helper (GPU).app", ".DS_Store"],
    });
    const T = "/r/dist/dev/app/Clover Dev.app";
    expect(steps.slice(0, 6)).toEqual([
      ["rm", "-rf", T], ["mkdir", "-p", "/r/dist/dev/app"], ["ditto", "/n/Electron.app", T],
      ["plutil", "-replace", "CFBundleIdentifier", "-string", "com.waifucave.clover.dev", `${T}/Contents/Info.plist`],
      ["plutil", "-replace", "CFBundleName", "-string", "Clover Dev", `${T}/Contents/Info.plist`],
      ["plutil", "-replace", "CFBundleDisplayName", "-string", "Clover Dev", `${T}/Contents/Info.plist`],
    ]);
    // Frameworks first, then the helper apps (with the entitlements), never a stray file.
    expect(steps.slice(6, 10).map((s) => s.at(-1))).toEqual(["Electron Framework.framework", "Squirrel.framework", "Electron Helper (GPU).app", "Electron Helper.app"].map((n) => `${T}/Contents/Frameworks/${n}`));
    expect(steps[6]).not.toContain("--entitlements");
    expect(steps[8]).toContain("--entitlements");
    for (const s of steps.slice(6, 10)) expect(s.slice(0, 5)).toEqual(["codesign", "--force", "--deep", "--sign", hash]);
    expect(steps[10]).toContain("--identifier");
    expect(steps[10]![steps[10]!.indexOf("--identifier") + 1]).toBe("com.waifucave.clover.dev");
    expect(steps[10]).toContain(`-r=designated => ${appRequirement("dev")}`);
    expect(steps[10]!.at(-1)).toBe(T);
    expect(steps[11]).toEqual(["codesign", "--verify", "--deep", "--strict", `-R=${appRequirement("dev")}`, T]);
    expect(steps).toHaveLength(12);
    expect(devAppSignSteps({ source: "/n/Electron.app", target: T, identityHash: hash, teamId: "37N77U9RSZ", entitlements: "/e", nested: [], keychain: "/k.keychain" })[6]).toContain("/k.keychain");
    expect(() => devAppSignSteps({ source: "/n/Electron.app", target: T, identityHash: "Apple Development: x", teamId: "37N77U9RSZ", entitlements: "/e", nested: [] })).toThrow("SHA-1");
  });

  test("made again for another Electron or another identity, or a stamp it can't read", () => {
    const want = { electron: "45.2.3", identity: "A".repeat(40) };
    expect(devAppStale(null, want)).toBe(true);
    expect(devAppStale("{", want)).toBe(true);
    expect(devAppStale(JSON.stringify(want), want)).toBe(false);
    expect(devAppStale(JSON.stringify({ ...want, electron: "45.2.2" }), want)).toBe(true);
    expect(devAppStale(JSON.stringify({ ...want, identity: "B".repeat(40) }), want)).toBe(true);
  });
});

describe("Electron's binary", () => {
  test("is missing until its install step wrote path.txt (bun skips the postinstall)", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-electron-"));
    try {
      expect(electronBinaryMissing(dir)).toBe(true);
      writeFileSync(join(dir, "path.txt"), "Electron.app/Contents/MacOS/Electron");
      expect(electronBinaryMissing(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
