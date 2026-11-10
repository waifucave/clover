// Moving the window by its title area. Chromium honors `-webkit-app-region` only from a window's main frame, and the
// bundled tree draws its bars inside a layer's frame (an out-of-process iframe), so the CSS there moves nothing. The
// tree's layer therefore tells the main process when the mouse goes down on an element that declares `drag`, and
// where it is on the screen while it moves; the window follows. Only the bundled tree's parts may ask (decided by
// the caller from the mount, as for the calls), and a window that is full screen or maximized stays where it is.

export interface DragStart {
  /** The window's position when the mouse went down. */
  window: { x: number; y: number };
  /** The mouse's, on the screen. */
  mouse: { x: number; y: number };
}

export class WindowDrag {
  private readonly drags = new Map<number, DragStart>();

  start(windowId: number, window: { x: number; y: number }, mouse: { x: number; y: number }): void {
    this.drags.set(windowId, { window, mouse });
  }

  /** The window's new place for the mouse's, or undefined when no drag is going. */
  move(windowId: number, mouse: { x: number; y: number }): { x: number; y: number } | undefined {
    const d = this.drags.get(windowId);
    if (d === undefined) return undefined;
    return { x: Math.round(d.window.x + (mouse.x - d.mouse.x)), y: Math.round(d.window.y + (mouse.y - d.mouse.y)) };
  }

  /** Where the window was when the drag began (undefined: none going). */
  origin(windowId: number): { x: number; y: number } | undefined {
    return this.drags.get(windowId)?.window;
  }

  end(windowId: number): void {
    this.drags.delete(windowId);
  }
}
