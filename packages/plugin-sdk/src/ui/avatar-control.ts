// How a renderer receives cues and publishes what its model has and where the figure stands (`useAvatarControl`), the
// same in the stage's own document (a bundled renderer) and in a third-party renderer's frame (what crosses goes
// through main, from and to the parent document only, as plain data that is read again on each side).
//
// * `AvatarControlHub` is the one piece of logic: cues go to the renderer's listeners; the model's names and the
//   figure's box come the other way. The box is throttled (at most one change in BOX_MIN_MS, and only a change of more
//   than BOX_MIN_DELTA pixels, never while the document is hidden), the names are sent as they change.
// * In the stage's document the hub is the stage's own: its `publish` is the stage's `avatar.report` and a cue the core
//   sends reaches `hub.cue`. For a framed renderer the stage's `LayerFrame` forwards each cue to the frame as
//   `{ kind: "cue" }` and the frame's own hub sends its state up as `{ kind: "state" }`, which the parent's hub takes.
import type { Unsubscribe } from "../api/plugin-api";
import { cleanAvatarBox, cleanAvatarCue, cleanAvatarNames, type AvatarBox, type AvatarCatalogueNames, type AvatarCue } from "../catalogs/avatar-cues";

export const BOX_MIN_MS = 250;
export const BOX_MIN_DELTA = 3;

/** Parent to frame. */
export type AvatarDown = { readonly kind: "cue"; readonly cue: AvatarCue };
/** Frame to parent: what the model has (`null`: nothing loaded) and where the figure stands (`null`: unknown). */
export type AvatarUp = { readonly kind: "state"; readonly names?: AvatarCatalogueNames | null; readonly box?: AvatarBox | null };

export function cleanAvatarDown(raw: unknown): AvatarDown | undefined {
  if (raw === null || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== "cue") return undefined;
  const cue = cleanAvatarCue((raw as { cue?: unknown }).cue);
  return cue === undefined ? undefined : { kind: "cue", cue };
}

export function cleanAvatarUp(raw: unknown): AvatarUp | undefined {
  if (raw === null || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== "state") return undefined;
  const r = raw as { names?: unknown; box?: unknown };
  const out: { kind: "state"; names?: AvatarCatalogueNames | null; box?: AvatarBox | null } = { kind: "state" };
  if (r.names === null) out.names = null;
  else if (r.names !== undefined) { const n = cleanAvatarNames(r.names); if (n === undefined) return undefined; out.names = n; }
  if (r.box === null) out.box = null;
  else if (r.box !== undefined) { const b = cleanAvatarBox(r.box); if (b === undefined) return undefined; out.box = b; }
  return out;
}

const near = (a: AvatarBox | undefined, b: AvatarBox | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  const d = (x: number | undefined, y: number | undefined) => Math.abs((x ?? 0) - (y ?? 0)) <= BOX_MIN_DELTA;
  if (!d(a.canvas.width, b.canvas.width) || !d(a.canvas.height, b.canvas.height)) return false;
  if ((a.figure === undefined) !== (b.figure === undefined)) return false;
  if (a.figure !== undefined && b.figure !== undefined && !(d(a.figure.x, b.figure.x) && d(a.figure.y, b.figure.y) && d(a.figure.width, b.figure.width) && d(a.figure.height, b.figure.height))) return false;
  for (const k of ["headTop", "face", "mouth", "chest"] as const) {
    const p = a.anchors?.[k];
    const q = b.anchors?.[k];
    if ((p === undefined) !== (q === undefined)) return false;
    if (p !== undefined && q !== undefined && !(d(p.x, q.x) && d(p.y, q.y))) return false;
  }
  return true;
};

export interface HubTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}
const realTimers: HubTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() };

export interface AvatarState { readonly names: AvatarCatalogueNames | undefined; readonly box: AvatarBox | undefined }

export class AvatarControlHub {
  readonly #listeners = new Set<(cue: AvatarCue) => void>();
  #names: AvatarCatalogueNames | undefined;
  #box: AvatarBox | undefined;
  #sentBox: AvatarBox | undefined;
  #lastBoxAt = -Infinity;
  #timer: unknown = undefined;
  #visible = true;
  #closed = false;

  constructor(private readonly publish: (state: AvatarState) => void, private readonly timers: HubTimers = realTimers) {}

  /** A cue for the renderer (from the core, or from the parent for a framed renderer). */
  cue(cue: AvatarCue): void {
    for (const l of [...this.#listeners]) {
      try { l(cue); } catch (err) { console.error("an avatar cue failed", err); }
    }
  }

  onCue(listener: (cue: AvatarCue) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get state(): AvatarState { return { names: this.#names, box: this.#sentBox }; }

  /** What the loaded model has; undefined when nothing is loaded. Sent at once, with the box as last sent. */
  setNames(names: AvatarCatalogueNames | undefined): void {
    if (this.#closed || JSON.stringify(names) === JSON.stringify(this.#names)) return;
    this.#names = names;
    this.#send();
  }

  /** Where the figure stands. Throttled; nothing while hidden (the latest goes when the document shows again). */
  setBox(box: AvatarBox | undefined): void {
    if (this.#closed) return;
    this.#box = box;
    this.#maybeSendBox();
  }

  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (visible) this.#maybeSendBox();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) this.timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#listeners.clear();
  }

  #maybeSendBox(): void {
    if (!this.#visible || near(this.#box, this.#sentBox)) return;
    const wait = BOX_MIN_MS - (this.timers.now() - this.#lastBoxAt);
    if (wait <= 0) return this.#sendBox();
    if (this.#timer === undefined) this.#timer = this.timers.setTimeout(() => { this.#timer = undefined; this.#maybeSendBox(); }, wait);
  }

  #sendBox(): void {
    this.#sentBox = this.#box;
    this.#lastBoxAt = this.timers.now();
    this.#send();
  }

  #send(): void {
    this.publish({ names: this.#names, box: this.#sentBox });
  }
}

export { cleanAvatarCue } from "../catalogs/avatar-cues";
