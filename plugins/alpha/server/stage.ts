// Alpha's stage: the document her server writes and her tab's components read (the plugin store, key `stage`), the
// catalogue her tab publishes of the model it loaded (`stage.catalog`), and the scenes she can stand in
// (`stage.scenes`). Pure functions: every change goes through `applyStage`, which checks it against the catalogue and
// the scenes and answers what it changed, or why not, in words the model can act on.
//
// The store keys, and who writes them (the seam's rule: a component reads its plugin's store, only the host half
// writes it):
// * `stage` (STAGE_KEY): this document, version 1, written by the server from her stage tools, her commands and her
//   hooks; at most STAGE_MAX_BYTES serialized and STAGE_WRITES_PER_SECOND writes a second (`StageStore`).
// * `stage.catalog` (CATALOG_KEY): the names the loaded model has (expressions, motions, outfit toggles), which her
//   tab hands the server through `host.call("setCatalog", …)` once it has loaded the model; the server checks it and
//   writes it. Names only, never the model's files: they aren't Clover's to ship (spec §6.6).
// * `stage.scenes` (SCENES_KEY): the scenes she has, her own and the ones other plugins add through her
//   `alpha.scenes` point, written by the server.
// Her tab hears each change of `stage` as `host.on("stage")`, and of any key as `storage.synced.watch`.

export const STAGE_KEY = "stage";
export const CATALOG_KEY = "stage.catalog";
export const SCENES_KEY = "stage.scenes";
/** The `ui.send` topic each new stage document goes out on. */
export const STAGE_TOPIC = "stage";
export const STAGE_MAX_BYTES = 16 * 1024;
export const STAGE_WRITES_PER_SECOND = 10;

export const MOODS = ["calm", "focused", "alert", "joy", "sad"] as const;
export type Mood = (typeof MOODS)[number];

export interface Pinned {
  id: string;
  text: string;
}

/** The stage document, as lane E's components read it (version 1). */
export interface StageState {
  v: 1;
  /** Names the loaded model has (`stage.catalog`), discovered at run time. */
  expression?: string;
  motion?: string;
  scene: string;
  mood: Mood;
  /** The model's toggles, by name. */
  outfit: Record<string, boolean>;
  /** What she is doing now: "thinking", "Read notes.md", "celebrate". */
  activity?: { kind: string; label: string };
  pinned: Pinned[];
  /** Today's turns and tool calls (her tally widget); `day` is the local date it counts. */
  tally?: { turns: number; tools: number; day?: string };
  /** Bumped by each expression, motion or celebration, so the tab plays a repeated one again. */
  nonce: number;
}

/** What the loaded model has, as her tab publishes it. */
export interface StageCatalog {
  v: 1;
  expressions: string[];
  motions: string[];
  outfit: string[];
}

export interface Scene {
  id: string;
  title: string;
  /** The plugin that added it (her own, or one filling `alpha.scenes`). */
  from: string;
}

/** Her own scenes; others come from her `alpha.scenes` point. */
export const OWN_SCENES: readonly Scene[] = [
  { id: "meadow", title: "Clover meadow", from: "alpha" },
  { id: "study", title: "Study corner", from: "alpha" },
  { id: "starry", title: "Starry night", from: "alpha" },
  { id: "rain", title: "Rainy window", from: "alpha" },
];

export const PINNED_MAX = 6;
export const PIN_TEXT_MAX = 200;
/** A name from the loaded model (an expression, a motion, an outfit part): Unicode letters and digits (a model names
 *  its expressions in its own language, `脸红`, `举手确认`), `_`, `.` and `-`, at most 32, no spaces, NFC. Names reach
 *  the model, so they can't hold a sentence. */
export const NAME_RE = /^[\p{L}\p{N}_.-]{1,32}$/u;
const plainName = (n: string): string | undefined => {
  const v = n.normalize("NFC");
  return NAME_RE.test(v) ? v : undefined;
};
const NAMES_MAX = 128;

export function initialStage(scene = "meadow"): StageState {
  return { v: 1, scene, mood: "calm", outfit: {}, pinned: [], nonce: 0 };
}

/** A stored document read back: anything that isn't a version-1 stage starts over, keeping what still reads. */
export function readStage(raw: unknown, fallbackScene = "meadow"): StageState {
  const s = initialStage(fallbackScene);
  if (raw === null || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1) return s;
  const r = raw as Record<string, unknown>;
  if (typeof r.scene === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(r.scene)) s.scene = r.scene;
  if (typeof r.mood === "string" && (MOODS as readonly string[]).includes(r.mood)) s.mood = r.mood as Mood;
  if (typeof r.expression === "string" && plainName(r.expression) !== undefined) s.expression = plainName(r.expression);
  if (typeof r.motion === "string" && plainName(r.motion) !== undefined) s.motion = plainName(r.motion);
  if (r.outfit !== null && typeof r.outfit === "object") {
    for (const [k, v] of Object.entries(r.outfit as Record<string, unknown>).slice(0, NAMES_MAX)) if (plainName(k) === k && typeof v === "boolean") s.outfit[k] = v;
  }
  if (Array.isArray(r.pinned)) {
    for (const p of r.pinned.slice(0, PINNED_MAX)) {
      if (p !== null && typeof p === "object" && typeof (p as Pinned).id === "string" && typeof (p as Pinned).text === "string") s.pinned.push({ id: (p as Pinned).id.slice(0, 32), text: (p as Pinned).text.slice(0, PIN_TEXT_MAX) });
    }
  }
  const a = r.activity as Record<string, unknown> | undefined;
  if (a !== undefined && a !== null && typeof a === "object" && typeof a.kind === "string" && typeof a.label === "string") s.activity = { kind: a.kind.slice(0, 32), label: a.label.slice(0, 80) };
  const t = r.tally as Record<string, unknown> | undefined;
  if (t !== undefined && t !== null && typeof t === "object" && Number.isInteger(t.turns) && Number.isInteger(t.tools)) {
    s.tally = { turns: t.turns as number, tools: t.tools as number, ...(typeof t.day === "string" ? { day: t.day } : {}) };
  }
  if (Number.isInteger(r.nonce) && (r.nonce as number) >= 0) s.nonce = r.nonce as number;
  return s;
}

/** A catalogue her tab hands over, checked: names only, each a short plain name, at most NAMES_MAX of each kind. */
export function readCatalog(raw: unknown): StageCatalog | { error: string } {
  if (raw === null || typeof raw !== "object") return { error: "a catalogue is an object: { v: 1, expressions, motions, outfit }" };
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return { error: "a catalogue says v: 1" };
  const names = (k: string): string[] | undefined => {
    const v = r[k] ?? [];
    if (!Array.isArray(v) || v.length > NAMES_MAX) return undefined;
    const out = v.map((n) => (typeof n === "string" ? plainName(n) : undefined));
    if (out.some((n) => n === undefined)) return undefined;
    return [...new Set(out as string[])];
  };
  const expressions = names("expressions"), motions = names("motions"), outfit = names("outfit");
  if (expressions === undefined || motions === undefined || outfit === undefined) {
    return { error: `each of expressions, motions and outfit is a list of at most ${NAMES_MAX} names of at most 32 letters, digits, "_", "." or "-"` };
  }
  return { v: 1, expressions, motions, outfit };
}

/** A change to the stage, from a tool, a command or a hook. */
export type StageChange =
  | { kind: "expression"; name: string }
  | { kind: "motion"; name: string }
  | { kind: "scene"; scene: string }
  | { kind: "mood"; mood: string }
  | { kind: "outfit"; part: string; on?: boolean }
  | { kind: "pin"; text: string }
  | { kind: "unpin"; id: string }
  | { kind: "clearPins" }
  | { kind: "celebrate" }
  | { kind: "activity"; activity?: { kind: string; label: string } }
  | { kind: "tally"; turns?: number; tools?: number; day: string };

export type StageResult = { ok: true; state: StageState; said: string } | { ok: false; said: string };

/** Names as the model reads them: a quoted list, never words of a sentence. */
const list = (names: readonly string[]) => (names.length === 0 ? "none" : names.map((n) => JSON.stringify(n)).join(", "));

/** Applies a change: the new document and a line saying what happened, or a refusal that names the valid values. */
export function applyStage(state: StageState, change: StageChange, o: { catalog?: StageCatalog; scenes: readonly Scene[]; newId?: () => string }): StageResult {
  const next: StageState = { ...state, outfit: { ...state.outfit }, pinned: [...state.pinned] };
  const noModel = "Her tab hasn't loaded a model yet, so it has no names to use; try again once it shows her.";
  switch (change.kind) {
    case "expression":
    case "motion": {
      const names = change.kind === "expression" ? o.catalog?.expressions : o.catalog?.motions;
      if (names === undefined) return { ok: false, said: noModel };
      const name = change.name.normalize("NFC");
      if (!names.includes(name)) return { ok: false, said: `The model has no ${change.kind} ${JSON.stringify(name.slice(0, 32))}. The ${change.kind}s this model has: ${list(names)}.` };
      next[change.kind] = name;
      next.nonce = state.nonce + 1;
      return { ok: true, state: next, said: `${change.kind === "expression" ? "Expression" : "Motion"}: ${name}.` };
    }
    case "scene": {
      if (!o.scenes.some((s) => s.id === change.scene)) return { ok: false, said: `There's no scene ${JSON.stringify(change.scene.slice(0, 32))}. The scenes she has: ${list(o.scenes.map((s) => s.id))}.` };
      next.scene = change.scene;
      return { ok: true, state: next, said: `Scene: ${change.scene}.` };
    }
    case "mood": {
      if (!(MOODS as readonly string[]).includes(change.mood)) return { ok: false, said: `Moods: ${MOODS.join(", ")}.` };
      next.mood = change.mood as Mood;
      return { ok: true, state: next, said: `Mood: ${change.mood}.` };
    }
    case "outfit": {
      const names = o.catalog?.outfit;
      if (names === undefined) return { ok: false, said: noModel };
      const part = change.part.normalize("NFC");
      if (!names.includes(part)) return { ok: false, said: `The model has no outfit part ${JSON.stringify(part.slice(0, 32))}. The outfit parts this model has: ${list(names)}.` };
      const on = change.on ?? !(state.outfit[part] ?? false);
      next.outfit[part] = on;
      return { ok: true, state: next, said: `${part}: ${on ? "on" : "off"}.` };
    }
    case "pin": {
      const text = change.text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, PIN_TEXT_MAX);
      if (text === "") return { ok: false, said: "A pinned note needs some text." };
      if (state.pinned.length >= PINNED_MAX) return { ok: false, said: `Her stage holds ${PINNED_MAX} notes; unpin one first (their ids: ${list(state.pinned.map((p) => p.id))}).` };
      const id = (o.newId ?? (() => Math.random().toString(36).slice(2, 8)))();
      next.pinned.push({ id, text });
      return { ok: true, state: next, said: `Pinned as ${id}.` };
    }
    case "unpin": {
      if (!state.pinned.some((p) => p.id === change.id)) return { ok: false, said: `No note ${JSON.stringify(change.id.slice(0, 32))} is pinned (their ids: ${list(state.pinned.map((p) => p.id))}).` };
      next.pinned = state.pinned.filter((p) => p.id !== change.id);
      return { ok: true, state: next, said: `Unpinned ${change.id}.` };
    }
    case "clearPins":
      next.pinned = [];
      return { ok: true, state: next, said: "The stage's notes are cleared." };
    case "celebrate":
      next.mood = "joy";
      next.activity = { kind: "celebrate", label: "celebrating" };
      next.nonce = state.nonce + 1;
      return { ok: true, state: next, said: "Celebrating!" };
    case "activity":
      if (change.activity === undefined) delete next.activity;
      else next.activity = { kind: change.activity.kind.slice(0, 32), label: change.activity.label.slice(0, 80) };
      return { ok: true, state: next, said: "" };
    case "tally": {
      const same = state.tally?.day === change.day;
      const base = same ? state.tally! : { turns: 0, tools: 0 };
      next.tally = { turns: base.turns + (change.turns ?? 0), tools: base.tools + (change.tools ?? 0), day: change.day };
      return { ok: true, state: next, said: "" };
    }
  }
}

/** The serialized size of a document, which STAGE_MAX_BYTES caps. */
export function stageBytes(state: StageState): number {
  return new TextEncoder().encode(JSON.stringify(state)).length;
}
