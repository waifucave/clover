import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { appIdentity, daemonHome, daemonSocketPath, parseLaunchArgs, resolveAppProfile, WEB_PREFERENCES, windowOptions } from "../src/main/identity";

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
    expect(daemonSocketPath("/tmp/h")).toBe(join("/tmp/h", "run", "core.sock"));
  });

  test("--clover-smoke is the only launch flag", () => {
    expect(parseLaunchArgs(["electron", ".", "--clover-smoke"])).toEqual({ smoke: true });
    expect(parseLaunchArgs(["electron", "."])).toEqual({ smoke: false });
  });

  test("the window's renderer is sandboxed, isolated and has no Node", () => {
    expect(WEB_PREFERENCES).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false });
    expect(windowOptions(appIdentity("dev"))).toMatchObject({ title: "Clover Dev", show: false });
  });
});
