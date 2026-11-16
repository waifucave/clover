import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { appIdentity, daemonHome, parseLaunchArgs, resolveAppProfile } from "../src/main/identity";

describe("the app's identity (spec §2)", () => {
  test("MOSS_PROFILE=dev is the dev app; anything else is the dist app", () => {
    expect(resolveAppProfile({ MOSS_PROFILE: "dev" })).toBe("dev");
    expect(resolveAppProfile({})).toBe("dist");
    expect(resolveAppProfile({ MOSS_PROFILE: "DEV" })).toBe("dist");
  });

  test("dist and dev have their own app id and name (so their own user-data folder)", () => {
    expect(appIdentity("dist")).toEqual({ profile: "dist", appId: "com.waifucave.moss.code", productName: "MOSS Code" });
    expect(appIdentity("dev")).toEqual({ profile: "dev", appId: "com.waifucave.moss.code.dev", productName: "MOSS Code Dev" });
  });

  test("the daemon home follows MOSS_HOME, else ~/.moss — the daemon's own rule", () => {
    expect(daemonHome({ MOSS_HOME: "/tmp/h" }, "/Users/u")).toBe("/tmp/h");
    expect(daemonHome({}, "/Users/u")).toBe(join("/Users/u", ".moss"));
    expect(daemonHome({ MOSS_HOME: "" }, "/Users/u")).toBe(join("/Users/u", ".moss"));
  });

  test("the launch flags: the smoke run is headless; --moss-headless, --safe-mode, --quit, --moss-capture", () => {
    expect(parseLaunchArgs(["electron", ".", "--moss-smoke"])).toEqual({ smoke: true, headless: true, safeMode: false, quit: false });
    expect(parseLaunchArgs(["electron", "."])).toEqual({ smoke: false, headless: false, safeMode: false, quit: false });
    expect(parseLaunchArgs(["moss", "--moss-headless", "--safe-mode", "--moss-capture=/tmp/x.png"])).toEqual({ smoke: false, headless: true, capture: "/tmp/x.png", safeMode: true, quit: false });
    expect(parseLaunchArgs(["moss", "--quit"]).quit).toBe(true);
    expect(parseLaunchArgs(["moss"], { MOSS_APP_HEADLESS: "1" }).headless).toBe(true);
  });
});
