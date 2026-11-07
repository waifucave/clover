import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { appIdentity, daemonHome, parseLaunchArgs, resolveAppProfile } from "../src/main/identity";

describe("the app's identity (spec §2)", () => {
  test("CLOVER_PROFILE=dev is the dev app; anything else is the dist app", () => {
    expect(resolveAppProfile({ CLOVER_PROFILE: "dev" })).toBe("dev");
    expect(resolveAppProfile({})).toBe("dist");
    expect(resolveAppProfile({ CLOVER_PROFILE: "DEV" })).toBe("dist");
  });

  test("dist and dev have their own app id and name (so their own user-data folder)", () => {
    expect(appIdentity("dist")).toEqual({ profile: "dist", appId: "com.waifucave.clover", productName: "Clover" });
    expect(appIdentity("dev")).toEqual({ profile: "dev", appId: "com.waifucave.clover.dev", productName: "Clover Dev" });
  });

  test("the daemon home follows CLOVER_HOME, else ~/.clover — the daemon's own rule", () => {
    expect(daemonHome({ CLOVER_HOME: "/tmp/h" }, "/Users/u")).toBe("/tmp/h");
    expect(daemonHome({}, "/Users/u")).toBe(join("/Users/u", ".clover"));
    expect(daemonHome({ CLOVER_HOME: "" }, "/Users/u")).toBe(join("/Users/u", ".clover"));
  });

  test("the launch flags: the smoke run is headless; --clover-headless, --safe-mode, --quit, --clover-capture", () => {
    expect(parseLaunchArgs(["electron", ".", "--clover-smoke"])).toEqual({ smoke: true, headless: true, safeMode: false, quit: false });
    expect(parseLaunchArgs(["electron", "."])).toEqual({ smoke: false, headless: false, safeMode: false, quit: false });
    expect(parseLaunchArgs(["clover", "--clover-headless", "--safe-mode", "--clover-capture=/tmp/x.png"])).toEqual({ smoke: false, headless: true, capture: "/tmp/x.png", safeMode: true, quit: false });
    expect(parseLaunchArgs(["clover", "--quit"]).quit).toBe(true);
    expect(parseLaunchArgs(["clover"], { CLOVER_APP_HEADLESS: "1" }).headless).toBe(true);
  });
});
