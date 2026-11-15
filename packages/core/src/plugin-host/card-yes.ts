// A yes on a plugin change card (a sealed card the Plugins page raised) is applied after the call that raised it has
// answered. What the yes couldn't do, in words, goes out for that card on `plugin_card_note` (the page shows it where
// the card's result shows) and into the log: a failure there is never swallowed.

export interface CardYesOutput {
  /** The core's events (`plugin_card_note`). */
  emit?: (event: { type: string; [k: string]: unknown }) => void;
  log?: (line: string) => void;
}

/** Runs `apply` on the user's yes. `apply` gives back a word when it couldn't do what the card asked (undefined when
 *  it did), or throws; either is said for the card. */
/** A note as plain text a page may show: control characters and line breaks become spaces, characters that hide or
 *  reorder text (bidirectional controls, zero-width characters, tag characters) go, spaces collapse, and it is cut to
 *  500 code points. A reason that comes from a plugin or an index (an updater's, a failure's) passes through here. */
export function plainNote(text: string): string {
  const out = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const points = [...out];
  return points.length > 500 ? `${points.slice(0, 499).join("")}…` : out;
}

export function onCardYes(
  out: CardYesOutput,
  card: string | undefined,
  change: string,
  allowed: Promise<boolean>,
  apply: () => Promise<string | undefined> | string | undefined,
): void {
  const say = (raw: string) => {
    const note = plainNote(raw) || "It couldn't be done.";
    out.log?.(`plugins: a yes on the ${change} card${card ? ` ${card}` : ""} couldn't be done: ${note}`);
    if (card !== undefined) out.emit?.({ type: "plugin_card_note", card, change, note });
  };
  void allowed.then(async (yes) => {
    if (!yes) return;
    try {
      const note = await apply();
      if (note !== undefined) say(note);
    } catch (err) {
      say(`It couldn't be done: ${(err instanceof Error ? err.message : String(err)).replace(/^[a-z_]+: /, "")}`);
    }
  }, () => undefined);
}
