import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, AlreadyRunningError, LockHeldNoDaemonError, LockFailedError, classifyLockFailure, endpointAnswers } from "../src/lock";
import { resolveEndpoint } from "../src/platform/transport";

/** A run directory: its lock, and its endpoint as the daemon resolves it (a socket file on
 *  macOS/Linux, a named pipe on Windows). */
function tmpRun(): { lockPath: string; socketPath: string } {
  const d = mkdtempSync(join(tmpdir(), "clover-lock-"));
  return { lockPath: join(d, "core.lock"), socketPath: resolveEndpoint(d).path };
}
const windows = process.platform === "win32";
const fast = { confirmMs: 300, pollMs: 50 };
/** The holder's pid: in the lock file on macOS/Linux, beside it on Windows (the lock file is opened
 *  with no sharing there, so it can't be read while held). */
const pidOf = (lockPath: string): number =>
  JSON.parse(readFileSync(process.platform === "win32" ? join(lockPath, "..", "core.pid") : lockPath, "utf8")).pid;

describe("classifyLockFailure (S7 §5)", () => {
  test("only another holder is busy, per OS", () => {
    expect(classifyLockFailure("darwin", 35)).toBe("busy");
    expect(classifyLockFailure("linux", 11)).toBe("busy");
    expect(classifyLockFailure("win32", 32)).toBe("busy");
  });
  test("every other code is an error, never busy", () => {
    expect(classifyLockFailure("darwin", 13)).toBe("error"); // EACCES
    expect(classifyLockFailure("linux", 28)).toBe("error"); // ENOSPC
    expect(classifyLockFailure("linux", 35)).toBe("error"); // macOS's EWOULDBLOCK is not Linux's
    expect(classifyLockFailure("win32", 3)).toBe("error"); // a missing directory
    expect(classifyLockFailure("win32", 5)).toBe("error"); // access denied
  });
});

describe("acquireLock", () => {
  test("acquires, records its pid, and frees the home on release", async () => {
    const p = tmpRun();
    const lock = await acquireLock(p.lockPath, p.socketPath, fast);
    expect(pidOf(p.lockPath)).toBe(process.pid);
    lock.release();
    // The file stays (with a kernel lock it is only a name) but no longer names a holder.
    if (process.platform === "win32") expect(existsSync(join(p.lockPath, "..", "core.pid"))).toBe(false);
    else expect(readFileSync(p.lockPath, "utf8")).toBe("");
    const again = await acquireLock(p.lockPath, p.socketPath, fast);
    again.release();
  });

  test("a second daemon whose holder answers is refused as already running, naming the holder", async () => {
    const p = tmpRun();
    const first = await acquireLock(p.lockPath, p.socketPath, fast);
    const server = Bun.listen({ unix: p.socketPath, socket: { data() {} } });
    if (!windows) chmodSync(p.socketPath, 0o600); // as the daemon's is: the busy check checks the server (review M1)
    try {
      await acquireLock(p.lockPath, p.socketPath, fast);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(AlreadyRunningError);
      expect((e as AlreadyRunningError).pid).toBe(process.pid);
    } finally { server.stop(true); first.release(); }
  });

  test("a held lock with no daemon answering ends in LockHeldNoDaemonError, never a takeover", async () => {
    const p = tmpRun();
    const first = await acquireLock(p.lockPath, p.socketPath, fast);
    await expect(acquireLock(p.lockPath, p.socketPath, fast)).rejects.toBeInstanceOf(LockHeldNoDaemonError);
    expect(pidOf(p.lockPath)).toBe(process.pid); // the holder's record is untouched
    first.release();
  });

  test("a daemon still starting (no endpoint yet) that comes up within the window is honoured", async () => {
    const p = tmpRun();
    const first = await acquireLock(p.lockPath, p.socketPath, fast);
    let server: ReturnType<typeof Bun.listen> | undefined;
    setTimeout(() => { server = Bun.listen({ unix: p.socketPath, socket: { data() {} } }); if (!windows) chmodSync(p.socketPath, 0o600); }, 100);
    await expect(acquireLock(p.lockPath, p.socketPath, { confirmMs: 2_000, pollMs: 50 })).rejects.toBeInstanceOf(AlreadyRunningError);
    server?.stop(true);
    first.release();
  });

  test.skipIf(windows)("a lock file and socket left by a crashed daemon do not hold the home", async () => {
    const p = tmpRun();
    writeFileSync(p.lockPath, JSON.stringify({ pid: 999999999 })); // the crash freed the kernel lock
    writeFileSync(p.socketPath, ""); // and left a stale socket file
    const lock = await acquireLock(p.lockPath, p.socketPath, fast);
    expect(pidOf(p.lockPath)).toBe(process.pid);
    expect(existsSync(p.socketPath)).toBe(false);
    lock.release();
  });

  test("a corrupt lock file does not hold the home", async () => {
    const p = tmpRun();
    writeFileSync(p.lockPath, "not json {{{");
    const lock = await acquireLock(p.lockPath, p.socketPath, fast);
    expect(pidOf(p.lockPath)).toBe(process.pid);
    lock.release();
  });

  test("an OS refusal other than another holder throws LockFailedError (a missing run directory)", async () => {
    const p = tmpRun();
    const missing = join(p.lockPath, "..", "no-such-dir", "core.lock");
    await expect(acquireLock(missing, p.socketPath, fast)).rejects.toBeInstanceOf(LockFailedError);
  });

  test.skipIf(windows)("release removes the socket file but never a named pipe", async () => {
    const p = tmpRun();
    const lock = await acquireLock(p.lockPath, p.socketPath, fast);
    writeFileSync(p.socketPath, "");
    lock.release();
    expect(existsSync(p.socketPath)).toBe(false);
    const pipe = "\\\\.\\pipe\\clover-core-deadbeefdeadbeef";
    const second = await acquireLock(p.lockPath, pipe, fast);
    second.release(); // must not try to unlink a pipe name
  });

  test("without FFI, the pid-file fallback refuses a live holder and cleans only its own file", async () => {
    const p = tmpRun();
    writeFileSync(p.lockPath, JSON.stringify({ pid: process.ppid })); // a live process that is not us
    await expect(acquireLock(p.lockPath, p.socketPath, { ...fast, backend: "pidfile" })).rejects.toBeInstanceOf(LockHeldNoDaemonError);
    writeFileSync(p.lockPath, JSON.stringify({ pid: 999999999 }));
    const lock = await acquireLock(p.lockPath, p.socketPath, { ...fast, backend: "pidfile" });
    writeFileSync(p.lockPath, JSON.stringify({ pid: 424242 })); // a newer holder's record
    lock.release();
    expect(existsSync(p.lockPath)).toBe(true); // not ours to remove
  });
});

describe("endpointAnswers", () => {
  test("true for a listening endpoint, false for a missing or dead one", async () => {
    const p = tmpRun();
    expect(await endpointAnswers(p.socketPath)).toBe(false);
    if (!windows) {
      writeFileSync(p.socketPath, ""); // a stale socket file
      expect(await endpointAnswers(p.socketPath)).toBe(false);
    }
    const q = tmpRun();
    const server = Bun.listen({ unix: q.socketPath, socket: { data() {} } });
    expect(await endpointAnswers(q.socketPath)).toBe(true);
    server.stop(true);
  });
});
