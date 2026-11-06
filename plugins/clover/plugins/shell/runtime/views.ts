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

/** What a device is, as Settings groups them: a computer (it runs the core, or is one), a phone, or a browser. */
export function deviceKind(d: Pick<DeviceView, "kind" | "runsCore">): "computer" | "phone" | "web" {
  if (d.kind === "phone") return "phone";
  if (d.kind === "browser") return "web";
  return "computer";
}
