// The sidecar the daemon starts is the one shipped beside it (lane M's packages).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledLinkBinary, linkBinaryName } from "../sidecar-binary";

const asIs = (p: string): string => p;

describe("the bundled link sidecar", () => {
  test("lies beside the daemon's executable, as the packages ship it", () => {
    expect(bundledLinkBinary("/opt/Clover/resources/daemon/clover-core", "linux", asIs)).toBe("/opt/Clover/resources/daemon/clover-link");
    expect(bundledLinkBinary("/Applications/Clover.app/Contents/Resources/daemon/clover-core", "darwin", asIs))
      .toBe("/Applications/Clover.app/Contents/Resources/daemon/clover-link");
    expect(bundledLinkBinary("C:\\Users\\a\\AppData\\Local\\Programs\\Clover\\resources\\daemon\\clover-core.exe", "win32", asIs))
      .toBe("C:\\Users\\a\\AppData\\Local\\Programs\\Clover\\resources\\daemon\\clover-link.exe");
    expect(linkBinaryName("win32")).toBe("clover-link.exe");
    expect(linkBinaryName("linux")).toBe("clover-link");
  });

  test("follows the executable's links: a link in a folder the user can write never picks the sidecar beside it", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "clover-sidecar-binary-"));
    const app = join(root, "Clover.app", "Contents", "Resources", "daemon");
    const bin = join(root, "homebrew", "bin");
    mkdirSync(app, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(app, "clover-core"), "");
    symlinkSync(join(app, "clover-core"), join(bin, "clover"));
    // A planted sidecar beside the link is never the one chosen.
    writeFileSync(join(bin, "clover-link"), "");
    expect(bundledLinkBinary(join(bin, "clover"))).toBe(join(realpathSync(app), "clover-link"));
  });
});
