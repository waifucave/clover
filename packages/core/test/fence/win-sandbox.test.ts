// Windows Bash under the fence (lane C, C-M2 part 2): the sandbox command's pure half —
// launcher args, status parsing, the per-launch deny plan and the reset plan. No Windows needed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOVER_WFP_SUBLAYER, SANDBOX_EXIT, SANDBOX_PRINCIPAL, SRT_WIN_COMMIT, SRT_WIN_TAG,
  launcherHash, launcherPinned, parseSrtStatus, principalResetPlan, removeArgs, setupArgs,
  setupBashRefusal, setupExitMessage, srtWinPath, statusArgs, winCallerDenies, winLaunchDenies,
} from "../../src/fence/win-sandbox";
import type { SandboxPolicy } from "../../src/contracts/fence";

describe("the pinned launcher", () => {
  test("the pin names the controller's tag and commit", () => {
    expect(SRT_WIN_TAG).toBe("v0.0.81");
    expect(SRT_WIN_COMMIT).toBe("c40cf14a65d025e3cd27f071f13a73c12b3b1f92");
  });

  test("the sublayer GUID is a GUID, and the principal is hidden by name", () => {
    expect(CLOVER_WFP_SUBLAYER).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i);
    expect(SANDBOX_PRINCIPAL).toBe("clover-sandbox");
  });

  test("a missing launcher is missing, and only the exact hash pins", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-srt-"));
    const missing = join(dir, "srt-win.exe");
    expect(launcherHash(missing)).toEqual({ present: false, hash: null });
    expect(launcherPinned(missing, "abc")).toBe(false);
    const file = join(dir, "srt-win.exe");
    writeFileSync(file, "fake-launcher");
    expect(launcherHash(file).present).toBe(true);
    expect(launcherPinned(file, "abc")).toBe(false);
    expect(launcherPinned(file, launcherHash(file).hash!)).toBe(true);
  });

  test("the launcher lives beside clover-core, overridable for dev", () => {
    expect(srtWinPath("C:\\Program Files\\Clover\\clover-core.exe", {})).toBe("C:\\Program Files\\Clover\\srt-win.exe");
    expect(srtWinPath("/x/clover-core", { CLOVER_SRT_WIN: "/dev/srt-win.exe" })).toBe("/dev/srt-win.exe");
  });
});

describe("the sandbox command's args", () => {
  test("setup provisions the principal under Clover's sublayer, loopback closed", () => {
    const a = setupArgs("C:\\Clover\\srt-win.exe");
    expect(a).toEqual(["C:\\Clover\\srt-win.exe", "install", "--sandbox-user", "clover-sandbox", "--sublayer-guid", CLOVER_WFP_SUBLAYER]);
    expect(a.join(" ")).not.toContain("allow-loopback");
  });

  test("remove undoes everything; status never elevates", () => {
    expect(removeArgs("srt-win.exe")).toEqual(["srt-win.exe", "uninstall", "--sublayer-guid", CLOVER_WFP_SUBLAYER]);
    expect(removeArgs("srt-win.exe").join(" ")).not.toContain("keep-user");
    expect(statusArgs("srt-win.exe")).toEqual(["srt-win.exe", "status", "--sublayer-guid", CLOVER_WFP_SUBLAYER]);
  });

  test("install's exits map to setup's message, or none", () => {
    expect(setupExitMessage(0)).toBeNull();
    expect(setupExitMessage(10)).toContain("administrator");
    expect(setupExitMessage(13)).toContain("remove");
    expect(setupExitMessage(14)).toContain("principal");
    expect(setupExitMessage(1)).toContain("exit 1");
    expect(SANDBOX_EXIT).toEqual({ OK: 0, FAILED: 1, NOT_ELEVATED: 2, HASH_MISMATCH: 3 });
  });
});

describe("the status verdict", () => {
  const launcher = (() => {
    const dir = mkdtempSync(join(tmpdir(), "clover-srt-"));
    const file = join(dir, "srt-win.exe");
    writeFileSync(file, "fake-launcher");
    return { file, hash: launcherHash(file).hash! };
  })();

  test("a missing launcher, or a hash mismatch, is never ready", () => {
    const s = parseSrtStatus(JSON.stringify({ user: { exists: true } }), join(tmpdir(), "no-such-launcher.exe"), launcher.hash);
    expect(s.ready).toBe(false);
    expect(s.launcher.present).toBe(false);
    expect(launcherPinned(launcher.file, launcher.hash)).toBe(true);
    expect(launcherPinned(launcher.file, "0".repeat(64))).toBe(false);
  });

  test("anything but a matching-marker, existing principal with Secondary Logon up is refused", () => {
    // Exact shapes are pinned on the VM; here the parser must fail closed on unknown shapes.
    for (const stdout of ["not json", "{}", JSON.stringify({ user: null }), JSON.stringify({ user: { exists: false } })]) {
      const s = parseSrtStatus(stdout, launcher.file, launcher.hash);
      expect(s.ready).toBe(false);
    }
    // A marker from another build, or Secondary Logon down, is not usable.
    const other = (u: unknown) => parseSrtStatus(JSON.stringify({ user: u }), launcher.file, launcher.hash);
    expect(other({ exists: true, marker_version: "0", setup_version: "1", seclogon: "ok" }).ready).toBe(false);
    expect(other({ exists: true, marker_version: "1", setup_version: "1", seclogon: "disabled" }).ready).toBe(false);
    // The matching case is ready.
    const ok = other({ exists: true, sid: "S-1-5-21-1", marker_version: "1", setup_version: "1", seclogon: "ok" });
    expect(ok.ready).toBe(true);
    expect(ok.reason).toBeNull();
    expect(ok.user?.sid).toBe("S-1-5-21-1");
  });

  test("the refusal offers Set up Bash", () => {
    expect(setupBashRefusal("Bash isn't set up yet")).toContain("Set up Bash");
    expect(setupBashRefusal("Bash isn't set up yet")).toContain("sandbox setup");
    expect(setupBashRefusal(null)).toContain("Set up Bash");
  });
});

describe("the per-launch deny plan", () => {
  const policy: SandboxPolicy = {
    allowWrite: ["C:\\Users\\me", "C:\\Temp"],
    denyWrite: ["C:\\Users\\me\\.clover\\settings.json", "C:\\Users\\me\\.clover\\plugins-state\\oks"],
    denyRead: ["C:\\Users\\me\\.clover\\run"],
    closedDoors: ["schtasks", "Register-ScheduledTask"],
    blockedAddresses: ["169.254.169.254"],
    network: "none",
  };
  const home = "C:\\Users\\me\\.clover";

  test("the fenced set is denied, and every other runner is denied all of bots\\*\\memory", () => {
    const d = winLaunchDenies({ policy, cloverHome: home, caller: { sessionId: "s1", bot: "luna", botsOwnSession: true }, bots: ["luna", "sol"] });
    expect(d.denyWrite).toContain("C:\\Users\\me\\.clover\\settings.json");
    expect(d.denyRead).toContain("C:\\Users\\me\\.clover\\run");
    // Sol's memory: no reads, no writes; Luna's own: granted, never denied.
    expect(d.denyRead.join("|")).toContain("sol");
    expect(d.denyWrite.join("|")).toContain("sol");
    expect(d.denyRead.join("|")).not.toContain("luna");
    expect(d.denyWrite.filter((p) => p.endsWith("memory")).join("|")).not.toContain("luna");
    expect(d.ownMemory).toContain("luna");
  });

  test("a coding session with no bot owns no memory and reads no state", () => {
    const d = winCallerDenies({ cloverHome: home, caller: { sessionId: "s9" }, bots: ["luna"] });
    expect(d.ownMemory).toBeNull();
    expect(d.denyRead.join("|")).toContain("luna");
    expect(d.denyRead.join("|")).toContain("sessions-runtime");
    expect(d.denyWrite.join("|")).toContain("sessions-runtime");
  });

  test("the reset plan removes the profile by SID and fails closed on what's left", () => {
    const plan = principalResetPlan({ sid: "S-1-5-21-1-2-3-1001", profileRoot: "C:\\Users\\clover-sandbox" });
    expect(plan.map((s) => s.name)).toEqual(["unload-hive", "remove-profile-key", "remove-profile-dir", "remove-leftover-dirs"]);
    expect(plan.filter((s) => s.required).map((s) => s.name)).toEqual(["remove-profile-key", "remove-profile-dir"]);
    expect(plan.map((s) => s.argv.join(" ")).join("\n")).toContain("S-1-5-21-1-2-3-1001");
  });
});
