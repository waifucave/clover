// What her stage can ask of a Live2D figure, and how the figure answers. A model offers expressions in two ways: the ones its
// settings list (`.exp3.json` files, set by name), and, for a model made for a VTuber app, parameters the maker meant as
// switches (a `key7` that shows a blush, a `Clothes3` that changes the top) named in the model's display info, in the
// maker's own language. This file turns both into plain names a model can use (`blush`, `cry`, `love`, `skirt`) without
// hand-editing: by what each switch is called (a small word list in Chinese, Japanese and English) and what it is for,
// unless the avatar's folder carries a table of its own (`stage-map.json`), which wins for the names it lists. Names only
// leave this file, never the model's files.

export type CueKind = "expression" | "motion" | "outfit";

/** One thing the figure can do, by the plain names it answers to. */
export interface Switch {
  kind: CueKind;
  /** How the figure does it: a settings expression, a settings motion group, or a parameter driven to 1. */
  how: { type: "expression"; name: string } | { type: "motion"; group: string } | { type: "param"; id: string };
  /** The names a model may use for it: its own (when it is a plain name) and the aliases, first the best. */
  names: string[];
}

/** The avatar folder's own table: plain name to what it does. A string is a parameter id (or a settings expression or
 *  motion group, as the section says); never a path. */
export interface StageTable {
  expressions?: Record<string, string>;
  motions?: Record<string, string>;
  outfit?: Record<string, string>;
}

export interface ModelFacts {
  expressions: readonly string[];
  motionGroups: readonly string[];
  /** Parameter id to the display name the model's display info gives it. */
  params: ReadonlyMap<string, string>;
}

const NAME_OK = /^[\p{L}\p{N}_.-]{1,32}$/u;
const plain = (s: string) => s.normalize("NFC");

/** A switch's display name without its list number and spacing: "7. 脸红" is 脸红. */
export function cleanName(display: string): string {
  return plain(display).replace(/^\s*\d+\s*[.、．)]\s*/, "").replace(/[\s　]+/g, "").trim();
}

/** What a display name or id means, by word: the aliases first-best first. */
const WORDS: { re: RegExp; kind: CueKind; names: string[] }[] = [
  { re: /脸红|赤面|照れ|blush|cheek(?!.*puff)/i, kind: "expression", names: ["blush"] },
  { re: /落泪|流泪|泪|哭|涙|cry|tear/i, kind: "expression", names: ["cry", "sad", "tears"] },
  { re: /爱心|愛心|ハート|heart|love/i, kind: "expression", names: ["love", "heart"] },
  { re: /圈圈|蚊香|目が回|dizzy|spiral/i, kind: "expression", names: ["dizzy"] },
  { re: /生气|生氣|怒|angry|mad/i, kind: "expression", names: ["angry"] },
  { re: /微笑|笑|にこ|smile|happy/i, kind: "expression", names: ["smile", "happy"] },
  { re: /冷汗|汗|sweat|nervous/i, kind: "expression", names: ["sweat", "nervous"] },
  { re: /黑脸|黒|gloom/i, kind: "expression", names: ["gloomy"] },
  { re: /屑屑|smug|屑/i, kind: "expression", names: ["smug"] },
  { re: /> ?<|>_<|xd|squint/i, kind: "expression", names: ["squint"] },
  { re: /shock|惊|驚|surpris/i, kind: "expression", names: ["surprised", "shock"] },
  { re: /眼镜|眼鏡|glasses|monocle/i, kind: "outfit", names: ["glasses"] },
  { re: /裙|skirt/i, kind: "outfit", names: ["skirt"] },
  { re: /鞋|shoe/i, kind: "outfit", names: ["shoes"] },
  { re: /尾巴|tail/i, kind: "outfit", names: ["tail"] },
  { re: /衣服|上衣|top|shirt/i, kind: "outfit", names: ["top"] },
  { re: /帽|hat/i, kind: "outfit", names: ["hat"] },
  { re: /抚胸|撫胸|hand.?on.?chest/i, kind: "motion", names: ["hand-on-chest"] },
  { re: /竖食指|指|point/i, kind: "motion", names: ["point"] },
  { re: /狗尾草|grass/i, kind: "motion", names: ["grass"] },
  { re: /挥手|揮手|wave/i, kind: "motion", names: ["wave"] },
];

/** The parameters a maker made as switches: a numbered key, a movement, a clothes toggle (by id), when the display name says
 *  what it is. */
const SWITCH_ID = /^((key|hotkey|exp|expression|movement|motion|clothes|outfit)[_-]?\d+|eyesmile|angry\d?|shockeye)$/i;

function kindOfId(id: string): CueKind | undefined {
  if (/^(movement|motion)/i.test(id)) return "motion";
  if (/^(clothes|outfit)/i.test(id)) return "outfit";
  if (SWITCH_ID.test(id)) return "expression";
  return undefined;
}

function uniq(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => NAME_OK.test(n) && !seen.has(n) && (seen.add(n), true));
}

/** The switches a model offers, in the order a model should try them. */
export function switchesOf(facts: ModelFacts, table: StageTable = {}): Switch[] {
  const out: Switch[] = [];
  const named = (own: string, kind: CueKind) => {
    const aliases = WORDS.filter((w) => w.kind === kind && w.re.test(own)).flatMap((w) => w.names);
    return uniq([...aliases, plain(own)]);
  };
  for (const e of facts.expressions) out.push({ kind: "expression", how: { type: "expression", name: e }, names: named(e, "expression") });
  for (const g of facts.motionGroups) if (g.toLowerCase() !== "idle") out.push({ kind: "motion", how: { type: "motion", group: g }, names: named(g, "motion") });
  for (const [id, display] of facts.params) {
    const kind = kindOfId(id);
    if (kind === undefined) continue;
    const own = cleanName(display);
    const words = WORDS.filter((w) => w.re.test(own) || w.re.test(id));
    const matched = words.filter((w) => w.kind === kind).flatMap((w) => w.names);
    // A switch the word list cannot place keeps its own name, which the model can still use.
    out.push({ kind, how: { type: "param", id }, names: uniq([...matched, own]) });
  }
  // Two parameters that mean the same word keep the first the plain way and the rest under their own names.
  const used = new Set<string>();
  for (const s of out) s.names = s.names.filter((n) => (used.has(`${s.kind}:${n}`) ? false : (used.add(`${s.kind}:${n}`), true)));
  const sections: [CueKind, Record<string, string> | undefined][] = [["expression", table.expressions], ["motion", table.motions], ["outfit", table.outfit]];
  for (const [kind, map] of sections) {
    for (const [name, target] of Object.entries(map ?? {})) {
      if (!NAME_OK.test(name) || typeof target !== "string") continue;
      const hit = out.find((s) => s.kind === kind && (s.how.type === "param" ? s.how.id === target : s.how.type === "expression" ? s.how.name === target : s.how.group === target));
      if (!hit) continue;
      for (const s of out) if (s.kind === kind) s.names = s.names.filter((n) => n !== name);
      hit.names = uniq([name, ...hit.names]);
    }
  }
  return out.filter((s) => s.names.length > 0);
}

/** The catalogue her server asks for: every name, by kind. */
export function catalogOf(switches: readonly Switch[]): { v: 1; expressions: string[]; motions: string[]; outfit: string[] } {
  const by = (k: CueKind) => switches.filter((s) => s.kind === k).flatMap((s) => s.names).slice(0, 120);
  return { v: 1, expressions: by("expression"), motions: by("motion"), outfit: by("outfit") };
}

export function switchNamed(switches: readonly Switch[], kind: CueKind, name: string): Switch | undefined {
  const n = plain(name);
  return switches.find((s) => s.kind === kind && s.names.includes(n));
}

/** Drives parameters toward 0 or 1 smoothly, with a hold for the ones that are gestures. `set` writes a parameter. */
export class SwitchDriver {
  readonly #cur = new Map<string, number>();
  readonly #goal = new Map<string, { to: number; holdLeft: number }>();
  readonly #set: (id: string, value: number) => void;
  /** Seconds to go from 0 to 1. */
  readonly fade: number;
  constructor(set: (id: string, value: number) => void, fade = 0.3) {
    this.#set = set;
    this.fade = fade;
  }
  /** Turns a parameter on (1) or off (0); `holdSeconds` turns it off again by itself after that long. */
  turn(id: string, on: boolean, holdSeconds?: number): void {
    this.#goal.set(id, { to: on ? 1 : 0, holdLeft: on && holdSeconds !== undefined ? holdSeconds : Number.POSITIVE_INFINITY });
  }
  /** Turns every parameter of the listed ones off but `except`. */
  only(ids: readonly string[], except: string | undefined): void {
    for (const id of ids) if (id !== except) this.turn(id, false);
  }
  update(dt: number): void {
    for (const [id, g] of this.#goal) {
      if (g.to === 1 && Number.isFinite(g.holdLeft)) {
        g.holdLeft -= dt;
        if (g.holdLeft <= 0) { g.to = 0; g.holdLeft = Number.POSITIVE_INFINITY; }
      }
      const cur = this.#cur.get(id) ?? 0;
      const step = dt / this.fade;
      const next = g.to > cur ? Math.min(g.to, cur + step) : Math.max(g.to, cur - step);
      if (next !== cur) { this.#cur.set(id, next); this.#set(id, next); }
      else if (g.to === 0 && cur === 0) this.#goal.delete(id);
    }
  }
  get busy(): boolean { return this.#goal.size > 0; }
  level(id: string): number { return this.#cur.get(id) ?? 0; }
}

/** Reads the display info (`.cdi3.json`) of a model: parameter id to its name. */
export function paramNames(cdi: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = (cdi as { Parameters?: unknown } | null)?.Parameters;
  if (!Array.isArray(list)) return out;
  for (const p of list) {
    const r = p as { Id?: unknown; Name?: unknown };
    if (typeof r.Id === "string" && typeof r.Name === "string") out.set(r.Id, r.Name);
  }
  return out;
}

/** The avatar folder's table, checked: plain names to ids, nothing else. */
export function readTable(raw: unknown): StageTable {
  const out: StageTable = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const k of ["expressions", "motions", "outfit"] as const) {
    const sec = (raw as Record<string, unknown>)[k];
    if (sec === null || typeof sec !== "object") continue;
    const clean: Record<string, string> = {};
    for (const [name, target] of Object.entries(sec as Record<string, unknown>).slice(0, 128)) if (NAME_OK.test(name) && typeof target === "string" && target.length <= 80) clean[name] = target;
    out[k] = clean;
  }
  return out;
}

/** Where she looks. While the user types she glances at the composer (for a moment after the last key), while a turn
 *  runs she looks at the conversation, otherwise straight ahead. Pure: the avatar maps the answer to a point. */
export type Aim = "composer" | "sheet" | "ahead";
export const GLANCE_SECONDS = 1.8;
export class Gaze {
  #until = Number.NEGATIVE_INFINITY;
  working = false;
  /** The user typed in an input at `now` (seconds). */
  typed(now: number): void { this.#until = now + GLANCE_SECONDS; }
  aim(now: number): Aim {
    if (now < this.#until) return "composer";
    return this.working ? "sheet" : "ahead";
  }
}
