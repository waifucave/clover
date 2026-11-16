// The tray's menu, as data (tray.ts shows it). Pure, so the tests read it. Its words are the core's own strings
// (`moss.core.tray.…`), in the app's language.
import type { MenuItemConstructorOptions } from "electron";
import { translate, type StringTable } from "@waifucave/moss-plugin-sdk/ui/bridge";
import { CORE_STRINGS_EN } from "./ui/core-strings";

export interface TrayActions {
  open(): void;
  quit(): void;
  restart(safeMode: boolean): void;
  /** The core's plugin manager (§5.8: reachable from the tray in safe mode). */
  managePlugins(): void;
  /** A plugin's tray line (`app.tray`): hides the surface it names when it shows, shows it when it is put away; or runs its command. */
  line?(ref: string): void;
  /** Turns the four-finger tap (which hides and shows the surfaces that ask for it) on or off. */
  toggleFourFingerTap?(): void;
  /** Turns the app's one mute over all plugin sound on or off. */
  toggleSoundMute?(): void;
}

export interface TrayLine {
  ref: string;
  title: string;
  hidden?: boolean;
}

export interface TrayState {
  safeMode: boolean;
  /** The lines plugins add (`app.tray` entries): `hidden` says whether the surface a toggle names is put away (its line then says
   *  Show); a line with no `hidden` runs a command. */
  lines?: readonly TrayLine[];
  /** Whether the four-finger tap is on; left out where this Mac has no add-on for it (the menu then has no item). */
  fourFingerTap?: boolean;
  /** Whether all plugin sound is muted (the menu's checkbox); left out, the menu has no such item. */
  soundMuted?: boolean;
  /** The titles of the surfaces the tap hides and shows; none, and the menu has no tap item. */
  tapTitles?: readonly string[];
  /** One line about the pair, when the daemon isn't connected ("Reconnecting…"). */
  status?: string;
  /** The core's strings in the app's language (English until the runtime has them). */
  strings?: StringTable;
}

const ENGLISH: StringTable = { lang: "en", strings: CORE_STRINGS_EN };

export function trayMenu(state: TrayState, actions: TrayActions, strings: StringTable = state.strings ?? ENGLISH): MenuItemConstructorOptions[] {
  const t = (key: string, vars?: Record<string, string>) => translate(strings, `moss.core.${key}`, vars);
  return [
    ...(state.status !== undefined ? [{ label: state.status, enabled: false }, { type: "separator" as const }] : []),
    { label: t("tray.open"), click: () => actions.open() },
    ...(actions.line !== undefined ? (state.lines ?? []).map((l) => ({ label: l.hidden === undefined ? l.title : t(l.hidden ? "tray.show-item" : "tray.hide-item", { title: l.title }), click: () => actions.line?.(l.ref) })) : []),
    ...(state.fourFingerTap !== undefined && (state.tapTitles?.length ?? 0) > 0 && actions.toggleFourFingerTap !== undefined ? [{ label: t("tray.four-finger-tap", { titles: state.tapTitles!.join(", ") }), type: "checkbox" as const, checked: state.fourFingerTap, click: () => actions.toggleFourFingerTap?.() }] : []),
    ...(state.soundMuted !== undefined && actions.toggleSoundMute !== undefined ? [{ label: t("tray.mute-sound"), type: "checkbox" as const, checked: state.soundMuted, click: () => actions.toggleSoundMute?.() }] : []),
    ...(state.safeMode ? [{ label: t("tray.manage-plugins"), click: () => actions.managePlugins() }] : []),
    state.safeMode
      ? { label: t("tray.restart-normally"), click: () => actions.restart(false) }
      : { label: t("tray.safe-mode"), click: () => actions.restart(true) },
    { type: "separator" },
    { label: t("tray.quit"), click: () => actions.quit() },
  ];
}
