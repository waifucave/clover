// Key focus back after the island folds (lane HS; the CI lane's cause-finding on row 53): a press on the island (a
// non-activating panel that may become the key window) takes key from the window the person was typing in; when the island
// then hides, AppKit gives key to nothing, and the first keystrokes in the composer went nowhere. This tracks, in one
// program, which window a surface took key from, and only that: when the surface hides while it is still key, key goes back
// to that window, the one that had it a moment before the press. A surface that became key while no window of this program
// was key (the person was in another app: the panel never activates MOSS) hands nothing back, so nothing is raised or
// activated that the person did not have in front. A press never focuses a window by itself; only a fold hands back.
// Pure: no Electron import (test/focus-handback.test.ts).

/** How soon after a window lost key a surface taking it counts as taking it from that window (the press's own click). */
export const HAND_BACK_WINDOW_MS = 1_000;

export class FocusHandBack {
  #lastKey: { id: number; lostAt?: number } | undefined;
  #took: { surface: number; from: number } | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** A window of this program became key (`browser-window-focus`). */
  focused(id: number, isSurface: boolean): void {
    if (!isSurface) {
      this.#lastKey = { id };
      this.#took = undefined;
      return;
    }
    const last = this.#lastKey;
    this.#took = last?.lostAt !== undefined && this.now() - last.lostAt <= HAND_BACK_WINDOW_MS ? { surface: id, from: last.id } : undefined;
  }

  /** A window of this program resigned key (`browser-window-blur`). */
  blurred(id: number, isSurface: boolean): void {
    if (!isSurface && this.#lastKey?.id === id) this.#lastKey = { id, lostAt: this.now() };
  }

  /** A window closed: it is no window to hand key back to. */
  closed(id: number): void {
    if (this.#lastKey?.id === id) this.#lastKey = undefined;
    if (this.#took?.from === id || this.#took?.surface === id) this.#took = undefined;
  }

  /** A surface is about to hide: the window to give key back to, when this surface is key and took it from that window. */
  hiding(surfaceId: number, surfaceIsKey: boolean): number | undefined {
    const took = this.#took;
    if (took === undefined || took.surface !== surfaceId) return undefined;
    this.#took = undefined;
    return surfaceIsKey ? took.from : undefined;
  }
}
