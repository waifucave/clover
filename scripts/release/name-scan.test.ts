import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_NAME_SCAN_EXCLUSIONS, countFiles, nameGuardPath, runNameScan } from "./name-scan";

// A stand-in guard with the real one's interface (`<guard> artifacts <paths…>`, non-zero on a hit), looking for a
// planted word that is nobody's name.
const PLANTED = "PLANTED-IDENTITY-PROBE";
const guardScript = `#!/bin/bash\n[ "$1" = artifacts ] || exit 2\nshift\nif grep -rIl --binary-files=text "${PLANTED}" "$@" >/dev/null 2>&1; then exit 1; fi\nexit 0\n`;

function release(): string {
  const out = mkdtempSync(join(tmpdir(), "clover-name-scan-"));
  mkdirSync(join(out, "mac-arm64", "Clover.app", "Contents", "Resources", "daemon"), { recursive: true });
  writeFileSync(join(out, "mac-arm64", "Clover.app", "Contents", "Resources", "daemon", "clover-core"), "core bytes");
  writeFileSync(join(out, "mac-arm64", "Clover.app", "Contents", "Resources", "daemon", "clover-plugin-bun"), "bun bytes");
  writeFileSync(join(out, "Clover-1.0.0.dmg"), "dmg bytes");
  writeFileSync(join(out, "latest-mac.yml"), "version: 1.0.0\n");
  return out;
}

describe("the release's identity scan", () => {
  if (process.platform === "win32") return;
  const work = mkdtempSync(join(tmpdir(), "clover-name-guard-"));
  const guard = join(work, "guard.sh");
  writeFileSync(guard, guardScript);
  chmodSync(guard, 0o755);

  test("a clean release passes, and every file is scanned", () => {
    const out = release();
    try {
      const r = runNameScan(out, { required: true, guard, quiet: true });
      expect(r.ran && r.scanned === r.total && r.total === 4).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("a planted hit anywhere in the release fails it: in resources/daemon, an installer, an update file", () => {
    for (const where of [["mac-arm64", "Clover.app", "Contents", "Resources", "daemon", "clover-plugin-bun"], ["Clover-1.0.0.dmg"], ["latest-mac.yml"]]) {
      const out = release();
      try {
        writeFileSync(join(out, ...where), `bytes ${PLANTED} bytes`);
        expect(() => runNameScan(out, { required: true, guard, quiet: true })).toThrow("the identity scan found a hit");
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }
  });

  test("a signed release fails closed without the guard; an unsigned one says it skipped", () => {
    const out = release();
    try {
      expect(() => runNameScan(out, { required: true, guard: join(work, "nope.sh") })).toThrow("never ships unscanned");
      expect(runNameScan(out, { required: false, guard: join(work, "nope.sh") })).toEqual({ ran: false, reason: `no name guard at ${join(work, "nope.sh")}` });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("an exclusion still keeps the partition whole, and symlinks are neither counted nor followed", () => {
    const out = release();
    try {
      symlinkSync(join(out, "Clover-1.0.0.dmg"), join(out, "link.dmg"));
      expect(countFiles([out])).toBe(4);
      const r = runNameScan(out, { required: true, guard, quiet: true, exclusions: [/^Clover-1\.0\.0\.dmg$/] });
      expect(r.ran && r.scanned === 3 && r.total === 4).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("no exclusion ships yet, and the guard lives outside the repo", () => {
    expect(CLOVER_NAME_SCAN_EXCLUSIONS).toEqual([]);
    expect(nameGuardPath({ HOME: "/Users/x" })).toBe("/Users/x/norma-private/git-hooks/name-guard.sh");
    expect(nameGuardPath({ HOME: "/Users/x", CLOVER_NAME_GUARD: "/elsewhere/g.sh" })).toBe("/elsewhere/g.sh");
  });
});
