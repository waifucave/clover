// The figure's side of the avatar plugin's contract: its cues (`client/figure-link.ts`, handed in as `control`) become
// expressions, motions and outfit changes on the loaded model, and the names the model answers to go back out, plain
// names only, never its files. Nothing here talks to a frame or a window.

/** One thing the figure is asked to do (the avatar plugin's `FigureCue`, spelt out here: a plugin imports no other's). */
export type FigureCue =
  | { readonly type: "expression"; readonly name: string }
  | { readonly type: "motion"; readonly name: string }
  | { readonly type: "outfit"; readonly part: string; readonly on: boolean }
  | { readonly type: "pace"; readonly calm: boolean }
  | { readonly type: "lookAt"; readonly point: { readonly x: number; readonly y: number } | null };
/** What the loaded model has, by its own names. */
export interface FigureNames {
  readonly expressions: readonly string[];
  readonly motions: readonly string[];
  readonly outfits: readonly { readonly name: string; readonly on: boolean }[];
}
export interface FigurePoint { readonly x: number; readonly y: number }
/** Where the figure stands in its element, in its own pixels from the top left. */
export interface FigureBox {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly figure?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly anchors?: Readonly<Partial<Record<"headTop" | "face" | "mouth" | "chest", FigurePoint>>>;
}
/** The cues in, the names and the box out. */
export interface FigureControl {
  onCue(listener: (cue: FigureCue) => void): () => void;
  setCatalogue(names: FigureNames | undefined): void;
  setBox(box: FigureBox | undefined): void;
}

/** A figure's box from its bounding rectangle: the anchors at a portrait's proportions, an estimate of where the face is. */
export function boxFromRect(canvas: { width: number; height: number }, r: { x: number; y: number; width: number; height: number }): FigureBox {
  const cx = r.x + r.width / 2;
  const at = (f: number): FigurePoint => ({ x: Math.round(cx), y: Math.round(r.y + r.height * f) });
  return {
    canvas: { width: Math.round(canvas.width), height: Math.round(canvas.height) },
    figure: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    anchors: { headTop: at(0), face: at(0.2), mouth: at(0.26), chest: at(0.42) },
  };
}
import { catalogOf, switchNamed, switchesOf, SwitchDriver, type Switch } from "../cues";

/** What the figure can be asked to do, as Mochi2D offers it. */
export interface CueModel {
  setParameter(id: string, value: number): boolean;
  setExpression?(name: string, fades?: { fadeIn?: number }): unknown;
  clearExpression?(fades?: { fadeOut?: number }): unknown;
  startMotion?(group: string, index?: number): unknown;
}

export class FigureCues {
  readonly #control: FigureControl;
  readonly #switches: Switch[];
  readonly #driver: SwitchDriver;
  readonly #model: CueModel;
  #off = () => {};
  /** Where the bot looks (a point of the stage in its own square, -1 to 1 from the centre), or null for nowhere in particular. */
  lookAt: { x: number; y: number } | null = null;
  /** The pace the bot asked for (calm or lively); undefined: the figure's own. */
  pace: boolean | undefined;

  constructor(o: { control: FigureControl; model: CueModel; switches: Switch[] }) {
    this.#control = o.control;
    this.#switches = o.switches;
    this.#model = o.model;
    this.#driver = new SwitchDriver((id, v) => o.model.setParameter(id, v));
  }

  get driver(): SwitchDriver { return this.#driver; }
  get switches(): readonly Switch[] { return this.#switches; }

  /** The names this model has, and where each outfit part stands now. */
  names(): FigureNames {
    const c = catalogOf(this.#switches);
    const on = (name: string) => { const s = switchNamed(this.#switches, "outfit", name); return s?.how.type === "param" && this.#driver.goal(s.how.id) === 1; };
    return { expressions: c.expressions, motions: c.motions, outfits: c.outfit.map((name) => ({ name, on: on(name) })) };
  }

  start(): void {
    this.#off = this.#control.onCue((cue) => this.cue(cue));
    this.#control.setCatalogue(this.names());
  }

  stop(): void {
    this.#off();
    this.#off = () => {};
    this.#control.setCatalogue(undefined);
  }

  cue(c: FigureCue): void {
    const ids = this.#switches.filter((s) => s.kind === "expression" && s.how.type === "param").map((s) => (s.how as { id: string }).id);
    switch (c.type) {
      case "expression": {
        const s = switchNamed(this.#switches, "expression", c.name);
        if (!s) return;
        if (s.how.type === "param") {
          this.#driver.only(ids, s.how.id);
          // A look held for a while, then back to her own face, so one reaction never sticks for the rest of the day.
          this.#driver.turn(s.how.id, true, 12);
        } else if (s.how.type === "expression") void this.#model.setExpression?.(s.how.name, { fadeIn: 0.25 });
        return;
      }
      case "motion": {
        const s = switchNamed(this.#switches, "motion", c.name);
        if (s?.how.type === "param") this.#driver.turn(s.how.id, true, 4.5);
        else if (s?.how.type === "motion") void this.#model.startMotion?.(s.how.group);
        return;
      }
      case "outfit": {
        const s = switchNamed(this.#switches, "outfit", c.part);
        if (s?.how.type === "param") { this.#driver.turn(s.how.id, c.on); this.#control.setCatalogue(this.names()); }
        return;
      }
      case "pace": this.pace = c.calm; return;
      case "lookAt": this.lookAt = c.point === null ? null : { x: c.point.x, y: c.point.y }; return;
    }
  }
}

export function startFigureCues(o: { control: FigureControl; model: CueModel; facts: Parameters<typeof switchesOf>[0]; table?: Parameters<typeof switchesOf>[1] }): FigureCues {
  const f = new FigureCues({ control: o.control, model: o.model, switches: switchesOf(o.facts, o.table) });
  f.start();
  return f;
}
