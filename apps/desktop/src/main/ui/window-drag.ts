// Moving the window by its title area. Chromium honors `-webkit-app-region` only from a window's main frame, and the
// shell draws its bars inside a layer's frame (an out-of-process iframe), so the CSS there moves nothing. A root-document
// strip with holes would need the frame to say where its buttons are, so this takes the other way, with the whole
// decision in the main process:
//
//   * only the frame the core mounted as the shell in `app.root` may start a drag (the caller checks its own mount
//     record, never a plugin id or a field the page sends); the layer's message says no more than "the press was on a
//     declared drag region";
//   * a drag starts only from a primary-button press the main process itself saw come to the window, a moment ago,
//     inside the title area, and the window then follows the cursor positions the main process reads from its own
//     mouse events (never coordinates the layer supplies), and stops on the release;
//   * no drag starts or goes on while a sealed card is pending in the window: moving the window under the pointer
//     must not defeat "a click counts only while the button is visible and uncovered" (spec §5.5).
//
// Pure apart from the clock it is given, so the tests drive it under Bun.

/** How long after the main process saw the press a drag may still begin. */
export const DRAG_PRESS_WINDOW_MS = 400;

export interface Press { x: number; y: number; at: number }
interface Going { window: { x: number; y: number }; cursor: { x: number; y: number } }

export type DragStart = { ok: true } | { ok: false; why: string };

export class TitleDrag {
  private readonly presses = new Map<number, Press>();
  private readonly going = new Map<number, Going>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The main process saw a mouse press come to the window (`before-mouse-event`); only the primary button counts. */
  down(windowId: number, mouse: { button?: string; x: number; y: number }): void {
    if (mouse.button !== undefined && mouse.button !== "left") return;
    this.presses.set(windowId, { x: mouse.x, y: mouse.y, at: this.now() });
  }

  /** The shell says its press was on a drag region: begin, if every rule holds. `cursor` is where the main process saw
   *  that press on the screen. */
  start(windowId: number, o: { shell: boolean; titleHeight: number; cardPending: boolean; window: { x: number; y: number }; cursor: { x: number; y: number } | undefined }): DragStart {
    if (!o.shell) return { ok: false, why: "only the shell the core mounted in app.root drags the window" };
    const press = this.presses.get(windowId);
    this.presses.delete(windowId);
    if (press === undefined || this.now() - press.at > DRAG_PRESS_WINDOW_MS) return { ok: false, why: "no primary-button press of the user's just before" };
    if (press.y < 0 || press.y >= o.titleHeight) return { ok: false, why: "the press wasn't in the title area" };
    if (o.cardPending) return { ok: false, why: "a sealed card is pending in this window" };
    if (o.cursor === undefined) return { ok: false, why: "the cursor's place on the screen is unknown" };
    this.going.set(windowId, { window: o.window, cursor: o.cursor });
    return { ok: true };
  }

  get active(): boolean {
    return this.going.size > 0;
  }

  isGoing(windowId: number): boolean {
    return this.going.has(windowId);
  }

  /** The window's new place for the cursor the main process read; undefined when no drag goes (or a card appeared: it ends). */
  move(windowId: number, cursor: { x: number; y: number }, cardPending: boolean): { x: number; y: number } | undefined {
    const d = this.going.get(windowId);
    if (d === undefined) return undefined;
    if (cardPending) {
      this.going.delete(windowId);
      return undefined;
    }
    return { x: Math.round(d.window.x + (cursor.x - d.cursor.x)), y: Math.round(d.window.y + (cursor.y - d.cursor.y)) };
  }

  /** The release (or the window losing the pointer): the drag is over. */
  end(windowId: number): { x: number; y: number } | undefined {
    const d = this.going.get(windowId);
    this.going.delete(windowId);
    return d?.window;
  }

  forget(windowId: number): void {
    this.presses.delete(windowId);
    this.going.delete(windowId);
  }
}
