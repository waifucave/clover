// scripts/dev-app.ts's plan. Nothing here builds or opens the app: a window on this screen is CI's alone (plan §8).
import { describe, expect, test } from "bun:test";
import { describeDevAppPlan, devAppPlan } from "./dev-app";

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
