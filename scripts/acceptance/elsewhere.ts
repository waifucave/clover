// The rows MOSS Code's run no longer runs (lane MC: MOSS Code's window has no bots), each with who runs it now and why.
// They stay in the table at their numbers (other lanes and the merge check name rows by number), their step code stays,
// and no unit of shards.ts runs them: a full table reads each one BLOCKED with its owner, never PASS.
//
// * `MC2`: the avatars lane's (a bot's figure on its stage, a renderer, a bot's own tab under Bots' plug): until MC2
//   makes a bot's figure a pack, they need a bot's tab, which MOSS Code's window doesn't draw.
// * `MOSS`: a bot's row that needs a bot's tab, the Dispatch pill's bot or a bot's voice in the window: lane MA's `moss`
//   unit, on MOSS's own window (apps/moss).
// * `retired`: the plug went with the bot tab (G8): a bot plugin's own tab layout and a panel that replaces a stock one on
//   its bot's tab only.
//
// The rows about a bot that need no window (the engine's bots as records, a bot's model plugins, its shell and its
// agent) keep running on Alpha's record in this run: bots are the engine's data, whichever app is on top.
import { UI_STEPS } from "./ui-steps";
import { TAB_FLASH_STEP } from "./tab-flash-step";
import { NOTIFY_STEP } from "./child-notify-step";
import { LISTEN_STEP } from "./listen-step";
import { DRAG_STEP } from "./drag-step";
import { STAGE_COPY_STEP } from "./stage-copy-step";
import { STAGE_STEP, ELSEWHERE_NOTES } from "./steps";
import { EXAMPLE_NOTES_STEP } from "./example-steps";

export type Elsewhere = { owner: "MC2" | "MOSS" | "retired"; why: string };

const ui = (i: number): string => `window: ${UI_STEPS[i]}`;

export const ROWS_ELSEWHERE: ReadonlyMap<string, Elsewhere> = new Map<string, Elsewhere>([
  [ui(5), { owner: "MOSS", why: "the Dispatch pill sends to a bot" }],
  [ui(7), { owner: "MOSS", why: "Alpha's tab drawn by her own layout" }],
  [ui(14), { owner: "MOSS", why: "the bot editor, opened from a bot's tab and Settings › Bots" }],
  [ui(15), { owner: "MC2", why: "a bot's avatar imported in the bot editor" }],
  [ui(17), { owner: "MC2", why: "a bot plugin's Live2D figure on its stage" }],
  [ui(18), { owner: "MC2", why: "a character renderer drawing a bot's figure" }],
  [ui(19), { owner: "MC2", why: "a bot with a voice on its stage (the stage half MC2's; the voice half goes with it to the MOSS unit)" }],
  [ui(20), { owner: "MC2", why: "Alpha's tab under Bots' plug: the stock sidebar, her top bar, her stage's fold" }],
  [ui(21), { owner: "retired", why: "a bot plugin's own tab layout: the plug went with the bot tab (G8)" }],
  [ui(26), { owner: "retired", why: "a bot plugin's panel replacing a stock one on its bot's tab only: the plug went with the bot tab (G8)" }],
  [TAB_FLASH_STEP, { owner: "MOSS", why: "Alpha's tab never flashing on the way back to it" }],
  [NOTIFY_STEP, { owner: "MOSS", why: "a turn a bot runs on its own reaching the notifier, from a bot's tab" }],
  [LISTEN_STEP, { owner: "MOSS", why: "push-to-talk where a bot's voice listens" }],
  [DRAG_STEP, { owner: "MOSS", why: "a bot's own controls dragging the window" }],
  [STAGE_COPY_STEP, { owner: "MC2", why: "a copy of the stage drawing a bot's figure" }],
  [EXAMPLE_NOTES_STEP, { owner: "MOSS", why: "the notes example's child bot and its tools scoped to bots, on that bot's tab (with bots as records a plugin installed after the move brings no bot, so the example's bot is the MOSS unit's to make)" }],
  [STAGE_STEP, { owner: "MC2", why: "Alpha's stage tools and their levels on her stage" }],
]);

for (const [name, e] of ROWS_ELSEWHERE) ELSEWHERE_NOTES.set(name, `runs elsewhere (${e.owner === "retired" ? "retired" : e.owner === "MOSS" ? "lane MA's moss unit" : "lane MC2"}): ${e.why}`);
