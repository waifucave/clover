// Ruling R9, the app's side: a hang restarts the app into safe mode. The window's own page is core code that does next
// to nothing, so a window that stays unresponsive is the compositor or the GPU stuck (S7's shared-texture hang is the
// case in view, which M1's CPU bitmaps can't have yet), not a plugin: plugins draw in frames of their own processes,
// whose hangs leave the window responsive. The daemon's side (lane C) is the pair's heartbeat: the app answers
// `app.ping` at once from its main process, and a daemon that hears nothing for a while restarts it, in safe mode.
// Pure, so the timing is unit-tested.

/** How long a window may stay unresponsive before the app restarts into safe mode. */
export const HANG_RESTART_MS = 15_000;

export class HangWatch {
  private readonly hung = new Map<number, ReturnType<typeof setTimeout>>();
  private fired = false;

  constructor(
    private readonly restart: (windowId: number) => void,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
    private readonly afterMs = HANG_RESTART_MS,
  ) {}

  /** A window's page stopped answering (`unresponsive`). */
  unresponsive(windowId: number): void {
    if (this.fired || this.hung.has(windowId)) return;
    this.hung.set(windowId, this.timers.set(() => {
      this.hung.delete(windowId);
      if (this.fired) return;
      this.fired = true;
      this.restart(windowId);
    }, this.afterMs));
  }

  /** It answers again (`responsive`), or it closed. */
  responsive(windowId: number): void {
    const t = this.hung.get(windowId);
    if (t !== undefined) this.timers.clear(t);
    this.hung.delete(windowId);
  }
}
