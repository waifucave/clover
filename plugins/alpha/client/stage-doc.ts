// The stage document her components read (state version 1), checked: the shape her server writes. Pure, so it is tested
// (`stage-store.ts` is where it comes from).
export const MOODS = ["calm", "focused", "alert", "joy", "sad"] as const;
export type Mood = (typeof MOODS)[number];

export interface StageState {
  v: 1;
  expression?: string;
  motion?: string;
  scene: string;
  mood: Mood;
  outfit: Record<string, boolean>;
  activity?: { kind: string; label: string };
  pinned: { id: string; text: string }[];
  tally?: { turns: number; tools: number; day?: string };
  /** Bumped by each expression, motion or celebration, so a repeated one plays again. */
  nonce: number;
}

export const EMPTY_STAGE: StageState = { v: 1, scene: "meadow", mood: "calm", outfit: {}, pinned: [], nonce: 0 };

/** A document read from the store or heard from her server, taken only if it is the shape the stage writes. */
export function readStage(raw: unknown): StageState | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.scene !== "string") return undefined;
  const mood = (MOODS as readonly string[]).includes(String(r.mood)) ? (r.mood as Mood) : "calm";
  const pinned = Array.isArray(r.pinned)
    ? r.pinned.filter((p): p is { id: string; text: string } => p !== null && typeof p === "object" && typeof (p as { id?: unknown }).id === "string" && typeof (p as { text?: unknown }).text === "string")
    : [];
  const act = r.activity as { kind?: unknown; label?: unknown } | undefined;
  const tally = r.tally as { turns?: unknown; tools?: unknown; day?: unknown } | undefined;
  return {
    v: 1,
    ...(typeof r.expression === "string" ? { expression: r.expression } : {}),
    ...(typeof r.motion === "string" ? { motion: r.motion } : {}),
    scene: r.scene,
    mood,
    outfit: r.outfit !== null && typeof r.outfit === "object" ? (r.outfit as Record<string, boolean>) : {},
    ...(act && typeof act.kind === "string" && typeof act.label === "string" ? { activity: { kind: act.kind, label: act.label } } : {}),
    pinned,
    ...(tally && typeof tally.turns === "number" && typeof tally.tools === "number" ? { tally: { turns: tally.turns, tools: tally.tools, ...(typeof tally.day === "string" ? { day: tally.day } : {}) } } : {}),
    nonce: typeof r.nonce === "number" ? r.nonce : 0,
  };
}


/** The shell document's exact origin, as the frame sees it (`location.ancestorOrigins`): `undefined` when the browser
 *  doesn't say or it is opaque, and then nothing is sent and nothing is heard. */
export function shellOriginOf(ancestors: ArrayLike<string> | undefined): string | undefined {
  const o = ancestors?.[0];
  return typeof o === "string" && o !== "" && o !== "null" ? o : undefined;
}

/** Whether a message is from the shell: our parent window, at the shell's exact origin. */
export function heardFromShell(e: { source: unknown; origin: string }, parent: unknown, shell: string | undefined): boolean {
  return shell !== undefined && e.source === parent && e.origin === shell;
}
