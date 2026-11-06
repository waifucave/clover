// The menu-bar icon (macOS) or tray icon (Windows, Linux), spec §3.1: the app always runs there, with no window until
// the user opens one, and its Quit stops both halves. On a Linux desktop with no tray, the launcher's Quit action runs
// `clover --quit`, which reaches the running app as a second instance (index.ts). Never made in a headless run.
import { Menu, Tray, nativeImage } from "electron";
import { trayMenu, type TrayActions, type TrayState } from "./tray-menu";

export class AppTray {
  private tray: Tray | undefined;

  constructor(private readonly icon: string, private readonly actions: TrayActions, private readonly log: (line: string) => void) {}

  show(state: TrayState): void {
    try {
      if (this.tray === undefined) {
        const image = nativeImage.createFromPath(this.icon);
        if (process.platform === "darwin") image.setTemplateImage(true);
        this.tray = new Tray(image);
        this.tray.setToolTip("Clover");
        if (process.platform !== "darwin") this.tray.on("click", () => this.actions.open());
      }
      this.tray.setContextMenu(Menu.buildFromTemplate(trayMenu(state, this.actions)));
    } catch (err) {
      // No tray on this desktop: the launcher's actions and the window's menu stand in.
      this.log(`tray: none here (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
}
