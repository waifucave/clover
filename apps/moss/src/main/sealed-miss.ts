// MOSS's own copy of MOSS Code's sealed-miss.ts (apps/desktop/src/main/sealed-miss.ts), unchanged.
// A press the person made on a sealed button that no sealed page heard (lane RT, round 5). Under load Chromium sometimes hands a
// mouse-down over a drawn, visible sealed button to the frame that embeds it, or to no document at all (the probe on GitHub saw
// both: the embedding document took the press at the button's spot; or no document saw it). The page can't say anything about a
// press it never got, so the person's press was silent. The main process sees every mouse-down that comes to a window; when no
// sealed page in that window reported a press within MISS_BOUND_MS, and the point lies inside a pending sealed button that has
// reported itself visible, the app tells that button's page to say "Not ready yet — press again" (the words of a late reading).
//
// It only shows the notice: nothing here answers, presses or spends a press; the next press is an ordinary one, judged as always.
//
// Where the buttons are: each sealed page measures its own buttons (in its own viewport, a page of ours), and the frames that
// embed it say where its frame sits (each parent document's iframe box, summed up to the window). A parent may be a plugin's
// document: lying about the box only moves where the app looks for a button, so the worst it can do is a wrong "press again" on
// a card whose frame it embeds, or no notice at all; it never reaches an answer, a token or another frame's page.

/** How long after a mouse-down a sealed page has to say it got the press before the app counts it as missed. */
export const MISS_BOUND_MS = 400;

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; width: number; height: number }

/** Each window's latest mouse-down, and whether a sealed page in that window said it got a press since. */
export class MissWatch {
  readonly #downs = new Map<number, { point: Point; at: number; heard: boolean; checked: boolean }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A mouse-down main saw in a window (window coordinates). */
  down(windowId: number, point: Point): void {
    this.#downs.set(windowId, { point, at: this.now(), heard: false, checked: false });
  }

  /** A sealed page in that window said it got a press (any of its words). */
  heard(windowId: number): void {
    const d = this.#downs.get(windowId);
    if (d !== undefined && this.now() >= d.at) d.heard = true;
  }

  /** Once the bound has passed: the point of that window's latest mouse-down if no sealed page heard it; asked once per press. */
  missed(windowId: number): Point | undefined {
    const d = this.#downs.get(windowId);
    if (d === undefined || d.heard || d.checked || this.now() - d.at < MISS_BOUND_MS) return undefined;
    d.checked = true;
    return d.point;
  }

  forget(windowId: number): void {
    this.#downs.delete(windowId);
  }
}

/** A box inside a frame, moved into the window by the offsets of the frames above it (each iframe's box in its parent). */
export function inWindow(box: Box, offsets: readonly Point[]): Box {
  let x = box.x;
  let y = box.y;
  for (const o of offsets) {
    x += o.x;
    y += o.y;
  }
  return { x, y, width: box.width, height: box.height };
}

/** The first button whose box holds the point (edges included), or undefined. */
export function buttonAt<T extends { box: Box }>(point: Point, buttons: readonly T[]): T | undefined {
  return buttons.find((b) => b.box.width > 0 && b.box.height > 0 && point.x >= b.box.x && point.x <= b.box.x + b.box.width && point.y >= b.box.y && point.y <= b.box.y + b.box.height);
}
