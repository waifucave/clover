// The figure's bridge to her stage: the avatar sits in the shell's document and her tab's parts are frames inside it, so
// they talk by `postMessage`. Each side checks who sent it: the avatar hears only a frame of its own bot's plugin (the
// frame's origin is the bot's id), and the part hears only the document around it. Out goes the catalogue (the plain names
// the loaded model answers to, never its files); in comes each new expression, motion or outfit her stage settled on.
import { catalogOf, switchNamed, switchesOf, SwitchDriver, type Switch } from "../cues";

export interface CueMessage {
  type: "clover.avatar.cue";
  nonce?: number;
  expression?: string;
  motion?: string;
  outfit?: Record<string, boolean>;
  celebrate?: boolean;
  /** A turn is running: she looks at the conversation. */
  working?: boolean;
}

/** What the figure can be asked to do, as Mochi2D offers it. */
export interface CueModel {
  setParameter(id: string, value: number): boolean;
  setExpression?(name: string, fades?: { fadeIn?: number }): unknown;
  clearExpression?(fades?: { fadeOut?: number }): unknown;
  startMotion?(group: string, index?: number): unknown;
}

const LAYER = "clover-plugin";

export class StageBridge {
  readonly #botId: string;
  readonly #win: Window;
  readonly #switches: Switch[];
  readonly #driver: SwitchDriver;
  readonly #model: CueModel;
  #lastNonce = -1;
  /** A turn is running (the last cue said so). */
  working = false;
  #stop = () => {};

  constructor(o: { botId: string; win: Window; switches: Switch[]; model: CueModel }) {
    this.#botId = o.botId;
    this.#win = o.win;
    this.#switches = o.switches;
    this.#model = o.model;
    this.#driver = new SwitchDriver((id, v) => o.model.setParameter(id, v));
  }

  get driver(): SwitchDriver { return this.#driver; }
  get switches(): readonly Switch[] { return this.#switches; }

  /** A frame of this bot's own plugin sent it. */
  #fromMyFrame(e: MessageEvent): boolean {
    return typeof e.origin === "string" && e.origin === `${LAYER}://${this.#botId}`;
  }

  #sendCatalog(to: { postMessage(m: unknown, target: string): void }, origin: string): void {
    to.postMessage({ type: "clover.avatar.catalog", ...catalogOf(this.#switches) }, origin);
  }

  start(): void {
    const publish = () => {
      for (const f of Array.from(this.#win.document.querySelectorAll("iframe"))) {
        try { this.#sendCatalog(f.contentWindow!, `${LAYER}://${this.#botId}`); } catch { /* a frame that is going */ }
      }
    };
    const on = (e: MessageEvent) => {
      if (!this.#fromMyFrame(e)) return;
      const d = e.data as { type?: unknown } | null;
      if (d?.type === "clover.avatar.hello") this.#sendCatalog(e.source as Window, e.origin);
      else if (d?.type === "clover.avatar.cue") this.cue(d as CueMessage);
    };
    this.#win.addEventListener("message", on);
    publish();
    const again = setInterval(publish, 4000);
    setTimeout(() => clearInterval(again), 20000);
    this.#stop = () => { this.#win.removeEventListener("message", on); clearInterval(again); };
  }

  stop(): void { this.#stop(); }

  cue(m: CueMessage): void {
    if (typeof m.working === "boolean") this.working = m.working;
    const fresh = m.nonce === undefined || m.nonce !== this.#lastNonce;
    if (m.nonce !== undefined) this.#lastNonce = m.nonce;
    const exprs = this.#switches.filter((s) => s.kind === "expression" && s.how.type === "param");
    const ids = exprs.map((s) => (s.how as { id: string }).id);
    if (m.expression !== undefined && fresh) this.#express(m.expression, ids);
    if (m.motion !== undefined && fresh) {
      const s = switchNamed(this.#switches, "motion", m.motion);
      if (s?.how.type === "param") this.#driver.turn(s.how.id, true, 4.5);
      else if (s?.how.type === "motion") void this.#model.startMotion?.(s.how.group);
    }
    for (const [name, on] of Object.entries(m.outfit ?? {})) {
      const s = switchNamed(this.#switches, "outfit", name);
      if (s?.how.type === "param") this.#driver.turn(s.how.id, on === true);
    }
    if (m.celebrate === true && fresh) {
      const joy = switchNamed(this.#switches, "expression", "love") ?? switchNamed(this.#switches, "expression", "smile") ?? switchNamed(this.#switches, "expression", "happy");
      if (joy?.how.type === "param") { this.#driver.only(ids, joy.how.id); this.#driver.turn(joy.how.id, true, 4.5); }
    }
  }

  #express(name: string, ids: readonly string[]): void {
    const s = switchNamed(this.#switches, "expression", name);
    if (!s) return;
    if (s.how.type === "param") {
      this.#driver.only(ids, s.how.id);
      // A look held for a while, then back to her own face, so one reaction never sticks for the rest of the day.
      this.#driver.turn(s.how.id, true, 12);
    } else if (s.how.type === "expression") void this.#model.setExpression?.(s.how.name, { fadeIn: 0.25 });
  }
}

export function startBridge(o: { botId: string; win: Window; model: CueModel; facts: Parameters<typeof switchesOf>[0]; table?: Parameters<typeof switchesOf>[1] }): StageBridge {
  const b = new StageBridge({ botId: o.botId, win: o.win, model: o.model, switches: switchesOf(o.facts, o.table) });
  b.start();
  return b;
}
