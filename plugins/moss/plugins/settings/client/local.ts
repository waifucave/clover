// Small shapes and readers this part keeps for itself (they were the shell's, F2b: no part imports another's folder).
import type { DeviceView, EntryProps, PluginApi, UiComponent, Unsubscribe } from "@waifucave/moss-plugin-sdk";
import { displayText } from "@waifucave/moss-plugin-sdk/plain";

/** A bot as a reference: its id and name. */
export interface BotRef {
  id: string;
  name: string;
}

/** A component an entry names. */
export type EntryComponent<P = any> = UiComponent<EntryProps<P>>;

/** `files`, with its watch. */
export type FilesWithWatch = NonNullable<PluginApi["files"]>;
export type { Unsubscribe };

/** A manifest's text: a plain string, or one per language with `en` always there. */
export type Text = string | ({ en: string } & Record<string, string>);

/** A `Text` in the user's language, else its base language, else English. */
export function plain(text: Text | undefined, lang = "en"): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  return text[lang] ?? text[lang.split("-")[0]!] ?? text.en;
}

/** The most of a spot entry's title shown in one line. */
export const FIELD_TEXT_MAX = 80;

/** A spot entry's text field (a string, or words by language) in `lang`, one clean line, or undefined. */
export function fieldText(v: unknown, lang = "en"): string | undefined {
  if (typeof v === "string") return displayText(v, FIELD_TEXT_MAX);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  if (typeof t.en !== "string") return undefined;
  const pick = [t[lang], t[lang.split("-")[0]!], t.en].find((x): x is string => typeof x === "string");
  return displayText(pick, FIELD_TEXT_MAX);
}

/** What a device is, as Settings groups them: a computer, a phone, or a browser. */
export function deviceKind(d: Pick<DeviceView, "kind" | "runsCore">): "computer" | "phone" | "web" {
  if (d.kind === "phone") return "phone";
  if (d.kind === "browser") return "web";
  return "computer";
}
