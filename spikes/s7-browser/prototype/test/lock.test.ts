import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLock } from "../src/pair/lock.ts";

// The daemon's lock (round eight): a held lock reads as busy; anything else is an error, never "busy".
describe.skipIf(process.platform === "win32")("the daemon lock", () => {
  test("held → busy; released → free; an unopenable path throws instead of reading as busy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s7-lock-"));
    try {
      const path = join(dir, "core.lock");
      const first = await takeLock(path);
      expect("busy" in first).toBe(false);
      const second = await takeLock(path); // flock locks belong to the open file, so a second open is refused
      expect("busy" in second).toBe(true);
      if (!("busy" in first)) first.release();
      const third = await takeLock(path);
      expect("busy" in third).toBe(false);
      if (!("busy" in third)) third.release();
      await expect(takeLock(join(dir, "no-such-dir", "core.lock"))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
