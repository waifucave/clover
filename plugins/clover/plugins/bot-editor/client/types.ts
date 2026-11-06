// The bot editor's props: a bot's fields as the user's own layer sets them over its plugin's (spec §6.1, open
// question 14's answer): its name, the instructions the user adds, its model and effort, its avatar, its voice, its
// theme (a plain one among them) and its layout. Every change is a patch to the user layer; a field cleared (Reset)
// goes back to what the bot's plugin says.

/** A change to the user layer (lane B's `UserLayerPatch`): `null` clears a field, absent leaves it. */
export interface BotPatch {
  name?: string | null;
  instructions?: string | null;
  model?: string | null;
  effort?: string | null;
  voice?: { provider: string; voice: string; model?: string } | null;
  avatar?: { file: string; format: string; portrait?: string } | null;
  theme?: string | null;
  layout?: string | null;
}

export type BotField = keyof BotPatch;

/** One avatar the installed packs offer (`avatar.packs`, a data point the editor declares). */
export interface AvatarChoice {
  /** `<plugin-id>#<entry-id>`. */
  id: string;
  name: string;
  /** The pack plugin's name. */
  pack: string;
  file: string;
  format: string;
  /** The portrait as the pack names it (a path in the pack's folder), which the bot's user layer keeps. */
  portrait?: string;
  /** Where it shows from: the pack's own asset URL. */
  portraitUrl?: string;
}

export interface BotEditorModel {
  id: string;
  label: string;
  detail?: string;
  efforts?: string[];
}

export interface BotEditorProps {
  bot: { id: string; name: string; portraitUrl?: string };
  /** The fields the user layer sets now: each shows Reset. */
  own: readonly BotField[];
  model: { value: string; effort?: string; models: BotEditorModel[] };
  voice?: { provider: string; voice: string; model?: string };
  avatars: AvatarChoice[];
  /** The avatar file the user picked, when they picked one. */
  avatar?: string;
  themes: { id: string; name: string }[];
  /** The theme the bot wears, or none for the app's own. */
  theme?: string;
  /** A field whose change waits on a card. */
  waiting?: BotField;
  onChange: (patch: BotPatch) => void;
  onBack: () => void;
}
