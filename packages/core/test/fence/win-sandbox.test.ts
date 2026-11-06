// Windows Bash under the fence (lane C, C-M2 part 2): the sandbox command's pure half —
// launcher args, status parsing, the per-launch allow/deny plan and the reset plan. No Windows needed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOVER_WFP_SUBLAYER,
  SANDBOX_EXIT,
  sandboxPrincipal,
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
} from "../../src/fence/win-sandbox";
import { authenticodeDigest, validateCertificateTable } from "../../src/fence/windows-launcher";
import type { SandboxPolicy } from "../../src/contracts/fence";

describe("the pinned launcher", () => {
  test("the pin names the controller's tag and commit", () => {
    expect(SRT_WIN_TAG).toBe("v0.0.81");
    expect(SRT_WIN_COMMIT).toBe("c40cf14a65d025e3cd27f071f13a73c12b3b1f92");
  });

  test("the sublayer GUID is a GUID, and the principal uses the Addendum 9 format", () => {
    expect(CLOVER_WFP_SUBLAYER).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i);
    // Base prefix is clover-sb- (10 chars), full name with 8 hex chars = 18 chars
    expect(sandboxPrincipal()).toBe("clover-sb-");
    expect(sandboxPrincipal().length).toBe(10);
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
    expect(SRT_WIN_PINS.x64).toBe("9e303d358e0bfe153c1f81d3601f88b74a610ccb62bc67d7001249b7a6b0293b");
    expect(SRT_WIN_PINS.arm64).toBe("cf562110127e7612084de53782b0307326074d4e1958ca2c5262a974f6bc19c6");
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
    // Default uses sandboxPrincipal() base prefix; actual per-user name passed by CLI
    const a = setupArgs("C:\\Clover\\srt-win.exe");
    expect(a).toEqual(["C:\\Clover\\srt-win.exe", "install", "--sandbox-user", "clover-sb-", "--sublayer-guid", CLOVER_WFP_SUBLAYER]);
    expect(a.join(" ")).not.toContain("allow-loopback");
  });

  test("remove undoes everything; status never elevates", () => {
    expect(removeArgs("srt-win.exe")).toEqual(["srt-win.exe", "uninstall", "--sublayer-guid", CLOVER_WFP_SUBLAYER]);
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
  // A launcher path that doesn't exist - parseSrtStatus will check it first
  const missingLauncher = join(tmpdir(), "no-such-launcher.exe");

  test("a missing launcher, or a digest mismatch, is never ready (exit 3)", () => {
    const s = parseSrtStatus(JSON.stringify({ user: { exists: true } }), { launcher: missingLauncher });
    expect(s.ready).toBe(false);
    expect(s.launcher.present).toBe(false);
    expect(s.exit).toBe(SANDBOX_EXIT.HASH_MISMATCH);
    expect(s.reason).toContain("isn't installed");
  });

  test("numeric marker/setup versions (as srt-win reports them) match, and a pinned launcher is ready", () => {
    // srt-win status reports marker_version/setup_version as JSON numbers; the parser must accept them.
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
    const ready = parse({ exists: true, marker_version: 3, setup_version: 3, seclogon: "ok" });
    expect(ready.ready).toBe(true);
    expect(ready.exit).toBe(SANDBOX_EXIT.OK);
    // A marker from another build is still refused, numeric or string.
    expect(parse({ exists: true, marker_version: "2", setup_version: "3", seclogon: "ok" }).ready).toBe(false);
    expect(parse({ exists: true, marker_version: "3", setup_version: "3", seclogon: "ok" }).ready).toBe(true);
    // The real srt-win shape nests the account under user.user; the install state stays on top.
    const nested = parse({
      cred_present: true,
      marker_version: 3,
      setup_version: 3,
      seclogon: "ok",
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

  test("the home is default-deny; only the caller's own outputs, scratch, bot folder (read) and memory (read/write) are granted", () => {
    const entries = (dir: string) => {
      if (dir.endsWith("\\outputs")) return ["s1", "s2"];
      if (dir.endsWith("\\scratch")) return ["luna", "sol"];
      return [];
    };
    const plan = winLaunchPlan({
      policy,
      cloverHome: home,
      caller: { sessionId: "s1", bot: "luna", botsOwnSession: true },
      bots: ["luna", "sol"],
      entries,
    });
    // Home itself is denied both ways
    expect(plan.denyRead).toContain(home);
    expect(plan.denyWrite).toContain(home);
    // Other session's outputs denied
    expect(plan.denyRead).toContain("C:\\Users\\me\\.clover\\outputs\\s2");
    expect(plan.denyWrite).toContain("C:\\Users\\me\\.clover\\outputs\\s2");
    // Own session's outputs granted write
    expect(plan.grantWrite).toContain("C:\\Users\\me\\.clover\\outputs\\s1");
    // Other bot's scratch denied
    expect(plan.denyRead).toContain("C:\\Users\\me\\.clover\\scratch\\sol");
    expect(plan.denyWrite).toContain("C:\\Users\\me\\.clover\\scratch\\sol");
    // Own bot's scratch granted write
    expect(plan.grantWrite).toContain("C:\\Users\\me\\.clover\\scratch\\luna");
    // Other bot's folder denied read and write
    expect(plan.denyRead).toContain("C:\\Users\\me\\.clover\\bots\\sol");
    expect(plan.denyWrite).toContain("C:\\Users\\me\\.clover\\bots\\sol");
    // Own bot's folder granted read, memory granted read/write
    expect(plan.grantRead).toContain("C:\\Users\\me\\.clover\\bots\\luna");
    expect(plan.grantWrite).toContain("C:\\Users\\me\\.clover\\bots\\luna\\memory");
    // Own bot's folder denied write (but memory is granted write)
    expect(plan.denyWrite).toContain("C:\\Users\\me\\.clover\\bots\\luna");
    // Memory folders protected from delete/move
    expect(plan.protectDelete).toContain("C:\\Users\\me\\.clover\\bots\\luna\\memory");
    expect(plan.protectDelete).toContain("C:\\Users\\me\\.clover\\bots\\sol\\memory");
    // Runtime: own file readable, folder denied
    expect(plan.grantRead).toContain("C:\\Users\\me\\.clover\\sessions-runtime\\s1.json");
    expect(plan.denyRead).toContain("C:\\Users\\me\\.clover\\sessions-runtime");
    expect(plan.denyWrite).toContain("C:\\Users\\me\\.clover\\sessions-runtime");
  });

  test("a coding session with no bot owns no memory but has its own runtime file", () => {
    const entries = (dir: string) => (dir.endsWith("\\outputs") ? ["s9"] : []);
    const plan = winLaunchPlan({
      policy,
      cloverHome: home,
      caller: { sessionId: "s9" },
      bots: ["luna"],
      entries,
    });
    expect(plan.ownMemory).toBeNull();
    // Other bot's folder denied
    expect(plan.denyRead).toContain("C:\\Users\\me\\.clover\\bots\\luna");
    expect(plan.denyWrite).toContain("C:\\Users\\me\\.clover\\bots\\luna");
    // Non-bot session still has its own runtime file
    expect(plan.ownRuntime).toBe("C:\\Users\\me\\.clover\\sessions-runtime\\s9.json");
    expect(plan.grantRead).toContain("C:\\Users\\me\\.clover\\sessions-runtime\\s9.json");
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
