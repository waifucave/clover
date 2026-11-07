// Characters that draw nothing but change what code means: the bidirectional controls of the Trojan
// Source attack, zero-width and filler characters, the tag characters that can carry text no one sees
// (U+E0000 to U+E007F, used to hide instructions in a prompt), and the variation selectors (U+FE00 to
// U+FE0F, U+E0100 to U+E01EF), which can carry data too. This panel exists to review what an agent wrote,
// so it never lets one pass unseen: each shows as a visible mark naming its code point, as GitHub and
// VS Code do, and the character itself is never drawn (so it can't reorder the text around it).
import { Fragment, type ReactNode } from "react";
import { S } from "./strings";

/** Each hidden character, by its code point, with its Unicode name in plain words. The names stay inline, not
 *  `clover.` keys: they are Unicode's standard identifiers for the characters, not UI text (the controller's ruling). */
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

/** The ranges of hidden characters that have no one name each. */
const RANGES = "\\u{FE00}-\\u{FE0F}\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}";
const CLASS = `[${Object.keys(HIDDEN).join("")}${RANGES}]`;
const PATTERN = new RegExp(CLASS, "u");
const SPLIT = new RegExp(`(${CLASS})`, "gu");

/** A hidden character's name in plain words, or `undefined` for any other character. */
export function hiddenName(c: string): string | undefined {
  const named = HIDDEN[c];
  if (named !== undefined) return named;
  const cp = c.codePointAt(0);
  if (cp === undefined || String.fromCodePoint(cp) !== c) return undefined;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return `variation selector ${cp - 0xfe00 + 1}`;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return `variation selector ${cp - 0xe0100 + 17}`;
  if (cp === 0xe0001) return "language tag";
  if (cp === 0xe007f) return "cancel tag";
  // A tag for a printable ASCII character carries that character, unseen: say which.
  if (cp >= 0xe0020 && cp <= 0xe007e) return `tag for "${String.fromCodePoint(cp - 0xe0000)}"`;
  if (cp >= 0xe0000 && cp <= 0xe007f) return "tag character";
  return undefined;
}

/** `U+202E`. */
export const codePoint = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

export function hasHidden(text: string): boolean {
  return PATTERN.test(text);
}

/** The text, with every hidden character drawn as a mark in its place. */
export function ShowHidden({ text }: { text: string }): ReactNode {
  if (!hasHidden(text)) return text;
  // With one capture group, the odd parts are the hidden characters, one code point each.
  return text.split(SPLIT).map((part, i) => {
    const name = i % 2 === 1 ? hiddenName(part) : undefined;
    return name !== undefined ? (
      <span key={i} className="cl-diff-hidden" role="img" aria-label={S.hiddenMark(codePoint(part), name)} title={S.hiddenMark(codePoint(part), name)}>
        {codePoint(part)}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    );
  });
}
