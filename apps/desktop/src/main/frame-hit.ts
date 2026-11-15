// Which frames a press landed in (the frame under the pointer at a mouse down, with the frames it sits in), for `user.send`'s
// allowance after a hold: the release counts for the frames the press happened in, never for one a page moved focus to.
// The first hop is asked of the window's own root document (the app's, which no plugin can bend); each hop after it is asked
// inside the layer document the pointer is over, and only ever finds that plugin's own frames, so a page that lies there
// can only name frames it already owns.

/** One frame of the window, as the walk sees it. */
export interface HitFrame {
  readonly id: string;
  readonly url: string;
  readonly children: readonly HitFrame[];
  /** The iframe element at (x, y) in this frame's own coordinates: its `src` and where its content box starts; null if the point
   *  is not over an iframe (or the frame does not answer in time). */
  ask(x: number, y: number): Promise<{ src: string; x: number; y: number } | null>;
}

export const FRAME_HIT_DEPTH = 5;

/** The ids of the frames the point (window coordinates) is in, outermost first, the window's main frame left out: empty if the
 *  point is over the root document's own content. */
export async function frameChainAt(main: HitFrame, x: number, y: number): Promise<string[]> {
  const chain: string[] = [];
  let frame = main;
  let ox = 0;
  let oy = 0;
  for (let i = 0; i < FRAME_HIT_DEPTH; i++) {
    const hit = await frame.ask(x - ox, y - oy).catch(() => null);
    if (hit === null) break;
    const child = frame.children.find((c) => c.url === hit.src);
    if (child === undefined) break;
    chain.push(child.id);
    ox += hit.x;
    oy += hit.y;
    frame = child;
  }
  return chain;
}

/** The script a frame answers a hop with. */
export const hitScript = (x: number, y: number): string =>
  `(() => { const e = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)}); if (e === null || e.tagName !== "IFRAME") return null; const r = e.getBoundingClientRect(); return { src: e.src, x: r.x + e.clientLeft, y: r.y + e.clientTop }; })()`;
