// C0: the daemon's brand is MOSS's names on the SDK's `BrandProfile`, with only the preset and the
// process label taken from the SDK's own default (`WINTER_BRAND`, which keeps Winter's names until
// lane A renames the SDK). Validated by the SDK's OWN `resolveBrand`, not by a mirror of its rules
// here: the rules live in one place (`sdk/src/brand.ts`) and a copy in a test would rot the first
// time the SDK tightened one.
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mcpToolName, resolveBrand, resolveWinterHome as sdkResolveHome, WINTER_BRAND,
  type BrandProfile,
} from "@waifucave/clover-agent-sdk";
import { keychainService } from "../../src/profile";
import { buildCoreBrand, CORE_BRAND } from "../../src/runtime-sdk/brand";
import { CORE_VERSION } from "../../src/version";
import { resolveMossHome } from "../../src/moss-dir";

/** The fourteen fields `BrandProfile` has (surface map §1.5 / global constraints). */
const FIELDS: Array<keyof BrandProfile> = [
  "productName", "packageName", "homeDirName", "projectDirName", "instructionsFile", "envPrefix",
  "keychainService", "mcpServerName", "presetName", "processLabel", "codexOriginator",
  "tempRootName", "pluginManifestDir", "contactUrl",
];

/** The only fields the daemon takes from the SDK's default as they are. */
const FROM_THE_SDK: ReadonlyArray<keyof BrandProfile> = ["presetName", "processLabel"];

describe("CORE_BRAND", () => {
  test("all fourteen fields are present, string, and non-empty — and there are no others", () => {
    for (const f of FIELDS) {
      expect(typeof CORE_BRAND[f]).toBe("string");
      expect((CORE_BRAND[f] as string).length).toBeGreaterThan(0);
    }
    // The count is pinned against WINTER_BRAND rather than a literal 14, so a future SDK field
    // makes this fail here (where the fix is one line) instead of at a child's first session.
    // A-M1: plus `productVersion` (SDK 0.0.63), which Winter's own brand leaves out.
    expect(Object.keys(CORE_BRAND).sort()).toEqual([...Object.keys(WINTER_BRAND), "productVersion"].sort());
    expect(Object.keys(CORE_BRAND).sort()).toEqual([...FIELDS, "productVersion"].sort());
    expect(CORE_BRAND.productVersion).toBe(CORE_VERSION);
  });

  test("the SDK's own resolveBrand reports it valid", () => {
    const v = resolveBrand(CORE_BRAND);
    expect(v.ok ? "" : v.reason).toBe(""); // the reason names the offending field when it is not ok
    expect(v.ok).toBe(true);
  });

  test("every field but the preset and the process label is MOSS's, never the SDK's Winter default", () => {
    const dist = buildCoreBrand("dist");
    const same = FIELDS.filter((f) => dist[f] === WINTER_BRAND[f]);
    expect(same.sort()).toEqual([...FROM_THE_SDK].sort());
    expect(dist).toEqual({
      productName: "MOSS",
      packageName: "moss-core",
      homeDirName: ".moss",
      projectDirName: ".moss",
      instructionsFile: "MOSS.md",
      envPrefix: "MOSS_",
      keychainService: "com.waifucave.moss.core",
      mcpServerName: "moss",
      presetName: WINTER_BRAND.presetName,
      processLabel: WINTER_BRAND.processLabel,
      codexOriginator: "moss",
      tempRootName: "moss",
      pluginManifestDir: ".moss-plugin",
      contactUrl: "https://github.com/waifucave/moss",
      productVersion: CORE_VERSION,
    });
  });

  // The dev/dist split the SDK's own default has no notion of; `auth/secret-store.ts`'s `SERVICE`
  // resolves the identical way.
  test("dev: only keychainService differs from dist, at exactly com.waifucave.moss.core.dev", () => {
    const dist = buildCoreBrand("dist");
    const dev = buildCoreBrand("dev");
    expect(FIELDS.filter((f) => dev[f] !== dist[f])).toEqual(["keychainService"]);
    expect(dev.keychainService).toBe("com.waifucave.moss.core.dev");
    expect(dev.keychainService).toBe(keychainService("dev"));
    expect(resolveBrand(dev).ok).toBe(true);
  });

  test("mcpToolName produces the capability names under moss", () => {
    expect(mcpToolName(CORE_BRAND, "x")).toBe("mcp__moss__x");
    expect(mcpToolName(CORE_BRAND, "sessions__list_sessions")).toBe("mcp__moss__sessions__list_sessions");
    expect(mcpToolName(CORE_BRAND, "computer__computer")).toBe("mcp__moss__computer__computer");
  });

  test("envPrefix carries its trailing underscore (ENV_PREFIX_RE requires it)", () => {
    expect(CORE_BRAND.envPrefix).toBe("MOSS_");
    expect(resolveBrand({ ...CORE_BRAND, envPrefix: "MOSS" }).ok).toBe(false);
  });

  test("keychainService is profile-aware and equals the daemon's own", () => {
    expect(buildCoreBrand("dist").keychainService).toBe(keychainService("dist"));
    expect(buildCoreBrand("dev").keychainService).toBe(keychainService("dev"));
    // The default (what CORE_BRAND itself froze at module load) follows the process's profile.
    expect(CORE_BRAND.keychainService).toBe(keychainService());
    expect(CORE_BRAND.keychainService).toBe(keychainService(undefined));
  });

  // THE HOME ALIGNMENT: a MOSS-branded session resolves its home from the SAME env var and default
  // core's own resolver does, so the daemon's home and the runtime's home are ONE directory, and
  // never Winter's. Asserted by comparing the SDK's own resolver (given CORE_BRAND) against core's
  // own `resolveMossHome()` under the SAME env, rather than by duplicating the SDK's rules here.
  describe("the SDK's home resolver under CORE_BRAND equals core's own resolver", () => {
    const savedHome = process.env.MOSS_HOME;
    const savedProfile = process.env.MOSS_PROFILE;
    afterEach(() => {
      if (savedHome === undefined) delete process.env.MOSS_HOME; else process.env.MOSS_HOME = savedHome;
      if (savedProfile === undefined) delete process.env.MOSS_PROFILE; else process.env.MOSS_PROFILE = savedProfile;
    });

    test("under a temp MOSS_HOME", () => {
      delete process.env.MOSS_PROFILE;
      process.env.MOSS_HOME = "/tmp/some-moss-home-for-brand-test";
      expect(sdkResolveHome(undefined, CORE_BRAND)).toBe(resolveMossHome());
      expect(resolveMossHome()).toBe("/tmp/some-moss-home-for-brand-test");
    });

    // Every real entry point sets `MOSS_HOME` and `MOSS_PROFILE` TOGETHER under the dev profile
    // (CLAUDE.md's own dev command: `MOSS_HOME=~/.moss-dev MOSS_PROFILE=dev …`) — so this is
    // the alignment that actually holds in production. NOT tested here: `MOSS_PROFILE=dev` ALONE,
    // with no explicit `MOSS_HOME`: core's own `resolveMossHome()` reads only `MOSS_HOME`, with
    // no profile-derived `-dev` suffix of its own (a gap that predates the rename).
    test("under MOSS_PROFILE=dev with the matching explicit MOSS_HOME", () => {
      process.env.MOSS_HOME = "/tmp/some-moss-dev-home-for-brand-test";
      process.env.MOSS_PROFILE = "dev";
      expect(sdkResolveHome(undefined, CORE_BRAND)).toBe(resolveMossHome());
      expect(resolveMossHome()).toBe("/tmp/some-moss-dev-home-for-brand-test");
    });

    // With nothing set, the runtime's default home under the daemon's brand is the shared SDK home
    // under `~/.moss` (WS-21), never anything under Winter's `~/.winter`. Paths only: nothing is read.
    test("with no MOSS_HOME, the runtime's default home is under ~/.moss, never ~/.winter", () => {
      delete process.env.MOSS_PROFILE;
      delete process.env.MOSS_HOME;
      expect(sdkResolveHome(undefined, CORE_BRAND)).toBe(join(homedir(), ".moss", "sdk"));
      expect(sdkResolveHome(undefined, CORE_BRAND)).not.toContain("/.winter");
    });

    // A shell that still exports Winter's variables (the live install's, or an old dev one) must not
    // move a MOSS home: under CORE_BRAND the runtime reads only `MOSS_*`.
    test("Winter's WINTER_HOME and WINTER_PROFILE in the environment are ignored", () => {
      const savedWinterHome = process.env.WINTER_HOME;
      const savedWinterProfile = process.env.WINTER_PROFILE;
      try {
        delete process.env.MOSS_PROFILE;
        process.env.MOSS_HOME = "/tmp/some-moss-home-for-brand-test";
        process.env.WINTER_HOME = "/tmp/a-winter-home-that-must-be-ignored";
        process.env.WINTER_PROFILE = "dev";
        expect(sdkResolveHome(undefined, CORE_BRAND)).toBe("/tmp/some-moss-home-for-brand-test");
        expect(resolveMossHome()).toBe("/tmp/some-moss-home-for-brand-test");
      } finally {
        if (savedWinterHome === undefined) delete process.env.WINTER_HOME; else process.env.WINTER_HOME = savedWinterHome;
        if (savedWinterProfile === undefined) delete process.env.WINTER_PROFILE; else process.env.WINTER_PROFILE = savedWinterProfile;
      }
    });
  });
});
