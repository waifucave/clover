// Small readers for B's views that every part needs.
import type { DeviceView } from "./types";

/** B's `Text`: a plain string, or one per language with `en` always there. */
export type Text = string | ({ en: string } & Record<string, string>);

/** A `Text` in the user's language, else its base language, else English. */
export function plain(text: Text | undefined, lang = "en"): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  return text[lang] ?? text[lang.split("-")[0]!] ?? text.en;
}

/** A spot entry's text field (a `title`, as the manifest wrote it: a string, or words by language) in `lang`, or
 *  undefined when it is neither. A plugin's language map is as good as a string: an entry is never dropped for one. */
export function fieldText(v: unknown, lang = "en"): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  if (typeof t.en !== "string") return undefined;
  const pick = [t[lang], t[lang.split("-")[0]!], t.en].find((x): x is string => typeof x === "string");
  return pick;
}

/** What a device is, as Settings groups them: a computer (it runs the core, or is one), a phone, or a browser. */
export function deviceKind(d: Pick<DeviceView, "kind" | "runsCore">): "computer" | "phone" | "web" {
  if (d.kind === "phone") return "phone";
  if (d.kind === "browser") return "web";
  return "computer";
}
