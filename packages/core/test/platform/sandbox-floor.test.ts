import { describe, expect, test } from "bun:test";
import { callerFloorVerdict, mayBeUser, type SandboxProbe } from "../../src/platform/sandbox-floor";

describe("callerFloorVerdict (spec §3.1)", () => {
  test("macOS: outside the floor only when not sandboxed", () => {
    expect(callerFloorVerdict("darwin", { sandboxedMac: false })).toBe("outside-floor");
    expect(callerFloorVerdict("darwin", { sandboxedMac: true })).toBe("fenced");
    expect(callerFloorVerdict("darwin", {})).toBe("fenced"); // unknown → fail closed
  });

  test("Linux: outside the floor only in the host's namespaces", () => {
    expect(callerFloorVerdict("linux", { inHostNamespacesLinux: true })).toBe("outside-floor");
    expect(callerFloorVerdict("linux", { inHostNamespacesLinux: false })).toBe("fenced");
    expect(callerFloorVerdict("linux", {})).toBe("fenced");
  });

  test("Windows: outside the floor only with an unrestricted, non-AppContainer token", () => {
    expect(callerFloorVerdict("win32", { tokenRestrictedWin: false, appContainerWin: false })).toBe("outside-floor");
    expect(callerFloorVerdict("win32", { tokenRestrictedWin: true, appContainerWin: false })).toBe("fenced");
    expect(callerFloorVerdict("win32", { tokenRestrictedWin: false, appContainerWin: true })).toBe("fenced");
    expect(callerFloorVerdict("win32", { tokenRestrictedWin: false })).toBe("fenced"); // appContainer unknown
    expect(callerFloorVerdict("win32", {})).toBe("fenced");
  });

  test("a bot's double-forked command stays fenced on every OS (the escape floor)", () => {
    // Even if its process tree looked detached, the sandbox signal keeps it fenced.
    const fenced: SandboxProbe = { sandboxedMac: true, inHostNamespacesLinux: false, tokenRestrictedWin: true, appContainerWin: true };
    for (const os of ["darwin", "linux", "win32"] as const) {
      expect(mayBeUser(callerFloorVerdict(os, fenced))).toBe(false);
    }
  });
});
