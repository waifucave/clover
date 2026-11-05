// The tray's menu, as data (tray.ts shows it). Pure, so the tests read it.
import type { MenuItemConstructorOptions } from "electron";

export interface TrayActions {
  open(): void;
  quit(): void;
  restart(safeMode: boolean): void;
}

export interface TrayState {
  safeMode: boolean;
  /** One line about the pair, when the daemon isn't connected ("Reconnecting…"). */
  status?: string;
}

export function trayMenu(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  return [
    ...(state.status !== undefined ? [{ label: state.status, enabled: false }, { type: "separator" as const }] : []),
    { label: "Open Clover", click: () => actions.open() },
    state.safeMode
      ? { label: "Restart Normally", click: () => actions.restart(false) }
      : { label: "Restart in Safe Mode", click: () => actions.restart(true) },
    { type: "separator" },
    { label: "Quit Clover", click: () => actions.quit() },
  ];
}
