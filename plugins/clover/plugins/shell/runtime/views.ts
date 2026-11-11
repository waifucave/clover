// Small readers for B's views that every part needs.
import type { DeviceView } from "./types";
import { displayText } from "@waifucave/clover-plugin-sdk/plain";

/** B's `Text`: a plain string, or one per language with `en` always there. */
export type Text = string | ({ en: string } & Record<string, string>);

/** A `Text` in the user's language, else its base language, else English. */
export function plain(text: Text | undefined, lang = "en"): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  return text[lang] ?? text[lang.split("-")[0]!] ?? text.en;
}

/** The most of a spot entry's title the shell shows (a sidebar row, the title bar, a Settings section's heading). */
export const FIELD_TEXT_MAX = 80;

/** A spot entry's text field (a `title`, as the manifest wrote it: a string, or words by language) in `lang`, through
 *  the SDK's one plain-text cleaner (`displayText`: one line, no control, bidi or zero-width characters, at most
 *  FIELD_TEXT_MAX), or undefined when it is neither or nothing is left. A plugin wrote it, and the places that show it
 *  are the shell's own. A language map is as good as a string: an entry is never dropped for one. */
export function fieldText(v: unknown, lang = "en"): string | undefined {
  if (typeof v === "string") return displayText(v, FIELD_TEXT_MAX);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  if (typeof t.en !== "string") return undefined;
  const pick = [t[lang], t[lang.split("-")[0]!], t.en].find((x): x is string => typeof x === "string");
  return displayText(pick, FIELD_TEXT_MAX);
}

/** What a device is, as Settings groups them: a computer (it runs the core, or is one), a phone, or a browser. */
export function deviceKind(d: Pick<DeviceView, "kind" | "runsCore">): "computer" | "phone" | "web" {
  if (d.kind === "phone") return "phone";
  if (d.kind === "browser") return "web";
  return "computer";
}
