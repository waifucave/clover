// Which of the app's own icons (out/main/icons/, drawn by scripts/brand-icons.ts from assets/brand/clover/; see
// docs/clover-brand.md) the tray and Clover Dev wear. Pure, so the choice is tested without Electron.
import type { AppProfile } from "./identity";

/** The tray's image: macOS's menu-bar template (the bar draws it in its own colour), else the shape in white on a
 *  dark taskbar and in dark on a light one. Electron picks up each file's `@2x` beside it. */
export function trayIconFile(platform: NodeJS.Platform, darkTaskbar: boolean): string {
  if (platform === "darwin") return "trayTemplate.png";
  return darkTaskbar ? "tray-on-dark.png" : "tray-on-light.png";
}

/** Clover Dev's own icon, green on dark, so it never looks like the release app: unpackaged it would otherwise wear
 *  Electron's. The release app's comes from its package (electron-builder's `icon` keys). */
export function devAppIcon(input: { profile: AppProfile; packaged: boolean; platform: NodeJS.Platform }): { dock?: string; window?: string } {
  if (input.profile !== "dev" || input.packaged) return {};
  return input.platform === "darwin" ? { dock: "dev-dock.png" } : { window: "dev-window.png" };
}
