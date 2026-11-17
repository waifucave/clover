// The menu-bar icon (macOS) or tray icon (Windows, Linux), spec §3.1: the app always runs there, with no window until
// the user opens one, and its Quit stops both halves. On a Linux desktop with no tray, the launcher's Quit action runs
// `moss --quit`, which reaches the running app as a second instance (index.ts). Never made in a headless run.
//
// Its image is the moss (docs/moss-brand.md): macOS's menu-bar template, which the bar tints itself; on Windows
// and Linux the shape in white on a dark taskbar and in dark on a light one, swapped when the theme changes.
import { join } from "node:path";
import { Menu, Tray, nativeImage, nativeTheme } from "electron";
import { trayIconFile } from "./icons";
import { trayMenu, type TrayActions, type TrayState } from "./tray-menu";
import type { MenuItemConstructorOptions } from "electron";

/** Windows themes the taskbar apart from apps (`shouldUseDarkColorsForSystemIntegratedUI`); elsewhere it follows the OS. */
function darkTaskbar(): boolean {
  return process.platform === "win32" ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI : nativeTheme.shouldUseDarkColors;
}

/** Builds the menu from the state and the actions: MOSS Code's (`trayMenu`), or the background host's (`hostTrayMenu`,
 *  lane HS: the one menu-bar icon once a host runs, item 112). */
export type TrayMenuBuilder<A> = (state: TrayState, actions: A) => MenuItemConstructorOptions[];

export class AppTray<A extends { open?(): void } = TrayActions> {
  private tray: Tray | undefined;

  private readonly retint = () => this.tray?.setImage(this.image());

  /** `icons` is the folder of the app's own icons (out/main/icons). */
  constructor(private readonly icons: string, private readonly actions: A, private readonly log: (line: string) => void,
    private readonly menu: TrayMenuBuilder<A> = trayMenu as unknown as TrayMenuBuilder<A>, private readonly tooltip = "MOSS Code") {}

  show(state: TrayState): void {
    try {
      if (this.tray === undefined) {
        this.tray = new Tray(this.image());
        if (process.platform !== "darwin") nativeTheme.on("updated", this.retint);
        this.tray.setToolTip(this.tooltip);
        if (process.platform !== "darwin") this.tray.on("click", () => this.actions.open?.());
      }
      this.tray.setContextMenu(Menu.buildFromTemplate(this.menu(state, this.actions)));
    } catch (err) {
      // No tray on this desktop: the launcher's actions and the window's menu stand in.
      this.log(`tray: none here (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  private image(): Electron.NativeImage {
    const image = nativeImage.createFromPath(join(this.icons, trayIconFile(process.platform, darkTaskbar())));
    // The name ends in "Template" already; said again so a renamed file can't lose it.
    if (process.platform === "darwin") image.setTemplateImage(true);
    return image;
  }

  destroy(): void {
    nativeTheme.off("updated", this.retint);
    this.tray?.destroy();
    this.tray = undefined;
  }
}
