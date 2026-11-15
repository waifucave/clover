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
  /** Hides the Dispatch pill when it shows, shows it when it is hidden. */
  togglePill?(): void;
  /** Turns the four-finger tap (which hides and shows the pill) on or off. */
  toggleFourFingerTap?(): void;
}

export interface TrayState {
  safeMode: boolean;
  /** The pill is put away (its item then says Show). Left out, the menu has no pill item. */
  pillHidden?: boolean;
  /** Whether the four-finger tap is on; left out where this Mac has no add-on for it (the menu then has no item). */
  fourFingerTap?: boolean;
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
    ...(state.pillHidden !== undefined && actions.togglePill !== undefined ? [{ label: t(state.pillHidden ? "tray.show-pill" : "tray.hide-pill"), click: () => actions.togglePill?.() }] : []),
    ...(state.fourFingerTap !== undefined && actions.toggleFourFingerTap !== undefined ? [{ label: t("tray.four-finger-tap"), type: "checkbox" as const, checked: state.fourFingerTap, click: () => actions.toggleFourFingerTap?.() }] : []),
    ...(state.safeMode ? [{ label: t("tray.manage-plugins"), click: () => actions.managePlugins() }] : []),
    state.safeMode
      ? { label: t("tray.restart-normally"), click: () => actions.restart(false) }
      : { label: t("tray.safe-mode"), click: () => actions.restart(true) },
    { type: "separator" },
    { label: t("tray.quit"), click: () => actions.quit() },
  ];
}
