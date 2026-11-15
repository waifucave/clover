// The scheduled routine row (checklist row 4.23, the bundled clover/trigger-schedule: the core's own schedule, in its
// grammar): Alpha's `Routine` tool makes a routine that runs `every 15s`; nobody presses run now, and its schedule fires
// it: its side thread's turn reaches the model, and `routine.runs` lists the finished run, done, with the side thread's
// reply as its summary. Then its file is deleted, as the Routine tool's text says a routine is removed, and it is gone
// from `routine.list` (so nothing of it fires during a later row). Kept apart from run.ts (which starts a run when
// loaded) so the verdict can be unit-tested.

export const SCHEDULED_ROUTINE_STEP = "a routine on a schedule runs from it (the bundled trigger-schedule's grammar, the core's own timer): Alpha's Routine tool makes one that runs every 15 s; with nobody pressing run now its schedule fires it, its side thread's turn reaches the model, and routine.runs lists the finished run, done, with its reply; its file deleted, it's gone from routine.list";

export const ROUTINE_NAME = "Scheduled probe";
export const ROUTINE_SCHEDULE = "every 15s";

/** The routine's instructions: a tag only its own side thread's turn can make the fake answer with (fake-anthropic.ts
 *  `ACCEPTANCE-TAG-<id>` → `ACCEPTANCE-REPLY-OK ACCEPTANCE-TAG-<id>`). */
export const routineTag = (nonce: string) => `ACCEPTANCE-TAG-SCHED${nonce.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;

export interface RunSeen { routine: string; session: string; startedAt: number; endedAt?: number; outcome: string; summary?: string }

/** Why the runs don't show a run its schedule made, finished, with the side thread's reply; undefined when they do.
 *  `createdAt` is when the routine was made (a run before it isn't this routine's), `mainSession` Alpha's conversation
 *  (a side thread is never it). */
export function scheduledRunWrong(o: { id: string; runs: readonly RunSeen[]; createdAt: number; tag: string; mainSession: string }): string | undefined {
  const mine = o.runs.filter((r) => r.routine === o.id && r.startedAt >= o.createdAt);
  if (mine.length === 0) return `routine.runs lists no run of ${o.id} since it was made`;
  const done = mine.find((r) => r.outcome === "done");
  if (done === undefined) return `its runs are ${mine.map((r) => `${r.outcome}${r.summary ? ` (${r.summary.slice(0, 160)})` : ""}`).join(", ")}, none done`;
  if (done.endedAt === undefined) return "its done run has no end time";
  if (done.session === "none" || done.session === o.mainSession) return `its done run's session is ${done.session}, not a side thread`;
  if (!(done.summary ?? "").includes(`ACCEPTANCE-REPLY-OK ${o.tag}`)) return `its done run's summary isn't its side thread's reply: ${JSON.stringify((done.summary ?? "").slice(0, 200))}`;
  return undefined;
}
