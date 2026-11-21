// Which bot MOSS's window opens by itself when the person has not chosen one: the default bot (the one the engine made, with her
// greeting) and otherwise the first of the list. The list is newest activity first, so "the first" moves: while the default bot has
// no message yet (her greeting not written) another bot with an older conversation sorts ahead of her, and the window opened on that
// one and then switched when her greeting arrived (a person with another bot already in the home met it at the first start; the
// acceptance row for the list caught it, "MOSS opened Chronicle's conversation"). She is chosen by what she is, not by where she sits.
import type { BotRow } from "../shared/view";

export function autoOpenBot(bots: readonly BotRow[]): BotRow | undefined {
  return bots.find((b) => b.default === true) ?? bots[0];
}
