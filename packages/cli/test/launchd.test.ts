import { describe, expect, test } from "bun:test";
import { LEGACY_LAUNCHD_LABEL } from "@waifucave/clover-core";
import { migrateFromLaunchdAgent, launchdLabel } from "../src/launchd";

// C-M1 retired this file's own LaunchAgent installer (`installDaemon`, `renderPlist`, …): login start
// is core's `platform/login/` behind `clover autostart`, tested in packages/core/test/platform/. What
// stays here is the teardown of the historical pre-rename agent and the profile label.

describe("migrateFromLaunchdAgent", () => {
  const fakePath = `/fake/Library/LaunchAgents/${LEGACY_LAUNCHD_LABEL}.plist`;

  // M-M0: the legacy agent is a legacy install's item, kept as the rollback source — off by the code's own switch
  // (`migration/legacy-imports.ts`), the teardown looks at nothing. The tests below opt in with `enabled: true`.
  test("off by default: no exists check, no bootout, no remove", async () => {
    const calls: string[] = [];
    await migrateFromLaunchdAgent({
      plistPath: fakePath,
      exists: () => { calls.push("exists"); return true; },
      bootout: async () => { calls.push("bootout"); },
      remove: () => { calls.push("remove"); },
    });
    expect(calls).toEqual([]);
  });

  test("unloads an existing legacy plist: bootout(label) then remove(path)", async () => {
    let bootoutLabel: string | undefined;
    let removedPath: string | undefined;

    await migrateFromLaunchdAgent({
      enabled: true,
      plistPath: fakePath,
      exists: (p) => p === fakePath,
      bootout: async (label) => { bootoutLabel = label; },
      remove: (p) => { removedPath = p; },
    });

    expect(bootoutLabel).toBe(LEGACY_LAUNCHD_LABEL);
    expect(removedPath).toBe(fakePath);
  });

  // The historical agent's label (`LEGACY_LAUNCHD_LABEL`, `legacy-names.ts`) is NOT today's CURRENT
  // dist label (`launchdLabel("dist")`): the rename made those two strings different again after
  // briefly (and only textually) colliding. This teardown must keep targeting the pre-rename
  // literal regardless of CLOVER_PROFILE, or of the product's own name — imported, never
  // hardcoded (the residue test forbids the legacy literal outside `legacy-names.ts`).
  test("keeps the historical literal label regardless of CLOVER_PROFILE", async () => {
    const prev = process.env.CLOVER_PROFILE;
    process.env.CLOVER_PROFILE = "dev";
    let bootoutLabel: string | undefined;
    try {
      await migrateFromLaunchdAgent({
        enabled: true,
        plistPath: fakePath,
        exists: (p) => p === fakePath,
        bootout: async (label) => { bootoutLabel = label; },
        remove: () => {},
      });
    } finally {
      if (prev === undefined) delete process.env.CLOVER_PROFILE; else process.env.CLOVER_PROFILE = prev;
    }
    expect(bootoutLabel).toBe(LEGACY_LAUNCHD_LABEL);
    expect(bootoutLabel).not.toBe(launchdLabel("dist"));
  });

  test("no-ops when the plist is absent: no bootout, no remove call, never throws", async () => {
    let bootoutCalled = false;
    let removeCalled = false;

    await expect(migrateFromLaunchdAgent({
      enabled: true,
      plistPath: fakePath,
      exists: () => false,
      bootout: async () => { bootoutCalled = true; },
      remove: () => { removeCalled = true; },
    })).resolves.toBeUndefined();

    expect(bootoutCalled).toBe(false);
    expect(removeCalled).toBe(false);
  });

  test("never throws even when bootout or remove fail", async () => {
    await expect(migrateFromLaunchdAgent({
      enabled: true,
      plistPath: fakePath,
      exists: () => true,
      bootout: async () => { throw new Error("launchctl bootout failed"); },
      remove: () => { throw new Error("unlink failed"); },
    })).resolves.toBeUndefined();
  });
});


describe("launchd profile label", () => {
  test("label derives from profile, dist literal unchanged", () => {
    expect(launchdLabel("dist")).toBe("com.waifucave.clover.core");
    expect(launchdLabel("dev")).toBe("com.waifucave.clover.core.dev");
  });
});
