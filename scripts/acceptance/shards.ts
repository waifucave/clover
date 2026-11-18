// The acceptance run in shards (`run.ts --shards N`): the table's rows grouped into units that can run apart, each in a
// temp home, daemon and app of its own, N at a time, then the units that MEASURE (idle CPU, a card's timing and a
// stream's cost, the tab flash, the cold start's deadline) one after another, alone on the machine, so their numbers
// mean something. Kept apart from run.ts (which starts a run when loaded) so the split and the merge can be tested.
//
// What a unit is, from the step tables and the run's order (run.ts `main`):
// * `main` names the whole of what used to be one chain sharing one home, and is now four units (`expandUnitIds`):
//   - `chain`: the first start, the key, the turns, the plugin installed and called, the fenced write, the restart, the reopened
//     app pressing the plugin's card, and the web, hook, stdio, network, shell and outside turns and the agent: everything
//     that reads step 4's plugin or the first daemon's state, in order. Every row no other unit names is the chain's.
//   - `window-1`, `window-2`, `window-3`: the window's steps (UI_STEPS 0-11, 12-22, 23-30), each from a fresh home, a keyed daemon
//     with step 4's plugin installed (the slash menu step runs its command) and an app over it, as `--only-ui` runs steps
//     alone. They were one app and one conversation; the cut is by time (about 3, 5 and 4 minutes of steps), at 12 (the
//     Plugins page, which opens its own folder) and 23 (the bot editor). A step that needs an earlier one's state is
//     moved to that one's unit, not patched.
//   `--units main` runs all four in one process, in one home, as before (the Mac's merge check and the try build use it).
// * The rows that need only a keyed daemon, Alpha's conversation and an app over it (each proved alone by an
//   `--only-*` run, or by its own setup in the step): the SDK's two examples (one unit: notes then weather, in the
//   order the full run gives them), the bundled tools, the cards, the workshop, the ways a plugin arrives besides the
//   Plugins page (a hand copy, a wrapped skill folder and agent file), a plugin's add-ons of its own (its question card,
//   the Plugins page's Restart), the previous app's session on the Archive page (seeded before the shard's daemon), the
//   Browser tool on the run's fixture site
//   (its names given to the shard's app); `models`, the appless rows over the app's methods (each proved alone by its
//   `--only-*`: a plugin's code adapter, a third party's model, the oauth-pkce sign-in, a scheduled routine), on the
//   shard's keyed daemon with no app; and the reopen steps, which start
//   their own daemons and apps on the home in order, with step 4's fixture plugin installed and OK'd first in their
//   shard (the mid-tool-call step calls its Echo tool: a first sharded run without it found no Echo tool).
//   `moss`: MOSS, the bots app (apps/moss), from source over a keyed engine with the bots as engine data, its rows in its
//   own window (moss-step.ts); alone in its run its home is fresh, beside other units it runs last, on a daemon restarted
//   with the records as the bots' source.
//   Everything else stays in `main`: what reads step 4's plugin or the first daemon's state (the API areas row, the
//   host API, plugin CLI and index/npm rows, the agent row and its plugin-tool probes), and the workshop's own steps.
// * Measuring units, serial after the parallel phase: the stage row (its narrow-window readings: a card's timing and
//   a streamed reply's cost; its default-level turn runs with it), the tab flash, the cold start, the idle row.
import { UI_STEPS } from "./ui-steps";
import { COLD_START_STEP, FULL_STEPS, IDLE_STEP, REOPEN_STEPS, STAGE_STEP, finishTable, type Row } from "./steps";
import { EXAMPLE_NOTES_STEP, EXAMPLE_WEATHER_STEP } from "./example-steps";
import { BUNDLED_TOOLS_STEP } from "./bundled-tools-step";
import { TOOL_SETTING_STEP } from "./tool-setting-step";
import { CODE_TOOLS_STEP } from "./code-tools-step";
import { CARDS_STEP } from "./cards-step";
import { ROUTER_STEP } from "./router-step";
import { WORKSHOP_STEP } from "./workshop-step";
import { TAB_FLASH_STEP } from "./tab-flash-step";
import { ARRIVALS_STEP } from "./arrivals-step";
import { CHILD_STEP, NOTIFY_STEP } from "./child-notify-step";
import { LISTEN_STEP } from "./listen-step";
import { WEB_STEP } from "./web-step";
import { DRAG_STEP } from "./drag-step";
import { REVIEW_STEP } from "./review-step";
import { SURFACE_COPY_STEP } from "./surface-copy-step";
import { CONVERSATION_COPY_STEP } from "./conversation-copy-step";
import { STAGE_COPY_STEP } from "./stage-copy-step";
import { ADDONS_STEP } from "./addons-step";
import { ARCHIVE_STEP } from "./archive-step";
import { ACP_BACKEND_STEP } from "./acp-backend-step";
import { BUILDER_EXAMPLES_STEP } from "./builder-examples-step";
import { WORKSHOP_POINTS_STEP } from "./workshop-points-step";
import { BROWSER_STEP } from "./browser-step";
import { CODE_ADAPTER_STEP, OAUTH_SIGN_IN_STEP, THIRD_PARTY_MODEL_STEP } from "./code-adapter-step";
import { SCHEDULED_ROUTINE_STEP } from "./routine-schedule-step";
import { RELEASE_AHEAD_STEP, RELEASE_BEHIND_STEP } from "./release-step";
import { MOSS_STEPS } from "./moss-step";
import { BROWSER_HOST_STEP, HOST_GAVE_UP_STEP, HOST_STEP, SURFACE_COPY_HOST_STEP } from "./host-step";
import { ROWS_ELSEWHERE } from "./elsewhere";

export type UnitId = "main" | "chain" | "window-1" | "window-2" | "window-3" | "examples" | "bundled-tools" | "cards" | "workshop" | "reopen" | "arrivals" | "addons" | "archive" | "acp" | "builder-examples" | "workshop-points" | "release" | "browser" | "plugin-app" | "models" | "moss" | "stage" | "tab-flash" | "cold" | "idle" | "host" | "browser-host" | "surface-copy-host";

export interface Unit {
  id: UnitId;
  /** Its rows, by name, in the order it runs them. `main`'s are every row no other unit names. */
  rows: readonly string[];
  /** `serial`: run alone after the parallel phase (it measures). */
  phase: "parallel" | "serial";
  /** About how long it takes on the source target, in seconds, as a sharded run measured it (the split's weights). */
  estimate: number;
  /** Its rows need a home no other unit has used (MOSS's "only MOSS has ever run here" rows): beside other units it runs
   *  as a run of its own (`--units <it>`, its own temp home, keychain file, fake provider and daemon), as a shard does. */
  ownHome?: true;
}

/** The window's steps, in three units: the places in UI_STEPS where each starts (the last ends at its length). */
const WINDOW_STARTS: readonly (readonly [UnitId, number])[] = [["window-1", 0], ["window-2", 12], ["window-3", 23]];

/** What `main` names: the chain and the window's steps. */
export const MAIN_PARTS: readonly UnitId[] = ["chain", ...WINDOW_STARTS.map(([id]) => id)];

/** The unit ids a `--units` list names, with `main` as the parts it stands for. */
export function expandUnitIds(ids: readonly UnitId[]): UnitId[] {
  return [...new Set(ids.flatMap((id) => (id === "main" ? MAIN_PARTS : [id])))];
}

/** The window steps (by their place in UI_STEPS) a window unit runs, or undefined for any other unit. */
export function windowIndexes(id: UnitId): number[] | undefined {
  const at = WINDOW_STARTS.findIndex(([w]) => w === id);
  if (at < 0) return undefined;
  const from = WINDOW_STARTS[at]![1];
  const to = WINDOW_STARTS[at + 1]?.[1] ?? UI_STEPS.length;
  return Array.from({ length: to - from }, (_, i) => from + i);
}

const WINDOW_ESTIMATES: Readonly<Record<string, number>> = { "window-1": 120, "window-2": 200, "window-3": 170 };

const OTHERS: readonly Unit[] = [
  { id: "examples", rows: [EXAMPLE_NOTES_STEP, EXAMPLE_WEATHER_STEP], phase: "parallel", estimate: 90 },
  { id: "bundled-tools", rows: [BUNDLED_TOOLS_STEP, TOOL_SETTING_STEP, CODE_TOOLS_STEP], phase: "parallel", estimate: 110 },
  { id: "cards", rows: [CARDS_STEP, ROUTER_STEP], phase: "parallel", estimate: 70 },
  { id: "workshop", rows: [WORKSHOP_STEP], phase: "parallel", estimate: 60 },
  { id: "reopen", rows: REOPEN_STEPS.map((s) => s.name), phase: "parallel", estimate: 110 },
  { id: "arrivals", rows: [ARRIVALS_STEP], phase: "parallel", estimate: 45 },
  { id: "addons", rows: [ADDONS_STEP], phase: "parallel", estimate: 60 },
  { id: "archive", rows: [ARCHIVE_STEP], phase: "parallel", estimate: 30 },
  { id: "acp", rows: [ACP_BACKEND_STEP], phase: "parallel", estimate: 40 },
  { id: "builder-examples", rows: [BUILDER_EXAMPLES_STEP], phase: "parallel", estimate: 150 },
  { id: "workshop-points", rows: [WORKSHOP_POINTS_STEP], phase: "parallel", estimate: 60 },
  { id: "release", rows: [RELEASE_BEHIND_STEP, RELEASE_AHEAD_STEP], phase: "parallel", estimate: 90 },
  { id: "plugin-app", rows: [CHILD_STEP, NOTIFY_STEP, LISTEN_STEP, WEB_STEP, DRAG_STEP, REVIEW_STEP, SURFACE_COPY_STEP, CONVERSATION_COPY_STEP, STAGE_COPY_STEP], phase: "parallel", estimate: 330 },
  { id: "browser", rows: [BROWSER_STEP], phase: "parallel", estimate: 60 },
  { id: "models", rows: [CODE_ADAPTER_STEP, THIRD_PARTY_MODEL_STEP, OAUTH_SIGN_IN_STEP, SCHEDULED_ROUTINE_STEP], phase: "parallel", estimate: 90 },
  // MOSS, the bots app (moss-step.ts): its own app from source over the shard's engine, the bots as engine data.
  { id: "moss", rows: MOSS_STEPS, phase: "parallel", estimate: 240, ownHome: true },
  { id: "stage", rows: [STAGE_STEP], phase: "serial", estimate: 125 },
  { id: "tab-flash", rows: [TAB_FLASH_STEP], phase: "serial", estimate: 105 },
  { id: "cold", rows: [COLD_START_STEP], phase: "serial", estimate: 16 },
  { id: "idle", rows: [IDLE_STEP], phase: "serial", estimate: 45 },
  // lane HS: the background host's row, alone (its own daemon starts the host, host-step.ts).
  { id: "host", rows: [HOST_STEP, HOST_GAVE_UP_STEP], phase: "serial", estimate: 240 },
  // …and the Browser rows with that host running (the controller's ruling: every browser row passes with a host too).
  { id: "browser-host", rows: [BROWSER_HOST_STEP], phase: "serial", estimate: 90 },
  // lane HS: row 65 (the island and pill copies) with the background host drawing the screen (the controller's R12 ruling).
  { id: "surface-copy-host", rows: [SURFACE_COPY_HOST_STEP], phase: "serial", estimate: 120 },
];

/** Every unit, the `chain` first, its rows every row of `steps` the others don't name; then the window's three. */
export function units(steps: readonly string[] = FULL_STEPS): Unit[] {
  // A row another lane runs (elsewhere.ts) is in no unit: MOSS Code's run never reaches it, and a full table says who does.
  const here = (r: string) => !ROWS_ELSEWHERE.has(r);
  const windows: Unit[] = WINDOW_STARTS.map(([id]) => ({
    id,
    rows: windowIndexes(id)!.map((i) => `window: ${UI_STEPS[i]}`).filter((r) => steps.includes(r) && here(r)),
    phase: "parallel" as const,
    estimate: WINDOW_ESTIMATES[id]!,
  }));
  const others = OTHERS.map((u) => ({ ...u, rows: u.rows.filter(here) }));
  const taken = new Set([...OTHERS, ...windows].flatMap((u) => u.rows));
  // A unit all of whose rows run elsewhere is left out (`stage`, `tab-flash`).
  return [{ id: "chain", rows: steps.filter((s) => !taken.has(s) && here(s)), phase: "parallel", estimate: 270 }, ...windows, ...others.filter((u) => u.rows.length > 0)];
}

/** Which unit runs a row (by name). */
export function unitOf(name: string, all: readonly Unit[] = units()): UnitId | undefined {
  return all.find((u) => u.rows.includes(name))?.id;
}

/** The parallel phase's units in `n` shards: the `chain`, the long pole, alone in the first (from 2 shards: anything added
 *  to it lengthens the whole run, and each shard pays its own start-up, so the others' estimates run high); the rest
 *  the longest first, each to the shard with the least so far (a unit is never split: its rows share a home and run in
 *  order). Shards with nothing are left out. */
export function planShards(n: number, all: readonly Unit[] = units()): UnitId[][] {
  if (!Number.isInteger(n) || n < 1) throw new Error("--shards takes a whole number from 1");
  const parallel = all.filter((u) => u.phase === "parallel").sort((a, b) => b.estimate - a.estimate);
  const shards: { ids: UnitId[]; load: number }[] = Array.from({ length: n }, () => ({ ids: [], load: 0 }));
  const main = parallel.find((u) => u.id === "chain");
  if (n > 1 && main !== undefined) {
    shards[0] = { ids: ["chain"], load: Number.POSITIVE_INFINITY };
    parallel.splice(parallel.indexOf(main), 1);
  }
  for (const u of parallel) {
    const to = shards.reduce((a, b) => (b.load < a.load ? b : a));
    to.ids.push(u.id);
    to.load += u.estimate;
  }
  // Within a shard, its units in the table's order (main's chain first).
  const order = all.map((u) => u.id);
  return shards.filter((s) => s.ids.length > 0).map((s) => s.ids.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
}

/** The serial phase: each measuring unit alone, in the table's order. */
/** Where a run's units go: those that share the run's own home, and those run as runs of their own (`ownHome`), each in
 *  a home no other unit uses. A unit that needs its own home and is the run's only unit is that run's home already. */
export function homePlan(ids: readonly UnitId[], all: readonly Unit[] = units()): { shared: UnitId[]; ownRuns: UnitId[] } {
  const own = new Set(all.filter((u) => u.ownHome === true).map((u) => u.id));
  if (ids.length === 1) return { shared: [...ids], ownRuns: [] };
  return { shared: ids.filter((id) => !own.has(id)), ownRuns: ids.filter((id) => own.has(id)) };
}

export function serialUnits(all: readonly Unit[] = units()): UnitId[] {
  return all.filter((u) => u.phase === "serial").map((u) => u.id);
}

/** A row as a shard reports it: its result, how long it took in that shard (seconds since the shard's previous result,
 *  or its start), and which shard ran it. */
export interface TimedRow extends Row {
  seconds?: number;
  shard?: string;
}

/** One table from the shards' results, in row order: a row no shard reported reads BLOCKED "not reached" (its shard
 *  crashed or never got there), a row two shards reported reads FAIL with both (a harness bug), and one shard's red
 *  never hides another's result. Each row keeps its shard and seconds. */
export function mergeShards(results: readonly { shard: string; rows: readonly TimedRow[] }[], steps: readonly string[] = FULL_STEPS): TimedRow[] {
  const all: TimedRow[] = results.flatMap((r) => r.rows.map((row) => ({ ...row, shard: r.shard })));
  return finishTable(all, steps).map((row) => {
    const mine = all.filter((r) => r.n === row.n);
    if (mine.length !== 1) return { ...row, ...(mine.length > 1 ? { shard: mine.map((m) => m.shard).join("+") } : {}) };
    return { ...row, ...(mine[0]!.seconds !== undefined ? { seconds: mine[0]!.seconds } : {}), shard: mine[0]!.shard! };
  });
}

/** The `k` slowest rows, slowest first. */
export function slowest(rows: readonly TimedRow[], k = 5): TimedRow[] {
  return [...rows].filter((r) => r.seconds !== undefined).sort((a, b) => b.seconds! - a.seconds!).slice(0, k);
}
