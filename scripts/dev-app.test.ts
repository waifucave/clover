// scripts/dev-app.ts's plan. Nothing here builds or opens the app: a window on this screen is CI's alone (plan §8).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeDevAppPlan, DEV_APP_BUNDLE, devAppPlan, devAppSignSteps, devAppStale, electronBinaryMissing } from "./dev-app";
import { hostRequirement } from "../packages/core/src/host/world";
import { appRequirement } from "../packages/core/src/bundled-identities";

const plan = (argv: string[], platform: NodeJS.Platform = "linux", env: NodeJS.ProcessEnv = {}) => devAppPlan({ argv, env, platform, userHome: "/home/u" });

describe("the dev app's plan", () => {
  test("builds, then runs apps/desktop under Electron on ~/.moss-dev with the dev profile, on every OS", () => {
    for (const [platform, os] of [["darwin", "macos"], ["linux", "linux"], ["win32", "windows"]] as const) {
      expect(plan([], platform)).toEqual({
        os,
        home: "/home/u/.moss-dev",
        build: true,
        args: ["apps/desktop"],
        env: { MOSS_HOME: "/home/u/.moss-dev", MOSS_PROFILE: "dev" },
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
    expect(() => plan([], "linux", { MOSS_HOME: "/home/u/.moss" })).toThrow("dist home");
    expect(plan([], "linux", { MOSS_HOME: "/tmp/h" }).home).toBe("/tmp/h");
  });

  test("--dry-run says what would run, as which identity", () => {
    const lines = describeDevAppPlan(plan(["--dry-run"]), "/x/electron");
    expect(lines).toEqual([
      "dev:app: the plan on linux (dry run: nothing is built or opened)",
      "  home     /home/u/.moss-dev",
      "  build    (in apps/desktop) bun run build",
      "  run      /x/electron apps/desktop",
      "  as       MOSS Code Dev (com.waifucave.moss.code.dev), MOSS_HOME=/home/u/.moss-dev MOSS_PROFILE=dev",
    ]);
  });
});

describe("macOS: the dev app's signed copy (the daemon's app check takes only a signed MOSS Code Dev)", () => {
  test("--dry-run names the copy it signs and runs", () => {
    const lines = describeDevAppPlan(plan(["--dry-run"], "darwin"), "/x/electron");
    expect(lines[3]).toBe(`  sign     ${DEV_APP_BUNDLE} (a copy of Electron.app as com.waifucave.moss.code.dev, signed with the dev identity of team 37N77U9RSZ), unless it is already`);
    expect(lines[4]).toBe(`  run      ${DEV_APP_BUNDLE}/Contents/MacOS/Electron apps/desktop`);
  });

  test("copy, rename, sign the nested code inside out, sign the app as com.waifucave.moss.code.dev, check the daemon's requirement", () => {
    const hash = "A".repeat(40);
    const steps = devAppSignSteps({
      source: "/n/Electron.app", target: "/r/dist/dev/app/MOSS Code Dev.app", identityHash: hash, teamId: "37N77U9RSZ", entitlements: "/r/e.plist",
      nested: ["Electron Helper.app", "Squirrel.framework", "Electron Framework.framework", "Electron Helper (GPU).app", ".DS_Store"],
    });
    const T = "/r/dist/dev/app/MOSS Code Dev.app";
    expect(steps.slice(0, 6)).toEqual([
      ["rm", "-rf", T], ["mkdir", "-p", "/r/dist/dev/app"], ["ditto", "/n/Electron.app", T],
      ["plutil", "-replace", "CFBundleIdentifier", "-string", "com.waifucave.moss.code.dev", `${T}/Contents/Info.plist`],
      ["plutil", "-replace", "CFBundleName", "-string", "MOSS Code Dev", `${T}/Contents/Info.plist`],
      ["plutil", "-replace", "CFBundleDisplayName", "-string", "MOSS Code Dev", `${T}/Contents/Info.plist`],
    ]);
    // Frameworks first, then the helper apps (with the entitlements), never a stray file.
    expect(steps.slice(6, 10).map((s) => s.at(-1))).toEqual(["Electron Framework.framework", "Squirrel.framework", "Electron Helper (GPU).app", "Electron Helper.app"].map((n) => `${T}/Contents/Frameworks/${n}`));
    expect(steps[6]).not.toContain("--entitlements");
    expect(steps[8]).toContain("--entitlements");
    for (const s of steps.slice(6, 10)) expect(s.slice(0, 5)).toEqual(["codesign", "--force", "--deep", "--sign", hash]);
    // Every signature is hardened (the daemon's app check requires it), the app's with the packaging entitlements.
    for (const s of steps.slice(6, 11)) expect(s.join(" ")).toContain("--options runtime");
    expect(steps[10]![steps[10]!.indexOf("--entitlements") + 1]).toBe("/r/e.plist");
    expect(steps[10]).toContain("--identifier");
    expect(steps[10]![steps[10]!.indexOf("--identifier") + 1]).toBe("com.waifucave.moss.code.dev");
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
    const dir = mkdtempSync(join(tmpdir(), "moss-electron-"));
    try {
      expect(electronBinaryMissing(dir)).toBe(true);
      writeFileSync(join(dir, "path.txt"), "Electron.app/Contents/MacOS/Electron");
      expect(electronBinaryMissing(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the dev app carries the host's dev helper: made inside the copy, signed inside out as com.waifucave.moss.host.dev, checked, before the app seals it", () => {
  const hash = "A".repeat(40);
  const T = "/r/dist/dev/app/MOSS Code Dev.app";
  const H = `${T}/Contents/Frameworks/MOSS Host Dev.app`;
  const steps = devAppSignSteps({ source: "/n/Electron.app", target: T, identityHash: hash, teamId: "37N77U9RSZ", entitlements: "/e", nested: ["Electron Framework.framework", "Electron Helper (GPU).app"], host: { script: "/r/h.mjs", desktop: "/r/apps/desktop" } });
  const at = steps.findIndex((s) => s[1] === "/r/h.mjs");
  expect(steps[at]).toEqual(["bun", "/r/h.mjs", "make-dev", T, "/r/apps/desktop"]);
  expect(steps.slice(at + 1, at + 3).map((s) => s.at(-1))).toEqual([`${H}/Contents/Frameworks/Electron Framework.framework`, `${H}/Contents/Frameworks/MOSS Host Dev Helper (GPU).app`]);
  expect(steps[at + 3]![steps[at + 3]!.indexOf("--identifier") + 1]).toBe("com.waifucave.moss.host.dev");
  expect(steps[at + 4]).toEqual(["codesign", "--verify", "--deep", "--strict", `-R=${hostRequirement("dev", "37N77U9RSZ")}`, H]);
  // The app itself is signed after (it seals the helper), then checked.
  expect(steps.at(-2)!.at(-1)).toBe(T);
  expect(devAppStale(JSON.stringify({ electron: "45.2.3", identity: hash }), { electron: "45.2.3", identity: hash, host: 1 })).toBe(true);
});
