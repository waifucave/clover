import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { bootstrapMossDir, type MossDirs } from "../../src/moss-dir";
/** Whole-branch review, Major 1: `startRuntimeState`'s `claude-resume-*` staging sweep (P8d-12)
 *  falls back to the developer's REAL `os.tmpdir()` whenever a caller names neither the
 *  `recovery.claudeResumeScanRoot` dep nor `MOSS_CLAUDE_RESUME_SCAN_ROOT`. Every `startDaemon`-style
 *  test in this file's callers goes through this one helper, so setting the env seam here — to a
 *  subdirectory of the SAME temp home already being torn down in `finally` — is what keeps all of
 *  them (and `daemon-wiring.test.ts`'s `boot()`) off the real machine's tmpdir, with no per-test
 *  wiring. Saved/restored around the call so a stray ambient value in the runner's own environment
 *  is never permanently clobbered. */
export async function withTempHome(fn: (home: string, dirs: MossDirs) => Promise<void> | void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "moss-8a-")); const dirs = bootstrapMossDir(home);
  const prevScanRoot = process.env.MOSS_CLAUDE_RESUME_SCAN_ROOT;
  process.env.MOSS_CLAUDE_RESUME_SCAN_ROOT = join(home, "claude-resume-scan-env");
  try { await fn(home, dirs); } finally {
    if (prevScanRoot === undefined) delete process.env.MOSS_CLAUDE_RESUME_SCAN_ROOT;
    else process.env.MOSS_CLAUDE_RESUME_SCAN_ROOT = prevScanRoot;
    rmSync(home, { recursive: true, force: true });
  }
}
export const ISO = () => new Date().toISOString();
