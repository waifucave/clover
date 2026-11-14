// The bot editor's props: a bot's fields as the user's own layer sets them over its plugin's (spec §6.1, open
// question 14's answer): its name, the instructions the user adds, its model and effort, its voice, its
// theme (a plain one among them), its layout and its LAN switch. Every change is a patch to the user layer; a field cleared (Reset)
// goes back to what the bot's plugin says.
import type { ReactNode } from "react";

/** A change to the user layer (lane B's `UserLayerPatch`): `null` clears a field, absent leaves it. */
export interface BotPatch {
  name?: string | null;
  instructions?: string | null;
  model?: string | null;
  effort?: string | null;
  voice?: { provider: string; voice: string; model?: string } | null;
  theme?: string | null;
  layout?: string | null;
  /** The LAN switch (spec's `lan`): `true` turns it on, `null` turns it off. It is never `false`, since off is the
   *  bot's default, so turning it off clears the field. */
  lan?: true | null;
}

export type BotField = keyof BotPatch;

export interface BotEditorModel {
  id: string;
  label: string;
  detail?: string;
  efforts?: string[];
}

/** A plugin's patch to this bot's tab: `<plugin-id>#<entry-id>`, the plugin's name, and whether it is on here. */
export interface TabPatchChoice {
  ref: string;
  name: string;
  on: boolean;
}

/** A part a plugin's `hide` takes out of this bot's tab: the hide (`<plugin-id>#<entry-id>`), the spot it is in, what
 *  the part is called, the hiding plugin's name, and whether the user shows it again. */
export interface HiddenPartChoice {
  ref: string;
  spot: string;
  title: string;
  by: string;
  shown: boolean;
}

export interface BotEditorProps {
  bot: { id: string; name: string; portraitUrl?: string };
  /** The fields the user layer sets now: each shows Reset. */
  own: readonly BotField[];
  model: { value: string; effort?: string; models: BotEditorModel[] };
  voice?: { provider: string; voice: string; model?: string };
  /** The sections other plugins add (`bot.editor.section`), drawn after the model and before the voice: the avatar's is the character plugin's. */
  sections?: ReactNode;
  themes: { id: string; name: string }[];
  /** The theme the bot wears, or none for the app's own. */
  theme?: string;
  /** The LAN switch is on: the bot's browser tabs may reach the local network. Off by default. */
  lan?: boolean;
  /** A field whose change waits on a card. */
  waiting?: BotField;
  /** Other plugins that rearrange this bot's tab (their layout patches, in turn order), each on or switched off by
   *  the user for this bot. */
  tabPatches?: readonly TabPatchChoice[];
  /** Switches one plugin's patch on or off in this bot's tab. */
  onTabPatch?: (ref: string, on: boolean) => void;
  /** The parts other plugins' hides take out of this bot's tab, each shown again or not by the user. */
  hiddenParts?: readonly HiddenPartChoice[];
  /** Shows a hidden part again (`shown` true), or lets the plugin's hide apply again. */
  onHiddenPart?: (part: HiddenPartChoice, shown: boolean) => void;
  onChange: (patch: BotPatch) => void;
  onBack: () => void;
}

/** One of the bot's plugin's settings as the stock section draws it (a secret is left out: its key is entered in the app's own dialog). */
export type StockSetting = {
  key: string;
  title: string;
  description?: string;
  /** One value per bot: saved with the bot named. */
  perBot: boolean;
  value?: unknown;
} & (
  | { type: "string" | "color" }
  | { type: "number"; min?: number; max?: number }
  | { type: "boolean" }
  | { type: "enum"; options: { value: string; title: string }[] }
);
