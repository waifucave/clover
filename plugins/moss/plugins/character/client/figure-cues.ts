// What a plugin may ask the figure to do, and what a renderer tells back: the avatar plugin's own contract, carried on its
// own points as point messages (spec revision 19, G7: the platform has no avatar). Plain data only.
//
// * A controller (a plugin with an entry in `moss.character.figure`, named on its OK card) sends a cue with
//   `points.send("moss.character.figure", cue)`; the avatar plugin judges it here against what the drawing renderer
//   declared it does (`moss.character.formats`' `capabilities`) and the names its model answers to, and answers the sender
//   plainly (`{ result }`); one it can play goes on to the renderer.
// * A renderer (an entry in the UI spot `moss.character.renderer`, named on its OK card) is sent `{ mount, cue }` and
//   sends back `{ mount, names?, box? }`: what its model has and where the figure stands.
// * Everything that crosses is read through the `clean*` functions here: a value that isn't one of these shapes is
//   dropped, never passed on, and every list and string is capped.

/** A name a model answers to (an expression, a motion, an outfit part), at most this long. */
export const FIGURE_NAME_MAX = 64;
/** Names per list a renderer may publish. */
export const FIGURE_NAMES_MAX = 200;
/** What a renderer can do beyond drawing (its `moss.character.formats` entry's `capabilities`). */
export const FIGURE_CAPABILITIES = ["lipsync", "expressions", "motions", "outfits", "lookat", "pace"] as const;
export type FigureCapability = (typeof FIGURE_CAPABILITIES)[number];

/** One thing the figure is asked to do. `x` and `y` of `lookAt` are in the figure's own square, -1 to 1 from its centre
 *  (x to the right, y down), and `null` is back to looking at nothing in particular. */
export type FigureCue =
  | { readonly type: "expression"; readonly name: string }
  | { readonly type: "motion"; readonly name: string }
  | { readonly type: "outfit"; readonly part: string; readonly on: boolean }
  | { readonly type: "pace"; readonly calm: boolean }
  | { readonly type: "lookAt"; readonly point: { readonly x: number; readonly y: number } | null };

/** The plain answer to a cue. One that wasn't played says why: `no-renderer` (nothing draws the figure now),
 *  `unsupported` (the renderer doesn't do that kind of cue), `unknown-name` (the loaded model has no such expression,
 *  motion or part: the answer lists some it has), `invalid`. */
export type FigureCueResult = { readonly ok: true } | { readonly ok: false; readonly reason: "no-renderer" | "unsupported" | "unknown-name" | "invalid"; readonly message: string };

/** What the loaded model has, by the renderer's own names. */
export interface FigureNames {
  readonly expressions: readonly string[];
  readonly motions: readonly string[];
  /** Outfit parts that switch on and off, with where each stands now. */
  readonly outfits: readonly { readonly name: string; readonly on: boolean }[];
}

/** The figure as a controller reads it: the format and the renderer's plugin id, what the renderer does, the names. */
export interface FigureCatalogue extends FigureNames {
  readonly format: string;
  readonly renderer: string;
  readonly capabilities: readonly FigureCapability[];
}

export interface FigurePoint { readonly x: number; readonly y: number }
export const FIGURE_ANCHORS = ["headTop", "face", "mouth", "chest"] as const;
export type FigureAnchorName = (typeof FIGURE_ANCHORS)[number];

/** Where the figure is in its box, in the box's own pixels (top left origin): the box's size, the figure's bounding box
 *  and some named anchors. A renderer that can't know says only the canvas (`defaultFigureBox` fills the rest). */
export interface FigureBox {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly figure?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly anchors?: Readonly<Partial<Record<FigureAnchorName, FigurePoint>>>;
  /** True when the figure and anchors are made up (the renderer reported only the canvas). */
  readonly estimated?: boolean;
}

/** What the drawing renderer said: its declaration and what it reported. */
export interface FigureReport {
  readonly format: string;
  readonly renderer: string;
  readonly capabilities: readonly FigureCapability[];
  readonly names?: FigureNames;
  readonly box?: FigureBox;
}

/** The kind of capability a cue needs of the renderer. */
export const CUE_CAPABILITY: Readonly<Record<FigureCue["type"], FigureCapability>> = {
  expression: "expressions", motion: "motions", outfit: "outfits", pace: "pace", lookAt: "lookat",
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
/** A name as it may cross: a non-empty string, no control characters, at most FIGURE_NAME_MAX characters. */
export const cleanFigureName = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= FIGURE_NAME_MAX && !CONTROL.test(v) ? v : undefined);

/** A cue as it may cross, or undefined. */
export function cleanFigureCue(raw: unknown): FigureCue | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case "expression": case "motion": {
      const name = cleanFigureName(c.name);
      return name === undefined ? undefined : { type: c.type, name };
    }
    case "outfit": {
      const part = cleanFigureName(c.part);
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

const cleanNames = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw.slice(0, FIGURE_NAMES_MAX)) {
    const n = cleanFigureName(v);
    if (n !== undefined && !out.includes(n)) out.push(n);
  }
  return out;
};

/** What a model has, as it may cross; undefined if it isn't that. */
export function cleanFigureNames(raw: unknown): FigureNames | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const expressions = cleanNames(r.expressions);
  const motions = cleanNames(r.motions);
  if (expressions === undefined || motions === undefined || !Array.isArray(r.outfits)) return undefined;
  const outfits: { name: string; on: boolean }[] = [];
  for (const o of r.outfits.slice(0, FIGURE_NAMES_MAX)) {
    const name = cleanFigureName((o as { name?: unknown } | null)?.name);
    if (name !== undefined && typeof (o as { on?: unknown }).on === "boolean" && !outfits.some((x) => x.name === name)) outfits.push({ name, on: (o as { on: boolean }).on });
  }
  return { expressions, motions, outfits };
}

const BOX_MAX = 16_384;
const cleanPoint = (raw: unknown): FigurePoint | undefined => {
  const p = raw as Record<string, unknown> | null | undefined;
  return p !== null && p !== undefined && typeof p === "object" && finite(p.x) && finite(p.y) && Math.abs(p.x) <= BOX_MAX && Math.abs(p.y) <= BOX_MAX ? { x: Math.round(p.x), y: Math.round(p.y) } : undefined;
};

/** A box as it may cross (whole pixels), or undefined. */
export function cleanFigureBox(raw: unknown): FigureBox | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const c = b.canvas as Record<string, unknown> | undefined;
  if (c === undefined || c === null || typeof c !== "object" || !finite(c.width) || !finite(c.height) || c.width <= 0 || c.height <= 0 || c.width > BOX_MAX || c.height > BOX_MAX) return undefined;
  const canvas = { width: Math.round(c.width), height: Math.round(c.height) };
  const f = b.figure as Record<string, unknown> | undefined;
  const figure = f !== undefined && f !== null && typeof f === "object" && finite(f.x) && finite(f.y) && finite(f.width) && finite(f.height) && f.width > 0 && f.height > 0 && Math.abs(f.x) <= BOX_MAX && Math.abs(f.y) <= BOX_MAX && f.width <= BOX_MAX && f.height <= BOX_MAX
    ? { x: Math.round(f.x), y: Math.round(f.y), width: Math.round(f.width), height: Math.round(f.height) }
    : undefined;
  const a = b.anchors as Record<string, unknown> | undefined;
  const anchors: Partial<Record<FigureAnchorName, FigurePoint>> = {};
  if (a !== undefined && a !== null && typeof a === "object") for (const k of FIGURE_ANCHORS) { const p = cleanPoint(a[k]); if (p !== undefined) anchors[k] = p; }
  return { canvas, ...(figure !== undefined ? { figure } : {}), ...(Object.keys(anchors).length > 0 ? { anchors } : {}), ...(b.estimated === true ? { estimated: true } : {}) };
}

/** The capabilities as a declaration lists them: only the known ones, each once. */
export function cleanFigureCapabilities(raw: unknown): FigureCapability[] {
  if (!Array.isArray(raw)) return [];
  return FIGURE_CAPABILITIES.filter((c) => raw.includes(c));
}

/** The box when a renderer can't say where its figure is: the upper-centre, a head-and-shoulders figure. */
export function defaultFigureBox(canvas: { width: number; height: number }): FigureBox {
  const { width: w, height: h } = canvas;
  const at = (fx: number, fy: number): FigurePoint => ({ x: Math.round(w * fx), y: Math.round(h * fy) });
  return {
    canvas: { width: Math.round(w), height: Math.round(h) },
    figure: { x: Math.round(w * 0.25), y: Math.round(h * 0.05), width: Math.round(w * 0.5), height: Math.round(h * 0.9) },
    anchors: { headTop: at(0.5, 0.08), face: at(0.5, 0.2), mouth: at(0.5, 0.27), chest: at(0.5, 0.45) },
    estimated: true,
  };
}

/** A box as a controller reads it: the renderer's, with the default filled in where it said only the canvas. */
export function boxOrDefault(box: FigureBox | undefined): FigureBox | undefined {
  if (box === undefined) return undefined;
  return box.figure !== undefined ? box : { ...defaultFigureBox(box.canvas), ...(box.anchors !== undefined ? { anchors: { ...defaultFigureBox(box.canvas).anchors, ...box.anchors } } : {}) };
}

const LISTED = 12;
/** The plain answer to `cue` for the renderer that reported `report` (`undefined`: nothing draws the figure): undefined
 *  when the cue may go on to the renderer, else why it can't. A name the renderer's own names lack is refused here
 *  (when it published them), listing some it has. */
export function judgeCue(report: Pick<FigureReport, "renderer" | "capabilities" | "names"> | undefined, cue: FigureCue): FigureCueResult | undefined {
  if (report === undefined) return { ok: false, reason: "no-renderer", message: "nothing is drawing the figure right now" };
  const needs = CUE_CAPABILITY[cue.type];
  if (!report.capabilities.includes(needs)) return { ok: false, reason: "unsupported", message: `this renderer (${report.renderer}) doesn't do ${{ expressions: "expressions", motions: "motions", outfits: "outfits", pace: "pace", lookat: "looking at a point", lipsync: "lip-sync" }[needs]}` };
  const names = report.names;
  if (names === undefined) return undefined;
  const check = (kind: string, have: readonly string[], name: string): FigureCueResult | undefined =>
    have.includes(name) ? undefined : { ok: false, reason: "unknown-name", message: `this model has no ${kind} "${name}"${have.length > 0 ? `; it has: ${have.slice(0, LISTED).join(", ")}${have.length > LISTED ? ", …" : ""}` : " (it has none)"}` };
  if (cue.type === "expression") return check("expression", names.expressions, cue.name);
  if (cue.type === "motion") return check("motion", names.motions, cue.name);
  if (cue.type === "outfit") return check("outfit part", names.outfits.map((o) => o.name), cue.part);
  return undefined;
}

/** The catalogue a controller reads, from what the renderer said. */
export function catalogueOf(report: FigureReport | undefined): FigureCatalogue | undefined {
  if (report === undefined) return undefined;
  return { format: report.format, renderer: report.renderer, capabilities: report.capabilities, expressions: report.names?.expressions ?? [], motions: report.names?.motions ?? [], outfits: report.names?.outfits ?? [] };
}
