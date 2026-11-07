// The name fold (spec §5.5's reserved titles; #179, #187, #264): what Clover compares a name a plugin gives with, so
// one that reads as Clover's own or a bot's is refused. No dependencies: a client imports it from
// `@waifucave/clover-plugin-sdk/fold` without pulling in zod or the catalogs.

/** Letters from other scripts that read as Latin ones (a short table after Unicode's confusables, UTS #39), and the
 *  digits and strokes that read as letters. */
const CONFUSABLES: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic
  ..."АaВbЕeКkМmНhОoРpСcТtХxУyІlЈjЅsҮyҺhӀlԚqԜwаaеeоoрpсcуyхxіiјjѕsԁdһhӏlԛqԝwүyёeїiгrпn".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Greek
  ..."ΑaΒbΕeΖzΗhΙlΚkΜmΝnΟoΡpΤtΥyΧxαaβbεeιiκkνvοoρpτtυuχxγyωw".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Latin lookalikes, Armenian, digits and strokes
  ..."ıiɩiɑaɡgʏyℓlǀlօoսuցgհhոn0o1l|l".match(/../gu)!.map((p) => [...p] as [string, string]),
]);
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

/** Small capitals and Cherokee letters that read as Latin ones (lane G's island comparison, kept in agreement). */
const LOOKALIKES: Readonly<Record<string, string>> = Object.fromEntries([
  // Small capitals
  ..."ᴀaʙbᴄcᴅdᴇeꜰfɢgʜhɪiᴊjᴋkʟlᴍmɴnᴏoᴘpǫqʀrꜱsᴛtᴜuᴠvᴡwʏyᴢz".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Letters with a stroke or hook, which NFD leaves whole (#187's review): đ ł ø ƚ ɗ ħ ŧ ɍ and their kin
  ..."đdĐdɗdƊdłlŁlƚlȽlɫlɬløoØoǿoǾoħhĦhŧtŦtɍrɌrƀbɃbɨiƗiʉuɄuǥgǤgɇeɆeɉjɈjƶzƵzȼcȻcꝁkꝀkƥpƤpɓbƁbƈcƇcɠgƓgƙkƘkƴyƳyȥzȤz".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Greek lunate sigma (mapped before NFKC, which would make it Σ), and other letters that read as Latin ones
  ..."ϲcϹcყyɘeѻoѺo○o◯oᏁnᏑn".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Lisu (U+A4D0–A4FF), whose letters are Latin capitals, some turned; its tone marks are dropped
  ..."ꓐbꓑpꓒdꓓdꓔtꓕtꓖgꓗkꓘkꓙjꓚcꓛcꓜzꓝfꓞfꓟmꓠnꓡlꓢsꓣrꓤrꓥvꓦvꓧhꓨhꓩfꓪwꓫxꓬyꓭgꓮaꓯaꓰeꓱeꓲlꓳoꓴuꓵuꓶuꓷo".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Cherokee capitals (a small letter is upper-cased to its capital first)
  ..."ᎪaᏴbᏟcᎠdᎬeᏀgᎻhᏆlᎫjᏦkᏞlᎷmᏢpᏒrᏚsᎢtᏙvᎳwᏔwᎩyᏃz".match(/../gu)!.map((p) => [...p] as [string, string]),
]);
/** The island's own lookalike tables (lane G, before #264), folded in so the manifest check refuses everything the
 *  island did: Cyrillic, Greek, Armenian and Cherokee letters that read as Latin ones, in both cases, and Latin's
 *  small capitals. One entry of theirs is left out as too loose: Greek η, which reads as an "n" only in some faces. */
const ISLAND_LOOKALIKES: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic capitals and small letters
  ..."АaВbЕeЁeЗ3КkМmНhОoРpСcТtУyХxЅsІlЇlЈjҮyԚqԜwӀlꙆl".match(/../gu)!.map((p) => [...p] as [string, string]),
  ..."аaвbеeёeгrз3кkмmнhоoпnрpсcтtуyхxѕsіlїlјjԁdһhӏlԛqԝwүyҽeѵvꙇl".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Greek capitals and small letters (σ and ς read as "o" and "c"; ϲ, Ϲ and ϳ, Ϳ too)
  ..."ΑaΒbΕeΖzΗhΙlΚkΜmΝnΟoΡpΤtΥyΧxϹcͿj".match(/../gu)!.map((p) => [...p] as [string, string]),
  ..."αaβbγyεeιlκkνvοoρpσoτtυuχxϲcϳjςc".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Armenian capitals and small letters
  ..."ՏsՕoՍuաwզqհhոnսuօo".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Cherokee capitals (a small letter is upper-cased to its capital first)
  ..."ᎪaᏴbᏟcᎠdᎬeᏀgᎻhᎥlᎫjᏦkᏞlᎷmᏫoᏢpᏚsᎢtᏙvᎳwᏃz".match(/../gu)!.map((p) => [...p] as [string, string]),
  // Latin lookalikes
  ..."ɑaɡgıiȷjɩiʋuɣyꞵbǀl".match(/../gu)!.map((p) => [...p] as [string, string]),
]);

/** Every lookalike, one map: the confusables, the small capitals and Latin letters with a stroke, and the island's. */
const LOOKALIKE: Readonly<Record<string, string>> = { ...ISLAND_LOOKALIKES, ...LOOKALIKES, ...CONFUSABLES };

/** The Latin letter a character reads as, or undefined when it reads as itself (the merged map foldTitle uses). */
export function lookalikeOf(ch: string): string | undefined {
  return LOOKALIKE[ch];
}

function mapLookalikes(text: string): string {
  let out = "";
  for (const ch of text) out += LOOKALIKE[ch] ?? ch;
  return out;
}

const CHEROKEE_SMALL = /[\uAB70-\uABBF\u13F8-\u13FD]/gu;
/** ™ ® © ℠ ℗, and Lisu's tone marks (U+A4F8–A4FD), which read as nothing. */
const DROPPED_MARKS = /[\u2122\u00AE\u00A9\u2120\u2117\uA4F8-\uA4FD]/gu;

/** A title as reserved titles, plugin names that could pose as them, and bot names compare it (#179's review; lane
 *  G's island comparison, #264). Folding too much only reserves more. It runs in three passes of the lookalike map:
 *  1. The text as written, after NFKD (width, mathematical letters, ligatures decomposed), every accent and other mark
 *     stripped, and invisible characters dropped (zero-width spaces and joiners, bidi marks, variation selectors):
 *     a capital that reads as a Latin letter folds here, before case can turn it into a small form the map lacks
 *     (Cyrillic "Н" reads as "H", but its small "н" would not).
 *  2. After case is folded: a small letter, and a capital whose small form is in the map ("Ї" is "ї" is "l").
 *  3. After a second NFKD and mark strip: a letter the map turned into one with a mark, or a precomposed letter whose
 *     base only appears once case is folded, lands on a mapped letter only now, so it is mapped once more.
 *  Then every run of anything but letters and digits is dropped, so a missing or invisible space changes nothing
 *  ("Needsyou" is "Needs you"), and I, i, 1, | and l read as one letter, "rn" as "m", "vv" as "w" and "cl" as "d"
 *  ("Iris" is "iris" is "lris"). */
export function foldTitle(title: string): string {
  // Marks that NFKD would spell out as letters (™ as "TM") go first, with Lisu's tone marks; the lunate sigmas, which
  // NFKD turns into Σ and ς, read as "c".
  const bare = title.replace(DROPPED_MARKS, "").replace(/[\u03F2\u03F9]/gu, "c")
    .normalize("NFKD").replace(/\p{M}/gu, "").replace(INVISIBLE, "").replace(DROPPED_MARKS, "")
    .replace(CHEROKEE_SMALL, (ch) => ch.toUpperCase());
  const folded = mapLookalikes(mapLookalikes(bare).toUpperCase().toLowerCase());
  return mapLookalikes(folded.normalize("NFKD").replace(/\p{M}/gu, ""))
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/[il1|]/g, "l")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/cl/g, "d");
}

