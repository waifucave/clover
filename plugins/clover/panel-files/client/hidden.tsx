// Characters that draw nothing but change what code means: the bidirectional controls of the Trojan
// Source attack, and zero-width and filler characters. This panel exists to review what an agent wrote,
// so it never lets one pass unseen: each shows as a visible mark naming its code point, as GitHub and
// VS Code do, and the character itself is never drawn (so it can't reorder the text around it).
import { Fragment, type ReactNode } from "react";
import { S } from "./strings";

/** Each hidden character, by its code point, with its Unicode name in plain words. */
const HIDDEN: Readonly<Record<string, string>> = {
  "\u00AD": "soft hyphen",
  "\u061C": "Arabic letter mark",
  "\u115F": "Hangul choseong filler",
  "\u1160": "Hangul jungseong filler",
  "\u180E": "Mongolian vowel separator",
  "\u200B": "zero-width space",
  "\u200C": "zero-width non-joiner",
  "\u200D": "zero-width joiner",
  "\u200E": "left-to-right mark",
  "\u200F": "right-to-left mark",
  "\u202A": "left-to-right embedding",
  "\u202B": "right-to-left embedding",
  "\u202C": "pop directional formatting",
  "\u202D": "left-to-right override",
  "\u202E": "right-to-left override",
  "\u2060": "word joiner",
  "\u2061": "function application",
  "\u2062": "invisible times",
  "\u2063": "invisible separator",
  "\u2064": "invisible plus",
  "\u2066": "left-to-right isolate",
  "\u2067": "right-to-left isolate",
  "\u2068": "first strong isolate",
  "\u2069": "pop directional isolate",
  "\u3164": "Hangul filler",
  "\uFEFF": "zero-width no-break space",
  "\uFFA0": "halfwidth Hangul filler",
};

const PATTERN = new RegExp(`[${Object.keys(HIDDEN).join("")}]`, "u");
const SPLIT = new RegExp(`([${Object.keys(HIDDEN).join("")}])`, "u");

/** `U+202E`. */
export const codePoint = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

export function hasHidden(text: string): boolean {
  return PATTERN.test(text);
}

/** The text, with every hidden character drawn as a mark in its place. */
export function ShowHidden({ text }: { text: string }): ReactNode {
  if (!hasHidden(text)) return text;
  return text.split(new RegExp(SPLIT.source, "gu")).map((part, i) =>
    HIDDEN[part] !== undefined ? (
      <span key={i} className="cl-files-hidden" role="img" aria-label={S.hiddenMark(codePoint(part), HIDDEN[part]!)} title={S.hiddenMark(codePoint(part), HIDDEN[part]!)}>
        {codePoint(part)}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
