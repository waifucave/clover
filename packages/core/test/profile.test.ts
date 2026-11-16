import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { cliCommandName, keychainService, profileDisplayName, resolveMossProfile } from "../src/profile";

describe("profile", () => {
  test("cliCommandName: the command a hint names — moss-dev on the dev profile (the wrapper's), else moss", () => {
    expect(cliCommandName("dev")).toBe("moss-dev");
    expect(cliCommandName("dist")).toBe("moss");
  });
  test("resolveMossProfile: dev only on exact MOSS_PROFILE=dev", () => {
    expect(resolveMossProfile({} as NodeJS.ProcessEnv)).toBe("dist");
    expect(resolveMossProfile({ MOSS_PROFILE: "dev" } as NodeJS.ProcessEnv)).toBe("dev");
    expect(resolveMossProfile({ MOSS_PROFILE: "prod" } as NodeJS.ProcessEnv)).toBe("dist");
    expect(resolveMossProfile({ MOSS_PROFILE: "" } as NodeJS.ProcessEnv)).toBe("dist");
  });

  test("keychainService: dist literal unchanged, dev suffixed", () => {
    expect(keychainService("dist")).toBe("com.waifucave.moss.core");
    expect(keychainService("dev")).toBe("com.waifucave.moss.core.dev");
  });

  test("profileDisplayName", () => {
    expect(profileDisplayName("dist")).toBe("MOSS");
    expect(profileDisplayName("dev")).toBe("MOSS Dev");
  });

  // Test-keychain-isolation fix (P9c-15 guard): MOSS_KEYCHAIN_SERVICE overrides the returned
  // service ONLY for a non-default home. `test/preload.ts` sets this env var for the whole run, so
  // these tests save/restore it explicitly rather than relying on ambient state.
  describe("keychainService: MOSS_KEYCHAIN_SERVICE override (P9c-15 default-home guard)", () => {
    let prevOverride: string | undefined;
    beforeEach(() => { prevOverride = process.env.MOSS_KEYCHAIN_SERVICE; });
    afterEach(() => {
      if (prevOverride === undefined) delete process.env.MOSS_KEYCHAIN_SERVICE;
      else process.env.MOSS_KEYCHAIN_SERVICE = prevOverride;
    });

    test("ignored for the profile's own default home, even when set", () => {
      process.env.MOSS_KEYCHAIN_SERVICE = "com.acme.override";
      expect(keychainService("dist", join(homedir(), ".moss"))).toBe("com.waifucave.moss.core");
      expect(keychainService("dev", join(homedir(), ".moss-dev"))).toBe("com.waifucave.moss.core.dev");
    });

    test("honoured for a non-default (e.g. a test's temp) home", () => {
      process.env.MOSS_KEYCHAIN_SERVICE = "com.acme.override";
      expect(keychainService("dist", "/private/tmp/moss-test-home-xyz")).toBe("com.acme.override");
      expect(keychainService("dev", "/private/tmp/moss-test-home-xyz")).toBe("com.acme.override");
    });

    test("the override is reported once per process for each home and service, however often it is resolved", () => {
      process.env.MOSS_KEYCHAIN_SERVICE = "com.acme.override-once";
      const lines: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        for (let i = 0; i < 1000; i++) expect(keychainService("dev", "/private/tmp/moss-test-home-once")).toBe("com.acme.override-once");
        keychainService("dev", "/private/tmp/moss-test-home-other");
      } finally {
        console.warn = warn;
      }
      expect(lines.filter((l) => l.includes("override honoured")).map((l) => l.includes("home-once") ? "once" : "other")).toEqual(["once", "other"]);
    });

    test("no override at all when the env var is unset, regardless of home", () => {
      delete process.env.MOSS_KEYCHAIN_SERVICE;
      expect(keychainService("dist", "/private/tmp/moss-test-home-xyz")).toBe("com.waifucave.moss.core");
      expect(keychainService("dev", join(homedir(), ".moss-dev"))).toBe("com.waifucave.moss.core.dev");
    });
  });
});
