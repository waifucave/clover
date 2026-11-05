import { describe, expect, test } from "bun:test";
import { LEGACY_LAUNCHD_LABEL } from "@waifucave/clover-core";
import { renderPlist, migrateFromLaunchdAgent, launchdLabel } from "../src/launchd";

describe("renderPlist", () => {
  test("contains label, program arguments, keepalive, and log paths", () => {
    const xml = renderPlist({
      binaryPath: "/usr/local/bin/winter",
      cloverHome: "/Users/me/.clover",
    });
    expect(xml).toContain(`<string>${launchdLabel()}</string>`);
    expect(xml).toContain("<string>/usr/local/bin/winter</string>");
    expect(xml).toContain("<string>daemon</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<string>/Users/me/.clover/logs/core.out.log</string>");
    expect(xml).toContain("<string>/Users/me/.clover/logs/core.err.log</string>");
    expect(xml).not.toContain("~"); // launchd does not expand tildes
    expect(xml).toContain("<key>CLOVER_HOME</key>");
    expect(xml).toContain("<string>/Users/me/.clover</string>");
  });

  test("xml-escapes special characters in paths", () => {
    const xml = renderPlist({ binaryPath: "/a&b/clover", cloverHome: "/home/x<y>/.clover" });
    expect(xml).toContain("/a&amp;b/clover");
    expect(xml).toContain("/home/x&lt;y&gt;/.clover");
    expect(xml).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;)/);
  });
});

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

  test("renderPlist embeds the profile label", () => {
    const dev = renderPlist({ binaryPath: "/x/clover-core", cloverHome: "/tmp/h", profile: "dev" });
    expect(dev).toContain("<string>com.waifucave.clover.core.dev</string>");
    const dist = renderPlist({ binaryPath: "/x/clover-core", cloverHome: "/tmp/h", profile: "dist" });
    expect(dist).toContain("<string>com.waifucave.clover.core</string>");
    expect(dist).not.toContain("com.waifucave.clover.core.dev");
  });

  // DD branch review (I3): CLOVER_PROFILE must ride along in the plist's own EnvironmentVariables
  // for a dev-profile install (otherwise a launchd-installed dev daemon resolves
  // `keychainService()` to the dist Keychain literal despite living in ~/.clover-dev — silent
  // credential cross-contamination), and the dist plist must stay byte-identical to before this
  // fix (no new key at all, not even an empty one).
  test("dev plist carries CLOVER_PROFILE=dev; dist plist never mentions CLOVER_PROFILE", () => {
    const dev = renderPlist({ binaryPath: "/x/clover-core", cloverHome: "/tmp/h", profile: "dev" });
    expect(dev).toContain("<key>CLOVER_PROFILE</key><string>dev</string>");

    const dist = renderPlist({ binaryPath: "/x/clover-core", cloverHome: "/tmp/h", profile: "dist" });
    expect(dist).not.toContain("CLOVER_PROFILE");
  });

  // Byte-identity proof: the dist plist output must be EXACTLY what renderPlist produced before
  // this fix, character for character — not just "doesn't contain CLOVER_PROFILE". Passes
  // `profile: "dist"` explicitly (rather than relying on ambient `CLOVER_PROFILE` env resolution)
  // so this assertion can never flake against another test's env mutation.
  test("dist plist is byte-identical to the pre-fix output", () => {
    const xml = renderPlist({ binaryPath: "/usr/local/bin/winter", cloverHome: "/Users/me/.clover", profile: "dist" });
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.waifucave.clover.core</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/winter</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>CLOVER_HOME</key><string>/Users/me/.clover</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/me/.clover/logs/core.out.log</string>
  <key>StandardErrorPath</key><string>/Users/me/.clover/logs/core.err.log</string>
</dict>
</plist>
`
    );
  });
});
