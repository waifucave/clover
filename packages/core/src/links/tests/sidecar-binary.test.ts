// The sidecar the daemon starts is the one shipped beside it (lane M's packages).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledLinkBinary, linkBinaryName } from "../sidecar-binary";

const asIs = (p: string): string => p;

describe("the bundled link sidecar", () => {
  test("lies beside the daemon's executable, as the packages ship it", () => {
    expect(bundledLinkBinary("/opt/moss-code/resources/daemon/moss-core", "linux", asIs)).toBe("/opt/moss-code/resources/daemon/moss-link");
    expect(bundledLinkBinary("/Applications/MOSS Code.app/Contents/Resources/daemon/moss-core", "darwin", asIs))
      .toBe("/Applications/MOSS Code.app/Contents/Resources/daemon/moss-link");
    expect(bundledLinkBinary("C:\\Users\\a\\AppData\\Local\\Programs\\MOSS Code\\resources\\daemon\\moss-core.exe", "win32", asIs))
      .toBe("C:\\Users\\a\\AppData\\Local\\Programs\\MOSS Code\\resources\\daemon\\moss-link.exe");
    expect(linkBinaryName("win32")).toBe("moss-link.exe");
    expect(linkBinaryName("linux")).toBe("moss-link");
  });

  test("follows the executable's links: a link in a folder the user can write never picks the sidecar beside it", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "moss-sidecar-binary-"));
    const app = join(root, "MOSS Code.app", "Contents", "Resources", "daemon");
    const bin = join(root, "homebrew", "bin");
    mkdirSync(app, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(app, "moss-core"), "");
    symlinkSync(join(app, "moss-core"), join(bin, "moss"));
    // A planted sidecar beside the link is never the one chosen.
    writeFileSync(join(bin, "moss-link"), "");
    expect(bundledLinkBinary(join(bin, "moss"))).toBe(join(realpathSync(app), "moss-link"));
  });
});
