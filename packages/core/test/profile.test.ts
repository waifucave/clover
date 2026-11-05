import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { cliCommandName, keychainService, profileDisplayName, resolveCloverProfile } from "../src/profile";

describe("profile", () => {
  test("cliCommandName: the command a hint names — clover-dev on the dev profile (the wrapper's), else clover", () => {
    expect(cliCommandName("dev")).toBe("clover-dev");
    expect(cliCommandName("dist")).toBe("clover");
  });
  test("resolveCloverProfile: dev only on exact CLOVER_PROFILE=dev", () => {
    expect(resolveCloverProfile({} as NodeJS.ProcessEnv)).toBe("dist");
    expect(resolveCloverProfile({ CLOVER_PROFILE: "dev" } as NodeJS.ProcessEnv)).toBe("dev");
    expect(resolveCloverProfile({ CLOVER_PROFILE: "prod" } as NodeJS.ProcessEnv)).toBe("dist");
    expect(resolveCloverProfile({ CLOVER_PROFILE: "" } as NodeJS.ProcessEnv)).toBe("dist");
  });

  test("keychainService: dist literal unchanged, dev suffixed", () => {
    expect(keychainService("dist")).toBe("com.waifucave.clover.core");
    expect(keychainService("dev")).toBe("com.waifucave.clover.core.dev");
  });

  test("profileDisplayName", () => {
    expect(profileDisplayName("dist")).toBe("Clover");
    expect(profileDisplayName("dev")).toBe("Clover Dev");
  });

  // Test-keychain-isolation fix (P9c-15 guard): CLOVER_KEYCHAIN_SERVICE overrides the returned
  // service ONLY for a non-default home. `test/preload.ts` sets this env var for the whole run, so
  // these tests save/restore it explicitly rather than relying on ambient state.
  describe("keychainService: CLOVER_KEYCHAIN_SERVICE override (P9c-15 default-home guard)", () => {
    let prevOverride: string | undefined;
    beforeEach(() => { prevOverride = process.env.CLOVER_KEYCHAIN_SERVICE; });
    afterEach(() => {
      if (prevOverride === undefined) delete process.env.CLOVER_KEYCHAIN_SERVICE;
      else process.env.CLOVER_KEYCHAIN_SERVICE = prevOverride;
    });

    test("ignored for the profile's own default home, even when set", () => {
      process.env.CLOVER_KEYCHAIN_SERVICE = "com.acme.override";
      expect(keychainService("dist", join(homedir(), ".clover"))).toBe("com.waifucave.clover.core");
      expect(keychainService("dev", join(homedir(), ".clover-dev"))).toBe("com.waifucave.clover.core.dev");
    });

    test("honoured for a non-default (e.g. a test's temp) home", () => {
      process.env.CLOVER_KEYCHAIN_SERVICE = "com.acme.override";
      expect(keychainService("dist", "/private/tmp/clover-test-home-xyz")).toBe("com.acme.override");
      expect(keychainService("dev", "/private/tmp/clover-test-home-xyz")).toBe("com.acme.override");
    });

    test("no override at all when the env var is unset, regardless of home", () => {
      delete process.env.CLOVER_KEYCHAIN_SERVICE;
      expect(keychainService("dist", "/private/tmp/clover-test-home-xyz")).toBe("com.waifucave.clover.core");
      expect(keychainService("dev", join(homedir(), ".clover-dev"))).toBe("com.waifucave.clover.core.dev");
    });
  });
});
