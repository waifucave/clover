// The tray's and Clover Dev's icons (src/main/icons.ts; drawn into resources/icons by scripts/brand-icons.ts, and
// copied to out/main/icons by the build): which file each platform and theme wears, and that each is there.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { devAppIcon, trayIconFile } from "../src/main/icons";

const icons = join(import.meta.dir, "..", "resources", "icons");
const withRetina = (file: string) => [file, file.replace(/\.png$/, "@2x.png")];

describe("the tray's icon", () => {
  test("macOS: the menu-bar template, whatever the theme (the bar tints it)", () => {
    expect(trayIconFile("darwin", false)).toBe("trayTemplate.png");
    expect(trayIconFile("darwin", true)).toBe("trayTemplate.png");
  });

  test("Windows and Linux: white on a dark taskbar, dark on a light one", () => {
    for (const os of ["win32", "linux"] as const) {
      expect(trayIconFile(os, true)).toBe("tray-on-dark.png");
      expect(trayIconFile(os, false)).toBe("tray-on-light.png");
    }
  });

  test("each file is there, with its @2x beside it", () => {
    for (const file of ["trayTemplate.png", "tray16Template.png", "tray-on-dark.png", "tray-on-light.png"]) {
      for (const f of withRetina(file)) expect([f, existsSync(join(icons, f))]).toEqual([f, true]);
    }
  });
});

describe("Clover Dev's icon", () => {
  test("only the dev app run unpackaged wears it: in the Dock on macOS, on its windows elsewhere", () => {
    expect(devAppIcon({ profile: "dev", packaged: false, platform: "darwin" })).toEqual({ dock: "dev-dock.png" });
    expect(devAppIcon({ profile: "dev", packaged: false, platform: "win32" })).toEqual({ window: "dev-window.png" });
    expect(devAppIcon({ profile: "dev", packaged: false, platform: "linux" })).toEqual({ window: "dev-window.png" });
    // The release app's icon is its package's.
    expect(devAppIcon({ profile: "dist", packaged: false, platform: "darwin" })).toEqual({});
    expect(devAppIcon({ profile: "dist", packaged: true, platform: "linux" })).toEqual({});
    expect(devAppIcon({ profile: "dev", packaged: true, platform: "darwin" })).toEqual({});
    for (const f of ["dev-dock.png", "dev-window.png"]) expect(existsSync(join(icons, f))).toBe(true);
  });
});
