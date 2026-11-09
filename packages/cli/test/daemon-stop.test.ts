import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lane M's upgrade step: `clover-core daemon stop` stops the running daemon and leaves login start alone. With no
// daemon running it does nothing and exits 0 (it never reaches for a token or the Keychain then).
test("daemon stop with no daemon running: exit 0, autostart unchanged", () => {
  const user = mkdtempSync(join(tmpdir(), "clover-stop-user-"));
  // Login start serves the default home only, so the default home of a fake user (never the real one).
  mkdirSync(join(user, ".clover", "run"), { recursive: true });
  const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "main.ts"), "daemon", "stop"], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLOVER_HOME")), HOME: user, USERPROFILE: user, CLOVER_NO_AUTOLAUNCH: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain("the daemon: not-running; autostart unchanged");
}, 90_000);
