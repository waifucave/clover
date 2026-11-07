// FROZEN: the island's own name fold before #264, kept only as the oracle the agreement test holds lane B's
// foldTitle to. Never import it from the plugin: foldTitle is the one fold.

// How Clover's own parts compare a name a plugin gives against one that is Clover's or a bot's: a skeleton, in the
// way of Unicode's UTS #39, so two names that read the same compare the same. A reserved title ("Needs you"), a
// plugin's name beside a tab, a `pill.target` titled as a bot: each is refused on what a reader sees, never on the
// code points. Pure.
//
// The skeleton folds, in order: compatibility forms (NFKC: full width, mathematical letters, ligatures), the capital
// lookalikes from other scripts (Cyrillic "Н" reads as "H" and would lower to "н"), case, every accent and other
// combining mark, the characters that draw nothing (a zero-width space, a joiner, a bidi control, a variation
// selector), every space and blank (a Hangul filler draws as one), the small lookalikes from other scripts and the
// small capitals, and the Latin ones that a UI font draws alike ("l", "I", "1"; "0" and "o"; "rn" and "m"). It folds too
// much rather than too little: it decides only what is refused, and a name refused by mistake is renamed, where one
// let through reads as Clover's or a bot's. The table is the lookalikes of Latin letters from the scripts a UI font
// draws (Cyrillic, Greek, Armenian, Cherokee, Latin's own small capitals), not the whole of `confusables.txt`.
// Lane B's `foldTitle` (the manifest's own check) is meant to fold the same way, so a name the manifest takes is one
// the island takes.

/** Capitals that read as a Latin capital whose small form is not a lookalike of the Latin small form. */
const CAPITALS: Readonly<Record<string, string>> = {
  // Cyrillic
  А: "A", В: "B", Е: "E", Ё: "E", З: "3", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X",
  Ѕ: "S", І: "I", Ї: "I", Ј: "J", Ү: "Y", Ԛ: "Q", Ԝ: "W", Ӏ: "I", Ꙇ: "I",
  // Greek
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  Ϲ: "C", Ϳ: "J",
  // Armenian
  Տ: "S", Օ: "O", Ս: "U",
  // Cherokee (their small forms are another block, so they fold here, before case)
  Ꭺ: "A", Ᏼ: "B", Ꮯ: "C", Ꭰ: "D", Ꭼ: "E", Ꮐ: "G", Ꮋ: "H", Ꭵ: "i", Ꭻ: "J", Ꮶ: "K", Ꮮ: "L", Ꮇ: "M", Ꮻ: "O",
  Ꮲ: "P", Ꮪ: "S", Ꭲ: "T", Ꮩ: "V", Ꮃ: "W", Ꮓ: "Z",
};

/** Small letters and signs that read as a Latin small letter, after case and marks are gone. Each maps to its final
 *  form: "i" itself folds to "l", so every "i" lookalike maps to "l" too. */
const SMALL: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a", в: "b", е: "e", ё: "e", г: "r", з: "3", к: "k", м: "m", н: "h", о: "o", п: "n", р: "p", с: "c", т: "t",
  у: "y", х: "x", ѕ: "s", і: "l", ї: "l", ј: "j", ԁ: "d", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w", ү: "y", ҽ: "e", ѵ: "v",
  ꙇ: "l",
  // Greek
  α: "a", β: "b", γ: "y", ε: "e", η: "n", ι: "l", κ: "k", ν: "v", ο: "o", ρ: "p", σ: "o", τ: "t", υ: "u", χ: "x",
  ϲ: "c", ϳ: "j", ς: "c",
  // Armenian
  ա: "w", զ: "q", հ: "h", ո: "n", ս: "u", օ: "o",
  // Latin small capitals and other Latin lookalikes
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "l", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n",
  ᴏ: "o", ᴘ: "p", ǫ: "q", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
  ɑ: "a", ɡ: "g", ı: "l", ȷ: "j", ɩ: "l", ʋ: "u", ɣ: "y", ꞵ: "b",
  // What a UI font draws alike in Latin itself: "l", "i" (from "I"), "1", "|", "ǀ"; "0" and "o"
  i: "l", "1": "l", "|": "l", ǀ: "l", "0": "o",
};

/** Pairs a UI font draws as one letter. */
const PAIRS: readonly (readonly [RegExp, string])[] = [
  [/rn/g, "m"],
  [/vv/g, "w"],
  [/cl/g, "d"],
];

/** Blanks that draw as a space without being White_Space (Hangul fillers, the braille blank). */
const BLANKS = /[\p{White_Space}\u115F\u1160\u3164\uFFA0\u2800]+/gu;
/** What draws nothing: default ignorables (zero-width spaces and joiners, bidi controls, variation selectors, the
 *  soft hyphen), formats and controls. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]/gu;
const MARKS = /\p{M}/gu;

function mapEach(text: string, table: Readonly<Record<string, string>>): string {
  let out = "";
  for (const ch of text) out += table[ch] ?? ch;
  return out;
}

/** A name as a reader sees it: two names with the same skeleton read the same. */
export function nameSkeleton(name: string): string {
  let s = name.normalize("NFKC").replace(BLANKS, " ");
  s = mapEach(s, CAPITALS).toLowerCase();
  s = s.normalize("NFD").replace(MARKS, "").replace(INVISIBLE, "");
  // Spaces go too: a zero-width space between two words is where a narrow label breaks the line, so "Needs\u200Byou"
  // can show as "Needs you".
  s = mapEach(s, SMALL).replace(/ /g, "");
  for (const [pair, one] of PAIRS) s = s.replace(pair, one);
  return s;
}

/** Whether two names read the same. */
export function readsAs(a: string, b: string): boolean {
  return nameSkeleton(a) === nameSkeleton(b);
}

/** Bidi controls a shown name may not carry: one would turn "Servers · Home" around its separator. */
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** A name as Clover shows it beside its own words: bidi controls out, its blanks one space. */
export function shownName(name: string): string {
  return name.replace(BIDI, "").replace(BLANKS, " ").trim();
}
