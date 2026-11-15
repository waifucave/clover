// What a bot plugin may ask its figure to do, and what a renderer tells back (the `avatar.*` plugin API): one public
// contract between any bot plugin and any avatar renderer, with plain data only. The renderer fills the `avatar` spot
// and declares its format in `avatar.formats`, with the `capabilities` it supports; it publishes the model's catalogue
// (the names THIS model answers to) and the figure's box; a bot plugin plays cues and reads both.
//
// Everything that crosses (the plugin API, the core, the frame bridge) is read through the `clean*` functions here: a
// value that isn't one of these shapes is dropped, never passed on, and every list and string is capped.
import { AVATAR_CAPABILITIES } from "./avatars";

/** A name a model answers to (an expression, a motion, an outfit part), at most this long. */
export const AVATAR_NAME_MAX = 64;
/** Names per list a renderer may publish. */
export const AVATAR_NAMES_MAX = 200;

export type AvatarCapability = (typeof AVATAR_CAPABILITIES)[number];

/** One thing the figure is asked to do. `x` and `y` of `lookAt` are in the stage's own square, -1 to 1 from its centre
 *  (x to the right, y down), and `null` is back to looking at nothing in particular. */
export type AvatarCue =
  | { readonly type: "expression"; readonly name: string }
  | { readonly type: "motion"; readonly name: string }
  | { readonly type: "outfit"; readonly part: string; readonly on: boolean }
  | { readonly type: "pace"; readonly calm: boolean }
  | { readonly type: "lookAt"; readonly point: { readonly x: number; readonly y: number } | null };

/** Mouth levels per speech cue at most. A batch is the unit a plugin sends ahead of the clock; the stage keeps it by time. */
export const SPEECH_FRAMES_MAX = 128;
/** A stamp may be at most this far ahead of the core's clock (ms): "ahead of the clock", not a whole book at once. */
export const SPEECH_AHEAD_MAX_MS = 120_000;
/** Speech cues a plugin may send a second, and the mouth levels in them together: their own window, so a talking bot's
 *  expressions and motions (`AVATAR_CUES_PER_SECOND` in the core) never wait behind its mouth. */
export const SPEECH_CUES_PER_SECOND = 20;
export const SPEECH_FRAMES_PER_SECOND = 2000;
/** The brightness a level with no `centroid` reads as (Hz): a middle vowel. */
export const SPEECH_DEFAULT_CENTROID = 1500;

/** One mouth level: when it sounds (epoch milliseconds, the same clock as `Date.now()`), how loud (0 to 1) and, if the
 *  plugin knows it, how bright (the spectral centroid in Hz: it shapes the vowel; without it the mouth only opens). A level
 *  is heard until the next one, at most 50 ms. */
export interface AvatarSpeechFrame {
  readonly t: number;
  readonly rms: number;
  readonly centroid?: number;
}

/** What a speaking bot's mouth does: levels stamped in epoch milliseconds, in batches sent ahead of the clock (at most
 *  `SPEECH_FRAMES_MAX` a batch, stamps strictly rising, none more than `SPEECH_AHEAD_MAX_MS` ahead). The stage keeps them
 *  and hands the renderer each a moment before it is due, so the renderer lip-syncs exactly as it does to any speech;
 *  `speaking` is true from the first level's stamp to a moment after the last. `cut` first forgets every level not yet due
 *  (the speech is stopped or replaced), so a batch of only `cut` ends the mouth. Not an `AvatarCue`: a renderer is never
 *  handed one (it reads the speech through `useAvatarSpeech`). */
export interface AvatarSpeechCue {
  readonly type: "speech";
  readonly frames: readonly AvatarSpeechFrame[];
  readonly cut?: true;
}

/** What `avatar.cue` takes: a cue for the renderer, or the speech's mouth levels. */
export type AvatarAnyCue = AvatarCue | AvatarSpeechCue;

/** The plain answer to a cue. A cue that wasn't played says why, in words a bot plugin can pass on to its model:
 *  `no-renderer` (nothing draws this bot's figure now), `unsupported` (the renderer doesn't do that kind of cue),
 *  `unknown-name` (the loaded model has no such expression, motion or part: the answer lists some it has), `invalid`. */
export type AvatarCueResult = { readonly ok: true } | { readonly ok: false; readonly reason: "no-renderer" | "unsupported" | "unknown-name" | "invalid"; readonly message: string };

/** What the loaded model has, by the renderer's own names. */
export interface AvatarCatalogueNames {
  readonly expressions: readonly string[];
  readonly motions: readonly string[];
  /** Outfit parts that switch on and off, with where each stands now. */
  readonly outfits: readonly { readonly name: string; readonly on: boolean }[];
}

/** The figure's model as `avatar.catalogue()` answers: the format and the renderer's plugin id, what the renderer does
 *  (its `avatar.formats` `capabilities`), and the names. */
export interface AvatarCatalogue extends AvatarCatalogueNames {
  readonly format: string;
  readonly renderer: string;
  readonly capabilities: readonly AvatarCapability[];
}

/** A point on the stage, in its own pixels from the top left. */
export interface AvatarPoint { readonly x: number; readonly y: number }
export const AVATAR_ANCHORS = ["headTop", "face", "mouth", "chest"] as const;
export type AvatarAnchorName = (typeof AVATAR_ANCHORS)[number];

/** Where the figure is on the stage, in the stage's own pixels (top left origin): the stage's size, the figure's
 *  bounding box and some named anchors. A renderer that can't know says only the canvas: the box then reads as the
 *  default (`defaultAvatarBox`, `estimated: true`). */
export interface AvatarBox {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly figure?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly anchors?: Readonly<Partial<Record<AvatarAnchorName, AvatarPoint>>>;
  /** True when the app made the figure and anchors up (the renderer reported only the canvas). */
  readonly estimated?: boolean;
}

/** What `avatar.watch` hands its listener. */
export type AvatarChange =
  | { readonly kind: "catalogue"; readonly catalogue: AvatarCatalogue | undefined }
  | { readonly kind: "box"; readonly box: AvatarBox | undefined };

/** What the stage tells the core about the renderer it drew for a bot (`avatar.report`; undefined: nothing drawn). */
export interface AvatarReport {
  readonly format: string;
  readonly renderer: string;
  readonly capabilities: readonly AvatarCapability[];
  readonly names?: AvatarCatalogueNames;
  readonly box?: AvatarBox;
}

/** The plugin API's `avatar` area. */
export interface AvatarApi {
  /** Asks the figure for one cue (or, for `{ type: "speech", frames }`, a batch of the mouth's levels). Resolves with the
   *  plain answer, never throws for a cue that can't be played. For the plugin's own bot (the bot whose id is the
   *  plugin's top-level id) with `avatar.control`; `opts.bot` names another bot, which needs `avatar.control.all` (a
   *  plugin without it is refused, saying why). */
  cue(cue: AvatarAnyCue, opts?: { readonly bot?: string }): Promise<AvatarCueResult>;
  /** The model's catalogue, or undefined while nothing draws the figure. Needs `avatar.read`. */
  catalogue(): Promise<AvatarCatalogue | undefined>;
  /** The figure's box on the stage (the default when the renderer can't say), or undefined while nothing draws it. */
  box(): Promise<AvatarBox | undefined>;
  /** Hears the catalogue (a model loads, the user imports another) and the box change. */
  watch(listener: (change: AvatarChange) => void): () => void;
}

/** The kind of capability a cue needs of the renderer. */
export const CUE_CAPABILITY: Readonly<Record<AvatarCue["type"], AvatarCapability>> = {
  expression: "expressions", motion: "motions", outfit: "outfits", pace: "pace", lookAt: "lookat",
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
/** A name as it may cross: a non-empty string, no control characters, at most AVATAR_NAME_MAX characters. */
export const cleanAvatarName = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= AVATAR_NAME_MAX && !CONTROL.test(v) ? v : undefined);

/** A cue as it may cross, or undefined. */
export function cleanAvatarCue(raw: unknown): AvatarCue | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case "expression": case "motion": {
      const name = cleanAvatarName(c.name);
      return name === undefined ? undefined : { type: c.type, name };
    }
    case "outfit": {
      const part = cleanAvatarName(c.part);
      return part === undefined || typeof c.on !== "boolean" ? undefined : { type: "outfit", part, on: c.on };
    }
    case "pace": return typeof c.calm === "boolean" ? { type: "pace", calm: c.calm } : undefined;
    case "lookAt": {
      if (c.point === null) return { type: "lookAt", point: null };
      const p = c.point as Record<string, unknown> | undefined;
      if (p === undefined || typeof p !== "object" || !finite(p.x) || !finite(p.y)) return undefined;
      return { type: "lookAt", point: { x: Math.min(1, Math.max(-1, p.x)), y: Math.min(1, Math.max(-1, p.y)) } };
    }
    default: return undefined;
  }
}

/** A speech cue as it may cross: stamps whole milliseconds, strictly rising; loudness 0 to 1; brightness 0 to 24 kHz;
 *  at most SPEECH_FRAMES_MAX levels; `cut` only as true. Undefined if it isn't one (`why` says what is wrong). */
export function cleanSpeechCue(raw: unknown): { cue: AvatarSpeechCue } | { why: string } {
  if (raw === null || typeof raw !== "object") return { why: "a speech cue is { type: \"speech\", frames: [{ t, rms }] }" };
  const c = raw as Record<string, unknown>;
  if (c.type !== "speech" || !Array.isArray(c.frames)) return { why: "a speech cue is { type: \"speech\", frames: [{ t, rms }] }" };
  if (c.cut !== undefined && c.cut !== true) return { why: "a speech cue's cut is true or absent" };
  if (c.frames.length > SPEECH_FRAMES_MAX) return { why: `a speech cue carries at most ${SPEECH_FRAMES_MAX} levels; send the rest in the next one` };
  if (c.frames.length === 0 && c.cut !== true) return { why: "a speech cue needs levels, or cut to end the speech" };
  const frames: AvatarSpeechFrame[] = [];
  let last = -1;
  for (const f of c.frames as unknown[]) {
    const r = f as Record<string, unknown> | null;
    if (r === null || typeof r !== "object" || !finite(r.t) || !finite(r.rms) || (r.centroid !== undefined && !finite(r.centroid))) return { why: "each level is { t: epoch milliseconds, rms: 0 to 1, centroid?: Hz }, all numbers" };
    const t = Math.round(r.t);
    if (t < 0 || t > Number.MAX_SAFE_INTEGER) return { why: "a level's t is epoch milliseconds" };
    if (t <= last) return { why: "a speech cue's levels must be stamped strictly rising" };
    last = t;
    frames.push({ t, rms: Math.min(1, Math.max(0, r.rms)), ...(r.centroid !== undefined ? { centroid: Math.min(24_000, Math.max(0, r.centroid as number)) } : {}) });
  }
  return { cue: { type: "speech", frames, ...(c.cut === true ? { cut: true as const } : {}) } };
}

const cleanNames = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw.slice(0, AVATAR_NAMES_MAX)) {
    const n = cleanAvatarName(v);
    if (n !== undefined && !out.includes(n)) out.push(n);
  }
  return out;
};

/** What a model has, as it may cross; undefined if it isn't that. */
export function cleanAvatarNames(raw: unknown): AvatarCatalogueNames | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const expressions = cleanNames(r.expressions);
  const motions = cleanNames(r.motions);
  if (expressions === undefined || motions === undefined || !Array.isArray(r.outfits)) return undefined;
  const outfits: { name: string; on: boolean }[] = [];
  for (const o of r.outfits.slice(0, AVATAR_NAMES_MAX)) {
    const name = cleanAvatarName((o as { name?: unknown } | null)?.name);
    if (name !== undefined && typeof (o as { on?: unknown }).on === "boolean" && !outfits.some((x) => x.name === name)) outfits.push({ name, on: (o as { on: boolean }).on });
  }
  return { expressions, motions, outfits };
}

const STAGE_MAX = 16_384;
const cleanPoint = (raw: unknown): AvatarPoint | undefined => {
  const p = raw as Record<string, unknown> | null | undefined;
  return p !== null && p !== undefined && typeof p === "object" && finite(p.x) && finite(p.y) && Math.abs(p.x) <= STAGE_MAX && Math.abs(p.y) <= STAGE_MAX ? { x: Math.round(p.x), y: Math.round(p.y) } : undefined;
};

/** A box as it may cross (whole pixels), or undefined. */
export function cleanAvatarBox(raw: unknown): AvatarBox | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const c = b.canvas as Record<string, unknown> | undefined;
  if (c === undefined || c === null || typeof c !== "object" || !finite(c.width) || !finite(c.height) || c.width <= 0 || c.height <= 0 || c.width > STAGE_MAX || c.height > STAGE_MAX) return undefined;
  const canvas = { width: Math.round(c.width), height: Math.round(c.height) };
  const f = b.figure as Record<string, unknown> | undefined;
  const figure = f !== undefined && f !== null && typeof f === "object" && finite(f.x) && finite(f.y) && finite(f.width) && finite(f.height) && f.width > 0 && f.height > 0 && Math.abs(f.x) <= STAGE_MAX && Math.abs(f.y) <= STAGE_MAX && f.width <= STAGE_MAX && f.height <= STAGE_MAX
    ? { x: Math.round(f.x), y: Math.round(f.y), width: Math.round(f.width), height: Math.round(f.height) }
    : undefined;
  const a = b.anchors as Record<string, unknown> | undefined;
  const anchors: Partial<Record<AvatarAnchorName, AvatarPoint>> = {};
  if (a !== undefined && a !== null && typeof a === "object") for (const k of AVATAR_ANCHORS) { const p = cleanPoint(a[k]); if (p !== undefined) anchors[k] = p; }
  return { canvas, ...(figure !== undefined ? { figure } : {}), ...(Object.keys(anchors).length > 0 ? { anchors } : {}), ...(b.estimated === true ? { estimated: true } : {}) };
}

/** The capabilities as a declaration or a report may list them: only the catalog's, each once. */
export function cleanAvatarCapabilities(raw: unknown): AvatarCapability[] {
  if (!Array.isArray(raw)) return [];
  return AVATAR_CAPABILITIES.filter((c) => raw.includes(c));
}

/** The stage's report as it may cross, or undefined (also for `null`: nothing drawn). */
export function cleanAvatarReport(raw: unknown): AvatarReport | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.format !== "string" || r.format === "" || r.format.length > 32 || typeof r.renderer !== "string" || r.renderer === "" || r.renderer.length > 128) return undefined;
  const names = r.names === undefined ? undefined : cleanAvatarNames(r.names);
  const box = r.box === undefined ? undefined : cleanAvatarBox(r.box);
  return { format: r.format, renderer: r.renderer, capabilities: cleanAvatarCapabilities(r.capabilities), ...(names !== undefined ? { names } : {}), ...(box !== undefined ? { box } : {}) };
}

/** The box when a renderer can't say where its figure is: the upper-centre of the stage, a head-and-shoulders figure. */
export function defaultAvatarBox(canvas: { width: number; height: number }): AvatarBox {
  const { width: w, height: h } = canvas;
  const at = (fx: number, fy: number): AvatarPoint => ({ x: Math.round(w * fx), y: Math.round(h * fy) });
  return {
    canvas: { width: Math.round(w), height: Math.round(h) },
    figure: { x: Math.round(w * 0.25), y: Math.round(h * 0.05), width: Math.round(w * 0.5), height: Math.round(h * 0.9) },
    anchors: { headTop: at(0.5, 0.08), face: at(0.5, 0.2), mouth: at(0.5, 0.27), chest: at(0.5, 0.45) },
    estimated: true,
  };
}

/** A box as `avatar.box()` answers it: the renderer's, with the default filled in where it said only the canvas. */
export function boxOrDefault(box: AvatarBox | undefined): AvatarBox | undefined {
  if (box === undefined) return undefined;
  return box.figure !== undefined ? box : { ...defaultAvatarBox(box.canvas), ...(box.anchors !== undefined ? { anchors: { ...defaultAvatarBox(box.canvas).anchors, ...box.anchors } } : {}) };
}

const LISTED = 12;
/** The plain answer to `cue` for a renderer that reported `report` (`undefined`: nothing draws the figure): undefined
 *  when the cue may go on to the renderer, else why it can't. A name the renderer's own catalogue lacks is refused here
 *  (when it published one), listing some it has. */
export function judgeCue(report: Pick<AvatarReport, "renderer" | "capabilities" | "names"> | undefined, cue: AvatarCue): AvatarCueResult | undefined {
  if (report === undefined) return { ok: false, reason: "no-renderer", message: "nothing is drawing this bot's figure right now" };
  const needs = CUE_CAPABILITY[cue.type];
  if (!report.capabilities.includes(needs)) return { ok: false, reason: "unsupported", message: `this renderer (${report.renderer}) doesn't do ${{ expressions: "expressions", motions: "motions", outfits: "outfits", pace: "pace", lookat: "looking at a point", lipsync: "lip-sync" }[needs]}` };
  const names = report.names;
  if (names === undefined) return undefined;
  const check = (kind: string, have: readonly string[], name: string): AvatarCueResult | undefined =>
    have.includes(name) ? undefined : { ok: false, reason: "unknown-name", message: `this model has no ${kind} "${name}"${have.length > 0 ? `; it has: ${have.slice(0, LISTED).join(", ")}${have.length > LISTED ? ", …" : ""}` : " (it has none)"}` };
  if (cue.type === "expression") return check("expression", names.expressions, cue.name);
  if (cue.type === "motion") return check("motion", names.motions, cue.name);
  if (cue.type === "outfit") return check("outfit part", names.outfits.map((o) => o.name), cue.part);
  return undefined;
}

/** The plain answer to a speech cue for a renderer that reported `report`: undefined when the levels may go on to the
 *  stage, else why they can't (nothing draws the figure, or its renderer declares no `lipsync`). */
export function judgeSpeech(report: Pick<AvatarReport, "renderer" | "capabilities"> | undefined): AvatarCueResult | undefined {
  if (report === undefined) return { ok: false, reason: "no-renderer", message: "nothing is drawing this bot's figure right now" };
  if (!report.capabilities.includes("lipsync")) return { ok: false, reason: "unsupported", message: `this renderer (${report.renderer}) doesn't do lip-sync` };
  return undefined;
}
