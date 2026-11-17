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
import { UI_STEPS } from "./ui-steps";
import { TAB_FLASH_STEP } from "./tab-flash-step";
import { NOTIFY_STEP } from "./child-notify-step";
import { LISTEN_STEP } from "./listen-step";
import { DRAG_STEP } from "./drag-step";
import { STAGE_COPY_STEP } from "./stage-copy-step";
import { SURFACE_COPY_STEP } from "./surface-copy-step";
import { AGENT_STEP, FULL_STEPS, OUTSIDE_STEP, SHELL_STEP, STAGE_STEP, ELSEWHERE_NOTES } from "./steps";
export { PARTS_ELSEWHERE, partElsewhere, type PartElsewhere } from "./elsewhere-parts";

export type Elsewhere = { owner: "MC2" | "MOSS" | "retired"; why: string };

const ui = (i: number): string => `window: ${UI_STEPS[i]}`;

export const ROWS_ELSEWHERE: ReadonlyMap<string, Elsewhere> = new Map<string, Elsewhere>([
  [ui(5), { owner: "MOSS", why: "the Dispatch pill sends to a bot" }],
  [ui(7), { owner: "retired", why: "Alpha's tab drawn by her own layout: her tab layout is retired with the bot tab (G8), and MOSS draws its bots in its own window" }],
  [ui(14), { owner: "MOSS", why: "the bot editor, opened from a bot's tab and Settings › Bots" }],
  [ui(15), { owner: "MC2", why: "a bot's avatar imported in the bot editor" }],
  [ui(17), { owner: "MC2", why: "a bot plugin's Live2D figure on its stage" }],
  [ui(18), { owner: "MC2", why: "a character renderer drawing a bot's figure" }],
  [ui(19), { owner: "MC2", why: "a bot with a voice on its stage (the stage half MC2's; the voice half goes with it to the MOSS unit)" }],
  [ui(20), { owner: "MC2", why: "Alpha's tab under Bots' plug: the stock sidebar, her top bar, her stage's fold" }],
  [ui(21), { owner: "retired", why: "a bot plugin's own tab layout and another plugin's patch to it: the plug went with the bot tab (G8), and its fixtures (acceptance-layout-patch, acceptance-layout-mover) with it" }],
  [ui(26), { owner: "retired", why: "a bot plugin's panel replacing a stock one on its bot's tab only: the plug went with the bot tab (G8)" }],
  [ui(27), { owner: "MOSS", why: "panels a plugin adds on Alpha's tab and a bot plugin's panels inside its bot (its coding-tab half, Slides on a coding session, is the MOSS unit's to keep with the rest)" }],
  [SURFACE_COPY_STEP, { owner: "MOSS", why: "a copy of the Dispatch pill sending to a bot's conversation" }],
  [FULL_STEPS[6], { owner: "MOSS", why: "a bot's level for writes, its card pressed where the bot's conversation is drawn (MOSS Code's window is told of code sessions' cards only)" }],
  [SHELL_STEP, { owner: "MOSS", why: "a bot's shell and RequestAccess, its card pressed where the bot's conversation is drawn" }],
  [OUTSIDE_STEP, { owner: "MOSS", why: "a command outside the sandbox, only in a bot's own conversation, its card pressed where that is drawn" }],
  [AGENT_STEP, { owner: "MOSS", why: "Alpha's study-buddy agent and its card, pressed where her conversation is drawn" }],
  [ui(16), { owner: "MOSS", why: "Try again on a failed turn stays a bots' feature this round (the MOSS unit's own Try again row); a failed turn in a code session shows its error row, with no Try again" }],
  [TAB_FLASH_STEP, { owner: "MOSS", why: "Alpha's tab never flashing on the way back to it" }],
  [NOTIFY_STEP, { owner: "MOSS", why: "a turn a bot runs on its own reaching the notifier, from a bot's tab" }],
  [LISTEN_STEP, { owner: "MOSS", why: "push-to-talk where a bot's voice listens" }],
  [DRAG_STEP, { owner: "MOSS", why: "a bot's own controls dragging the window" }],
  [STAGE_COPY_STEP, { owner: "MC2", why: "a copy of the stage drawing a bot's figure" }],
  [STAGE_STEP, { owner: "MC2", why: "Alpha's stage tools and their levels on her stage" }],
]);

for (const [name, e] of ROWS_ELSEWHERE) ELSEWHERE_NOTES.set(name, `runs elsewhere (${e.owner === "retired" ? "retired" : e.owner === "MOSS" ? "lane MA's moss unit" : "lane MC2"}): ${e.why}`);
