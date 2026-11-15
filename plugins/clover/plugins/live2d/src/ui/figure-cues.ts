// The figure's side of the avatar contract: the app's cues (`useAvatarControl`, handed in as `control`) become
// expressions, motions and outfit changes on the loaded model, and the names the model answers to go back out, plain
// names only, never its files. Nothing here talks to a frame or a window: the app carries the cues, from the bot
// plugin's own calls, to this one hook.
import type { FigureControl, FigureCue, FigureNames } from "@waifucave/clover-plugin-vrm/control";
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
