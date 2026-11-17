// Parts of a row MOSS Code's run no longer runs (lane MC), where the rest of the row still runs here: each by its row's
// unit and the part's label in that row's step, with who runs it now and why (as `ROWS_ELSEWHERE`, elsewhere.ts, for
// whole rows). The step skips the part and says so in its row's detail.
export type PartElsewhere = { unit: string; part: string; owner: "MC2" | "MOSS" | "retired"; why: string };

export const PARTS_ELSEWHERE: readonly PartElsewhere[] = [
  { unit: "workshop", part: "6b", owner: "MOSS", why: "a peer bot's AppScreenshot of Alpha's tab while her card waits: MOSS Code's window draws no bot's tab" },
  { unit: "workshop", part: "9", owner: "retired", why: "a bot built as a plugin (PluginNew's bot template): PluginInstall refuses a plugin that brings a bot (G8; a bot makes a bot with MakeBot, the spine's ruling 3, which is the MOSS unit's)" },
];

/** The part of `unit`'s row labelled `part` when it runs elsewhere, else undefined. */
export function partElsewhere(unit: string, part: string): PartElsewhere | undefined {
  return PARTS_ELSEWHERE.find((p) => p.unit === unit && p.part === part);
}
