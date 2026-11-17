// What the figure does as sessions work (spec revision 19, G7: the avatar plugin follows sessions through the activity
// feed, `activity.read.sessions`, and bots only when it asks, `activity.read.bots`). The feed carries states and names,
// never words. The figure plays the expression a state calls for when its model has one by any of the usual names, and
// its pace: calm at rest, lively while something works.
import type { FigureCue, FigureNames } from "./figure-cues";

/** The feed's states (the engine's `ACTIVITY_STATES`). */
export type State = "idle" | "listening" | "thinking" | "working" | "asking" | "stuck" | "done" | "asleep";
/** One subject's activity as the feed gives it (`activity.list`, `activity.watch`). */
export interface ActivityView {
  subject: { kind: "sessions" | "bots"; id: string; bot?: string };
  state: State;
  name?: string;
  tool?: string;
  since: number;
}

/** The expression names each state looks for in the model, in order. */
export const STATE_EXPRESSIONS: Readonly<Record<State, readonly string[]>> = {
  idle: ["neutral", "normal", "default", "relaxed", "calm"],
  listening: ["listening", "curious", "neutral"],
  thinking: ["thinking", "think", "curious", "focused"],
  working: ["focused", "working", "serious", "determined"],
  asking: ["asking", "surprised", "curious", "question"],
  stuck: ["sad", "worried", "troubled", "confused"],
  done: ["happy", "joy", "smile", "glad"],
  asleep: ["sleepy", "sleep", "neutral", "relaxed"],
};

const CALM: ReadonlySet<State> = new Set(["idle", "asleep", "done", "listening"]);

/** The cues a state asks of the figure, by what its model has: an expression it has (any case), and the pace. */
export function cuesFor(state: State, names: FigureNames | undefined, canPace: boolean): FigureCue[] {
  const out: FigureCue[] = [];
  const have = names?.expressions ?? [];
  for (const want of STATE_EXPRESSIONS[state]) {
    const hit = have.find((n) => n.toLowerCase() === want);
    if (hit !== undefined) {
      out.push({ type: "expression", name: hit });
      break;
    }
  }
  if (canPace) out.push({ type: "pace", calm: CALM.has(state) });
  return out;
}

/** The activity the figure follows now: the one session it is shown beside, else the most recent change among what it
 *  reads (sessions, and bots when it follows them). */
export function followed(all: readonly ActivityView[], session: string | undefined): ActivityView | undefined {
  if (session !== undefined) return all.find((a) => a.subject.kind === "sessions" && a.subject.id === session);
  let best: ActivityView | undefined;
  for (const a of all) if (best === undefined || a.since > best.since) best = a;
  return best;
}

/** The feed as it changes: one view per subject, the newest kept. */
export function merge(all: readonly ActivityView[], next: ActivityView): ActivityView[] {
  const key = (a: ActivityView) => `${a.subject.kind}\u0000${a.subject.id}`;
  return [...all.filter((a) => key(a) !== key(next)), next].slice(-256);
}
