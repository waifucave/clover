import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLockFailure, takeLock } from "../src/pair/lock.ts";

// The daemon's lock (rounds eight and eleven). Only "another process holds it" may read as busy; any other failure is
// an error, so the daemon exits non-zero and is started again instead of exiting 0 as a second daemon would. The CI
// runs this file on macOS, Windows and Linux.
describe("classifying a failed lock", () => {
  test("only EWOULDBLOCK (macOS 35, Linux 11) and a sharing violation (Windows 32) are busy", () => {
    expect(classifyLockFailure("darwin", 35)).toBe("busy");
    expect(classifyLockFailure("linux", 11)).toBe("busy");
    expect(classifyLockFailure("win32", 32)).toBe("busy");
    // everything else is an error: a missing path, access denied, a full disk, a bad descriptor, a misread 0
    for (const code of [0, 2, 3, 5, 9, 13, 28, 33, 112]) {
      expect(classifyLockFailure("win32", code)).toBe("error");
    }
    for (const code of [0, 1, 2, 9, 11, 13, 28, 37]) expect(classifyLockFailure("darwin", code)).toBe("error");
    for (const code of [0, 1, 2, 9, 13, 28, 35, 37]) expect(classifyLockFailure("linux", code)).toBe("error");
  });
});

describe("the daemon lock on this OS", () => {
  test("held → busy; released → free", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s7-lock-"));
    try {
      const path = join(dir, "core.lock");
      const first = await takeLock(path);
      expect("busy" in first).toBe(false);
      // flock locks belong to the open file, and a share-none handle refuses every other open, so a second take in the
      // same process is refused on every OS
      const second = await takeLock(path);
      expect("busy" in second).toBe(true);
      if (!("busy" in first)) first.release();
      const third = await takeLock(path);
      expect("busy" in third).toBe(false);
      if (!("busy" in third)) third.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // On Windows this is CreateFileW's error 3 (path not found), which the round-one lock read as busy. On macOS and Linux
  // the open fails before flock, so the classification test above is what pins those.
  test("a path that can't be opened throws instead of reading as busy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s7-lock-"));
    try {
      await expect(takeLock(join(dir, "no-such-dir", "core.lock"))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
