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
export function onCardYes(
  out: CardYesOutput,
  card: string | undefined,
  change: string,
  allowed: Promise<boolean>,
  apply: () => Promise<string | undefined> | string | undefined,
): void {
  const say = (note: string) => {
    out.log?.(`plugins: a yes on the ${change} card${card ? ` ${card}` : ""} couldn't be done: ${note}`);
    if (card !== undefined) out.emit?.({ type: "plugin_card_note", card, change, note: note.slice(0, 500) });
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
