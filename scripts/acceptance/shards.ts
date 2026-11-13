// The acceptance run in shards (`run.ts --shards N`): the table's rows grouped into units that can run apart, each in a
// temp home, daemon and app of its own, N at a time, then the units that MEASURE (idle CPU, a card's timing and a
// stream's cost, the tab flash, the cold start's deadline) one after another, alone on the machine, so their numbers
// mean something. Kept apart from run.ts (which starts a run when loaded) so the split and the merge can be tested.
//
// What a unit is, from the step tables and the run's order (run.ts `main`):
// * `main` is the chain that shares one home and its state in order: the first start, the key, the turns, the
//   plugin installed and called, the fenced write, the restart, the window's steps on the restarted daemon (one app,
//   one conversation: the pill counts the replies the composer made, the reopened app presses the plugin's card), the
//   web, hook, stdio, network, shell and outside turns, the agent. Every row no other unit names is main's.
// * The rows that need only a keyed daemon, Alpha's conversation and an app over it (each proved alone by an
//   `--only-*` run, or by its own setup in the step): the SDK's two examples (one unit: notes then weather, in the
//   order the full run gives them), the bundled tools, the cards, the workshop, the ways a plugin arrives besides the
//   Plugins page (a hand copy, a wrapped skill folder and agent file); and the reopen steps, which start
//   their own daemons and apps on the home in order, with step 4's fixture plugin installed and OK'd first in their
//   shard (the mid-tool-call step calls its Echo tool: a first sharded run without it found no Echo tool).
// * Measuring units, serial after the parallel phase: the stage row (its narrow-window readings: a card's timing and
//   a streamed reply's cost; its default-level turn runs with it), the tab flash, the cold start, the idle row.
import { COLD_START_STEP, FULL_STEPS, IDLE_STEP, REOPEN_STEPS, STAGE_STEP, finishTable, type Row } from "./steps";
import { EXAMPLE_NOTES_STEP, EXAMPLE_WEATHER_STEP } from "./example-steps";
import { BUNDLED_TOOLS_STEP } from "./bundled-tools-step";
import { CARDS_STEP } from "./cards-step";
import { WORKSHOP_STEP } from "./workshop-step";
import { TAB_FLASH_STEP } from "./tab-flash-step";
import { ARRIVALS_STEP } from "./arrivals-step";

export type UnitId = "main" | "examples" | "bundled-tools" | "cards" | "workshop" | "reopen" | "arrivals" | "stage" | "tab-flash" | "cold" | "idle";

export interface Unit {
  id: UnitId;
  /** Its rows, by name, in the order it runs them. `main`'s are every row no other unit names. */
  rows: readonly string[];
  /** `serial`: run alone after the parallel phase (it measures). */
  phase: "parallel" | "serial";
  /** About how long it takes on the source target, in seconds, as a sharded run measured it (the split's weights). */
  estimate: number;
}

const OTHERS: readonly Unit[] = [
  { id: "examples", rows: [EXAMPLE_NOTES_STEP, EXAMPLE_WEATHER_STEP], phase: "parallel", estimate: 90 },
  { id: "bundled-tools", rows: [BUNDLED_TOOLS_STEP], phase: "parallel", estimate: 60 },
  { id: "cards", rows: [CARDS_STEP], phase: "parallel", estimate: 40 },
  { id: "workshop", rows: [WORKSHOP_STEP], phase: "parallel", estimate: 60 },
  { id: "reopen", rows: REOPEN_STEPS.map((s) => s.name), phase: "parallel", estimate: 110 },
  { id: "arrivals", rows: [ARRIVALS_STEP], phase: "parallel", estimate: 45 },
  { id: "stage", rows: [STAGE_STEP], phase: "serial", estimate: 125 },
  { id: "tab-flash", rows: [TAB_FLASH_STEP], phase: "serial", estimate: 105 },
  { id: "cold", rows: [COLD_START_STEP], phase: "serial", estimate: 16 },
  { id: "idle", rows: [IDLE_STEP], phase: "serial", estimate: 45 },
];

/** Every unit, `main` first, its rows every row of `steps` the others don't name. */
export function units(steps: readonly string[] = FULL_STEPS): Unit[] {
  const taken = new Set(OTHERS.flatMap((u) => u.rows));
  return [{ id: "main", rows: steps.filter((s) => !taken.has(s)), phase: "parallel", estimate: 270 }, ...OTHERS];
}

/** Which unit runs a row (by name). */
export function unitOf(name: string, all: readonly Unit[] = units()): UnitId | undefined {
  return all.find((u) => u.rows.includes(name))?.id;
}

/** The parallel phase's units in `n` shards: `main`, the long pole, alone in the first (from 2 shards: anything added
 *  to it lengthens the whole run, and each shard pays its own start-up, so the others' estimates run high); the rest
 *  the longest first, each to the shard with the least so far (a unit is never split: its rows share a home and run in
 *  order). Shards with nothing are left out. */
export function planShards(n: number, all: readonly Unit[] = units()): UnitId[][] {
  if (!Number.isInteger(n) || n < 1) throw new Error("--shards takes a whole number from 1");
  const parallel = all.filter((u) => u.phase === "parallel").sort((a, b) => b.estimate - a.estimate);
  const shards: { ids: UnitId[]; load: number }[] = Array.from({ length: n }, () => ({ ids: [], load: 0 }));
  const main = parallel.find((u) => u.id === "main");
  if (n > 1 && main !== undefined) {
    shards[0] = { ids: ["main"], load: Number.POSITIVE_INFINITY };
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
