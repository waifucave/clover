// The tray's menu, as data (tray.ts shows it). Pure, so the tests read it. Its words are the core's own strings
// (`clover.core.tray.…`), in the app's language.
import type { MenuItemConstructorOptions } from "electron";
import { translate, type StringTable } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { CORE_STRINGS_EN } from "./ui/core-strings";

export interface TrayActions {
  open(): void;
  quit(): void;
  restart(safeMode: boolean): void;
  /** The core's plugin manager (§5.8: reachable from the tray in safe mode). */
  managePlugins(): void;
}

export interface TrayState {
  safeMode: boolean;
  /** One line about the pair, when the daemon isn't connected ("Reconnecting…"). */
  status?: string;
  /** The core's strings in the app's language (English until the runtime has them). */
  strings?: StringTable;
}

const ENGLISH: StringTable = { lang: "en", strings: CORE_STRINGS_EN };

export function trayMenu(state: TrayState, actions: TrayActions, strings: StringTable = state.strings ?? ENGLISH): MenuItemConstructorOptions[] {
  const t = (key: string) => translate(strings, `clover.core.${key}`);
  return [
    ...(state.status !== undefined ? [{ label: state.status, enabled: false }, { type: "separator" as const }] : []),
    { label: t("tray.open"), click: () => actions.open() },
    ...(state.safeMode ? [{ label: t("tray.manage-plugins"), click: () => actions.managePlugins() }] : []),
    state.safeMode
      ? { label: t("tray.restart-normally"), click: () => actions.restart(false) }
      : { label: t("tray.safe-mode"), click: () => actions.restart(true) },
    { type: "separator" },
    { label: t("tray.quit"), click: () => actions.quit() },
  ];
}
