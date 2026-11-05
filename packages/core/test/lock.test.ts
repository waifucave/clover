import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, AlreadyRunningError } from "../src/lock";

function tmpRun(): { lockPath: string; socketPath: string } {
  const d = mkdtempSync(join(tmpdir(), "clover-lock-"));
  return { lockPath: join(d, "core.lock"), socketPath: join(d, "core.sock") };
}

describe("acquireLock", () => {
  test("acquires when no lock exists; writes own pid; release removes it", async () => {
    const p = tmpRun();
    const lock = await acquireLock(p.lockPath, p.socketPath);
    expect(JSON.parse(await Bun.file(p.lockPath).text()).pid).toBe(process.pid);
    lock.release();
    expect(existsSync(p.lockPath)).toBe(false);
  });

  test("refuses a second daemon while the first holds the lock", async () => {
    const p = tmpRun();
    const first = await acquireLock(p.lockPath, p.socketPath);
    // A second daemon on the same home — even with no socket yet (a daemon still starting) — defers.
    await expect(acquireLock(p.lockPath, p.socketPath)).rejects.toBeInstanceOf(AlreadyRunningError);
    first.release();
  });

  test("the refusal names the holder's pid", async () => {
    const p = tmpRun();
    const first = await acquireLock(p.lockPath, p.socketPath);
    try {
      await acquireLock(p.lockPath, p.socketPath);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AlreadyRunningError);
      expect((e as AlreadyRunningError).pid).toBe(process.pid);
    }
    first.release();
  });

  test("the home is free again once the holder releases", async () => {
    const p = tmpRun();
    const first = await acquireLock(p.lockPath, p.socketPath);
    first.release();
    const second = await acquireLock(p.lockPath, p.socketPath);
    expect(JSON.parse(await Bun.file(p.lockPath).text()).pid).toBe(process.pid);
    second.release();
  });

  test("takes over a stale lock file left by a crashed daemon (no live holder)", async () => {
    const p = tmpRun();
    // A crash leaves the file behind but holds no kernel lock, and the pid is dead.
    writeFileSync(p.lockPath, JSON.stringify({ pid: 999999999 }));
    writeFileSync(p.socketPath, ""); // and a stale socket file
    const lock = await acquireLock(p.lockPath, p.socketPath);
    expect(JSON.parse(await Bun.file(p.lockPath).text()).pid).toBe(process.pid);
    expect(existsSync(p.socketPath)).toBe(false); // stale socket unlinked
    lock.release();
  });

  test("takes over a corrupt lock file", async () => {
    const p = tmpRun();
    writeFileSync(p.lockPath, "not json {{{");
    const lock = await acquireLock(p.lockPath, p.socketPath);
    expect(JSON.parse(await Bun.file(p.lockPath).text()).pid).toBe(process.pid);
    lock.release();
  });

  test("release() is a no-op when a newer holder owns the lock file", async () => {
    const p = tmpRun();
    const lock = await acquireLock(p.lockPath, p.socketPath);
    // Simulate a newer daemon owning the file (and its socket).
    writeFileSync(p.lockPath, JSON.stringify({ pid: 424242, startedAt: 1 }));
    writeFileSync(p.socketPath, "");
    lock.release();
    expect(existsSync(p.lockPath)).toBe(true);
    expect(existsSync(p.socketPath)).toBe(true);
  });

  test("a Windows named pipe endpoint is never unlinked on release", async () => {
    const p = tmpRun();
    const pipe = "\\\\.\\pipe\\clover-core-deadbeefdeadbeef";
    const lock = await acquireLock(p.lockPath, pipe);
    lock.release(); // must not throw trying to unlink a pipe name
    expect(existsSync(p.lockPath)).toBe(false);
  });
});
