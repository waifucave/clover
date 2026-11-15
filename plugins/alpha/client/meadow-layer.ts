// The meadow in her backdrop's document (meadow-art.ts draws it): the still layer, painted once per size and scheme, and
// the sprites over it, which each frame of her backdrop's loop only moves (a transform and an opacity on each), so the
// still layer is never repainted. No React here.
import { backdropSvg, spriteFrame, spritesHtml, spritesOf, type Sprite } from "./meadow-art";

export class MeadowLayer {
  readonly #host: HTMLElement;
  #sprites: Sprite[] = [];
  #nodes: HTMLElement[] = [];
  /** What each sprite was last given. */
  #last: ({ transform: string; opacity: string } | undefined)[] = [];
  #key = "";
  #w = 0;
  #h = 0;

  constructor(host: HTMLElement) {
    this.#host = host;
  }

  /** Draws the meadow for a `w` by `h` backdrop in the scheme; nothing when it is drawn so already. */
  draw(w: number, h: number, dark: boolean): void {
    const key = `${w}x${h}|${dark ? "dark" : "light"}`;
    if (key === this.#key || w <= 0 || h <= 0) return;
    this.#key = key;
    this.#w = w;
    this.#h = h;
    this.#sprites = spritesOf(w, h, dark);
    this.#host.innerHTML = backdropSvg(w, h, dark) + spritesHtml(this.#sprites);
    this.#nodes = [...this.#host.querySelectorAll<HTMLElement>("[data-sprite]")];
    this.#last = [];
  }

  /** The sprites at time `t` of the scene's own clock. `calm` (no one about): only the petals drift; the lights hold. A
   *  value that didn't change isn't written. */
  move(t: number, calm = false): void {
    for (let i = 0; i < this.#nodes.length; i++) {
      const s = this.#sprites[i];
      const node = this.#nodes[i];
      if (s === undefined || node === undefined || (calm && s.kind !== "petal")) continue;
      const fr = spriteFrame(s, t, this.#w, this.#h);
      const was = this.#last[i];
      if (was?.transform !== fr.transform) node.style.transform = fr.transform;
      if (was?.opacity !== fr.opacity) node.style.opacity = fr.opacity;
      this.#last[i] = fr;
    }
  }

  /** Takes the meadow down (another scene shows). */
  clear(): void {
    if (this.#key === "") return;
    this.#host.innerHTML = "";
    this.#nodes = [];
    this.#last = [];
    this.#sprites = [];
    this.#key = "";
  }
}
