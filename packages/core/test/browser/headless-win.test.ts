// The Windows start of the headless shell (`winpipe.ts`), with a batch file in the browser's place so no browser is
// needed: its job object (a grandchild dies with it, on kill and when the browser exits by itself), the minimal
// environment it gets, and its standard error in `stderrTail`. Runs on the Windows machine job only.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsBrowserDirs, windowsBrowserEnv } from "../../src/browser/headless";
import { spawnWithWinPipes } from "../../src/browser/headless/winpipe";

const WIN = process.platform === "win32";

describe.skipIf(!WIN)("the headless shell's Windows start", () => {
  const root = mkdtempSync(join(tmpdir(), "clover-winpipe-"));
  afterAll(() => {
    // Windows keeps a file busy a moment after its process is gone.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // The temp folder is the system's to clear.
    }
  });

  const env = (): Record<string, string> => {
    const e = windowsBrowserEnv(root);
    for (const d of windowsBrowserDirs(e)) mkdirSync(d, { recursive: true });
    return e;
  };

  /** A "browser": prints to stderr, writes its environment to a file, and starts a long-lived grandchild under a name
   *  of its own (a copy of ping.exe). `lifetime` is how long the batch file itself keeps running. */
  function fakeBrowser(name: string, lifetime: "short" | "long"): { bat: string; probe: string; out: string } {
    const probe = `${name}-${process.pid}.exe`;
    copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE"), join(root, probe));
    const out = join(root, `${name}.env.txt`);
    const bat = join(root, `${name}.cmd`);
    writeFileSync(bat, [
      "@echo off",
      "echo boom-on-stderr 1>&2",
      `set > "${out}"`,
      `start "" /b "${join(root, probe)}" -n 120 127.0.0.1 > nul`,
      lifetime === "long" ? `"${join(root, probe)}" -n 120 127.0.0.1 > nul` : "exit /b 0",
    ].join("\r\n"));
    return { bat, probe, out };
  }

  const running = async (image: string): Promise<boolean> => {
    const p = Bun.spawn(["tasklist", "/FI", `IMAGENAME eq ${image}`, "/NH"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout as ReadableStream).text();
    await p.exited;
    return text.toLowerCase().includes(image.toLowerCase());
  };
  const until = async (what: string, ok: () => Promise<boolean>, ms = 20_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!(await ok())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(200);
    }
  };

  test("kill() ends the browser and everything it started, and its error output is kept", async () => {
    const f = fakeBrowser("killed", "long");
    const { process: proc, pipe } = await spawnWithWinPipes(f.bat, [], env());
    pipe.onData(() => undefined);
    await until("the grandchild to start", () => running(f.probe));
    await until("its stderr", async () => proc.stderrTail().includes("boom-on-stderr"));
    proc.kill();
    await proc.exited;
    await until("the grandchild to die with the job", async () => !(await running(f.probe)));
  }, 60_000);

  test("a browser that exits on its own leaves nothing behind", async () => {
    const f = fakeBrowser("exits", "short");
    const { process: proc } = await spawnWithWinPipes(f.bat, [], env());
    await proc.exited;
    // The batch file is gone; closing the daemon's last handle to the job takes the grandchild with it.
    await until("the grandchild to die with the job", async () => !(await running(f.probe)));
  }, 60_000);

  test("the browser's environment is the minimal one, not the daemon's", async () => {
    process.env.CLOVER_WINPIPE_SECRET = "must-not-leak";
    try {
      const f = fakeBrowser("env", "short");
      const { process: proc } = await spawnWithWinPipes(f.bat, [], env());
      await proc.exited;
      const text = await Bun.file(f.out).text();
      expect(text).not.toContain("CLOVER_WINPIPE_SECRET");
      expect(text).not.toContain("must-not-leak");
      expect(text.toLowerCase()).toContain(`localappdata=${join(root, "home", "LocalAppData").toLowerCase()}`);
      expect(text.toLowerCase()).toContain(`temp=${join(root, "home", "Temp").toLowerCase()}`);
      const path = text.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("path="));
      expect(path?.toLowerCase()).toBe(`path=${join(process.env.SystemRoot ?? "C:\\Windows", "System32").toLowerCase()}`);
    } finally {
      delete process.env.CLOVER_WINPIPE_SECRET;
    }
  }, 60_000);
});
