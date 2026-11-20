// The rows MOSS Code's run no longer runs (lane MC: MOSS Code's window has no bots), each with who runs it now and why.
// They stay in the table at their numbers (other lanes and the merge check name rows by number), their step code stays,
// and no unit of shards.ts runs them: a full table reads each one BLOCKED with its owner, never PASS.
//
// * `MC2`: the avatars lane's (a bot's figure on its stage, a renderer, a bot's own tab under Bots' plug): until MC2
//   makes a bot's figure a pack, they need a bot's tab, which MOSS Code's window doesn't draw.
// * `MOSS`: a bot's row that needs a bot's tab, the Dispatch pill's bot or a bot's voice in the window: lane MA's `moss`
//   unit, on MOSS's own window (apps/moss).
// * `retired`: the plug went with the bot tab (G8): a bot's tab layout (its own, or another plugin's patch) and a panel
//   that replaces a stock one on its bot's tab only.
//
// The rows about a bot that need no window (the engine's bots as records, a bot's model plugins, its shell and its
// agent) keep running on Alpha's record in this run: bots are the engine's data, whichever app is on top.
import { TAB_FLASH_STEP } from "./tab-flash-step";
import { NOTIFY_STEP } from "./child-notify-step";
import { LISTEN_STEP } from "./listen-step";
import { DRAG_STEP } from "./drag-step";
import { STAGE_COPY_STEP } from "./stage-copy-step";
import { SURFACE_COPY_STEP } from "./surface-copy-step";
import { AGENT_STEP, FULL_STEPS, OUTSIDE_STEP, SHELL_STEP, STAGE_STEP, ELSEWHERE_NOTES } from "./steps";
export { PARTS_ELSEWHERE, partElsewhere, type PartElsewhere } from "./elsewhere-parts";

export type Elsewhere = { owner: "MC2" | "MOSS" | "retired"; why: string };

/** A row by the start of its name (never by its number: rows are inserted, and a number written before an insertion marks the
 *  wrong row). Exactly one row of the table starts with it, or this fails when the module loads. */
const row = (start: string): string => {
  const found = FULL_STEPS.filter((s) => s.startsWith(start));
  if (found.length !== 1) throw new Error(`elsewhere.ts: ${found.length} rows start with "${start}"`);
  return found[0]!;
};
const ui = (start: string): string => row(`window: ${start}`);

export const ROWS_ELSEWHERE: ReadonlyMap<string, Elsewhere> = new Map<string, Elsewhere>([
  [ui("the Dispatch pill sends"), { owner: "MOSS", why: "the Dispatch pill sends to a bot" }],
  [ui("MOSS's tab is drawn by MOSS's own layout"), { owner: "retired", why: "MOSS's tab drawn by her own layout: her tab layout is retired with the bot tab (G8), and MOSS draws its bots in its own window" }],
  [ui("the bot editor opens the user's way"), { owner: "MOSS", why: "the bot editor, opened from a bot's tab and Settings › Bots" }],
  [ui("a bot's question card (AskUserQuestion)"), { owner: "MOSS", why: "a bot's question card (AskUserQuestion) with Send answer, and Try again on a failed turn, both bots' features this round (the MOSS unit's own rows): MOSS's coding agent has no AskUserQuestion (MOSS_CODE_TOOLS), so a code session raises no question card, and a failed turn in one shows its error row with no Try again" }],
  [ui("MOSS's tab shows the stock sidebar"), { owner: "MC2", why: "MOSS's tab under Bots' plug: the stock sidebar, her top bar, her stage's fold" }],
  [ui("a bot plugin changes one thing in its tab"), { owner: "retired", why: "a bot plugin's own tab layout and another plugin's patch to it: the plug went with the bot tab (G8), and its fixtures (acceptance-layout-patch, acceptance-layout-mover) with it" }],
  [ui("a plugin with a bot (the plug rule)"), { owner: "retired", why: "a bot plugin's panel replacing a stock one on its bot's tab only: the plug went with the bot tab (G8)" }],
  [ui("a plugin adds a panel of its own on the right"), { owner: "MOSS", why: "panels a plugin adds on MOSS's tab and a bot plugin's panels inside its bot (its coding-tab half, Slides on a coding session, is the MOSS unit's to keep with the rest)" }],
  [SURFACE_COPY_STEP, { owner: "MOSS", why: "a copy of the Dispatch pill sending to a bot's conversation" }],
  [row("a write to an ordinary folder lands with no card"), { owner: "MOSS", why: "a bot's level for writes, its card pressed where the bot's conversation is drawn (MOSS Code's window is told of code sessions' cards only)" }],
  [SHELL_STEP, { owner: "MOSS", why: "a bot's shell and RequestAccess, its card pressed where the bot's conversation is drawn" }],
  [OUTSIDE_STEP, { owner: "MOSS", why: "a command outside the sandbox, only in a bot's own conversation, its card pressed where that is drawn" }],
  [AGENT_STEP, { owner: "MOSS", why: "MOSS's study-buddy agent and its card, pressed where her conversation is drawn" }],
  [TAB_FLASH_STEP, { owner: "MOSS", why: "MOSS's tab never flashing on the way back to it" }],
  [NOTIFY_STEP, { owner: "MOSS", why: "a turn a bot runs on its own reaching the notifier, from a bot's tab" }],
  [LISTEN_STEP, { owner: "MOSS", why: "push-to-talk where a bot's voice listens" }],
  [DRAG_STEP, { owner: "MOSS", why: "a bot's own controls dragging the window" }],
  [STAGE_COPY_STEP, { owner: "MC2", why: "a copy of the stage drawing a bot's figure" }],
  [STAGE_STEP, { owner: "MC2", why: "MOSS's stage tools and their levels on her stage" }],
]);

for (const [name, e] of ROWS_ELSEWHERE) ELSEWHERE_NOTES.set(name, `runs elsewhere (${e.owner === "retired" ? "retired" : e.owner === "MOSS" ? "lane MA's moss unit" : "lane MC2"}): ${e.why}`);
