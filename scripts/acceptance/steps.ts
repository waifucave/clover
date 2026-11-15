// The acceptance run's result table: its steps, in order, and how a run's recorded results become one row per step.
// Kept apart from run.ts (which starts a run when loaded) so the table can be unit-tested (steps.test.ts).
import { UI_STEPS } from "./ui-steps";
import { EXAMPLE_NOTES_STEP, EXAMPLE_WEATHER_STEP } from "./example-steps";
import { BUNDLED_TOOLS_STEP } from "./bundled-tools-step";
import { CARDS_STEP } from "./cards-step";
import { ARRIVALS_STEP } from "./arrivals-step";
import { ADDONS_STEP } from "./addons-step";
import { ARCHIVE_STEP } from "./archive-step";
import { ACP_BACKEND_STEP } from "./acp-backend-step";
import { BUILDER_EXAMPLES_STEP } from "./builder-examples-step";
import { WORKSHOP_POINTS_STEP } from "./workshop-points-step";
import { WORKSHOP_STEP } from "./workshop-step";
import { TAB_FLASH_STEP } from "./tab-flash-step";
import { CHILD_STEP, NOTIFY_STEP } from "./child-notify-step";
import { LISTEN_STEP } from "./listen-step";
import { WEB_STEP } from "./web-step";
import { DRAG_STEP } from "./drag-step";
import { REVIEW_STEP } from "./review-step";
import { API_AREAS_STEP } from "./api-areas-step";
import { MANIFEST_FIELDS_STEP } from "./manifest-fields-step";
import { CODE_ADAPTER_STEP, OAUTH_SIGN_IN_STEP, THIRD_PARTY_MODEL_STEP } from "./code-adapter-step";
import { BROWSER_STEP } from "./browser-step";
import { SCHEDULED_ROUTINE_STEP } from "./routine-schedule-step";

export type Status = "PASS" | "FAIL" | "BLOCKED";
/** Stage 2 of "bots ask less": its name, which its number is looked up by (it sits before the three web steps, whose
 *  numbers count back from the cold start). */
export const SHELL_STEP = "the bot's shell: a command in its own folder runs with no card; one writing elsewhere is stopped by the sandbox, the bot asks with RequestAccess, the card is pressed and the retry lands; a network request is refused with no card";
/** Stage 3: a command outside the sandbox, only behind its own card, only in a bot's own conversation. */
export const OUTSIDE_STEP = "a command that needs the network: in the sandbox it can't reach it, with no card; flagged to run outside the sandbox it raises one card (the headline, the exact command, the plain sentence, no Always): denied it doesn't run, approved it runs; the same flagged call from a side thread or a child agent is refused with no card";
export interface Row { n: number; name: string; status: Status; detail: string }
/** The reopen steps (try 9's blocker: quit, reopen a few seconds later, stuck on "Starting Clover…"): the app quits the
 *  way the owner's does while a turn runs, and opens again. Each fails on a window that never fills. */
export const REOPEN_STEPS = [
  { name: "reopen 0 s after quitting mid-turn: the window fills, and the interrupted turn shows as such", delayMs: 0 },
  { name: "reopen 2 s after quitting mid-turn: the window fills, and the interrupted turn shows as such", delayMs: 2_000 },
  { name: "reopen 5 s after quitting mid-turn: the window fills, and the interrupted turn shows as such", delayMs: 5_000 },
  { name: "reopen while the old daemon is still going (held until the app has dialled it): the window fills once it has gone", delayMs: 0, held: true },
  { name: "reopen after a stop cut off at its bound mid-turn: the turn shows stopped, not thinking, and the next message is answered", delayMs: 0, capped: true },
  { name: "reopen after quitting mid tool call: the call reads interrupted, nothing spins, and the next turn doesn't run it again", delayMs: 0, toolCall: true },
  { name: "a stale socket and core.lock with no daemon: the app has one started, and the window fills", stale: true },
] as const;

/** Alpha's stage tools are display-only (`contained`, her own tree's rule, no special case): the step proves the three
 *  levels on the real path. */
export const AGENT_STEP = "Alpha starts her study-buddy on Clover's own coding agent with no card; the agent's row names the definition and the backend, and its report comes back to her conversation; her agent and the user's own coding session each call a plugin's tool through their bridge and get its answer";
export const STAGE_STEP = "Alpha's stage tool runs with no card at the default level and changes her stage; it asks at \"ask\" and is refused at read-only, where her read-only stage_status still answers with no card";
/** The cold-start step's name (`coldStartStep`). Its number is its own place in the table: rows after it (the idle
 *  step) must never take it. */
export const COLD_START_STEP = "cold start: the app opens first, the daemon after, and the shell fills the window";
/** The idle step's name (`idleStep`). */
export const IDLE_STEP = "idle: with the app up and quiet for 15 s, the supervisor and the daemon each use under 2% of a core";

/** A plugin's Review on its OK card, a row of its own after the install (the controller's ruling, 2026-11-13: a red
 *  Review never again stops the install row and the rows that read its plugin). */
export const PLUGIN_REVIEW_STEP = "a plugin's Review on its OK card: with the reviewer role set, the report comes back from the internal job for that plugin, with its disclaimer, the card unchanged; the card then answered";

export const FULL_STEPS = [
  "first start: the app pairs and finishes setup",
  "a model key added through the app's methods",
  "a bot turn gets the fake provider's reply",
  "a plugin installs from a folder, its OK card approved; a plugin whose host.start says each starts at once with no call; a plugin trigger arms a routine and fires it",
  PLUGIN_REVIEW_STEP,
  "the bot calls the plugin's MCP tool",
  "a write to an ordinary folder lands with no card; one to a sensitive place raises a card, pressed, then lands; a Read of ~/.aws/credentials is refused with no card, an ordinary file reads",
  "the daemon restarts on the same home and boots",
  ...UI_STEPS.map((s) => `window: ${s}`),
  "after quit and reopen: the app registers the same answer key, and a card's Approve is pressed in the window",
  ...REOPEN_STEPS.map((s) => s.name),
  SHELL_STEP,
  OUTSIDE_STEP,
  STAGE_STEP,
  AGENT_STEP,
  EXAMPLE_NOTES_STEP,
  EXAMPLE_WEATHER_STEP,
  BUNDLED_TOOLS_STEP,
  CARDS_STEP,
  WORKSHOP_STEP,
  TAB_FLASH_STEP,
  CHILD_STEP,
  NOTIFY_STEP,
  LISTEN_STEP,
  WEB_STEP,
  DRAG_STEP,
  REVIEW_STEP,
  BROWSER_STEP,
  "each boot lists the bundled web tools within 5 s and offers them; an installed plugin's server lists too",
  "the bot's WebSearch reaches the fake search backend; nothing leaves the machine",
  "the bot's WebFetch reads a page the user gave or a search hit with no card, asks for an address it made up or a link it found on a page, and is refused a private address",
  "a folder-installed plugin's command hook fires on its event, fenced: no write outside its folders, no undeclared host",
  "a plugin's own API in its host half: a point's entries, call and watch; its synced store's keys, delete and watch; settings.watch; a note and a message into Alpha's conversation; its hooks on all eight events; removed with its data",
  "the clover plugin CLI against the run's daemon: list, info, logs, pin refused for a folder plugin, restart, index list; install, disable, enable, update, remove, wrap skill-folder, dev add, list and remove; new and validate",
  "plugins from an index the user added and from npm: installed behind their OK cards; an update offered and applied on the user's click with no card; a pinned plugin offered none; an update that adds a trigger asks again on a card that says what changed",
  "a folder-installed plugin's stdio MCP server lists and answers, fenced: no write outside its folders, no undeclared host",
  "a plugin's own network: its granted host through its proxy and nothing else, no direct socket, no borrowed proxy; a pasted MCP config reaches the network, as its card says; a pasted MCP URL's tools list to the bot and answer it",
  API_AREAS_STEP,
  MANIFEST_FIELDS_STEP,
  CODE_ADAPTER_STEP,
  THIRD_PARTY_MODEL_STEP,
  OAUTH_SIGN_IN_STEP,
  SCHEDULED_ROUTINE_STEP,
  ARRIVALS_STEP,
  ADDONS_STEP,
  ARCHIVE_STEP,
  ACP_BACKEND_STEP,
  BUILDER_EXAMPLES_STEP,
  WORKSHOP_POINTS_STEP,
  COLD_START_STEP,
  IDLE_STEP,
] as const;

/** The upgrade run's steps (--upgrade-from), in the order they run. */
export const UPGRADE_STEPS = [
  "upgrade cold start: the app opens first on the old home, the daemon after, and the shell fills the window",
  "the old run's model key works with no re-entry",
  "the old conversation is listed and opens in the window",
  "a new turn runs on the upgraded home",
  "the old run's plugin is still installed and its tool answers, with no new OK card",
  "a fenced write still raises an approval card, then lands",
  "the bundled web tools and the old plugin's server list within 5 s, and the first turn offers them",
  "a setting the old run changed is still set",
  "an \"Always allow\" the old build saved still answers the same call (asking again is acceptable; an error is not)",
  "a bundled plugin this build parks (the forwarder, on in the old run) is listed as not available, its switch kept on, with no card",
  "the daemon trusts the state the old build signed (plugin registry, device key)",
] as const;

/** A step's number (1-based) in `steps` by its exact name; throws for a name the table doesn't have. */
export function stepNumber(steps: readonly string[], name: string): number {
  const i = steps.indexOf(name);
  if (i < 0) throw new Error(`no step named "${name.slice(0, 60)}…"`);
  return i + 1;
}

/** The table a run prints: exactly one row per step of `steps` (or only step `only`, for a cold-start-only run), in
 *  order. A step nothing recorded reads BLOCKED "not reached"; a step recorded more than once (two steps took the same
 *  number: a harness bug) reads FAIL and names every result, so the clash shows instead of one row silently replacing
 *  another; a result for a number outside the table is dropped. */
export function finishTable(recorded: readonly Row[], steps: readonly string[], only?: number | readonly number[]): Row[] {
  const keep = only === undefined ? undefined : new Set(typeof only === "number" ? [only] : only);
  const out: Row[] = [];
  for (let n = 1; n <= steps.length; n++) {
    if (keep !== undefined && !keep.has(n)) continue;
    const mine = recorded.filter((r) => r.n === n);
    const name = steps[n - 1]!;
    if (mine.length === 0) out.push({ n, name, status: "BLOCKED", detail: "not reached" });
    else if (mine.length === 1) out.push(mine[0]!);
    else out.push({ n, name, status: "FAIL", detail: `harness: step ${n} was recorded ${mine.length} times: ${mine.map((r) => `${r.status}: ${r.detail}`).join(" | ")}`.slice(0, 600) });
  }
  return out;
}

/** The first table row of the window steps (UI_STEPS[0]); the full run's UI phase records them from here. */
export const UI_FIRST_ROW: number = FULL_STEPS.findIndex((s) => s === `window: ${UI_STEPS[0]}`) + 1;
/** `--only-ui [indexes]`: which window steps run, by their place in UI_STEPS (comma-separated; default the Plugins page's, 12).
 *  Throws on a number outside the list. */
export function parseOnlyUi(arg: string | undefined): number[] {
  const text = arg === undefined || arg.startsWith("--") ? "12" : arg;
  const out = [...new Set(text.split(",").map((t) => Number(t.trim())))].sort((a, b) => a - b);
  for (const n of out) if (!Number.isInteger(n) || n < 0 || n >= UI_STEPS.length) throw new Error(`--only-ui takes window step numbers 0 to ${UI_STEPS.length - 1}, not "${text}"`);
  return out;
}
/** The table rows of those window steps. */
export const uiRowNumbers = (indexes: readonly number[]): number[] => indexes.map((i) => UI_FIRST_ROW + i);
