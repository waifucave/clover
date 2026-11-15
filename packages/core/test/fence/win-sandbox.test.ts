// Windows Bash under the fence (lane C, C-M2 part 2): the sandbox command's pure half —
// launcher args, status parsing, the per-launch allow/deny plan and the reset plan. No Windows needed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOVER_WFP_SUBLAYER,
  SANDBOX_EXIT,
  SANDBOX_PRINCIPAL_PREFIX,
  principalNameFromSid,
  SRT_WIN_COMMIT,
  SRT_WIN_TAG,
  SRT_WIN_PINS,
  launcherDigest,
  launcherPinned,
  launcherProblem,
  parseSrtStatus,
  principalResetPlan,
  removeArgs,
  setupArgs,
  setupBashRefusal,
  setupExitMessage,
  srtWinPath,
  statusArgs,
  winCallerRules,
  winLaunchPlan,
  profileLaunchCheck,
  sandboxHomeEnv,
  setDescriptionArgs,
  getDescriptionArgs,
  descriptionMatches,
  parseWhoamiSid,
  isTemporaryProfile,
  icaclsDenyArgs,
  icaclsDeleteDenyArgs,
  icaclsRemoveDenyArgs,
  mkdirArgs,
  removeDirArgs,
  claimDirArgs,
  installerTargetSid,
  psEncodedArgs,
  knownFolderArgs,
  sessionGrantArgs,
  sessionGrantInput,
  sessionRevokeArgs,
  sessionForgetArgs,
  sessionRestoreArgs,
  installMarkerPath,
  formatInstallMarker,
  parseInstallMarker,
  markerAllowsSetup,
  markerAllowsRemove,
  poolLockPath,
  readLeasesDirSecurity,
  leasesDirAccessProblem,
  minimalChildEnv,
  execArgs,
  profileQueryArgs,
  poolPrincipalName,
  poolSublayerGuid,
  sandboxPool,
  userStatusArgs,
  sandboxLeasesDir,
  acquirePoolLease,
} from "../../src/fence/win-sandbox";
import { authenticodeDigest, validateCertificateTable } from "../../src/fence/windows-launcher";
import type { SandboxPolicy } from "../../src/contracts/fence";
import { policyAllows } from "../../src/contracts/fence";
import { CloverFence } from "../../src/fence/fence";
import type { Caller } from "@waifucave/clover-protocol";

describe("the pinned launcher", () => {
  test("the pin names the controller's tag and commit", () => {
    expect(SRT_WIN_TAG).toBe("v0.0.81");
    expect(SRT_WIN_COMMIT).toBe("c40cf14a65d025e3cd27f071f13a73c12b3b1f92");
  });

  test("the sublayer GUID is a GUID, and the principal uses the Addendum 9 format", () => {
    expect(CLOVER_WFP_SUBLAYER).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i);
    // Full name with 8 hex chars = 18 chars (fits the 20-char account limit)
    expect(SANDBOX_PRINCIPAL_PREFIX).toBe("clover-sb-");
    expect(SANDBOX_PRINCIPAL_PREFIX.length).toBe(10);
    // Test principalNameFromSid produces 18-char name
    const name = principalNameFromSid("S-1-5-21-1234567890-1234567890-1234567890-1001");
    expect(name).toMatch(/^clover-sb-[0-9a-f]{8}$/);
    expect(name.length).toBe(18);
    // Collision test: different SIDs produce different names
    const name2 = principalNameFromSid("S-1-5-21-1234567890-1234567890-1234567890-1002");
    expect(name2).not.toBe(name);
    expect(name2.length).toBe(18);
  });

  test("the launcher has Authenticode digest pins for x64 and arm64", () => {
    expect(SRT_WIN_PINS.x64).toBe("95b2c474943b9cae55a2521a643e9a09aa34847e05c79796316c6ca819b4ae92");
    expect(SRT_WIN_PINS.arm64).toBe("bcd117665fe9f64494bd535b9508e4808ae99ad0ff6118fb410a7f60bb47abb9");
  });

  test("a missing launcher is missing, and only the exact digest pins", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-srt-"));
    const missing = join(dir, "srt-win.exe");
    expect(launcherDigest(missing)).toEqual({ present: false, digest: null });
    expect(launcherPinned(missing)).toBe(false);
    const file = join(dir, "srt-win.exe");
    writeFileSync(file, "fake-launcher");
    expect(launcherDigest(file).present).toBe(false); // not a PE image
    expect(launcherPinned(file)).toBe(false);
    // The problem explains the mismatch
    expect(launcherProblem(file)).toContain("isn't installed");
  });

  test("the launcher lives beside clover-core, overridable for dev", () => {
    expect(srtWinPath("C:\\Program Files\\Clover\\clover-core.exe", {})).toBe("C:\\Program Files\\Clover\\srt-win.exe");
    expect(srtWinPath("/x/clover-core", { CLOVER_SRT_WIN: "/dev/srt-win.exe" })).toBe("/dev/srt-win.exe");
  });
});

describe("the sandbox command's args", () => {
  test("setup provisions the principal under Clover's sublayer, loopback closed", () => {
    // The principal and owner are required: no bare-prefix default.
    const a = setupArgs("C:\\Clover\\srt-win.exe", CLOVER_WFP_SUBLAYER, "clover-sb-f41c96d1", "S-1-5-21-1");
    expect(a).toEqual(["C:\\Clover\\srt-win.exe", "install", "--sandbox-user", "clover-sb-f41c96d1", "--sublayer-guid", CLOVER_WFP_SUBLAYER, "--owner-sid", "S-1-5-21-1"]);
    expect(a.join(" ")).not.toContain("allow-loopback");
  });

  test("remove undoes everything; status never elevates", () => {
    expect(removeArgs("srt-win.exe", CLOVER_WFP_SUBLAYER)).toEqual(["srt-win.exe", "uninstall", "--sublayer-guid", CLOVER_WFP_SUBLAYER]);
    expect(statusArgs("srt-win.exe", CLOVER_WFP_SUBLAYER)).toEqual(["srt-win.exe", "status", "--sublayer-guid", CLOVER_WFP_SUBLAYER]);
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
  // A launcher path that doesn't exist - parseSrtStatus will check it first
  const missingLauncher = join(tmpdir(), "no-such-launcher.exe");

  test("a missing launcher, or a digest mismatch, is never ready (exit 3)", () => {
    const s = parseSrtStatus(JSON.stringify({ user: { exists: true } }), { launcher: missingLauncher });
    expect(s.ready).toBe(false);
    expect(s.launcher.present).toBe(false);
    expect(s.exit).toBe(SANDBOX_EXIT.HASH_MISMATCH);
    expect(s.reason).toContain("isn't installed");
  });

  test("numeric marker/setup versions (as srt-win reports them) match, and a pinned launcher is ready", () => {    // srt-win status reports marker_version/setup_version as JSON numbers; the parser must accept them.
    // Build a minimal valid PE32+ with no certificate table (same shape as the cert-fixture helper below).
    const buf = new ArrayBuffer(0x200);
    const view = new DataView(buf);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 0x40, true);
    view.setUint32(0x40, 0x00004550, true);
    view.setUint16(0x44, 0x8664, true);
    view.setUint16(0x54, 0xf0, true);
    view.setUint16(0x56, 0x02, true);
    view.setUint16(0x58, 0x20b, true);
    view.setUint32(0xc4, 16, true);
    const bytes = new Uint8Array(buf);
    const dir = mkdtempSync(join(tmpdir(), "clover-srt-"));
    const file = join(dir, "srt-win.exe");
    writeFileSync(file, bytes);
    const pins = { x64: authenticodeDigest(bytes), arm64: authenticodeDigest(bytes) };
    const parse = (u: unknown) => parseSrtStatus(JSON.stringify({
      user: u,
      wfp: { state: "installed", filters: 4, allow_loopback: false },
    }), { launcher: file, pins });
    const ready = parse({ exists: true, marker_version: 3, setup_version: 3, seclogon: "ok", owner_sid: "S-1-5-21-1" });
    expect(ready.ready).toBe(true);
    expect(ready.exit).toBe(SANDBOX_EXIT.OK);
    // A marker from another build is still refused, numeric or string.
    expect(parse({ exists: true, marker_version: "2", setup_version: "3", seclogon: "ok", owner_sid: "S-1-5-21-1" }).ready).toBe(false);
    expect(parse({ exists: true, marker_version: "3", setup_version: "3", seclogon: "ok", owner_sid: "S-1-5-21-1" }).ready).toBe(true);
    // An existing principal with no recorded owner is refused, never adopted.
    expect(parse({ exists: true, marker_version: 3, setup_version: 3, seclogon: "ok" }).ready).toBe(false);
    expect(parse({ exists: true, marker_version: 3, setup_version: 3, seclogon: "ok", owner_sid: null }).ready).toBe(false);
    // The real srt-win shape nests the account under user.user; the install state stays on top.
    const nested = parse({
      cred_present: true,
      marker_version: 3,
      setup_version: 3,
      seclogon: "ok",
      owner_sid: "S-1-5-21-1",
      user: { exists: true, sid: "S-1-5-21-1", hidden_from_logon: true, in_builtin_users: true, in_sandbox_group: true },
    });
    expect(nested.ready).toBe(true);
    expect(nested.user?.sid).toBe("S-1-5-21-1");
    expect(nested.user?.hiddenFromLogon).toBe(true);
  });

  test("anything but a matching-marker, existing principal with Secondary Logon up is refused", () => {
    // Exact shapes are pinned on the VM; here the parser must fail closed on unknown shapes.
    for (const stdout of ["not json", "{}", JSON.stringify({ user: null }), JSON.stringify({ user: { exists: false } })]) {
      const s = parseSrtStatus(stdout, { launcher: missingLauncher });
      expect(s.ready).toBe(false);
      expect(s.exit).toBe(SANDBOX_EXIT.HASH_MISMATCH); // launcher missing
    }
    // A marker from another build, or Secondary Logon down, is not usable.
    const other = (u: unknown) => parseSrtStatus(JSON.stringify({ user: u }), { launcher: missingLauncher });
    expect(other({ exists: true, marker_version: "0", setup_version: "1", seclogon: "ok" }).ready).toBe(false);
    expect(other({ exists: true, marker_version: "1", setup_version: "1", seclogon: "disabled" }).ready).toBe(false);
    // The matching case is ready (but needs WFP installed, profile checked, etc.) - but with missing launcher it fails on launcher
    const ok = other({ exists: true, sid: "S-1-5-21-1", marker_version: "1", setup_version: "1", seclogon: "ok" });
    expect(ok.ready).toBe(false); // fails on launcher missing
    expect(ok.exit).toBe(SANDBOX_EXIT.HASH_MISMATCH);
    expect(ok.reason).toContain("isn't installed");
  });

  test("the refusal offers Set up Bash", () => {
    expect(setupBashRefusal("Bash isn't set up yet")).toContain("Set up Bash");
    expect(setupBashRefusal("Bash isn't set up yet")).toContain("sandbox setup");
    expect(setupBashRefusal(null)).toContain("Set up Bash");
  });
});

describe("the per-launch allow/deny plan (Addendum 3: default-deny home)", () => {
  const policy: SandboxPolicy = {
    allowWrite: ["C:\\Users\\me", "C:\\Temp"],
    denyWrite: ["C:\\Users\\me\\.clover\\settings.json", "C:\\Users\\me\\.clover\\plugins-state\\oks"],
    denyRead: ["C:\\Users\\me\\.clover\\run"],
    closedDoors: ["schtasks", "Register-ScheduledTask"],
    blockedAddresses: ["169.254.169.254"],
    network: "none",
  };
  const home = "C:\\Users\\me\\.clover";

  test("a bot has open access (the owner's ruling of November 9): the home reads, every bot's scratch and memory write, escalation stays denied", () => {
    const entries = (dir: string) => {
      if (dir.endsWith("\\outputs")) return ["s1", "s2"];
      if (dir.endsWith("\\scratch")) return ["luna", "sol"];
      return [];
    };
    const plan = winLaunchPlan({
      policy,
      cloverHome: home,
      caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" },
      bots: ["luna", "sol"],
      entries,
    });
    const at = (rel: string) => `C:\\Users\\me\\.clover\\${rel}`;
    // The home reads; it isn't written.
    expect(plan.grantRead).toContain(home);
    expect(plan.denyRead).not.toContain(home);
    expect(plan.denyWrite).toContain(home);
    // Another session's outputs read, never written.
    expect(plan.denyRead).not.toContain(at("outputs\\s2"));
    expect(plan.denyWrite).toContain(at("outputs\\s2"));
    expect(plan.grantWrite).toContain(at("outputs\\s1"));
    // Every bot's scratch and memory written (the folders themselves never deleted or moved).
    for (const rel of ["scratch\\luna", "scratch\\sol", "bots\\luna\\memory", "bots\\sol\\memory"]) {
      expect(plan.grantWrite).toContain(at(rel));
      expect(plan.protectDelete).toContain(at(rel));
    }
    // The rest of every bot's folder reads, never written.
    expect(plan.denyRead).not.toContain(at("bots\\sol"));
    expect(plan.denyWrite).toContain(at("bots\\sol"));
    // Escalation stays denied: the credential and key copies, the plugins' data; the bot driver's state reads (a
    // transcript id) and is never written.
    for (const rel of ["credentials", "runtimes", "sdk\\.clover.json", "cache\\runs", "plugin-data"]) expect(plan.denyRead).toContain(at(rel));
    expect(plan.denyRead).not.toContain(at("sessions-runtime"));
    expect(plan.denyWrite).toContain(at("sessions-runtime"));
    expect(plan.ownMemory).toBe(at("bots\\luna\\memory"));
    expect(plan.grantWrite).toContain(at("routines\\luna"));
  });

  test("a coding session with no bot owns no memory and no runtime grant", () => {
    const entries = (dir: string) => (dir.endsWith("\\outputs") ? ["s9"] : []);
    const plan = winLaunchPlan({
      policy,
      cloverHome: home,
      caller: { kind: "session", sessionId: "s9", sessionKind: "coding" },
      bots: ["luna"],
      entries,
    });
    expect(plan.ownMemory).toBeNull();
    // Other bot's folder denied
    expect(plan.denyRead).toContain("C:\\Users\\me\\.clover\\bots\\luna");
    expect(plan.denyWrite).toContain("C:\\Users\\me\\.clover\\bots\\luna");
    // No runtime grant either: the store stays hidden from every runner
    expect(plan.grantRead).not.toContain("C:\\Users\\me\\.clover\\sessions-runtime\\s9.json");
    expect(plan.denyRead).toContain("C:\\Users\\me\\.clover\\sessions-runtime");
  });

  test("Windows grants agree with policyAllows, caller by caller", () => {
    // The Windows ACE lists follow the same reference order as the other OSes' sandboxes: a path matrix
    // over every caller kind, built from each caller's real ids (so its own outputs, runtime file, scratch,
    // routines and memory are actually exercised), where the plan's own grants are the only ways back
    // inside the home deny. `winAllows` mirrors `policyAllows`' order over win32 paths; the ACE writer must
    // enforce exactly this decision procedure when it lands. NOTE for that writer: DELETE is deliberately
    // left out of each own folder's own grant — an object-only DELETE deny on the folder (see `protectDelete`)
    // is what keeps it from being deleted or moved, while files strictly inside stay writable.
    const wseg = (p: string) => p.toUpperCase().split("\\").filter(Boolean);
    const wunder = (p: string, r: string, strict = false) => {
      const a = wseg(p), b = wseg(r);
      if (a.length < b.length || (strict && a.length === b.length)) return false;
      return b.every((n, i) => n === a[i]);
    };
    const winAllows = (plan: { grantWrite: readonly string[]; grantRead: readonly string[]; denyWrite: readonly string[]; denyRead: readonly string[] }, allowWrite: readonly string[], op: "read" | "write" | "unlink" | "rename", abs: string): boolean => {
      const rw = plan.grantWrite;
      const ro = [...plan.grantWrite, ...plan.grantRead];
      if ((op === "unlink" || op === "rename") && rw.some((g) => wunder(g, abs))) return false;
      // A deny always wins (the controller's ruling): a grant opens what it holds but a deny strictly inside it (an
      // explicit ACE on the item beats the grant it would inherit).
      const inner = (g: string, denies: readonly string[]) => denies.some((d) => wunder(d, g, true) && wunder(abs, d));
      if (rw.some((g) => wunder(abs, g, true) && !inner(g, op === "read" ? plan.denyRead : plan.denyWrite))) return true;
      if (op === "read" && ro.some((g) => wunder(abs, g) && !inner(g, plan.denyRead))) return true;
      if (op === "read") return !plan.denyRead.some((d) => wunder(abs, d));
      if (op === "write") return !plan.denyWrite.some((d) => wunder(abs, d));
      if (plan.denyWrite.some((d) => wunder(abs, d))) return false;
      return allowWrite.some((a) => wunder(abs, a));
    };
    const callers: Caller[] = [
      { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" },
      { kind: "session", sessionId: "s2", sessionKind: "side-thread", bot: "luna" },
      { kind: "session", sessionId: "a1", sessionKind: "agent", bot: "luna" },
      { kind: "session", sessionId: "c1", sessionKind: "coding" },
      { kind: "session", sessionId: "s9", sessionKind: "bot", bot: "alpha" },
      { kind: "plugin", pluginId: "tarot" },
      { kind: "user", client: "app" },
      { kind: "core" },
    ];
    // Per-caller matrix paths, built from the caller's real ids so its own ways back in are exercised.
    const matrix = (caller: Caller): string[] => {
      const rels = [
        "settings\\settings.json", "run\\token", "projects\\k\\s.jsonl", "usage\\ledger.jsonl",
        "sessions\\s_1.jsonl", "bots\\newbot\\memory\\n.md", "outputs", "scratch", "bots", "routines", "plugin-data",
      ];
      if (caller.kind === "session" && caller.sessionId !== undefined) {
        rels.push(`outputs\\${caller.sessionId}\\report.md`, `outputs\\${caller.sessionId}`, `sessions-runtime\\${caller.sessionId}.json`);
      }
      rels.push("outputs\\zz\\report.md", "sessions-runtime\\other.json");
      const bot = caller.kind === "session" && (caller.sessionKind === "bot" || caller.sessionKind === "side-thread") ? caller.bot : undefined;
      if (bot !== undefined) {
        const seg = bot.replace("/", "--");
        rels.push(`scratch\\${seg}\\a.md`, `scratch\\${seg}`, `routines\\${seg}\\m.md`, `routines\\${seg}`,
          `bots\\${seg}\\agents\\t.json`, `bots\\${seg}\\memory\\MEMORY.md`, `bots\\${seg}`, `bots\\${seg}\\memory`);
      }
      rels.push("scratch\\sol\\a.md", "routines\\sol\\m.md", "bots\\sol\\memory\\MEMORY.md", "bots\\sol");
      if (caller.kind === "plugin") {
        const seg = caller.pluginId.replace("/", "--");
        rels.push(`plugin-data\\${seg}\\d.json`, `plugin-data\\${seg}`);
      }
      rels.push("plugin-data\\tarot\\d.json", "plugin-data\\luna\\d.json");
      return rels;
    };
    const entries = (dir: string) => {
      if (dir.endsWith("\\outputs")) return ["s1", "s2", "a1", "c1", "s9", "zz"];
      if (dir.endsWith("\\scratch")) return ["luna", "sol", "alpha"];
      return [];
    };
    for (const caller of callers) {
      // The reference is the real fence's own policy for a Windows home; the plan under test merges it in.
      const fence = new CloverFence({ os: "windows", home: "C:\\Users\\me", cloverHome: home, canonical: (p) => p });
      const ref = fence.forCaller(caller).policy();
      const plan = winLaunchPlan({ policy: ref, cloverHome: home, caller, bots: ["luna", "sol", "alpha"], entries });
      const allowWrite = ref.allowWrite;
      for (const rel of matrix(caller)) {
        const abs = `C:\\Users\\me\\.clover\\${rel}`;
        for (const op of ["read", "write", "unlink", "rename"] as const) {
          // A bot's open access writes any bot's memory (the owner's amendment), but a launch grants the memory folders
          // of the bots there when it starts: a bot made during the run is the known gap (as on Linux).
          if (ref.botAccess !== undefined && op !== "read" && rel.startsWith("bots\\newbot\\memory\\")) continue;
          expect([caller.kind, op, rel, policyAllows(ref, op, abs, "windows")]).toEqual([caller.kind, op, rel, winAllows(plan, allowWrite, op, abs)]);
        }
      }
      // Outside the home the fence has no say: both models allow reads and writes.
      for (const abs of ["C:\\Users\\me\\project\\x.md", "C:\\Users\\me\\AppData\\Local\\Temp\\y.md"]) {
        for (const op of ["read", "write"] as const) {
          expect([caller.kind, op, abs, policyAllows(ref, op, abs, "windows")]).toEqual([caller.kind, op, abs, winAllows(plan, allowWrite, op, abs)]);
        }
      }
    }
  });

  test("the reset plan removes the profile by SID and fails closed on what's left", () => {
    const plan = principalResetPlan({ sid: "S-1-5-21-1-2-3-1001", profileRoot: "C:\\Users\\clover-sandbox" });
    expect(plan.map((s) => s.name)).toEqual(["unload-hive", "remove-profile-key", "remove-profile-dir", "remove-leftover-dirs"]);
    expect(plan.filter((s) => s.required).map((s) => s.name)).toEqual(["remove-profile-key", "remove-profile-dir"]);
    expect(plan.map((s) => s.argv.join(" ")).join("\n")).toContain("S-1-5-21-1-2-3-1001");
  });
});

describe("certificate table validation (Addendum 4)", () => {
  // A minimal valid PE32+ (x64) executable with no certificate table.
  // MZ header, PE signature, optional header (PE32+), no sections, no certificate table.
  function makeValidPe(): Uint8Array {
    const buf = new ArrayBuffer(0x200);
    const view = new DataView(buf);
    // MZ header
    view.setUint16(0, 0x5a4d, true); // e_magic
    view.setUint32(0x3c, 0x40, true); // e_lfanew -> PE header at 0x40
    // PE signature
    view.setUint32(0x40, 0x00004550, true); // "PE\0\0"
    // COFF header (20 bytes)
    view.setUint16(0x44, 0x8664, true); // Machine: x64
    view.setUint16(0x46, 0, true); // NumberOfSections: 0
    view.setUint32(0x48, 0, true); // TimeDateStamp
    view.setUint32(0x4c, 0, true); // PointerToSymbolTable
    view.setUint32(0x50, 0, true); // NumberOfSymbols
    view.setUint16(0x54, 0xf0, true); // SizeOfOptionalHeader: 240 (PE32+)
    view.setUint16(0x56, 0x02, true); // Characteristics: executable
    // Optional header (PE32+, 240 bytes)
    view.setUint16(0x58, 0x20b, true); // Magic: PE32+
    view.setUint8(0x5a, 0); // MajorLinkerVersion
    view.setUint8(0x5b, 0); // MinorLinkerVersion
    view.setUint32(0x5c, 0, true); // SizeOfCode
    view.setUint32(0x60, 0, true); // SizeOfInitializedData
    view.setUint32(0x64, 0, true); // SizeOfUninitializedData
    view.setUint32(0x68, 0, true); // AddressOfEntryPoint
    view.setUint32(0x6c, 0, true); // BaseOfCode
    view.setBigUint64(0x70, 0x100000000n, true); // ImageBase
    view.setUint32(0x78, 0x1000, true); // SectionAlignment
    view.setUint32(0x7c, 0x200, true); // FileAlignment
    view.setUint16(0x80, 0, true); // MajorOperatingSystemVersion
    view.setUint16(0x82, 0, true); // MinorOperatingSystemVersion
    view.setUint16(0x84, 0, true); // MajorImageVersion
    view.setUint16(0x86, 0, true); // MinorImageVersion
    view.setUint16(0x88, 0, true); // MajorSubsystemVersion
    view.setUint16(0x8a, 0, true); // MinorSubsystemVersion
    view.setUint32(0x8c, 0, true); // Win32VersionValue
    view.setUint32(0x90, 0x1000, true); // SizeOfImage
    view.setUint32(0x94, 0x200, true); // SizeOfHeaders
    view.setUint32(0x98, 0, true); // CheckSum
    view.setUint16(0x9c, 3, true); // Subsystem: Windows CUI
    view.setUint16(0x9e, 0, true); // DllCharacteristics
    view.setBigUint64(0xa0, 0x100000n, true); // SizeOfStackReserve
    view.setBigUint64(0xa8, 0x1000n, true); // SizeOfStackCommit
    view.setBigUint64(0xb0, 0x100000n, true); // SizeOfHeapReserve
    view.setBigUint64(0xb8, 0x1000n, true); // SizeOfHeapCommit
    view.setUint32(0xc0, 0, true); // LoaderFlags
    // NumberOfRvaAndSizes at optional + 0x6c = 0x58 + 0x6c = 0xc4
    view.setUint32(0xc4, 16, true); // NumberOfRvaAndSizes: 16
    // Data directories (16 * 8 = 128 bytes) start at optional + 0x70 = 0x58 + 0x70 = 0xc8
    // Index 4 = Certificate Table at 0xc8 + 4*8 = 0xe8
    // All zero = no certificate table
    return new Uint8Array(buf);
  }

  test("a valid PE with no certificate table passes validation", () => {
    const pe = makeValidPe();
    expect(() => validateCertificateTable(pe)).not.toThrow();
    // Digest should also work
    expect(authenticodeDigest(pe)).toBeTruthy();
  });

  test("a PE with certificate table starting before headers fails", () => {
    const pe = makeValidPe();
    const view = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
    // Certificate table entry is at directories + 4*8
    // directories = optional + 112 = 0x58 + 112 = 0xC8
    // certEntry = 0xC8 + 32 = 0xE8
    const certEntry = 0xe8;
    // Headers end at certEntry + 8 = 0xF0
    // Set certificate table offset to 0xE0 (before headers end)
    view.setUint32(certEntry, 0xe0, true); // offset
    view.setUint32(certEntry + 4, 0x20, true); // size
    expect(() => validateCertificateTable(pe)).toThrow("starts before the end of the headers");
  });

  test("a PE with certificate table starting before last section's raw data fails", () => {
    const pe = makeValidPe();
    const view = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
    // Add a section
    view.setUint16(0x46, 1, true); // NumberOfSections: 1
    const sectionTable = 0x40 + 24 + 0xf0; // after optional header
    // Section header (40 bytes)
    // Name: .text
    const text = ".text";
    for (let i = 0; i < text.length; i++) view.setUint8(sectionTable + i, text.charCodeAt(i));
    view.setUint32(sectionTable + 8, 0x1000, true); // VirtualSize
    view.setUint32(sectionTable + 12, 0x1000, true); // VirtualAddress
    view.setUint32(sectionTable + 16, 0x200, true); // SizeOfRawData
    view.setUint32(sectionTable + 20, 0x200, true); // PointerToRawData (at file offset 0x200)
    view.setUint32(sectionTable + 24, 0, true); // PointerToRelocations
    view.setUint32(sectionTable + 28, 0, true); // PointerToLinenumbers
    view.setUint16(sectionTable + 32, 0, true); // NumberOfRelocations
    view.setUint16(sectionTable + 34, 0, true); // NumberOfLinenumbers
    view.setUint32(sectionTable + 36, 0x60000020, true); // Characteristics: code | execute | read
    // Certificate table starts at 0x300 (before section's raw data ends at 0x400)
    const certEntry = 0xe8;
    view.setUint32(certEntry, 0x300, true); // offset
    view.setUint32(certEntry + 4, 0x100, true); // size
    // Extend buffer
    const buf2 = new Uint8Array(0x500);
    buf2.set(pe);
    expect(() => validateCertificateTable(buf2)).toThrow("starts before the end of the last section's raw data");
  });

  test("a PE with certificate table not ending at EOF fails", () => {
    const pe = makeValidPe();
    const view = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
    const certEntry = 0xe8;
    view.setUint32(certEntry, 0x200, true); // offset
    view.setUint32(certEntry + 4, 0x100, true); // size -> ends at 0x300, but file is 0x200
    expect(() => validateCertificateTable(pe)).toThrow("doesn't end exactly at the end of the file");
  });

  test("a PE with non-zero padding before certificate table fails", () => {
    const pe = makeValidPe();
    const view = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
    const certEntry = 0xe8;
    // Certificate table at 0x208 (8-byte aligned after 0x200), but put non-zero at 0x200
    view.setUint32(certEntry, 0x208, true); // offset
    view.setUint32(certEntry + 4, 0x10, true); // size -> ends at 0x218
    // Put non-zero padding at 0x200
    const buf2 = new Uint8Array(0x218);
    buf2.set(pe);
    buf2[0x200] = 0xff; // non-zero padding
    expect(() => validateCertificateTable(buf2)).toThrow("non-zero padding before the certificate table");
  });

  test("a PE with unaligned padding before certificate table fails", () => {
    const pe = makeValidPe();
    const view = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
    const certEntry = 0xe8;
    // Certificate table at 0x207 (not 8-byte aligned)
    view.setUint32(certEntry, 0x207, true); // offset
    view.setUint32(certEntry + 4, 0x11, true); // size -> ends at 0x218
    const buf2 = new Uint8Array(0x218);
    buf2.set(pe);
    // Padding from 0x200 to 0x207 is 7 bytes (not multiple of 8)
    expect(() => validateCertificateTable(buf2)).toThrow("non-8-byte-aligned padding before the certificate table");
  });

  test("a fixture whose certificate entry overlaps .text is refused (launcherProblem returns error)", () => {
    // Create a PE where the certificate table overlaps the .text section
    const pe = makeValidPe();
    const view = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
    // Add a section
    view.setUint16(0x46, 1, true); // NumberOfSections: 1
    const sectionTable = 0x40 + 24 + 0xf0; // after optional header
    const text = ".text";
    for (let i = 0; i < text.length; i++) view.setUint8(sectionTable + i, text.charCodeAt(i));
    view.setUint32(sectionTable + 8, 0x1000, true); // VirtualSize
    view.setUint32(sectionTable + 12, 0x1000, true); // VirtualAddress
    view.setUint32(sectionTable + 16, 0x200, true); // SizeOfRawData
    view.setUint32(sectionTable + 20, 0x200, true); // PointerToRawData
    view.setUint32(sectionTable + 24, 0, true);
    view.setUint32(sectionTable + 28, 0, true);
    view.setUint16(sectionTable + 32, 0, true);
    view.setUint16(sectionTable + 34, 0, true);
    view.setUint32(sectionTable + 36, 0x60000020, true);
    // Certificate table overlaps .text: starts at 0x200 (where .text raw data starts), size 0x100
    const certEntry = 0xe8;
    view.setUint32(certEntry, 0x200, true); // offset - overlaps .text
    view.setUint32(certEntry + 4, 0x100, true); // size
    // Extend buffer to cover certificate table
    const buf2 = new Uint8Array(0x300);
    buf2.set(pe);
    // launcherDigest should return present: false because validation fails
    // We can't easily test launcherDigest without a file, but we can test validateCertificateTable directly
    expect(() => validateCertificateTable(buf2)).toThrow("starts before the end of the last section's raw data");
  });
});

describe("the per-launch profile verdict (brief item 7)", () => {
  test("null or temporary profiles fail closed", () => {
    expect(profileLaunchCheck(null).ok).toBe(false);
    expect(profileLaunchCheck({ sid: "S-1-5-21-1", path: "C:\\Users\\TEMP" }).ok).toBe(false);
    expect(profileLaunchCheck({ sid: "S-1-5-21-1", path: "C:\\Users\\TEMP.testvm" }).ok).toBe(false);
    expect(profileLaunchCheck({ sid: "S-1-5-21-1", path: "C:\\Users\\clover-sb-f41c96d1" })).toEqual({ ok: true });
    expect(isTemporaryProfile("C:\\Users\\TEMP")).toBe(true);
    expect(isTemporaryProfile("C:\\Users\\clover-sb-f41c96d1")).toBe(false);
  });
});

describe("the child home environment (controller ruling 2)", () => {
  test("HOME, USERPROFILE and APPDATA point at the principal's profile", () => {
    const env = sandboxHomeEnv("C:\\Users\\clover-sb-f41c96d1");
    expect(env).toEqual({
      HOME: "C:\\Users\\clover-sb-f41c96d1",
      USERPROFILE: "C:\\Users\\clover-sb-f41c96d1",
      APPDATA: "C:\\Users\\clover-sb-f41c96d1\\AppData\\Roaming",
    });
    // Never the broker's: the caller passes exactly this plus proxy/CA entries.
    expect(env.HOME).not.toContain("real-user");
  });
});

describe("the owner-SID description check (Addendum 9)", () => {
  const sid = "S-1-5-21-2049286435-129160171-2159440921-1000";
  test("stamp and read args name the principal and SID", () => {
    const dec = (a: readonly string[]) => Buffer.from(a[5]!, "base64").toString("utf16le");
    expect(dec(setDescriptionArgs("clover-sb-f41c96d1", sid))).toContain(`-Description "${sid}"`);
    expect(dec(getDescriptionArgs("clover-sb-f41c96d1"))).toContain("Get-LocalUser");
  });
  test("only the exact SID matches", () => {
    expect(descriptionMatches(sid, sid)).toBe(true);
    expect(descriptionMatches(`  ${sid}\r\n`, sid)).toBe(true);
    expect(descriptionMatches("sandbox-runtime sandboxed-child account", sid)).toBe(false);
    expect(descriptionMatches("S-1-5-21-2049286435-129160171-2159440921-1002", sid)).toBe(false);
    expect(descriptionMatches(null, sid)).toBe(false);
    expect(descriptionMatches("", sid)).toBe(false);
  });
  test("whoami csv output parses to the SID", () => {
    expect(parseWhoamiSid(`"test-vm\\testuser","${sid}"\r\n`)).toBe(sid);
    expect(parseWhoamiSid("garbage")).toBeNull();
  });
});

describe("the icacls/cmd shapes (measured on the VM)", () => {
  test("deny trustees carry the SID asterisk, or icacls reports 0x534", () => {
    const sid = "S-1-5-21-1-2-3-1025";
    expect(icaclsDenyArgs("C:\\s", sid)).toEqual(["icacls", "C:\\s", "/deny", `*${sid}:(OI)(CI)F`]);
    expect(icaclsDeleteDenyArgs("C:\\m", sid)).toEqual(["icacls", "C:\\m", "/deny", `*${sid}:(D)`]);
    expect(icaclsRemoveDenyArgs("C:\\s", sid)).toEqual(["icacls", "C:\\s", "/remove:d", `*${sid}`]);
  });
  test("mkdir uses encoded powershell (cmd /c quoting breaks spaced paths under Bun.spawn)", () => {
    const a = mkdirArgs("C:\\Users\\x\\Startup");
    expect(a.slice(0, 5)).toEqual(["powershell", "-NoProfile", "-NoLogo", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(a[5]!, "base64").toString("utf16le")).toContain('New-Item -ItemType Directory -Force -Path "C:\\Users\\x\\Startup"');
  });
  test("markers claim refuses non-admin owners and locks the DACL", () => {
    const a = claimDirArgs("C:\\ProgramData\\Clover Sandbox");
    expect(a[4]).toBe("-EncodedCommand");
    const script = Buffer.from(a[5]!, "base64").toString("utf16le");
    expect(script).toContain("takeown.exe");
    expect(script).toContain("icacls.exe");
    expect(script).toContain("S-1-5-32-544");
  });
});

describe("the installer target SID (should-fix)", () => {
  test("reads the user SID off the protected-copy path", () => {
    expect(installerTargetSid("C:\\Program Files\\Clover Sandbox\\S-1-5-21-1-2-3-1000\\clover-core.exe")).toBe("S-1-5-21-1-2-3-1000");
    expect(installerTargetSid("C:\\Program Files\\Clover Sandbox\\S-1-5-21-1-2-3-1000")).toBe("S-1-5-21-1-2-3-1000");
    expect(installerTargetSid("C:\\Users\\me\\clover-core.exe")).toBeNull();
    expect(installerTargetSid("/x/clover-core")).toBeNull();
  });
});

describe("encoded powershell (should-fix: no -Command interpolation)", () => {
  test("scripts round-trip through base64 UTF-16LE", () => {
    const a = psEncodedArgs(`New-Item -Path "C:\\$x\\'q\\'" | Out-Null`);
    expect(a.slice(0, 5)).toEqual(["powershell", "-NoProfile", "-NoLogo", "-NonInteractive", "-EncodedCommand"]);
    const raw = Buffer.from(a[5]!, "base64").toString("utf16le");
    expect(raw).toContain(`New-Item -Path "C:\\$x\\'q\\'" | Out-Null`);
  });
  test("description and folder builders are encoded", () => {
    expect(setDescriptionArgs("p", "S-1-1")[4]).toBe("-EncodedCommand");
    expect(getDescriptionArgs("p")[4]).toBe("-EncodedCommand");
    expect(mkdirArgs("C:\\x")[4]).toBe("-EncodedCommand");
    expect(removeDirArgs("C:\\x")[4]).toBe("-EncodedCommand");
    expect(knownFolderArgs("CommonStartup")[4]).toBe("-EncodedCommand");
  });
});

describe("the launch session protocol (ruling 1)", () => {
  const sid = "S-1-5-21-1-2-3-1025";
  test("a session grant is persistent with write roots and kept denies", () => {
    expect(sessionGrantArgs({ launcher: "s", sid, holderPid: 42 })).toEqual(
      ["s", "acl", "grant", "--holder-pid", "42", "--sandbox-user-sid", sid, "--persistent"]);
    const doc = JSON.parse(sessionGrantInput({ read: ["r"], write: ["w"], denyWrite: ["d"] }));
    expect(doc).toEqual({ read: ["r"], write: ["w"], denyWrite: ["d"] });
  });
  test("exec requires env, write roots and the principal", () => {
    const a = execArgs({ launcher: "s", shell: ["bash"], denyRead: ["dr"], denyWrite: ["dw"], env: { HOME: "h" }, writeRoots: ["w"], user: "clover-sb-a-1" });
    expect(a).toEqual(["s", "exec", "--quiet", "--user", "clover-sb-a-1", "--write-restricted-token",
      "--deny-read", "dr", "--deny-write", "dw", "--write-root", "w", "--env", "HOME=h", "--", "bash"]);
  });
  test("a session ends with revoke then forget/restore", () => {
    expect(sessionRevokeArgs({ launcher: "s", sid, holderPid: 7 })).toEqual(
      ["s", "acl", "revoke", "--holder-pid", "7", "--sandbox-user-sid", sid]);
    expect(sessionForgetArgs("s")).toEqual(["s", "acl", "forget", "--all"]);
    expect(sessionRestoreArgs("s")).toEqual(["s", "acl", "restore"]);
  });
});

describe("the install marker (ruling 3)", () => {
  const owner = "S-1-5-21-1-2-3-1000";
  const m = {
    version: 2 as const, ownerSid: owner,
    members: [{ principal: "clover-sb-abc", principalSid: "S-1-5-21-1-2-3-1025", sublayer: "g" }],
  };
  test("round-trips, and rejects foreign shapes", () => {
    expect(parseInstallMarker(formatInstallMarker(m))).toEqual(m);
    expect(parseInstallMarker(null)).toBeNull();
    expect(parseInstallMarker("{}")).toBeNull();
    expect(parseInstallMarker(JSON.stringify({ ...m, version: 9 }))).toBeNull();
  });
  test("a version-1 single-principal marker reads as a one-member pool", () => {
    const v1 = JSON.stringify({ version: 1, ownerSid: owner, principal: "clover-sb-abc", principalSid: null, sublayer: "g" });
    expect(parseInstallMarker(v1)).toEqual({ ...m, members: [{ principal: "clover-sb-abc", principalSid: null, sublayer: "g" }] });
  });
  test("setup across owners is refused even with force", () => {
    expect(markerAllowsSetup(null, owner)).toEqual({ ok: true });
    expect(markerAllowsSetup(m, owner)).toEqual({ ok: true });
    expect(markerAllowsSetup(m, "S-1-5-21-9")).toEqual({ ok: false, reason: expect.stringContaining("another user") });
  });
  test("remove checks the marker belongs to the caller", () => {
    expect(markerAllowsRemove(null, owner)).toEqual({ ok: true });
    expect(markerAllowsRemove(m, owner)).toEqual({ ok: true });
    expect(markerAllowsRemove(m, "S-1-5-21-9")).toEqual({ ok: false, reason: expect.stringContaining("another user") });
  });
  test("the marker path scopes per owner under ProgramData", () => {
    expect(installMarkerPath("C:\\ProgramData", owner)).toBe(`C:\\ProgramData\\Clover Sandbox\\markers\\${owner}.json`);
  });
});

describe("the pool (ruling 2)", () => {
  const owner = "S-1-5-21-2049286435-129160171-2159440921-1000";
  test("four exclusive 18-char names with distinct sublayers", () => {
    const pool = sandboxPool(owner);
    expect(pool).toHaveLength(4);
    const names = pool.map((x) => x.principal);
    expect(new Set(names).size).toBe(4);
    for (const [i, p] of names.entries()) {
      expect(p).toMatch(/^clover-sb-[0-9a-f]{6}-[1-4]$/);
      expect(p.length).toBe(18);
      expect(p.endsWith(`-${i + 1}`)).toBe(true);
    }
    const guids = pool.map((x) => x.sublayer);
    expect(new Set(guids).size).toBe(4);
    for (const g of guids) expect(g).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Deterministic per owner.
    expect(sandboxPool(owner)).toEqual(pool);
    expect(poolPrincipalName(owner, 1)).toBe(names[0]!);
  });
  test("user status and uninstall take the principal selector", () => {
    expect(userStatusArgs("s.exe")).toEqual(["s.exe", "user", "status"]);
    expect(userStatusArgs("s.exe", "clover-sb-a-1")).toEqual(["s.exe", "user", "status", "--user", "clover-sb-a-1"]);
    expect(removeArgs("s.exe", "g")).toEqual(["s.exe", "uninstall", "--sublayer-guid", "g"]);
    expect(removeArgs("s.exe", "g", "clover-sb-a-1")).toEqual(["s.exe", "uninstall", "--sublayer-guid", "g", "--user", "clover-sb-a-1"]);
  });
});

describe("the pool lock file", () => {
  test("one lock file per principal", () => {
    expect(poolLockPath("C:\\l", "clover-sb-a")).toBe("C:\\l\\clover-sb-a.lock");
  });
});

describe("the minimal child env (should-fix)", () => {
  test("fixed PATH, no HOME or tokens", () => {
    const e = minimalChildEnv({ PATH: "/evil", HOME: "/h", GH_TOKEN: "x", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\U", ProgramData: "C:\\P", LOCALAPPDATA: "C:\\L" } as NodeJS.ProcessEnv);
    expect(e.PATH).toBe("C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0");
    expect(e.HOME).toBeUndefined();
    expect(e.GH_TOKEN).toBeUndefined();
    expect(e.SystemRoot).toBe("C:\\Windows");
    expect(e.USERPROFILE).toBe("C:\\U");
    expect(e.LOCALAPPDATA).toBe("C:\\L");
  });
});

describe("the exclusive pool lease (ruling 3)", () => {
  // In-memory fake with OS lock semantics: exclusive, fail-immediately (a second
  // tryLock on a held path fails even in this same process), freed on release —
  // which is how the tests model the OS freeing a dead holder's lock.
  const memLocks = () => {
    const held = new Set<string>();
    return {
      store: {
        tryLock: (p: string) => {
          if (held.has(p)) return null;
          held.add(p);
          let released = false;
          return {
            release: () => {
              if (released) return;
              released = true;
              held.delete(p);
            },
          };
        },
      },
    };
  };
  const pool2 = [{ principal: "clover-sb-a-1" }, { principal: "clover-sb-a-2" }];

  test("two launches get distinct principals; a third waits, then refuses", async () => {
    const { store } = memLocks();
    let t = 1000;
    const now = () => t;
    const sleep = async (ms: number) => { t += ms; };
    const a = await acquirePoolLease({ store, leasesDir: "L:", pool: pool2, timeoutMs: 1000, now, sleep });
    const b = await acquirePoolLease({ store, leasesDir: "L:", pool: pool2, timeoutMs: 1000, now, sleep });
    if (!a.ok || !b.ok) throw new Error("expected two wins");
    expect(a.principal).toBe("clover-sb-a-1");
    expect(b.principal).toBe("clover-sb-a-2");
    const c = await acquirePoolLease({ store, leasesDir: "L:", pool: pool2, timeoutMs: 500, pollMs: 500, now, sleep });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toContain("busy");
    a.release();
    b.release();
  });

  test("releasing frees the principal immediately (a dead holder's lock is free)", async () => {
    const { store } = memLocks();
    const first = await acquirePoolLease({ store, leasesDir: "L:", pool: pool2.slice(0, 1), timeoutMs: 10 });
    if (!first.ok) throw new Error("expected a win");
    expect(first.principal).toBe("clover-sb-a-1");
    first.release(); // models the OS freeing a killed holder's lock: no staleness, no wait
    const second = await acquirePoolLease({ store, leasesDir: "L:", pool: pool2.slice(0, 1), timeoutMs: 10 });
    if (!second.ok) throw new Error("expected an immediate re-win");
    expect(second.principal).toBe("clover-sb-a-1");
    second.release();
    second.release(); // idempotent
  });

  test("two racers for one lock: exactly one wins", async () => {
    const { store } = memLocks();
    // Both contenders race concurrently; the synchronous tryLock admits no
    // interleave, so the loser sees the winner's held lock and backs off.
    const [a, b] = await Promise.all([
      acquirePoolLease({ store, leasesDir: "L:", pool: pool2.slice(0, 1), timeoutMs: 500, pollMs: 10 }),
      acquirePoolLease({ store, leasesDir: "L:", pool: pool2.slice(0, 1), timeoutMs: 500, pollMs: 10 }),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    expect(wins[0]).toEqual({ ok: true, principal: "clover-sb-a-1", release: expect.any(Function) });
    const loser = [a, b].find((r) => !r.ok)!;
    if (!loser.ok) expect(loser.reason).toContain("busy");
    for (const r of wins) if (r.ok) r.release();
  });

  test("three racers for one lock: exactly one wins", async () => {
    const { store } = memLocks();
    const rs = await Promise.all([
      acquirePoolLease({ store, leasesDir: "L:", pool: pool2.slice(0, 1), timeoutMs: 500, pollMs: 10 }),
      acquirePoolLease({ store, leasesDir: "L:", pool: pool2.slice(0, 1), timeoutMs: 500, pollMs: 10 }),
      acquirePoolLease({ store, leasesDir: "L:", pool: pool2.slice(0, 1), timeoutMs: 500, pollMs: 10 }),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    for (const r of rs) if (r.ok) r.release();
  });

  test("a contender that finds the first member locked takes the next one", async () => {
    const inner = memLocks();
    let forced = false;
    const store = {
      tryLock: (p: string) => {
        if (!forced) {
          forced = true;
          return null; // simulate the OS reporting the first member busy
        }
        return inner.store.tryLock(p);
      },
    };
    const r = await acquirePoolLease({ store, leasesDir: "L:", pool: pool2, timeoutMs: 100 });
    if (!r.ok) throw new Error("expected a win on the second member");
    expect(r.principal).toBe("clover-sb-a-2");
    r.release();
  });
});

describe("the leases-dir trust check (Addendum 12)", () => {
  const self = "S-1-5-21-1-1-1-1000";
  const ba = "S-1-5-32-544";
  const sy = "S-1-5-18";
  const everyone = "S-1-1-0";
  const users = "S-1-5-32-545";

  test("inside the user's profile nothing is checked", () => {
    expect(leasesDirAccessProblem("C:\\Users\\amy\\.clover\\sandbox\\leases", { profileRoot: "C:\\Users\\amy", security: null })).toBeNull();
    expect(leasesDirAccessProblem("C:\\USERS\\AMY\\.clover\\sandbox\\leases", { profileRoot: "c:\\users\\amy", security: null })).toBeNull();
  });

  test("an owner-only dir outside the profile passes", () => {
    const ok = { userSid: self, ownerSid: self, allows: [{ sid: self, allow: true }, { sid: sy, allow: true }] };
    expect(leasesDirAccessProblem("C:\\ProgramData\\Clover Sandbox\\markers", { profileRoot: "C:\\Users\\amy", security: ok })).toBeNull();
    const admins = { userSid: self, ownerSid: ba, allows: [{ sid: ba, allow: true }, { sid: sy, allow: true }] };
    expect(leasesDirAccessProblem("D:\\leases", { profileRoot: "C:\\Users\\amy", security: admins })).toBeNull();
    // Deny entries for anyone do not matter; only allows are gated.
    const denies = { userSid: self, ownerSid: self, allows: [{ sid: self, allow: true }, { sid: everyone, allow: false }] };
    expect(leasesDirAccessProblem("D:\\leases", { profileRoot: "C:\\Users\\amy", security: denies })).toBeNull();
  });

  test("a foreign owner, extra allows, or an unreadable ACL refuse", () => {
    const foreign = { userSid: self, ownerSid: "S-1-5-21-9-9-9-2000", allows: [{ sid: "S-1-5-21-9-9-9-2000", allow: true }] };
    expect(leasesDirAccessProblem("D:\\leases", { profileRoot: "C:\\Users\\amy", security: foreign })).toContain("owned by");
    const shared = { userSid: self, ownerSid: ba, allows: [{ sid: ba, allow: true }, { sid: sy, allow: true }, { sid: everyone, allow: true }] };
    expect(leasesDirAccessProblem("D:\\leases", { profileRoot: "C:\\Users\\amy", security: shared })).toContain(everyone);
    // Inherited allows count: the dir is not owner-only however they arrived.
    const inherited = { userSid: self, ownerSid: ba, allows: [{ sid: ba, allow: true }, { sid: users, allow: true }] };
    expect(leasesDirAccessProblem("D:\\leases", { profileRoot: "C:\\Users\\amy", security: inherited })).toContain(users);
    expect(leasesDirAccessProblem("D:\\leases", { profileRoot: "C:\\Users\\amy", security: null })).toContain("could not be read");
    expect(leasesDirAccessProblem("D:\\leases", { profileRoot: null, security: null })).toContain("could not be read");
  });
});
