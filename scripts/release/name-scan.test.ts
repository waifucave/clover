import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { darwinTest } from "../../packages/core/test/helpers/darwin-only";
import { CLOVER_NAME_SCAN_EXCLUSIONS, countFiles, DMG_ROOT_LINKS, nameGuardPath, runNameScan, walkTree } from "./name-scan";

// A stand-in guard with the real one's interface (`<guard> artifacts <paths…>`, non-zero on a hit), looking for a
// planted word that is nobody's name.
const PLANTED = "PLANTED-IDENTITY-PROBE";
const guardScript = `#!/bin/bash\n[ "$1" = artifacts ] || exit 2\nshift\nif grep -rIl --binary-files=text "${PLANTED}" "$@" >/dev/null 2>&1; then exit 1; fi\nexit 0\n`;

/** A real (deflated) zip of `inside` at `file`: an installer the scan has to open to read. */
function zipOf(file: string, inside: string): void {
  const src = mkdtempSync(join(tmpdir(), "clover-name-scan-zip-"));
  writeFileSync(join(src, "inside.txt"), inside);
  const r = Bun.spawnSync(["bsdtar", "-a", "-cf", file, "-C", src, "inside.txt"]);
  rmSync(src, { recursive: true, force: true });
  if (r.exitCode !== 0) throw new Error(`bsdtar: ${r.stderr.toString()}`);
}

function release(): string {
  const out = mkdtempSync(join(tmpdir(), "clover-name-scan-"));
  mkdirSync(join(out, "mac-arm64", "Clover.app", "Contents", "Resources", "daemon"), { recursive: true });
  writeFileSync(join(out, "mac-arm64", "Clover.app", "Contents", "Resources", "daemon", "clover-core"), "core bytes");
  writeFileSync(join(out, "mac-arm64", "Clover.app", "Contents", "Resources", "daemon", "clover-plugin-bun"), "bun bytes");
  zipOf(join(out, "Clover-1.0.0-mac.zip"), "installer bytes");
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

  test("a planted hit anywhere in the release fails it: in resources/daemon, an update file, and inside an installer", () => {
    for (const where of [["mac-arm64", "Clover.app", "Contents", "Resources", "daemon", "clover-plugin-bun"], ["latest-mac.yml"]]) {
      const out = release();
      try {
        writeFileSync(join(out, ...where), `bytes ${PLANTED} bytes`);
        expect(() => runNameScan(out, { required: true, guard, quiet: true })).toThrow("the identity scan found a hit");
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }
    // Deflated inside the zip, so only opening it finds it (the scanner is #209's, which opens every archive).
    const out = release();
    try {
      rmSync(join(out, "Clover-1.0.0-mac.zip"));
      zipOf(join(out, "Clover-1.0.0-mac.zip"), `${"padding ".repeat(200)}${PLANTED}${" padding".repeat(200)}`);
      expect(() => runNameScan(out, { required: true, guard, quiet: true })).toThrow("the identity scan found a hit");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("an installer the scan can't open fails it (never read raw only)", () => {
    const out = release();
    try {
      writeFileSync(join(out, "Clover-1.0.0.dmg"), "not a disk image");
      expect(() => runNameScan(out, { required: true, guard, quiet: true })).toThrow("couldn't read the whole built release");
    } finally {
      rmSync(out, { recursive: true, force: true });
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
      // A relative link: its name and target are read, it is never followed (an absolute one fails the scan).
      symlinkSync("Clover-1.0.0-mac.zip", join(out, "link.zip"));
      expect(countFiles([out])).toBe(4);
      const r = runNameScan(out, { required: true, guard, quiet: true, exclusions: [/^Clover-1\.0\.0-mac\.zip$/] });
      expect(r.ran && r.scanned === 3 && r.total === 4).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  // A dmg's drag-to-install link (electron-builder's): `Applications` → `/Applications` at the image's root. The first
  // signed build's scan refused it as an absolute link.
  test("a disk image's root Applications link to /Applications is allowed; any other absolute link still isn't", () => {
    const root = mkdtempSync(join(tmpdir(), "clover-name-scan-links-"));
    try {
      symlinkSync("/Applications", join(root, "Applications"));
      mkdirSync(join(root, "sub"));
      symlinkSync("/Applications", join(root, "sub", "Applications"));
      symlinkSync("/etc", join(root, "etc"));
      expect(walkTree(root, DMG_ROOT_LINKS).problems).toEqual(["etc links to an absolute path (/etc)", "sub/Applications links to an absolute path (/Applications)"]);
      expect(walkTree(root).problems).toContain("Applications links to an absolute path (/Applications)");
      expect(DMG_ROOT_LINKS).toEqual({ Applications: "/Applications" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  darwinTest("a real dmg with its Applications link scans clean, and a planted hit inside it still fails", () => {
    for (const planted of [false, true]) {
      const out = mkdtempSync(join(tmpdir(), "clover-name-scan-dmg-"));
      const src = mkdtempSync(join(tmpdir(), "clover-name-scan-dmg-src-"));
      try {
        writeFileSync(join(src, "readme.txt"), planted ? PLANTED : "app bytes");
        symlinkSync("/Applications", join(src, "Applications"));
        const made = Bun.spawnSync(["hdiutil", "create", "-quiet", "-srcfolder", src, "-format", "UDZO", "-volname", "Clover", join(out, "Clover-1.0.0.dmg")]);
        if (made.exitCode !== 0) throw new Error(`hdiutil create: ${made.stderr.toString()}`);
        if (planted) expect(() => runNameScan(out, { required: true, guard, quiet: true })).toThrow("the identity scan found a hit");
        else expect(runNameScan(out, { required: true, guard, quiet: true }).ran).toBe(true);
      } finally {
        rmSync(src, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
      }
    }
  }, 120_000);

  test("no exclusion ships yet, and the guard lives outside the repo", () => {
    expect(CLOVER_NAME_SCAN_EXCLUSIONS).toEqual([]);
    expect(nameGuardPath({ HOME: "/Users/x" })).toBe("/Users/x/norma-private/git-hooks/name-guard.sh");
    expect(nameGuardPath({ HOME: "/Users/x", CLOVER_NAME_GUARD: "/elsewhere/g.sh" })).toBe("/elsewhere/g.sh");
  });
});
