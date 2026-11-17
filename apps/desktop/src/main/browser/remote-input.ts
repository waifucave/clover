// The window half of a tab the background host runs (spec revision 19 §12.1, item 111; lane HS): what MOSS Code's
// browser panel sends for the person's input. The viewport page (`viewport-page/`) sends Electron's own input events;
// they become the protocol's `TabInputEvent`s for `browser.view.input`. Only the person's own: a down, a key or a wheel
// counts only when the window's main process saw that very kind of event come into the viewport's own frame from the
// hardware just before (`RealInput`, fed by the viewport's `before-mouse-event` and `before-input-event`); a move, an up
// or a leave counts only while a press the main process saw is going on, or the viewport has the keyboard focus a real
// press gave it. Pure: no Electron import (test/remote-view.test.ts).
import type { TabInputEvent } from "@waifucave/moss-protocol";
import type { ViewportInput } from "./viewport";

const MOUSE: Record<string, "down" | "up" | "move" | "enter" | "leave" | undefined> = { mouseDown: "down", mouseUp: "up", mouseMove: "move", mouseEnter: "enter", mouseLeave: "leave" };
const KEY: Record<string, "down" | "up" | "char" | undefined> = { keyDown: "down", keyUp: "up", char: "char" };
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const mods = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((m): m is string => typeof m === "string").slice(0, 8).map((m) => m.slice(0, 16)) : undefined);

/** One viewport event as the protocol's, or undefined for one a remote tab doesn't take (the edit commands and paste:
 *  the host's own clipboard is not the person's, so they stay with a tab this window runs). */
export function tabInputOf(ev: ViewportInput): TabInputEvent | undefined {
  if ("type" in ev) {
    const e = ev as Record<string, unknown>;
    const type = String(ev.type);
    const m = MOUSE[type];
    if (m !== undefined) {
      const button = e.button === "left" || e.button === "middle" || e.button === "right" ? e.button : undefined;
      const clicks = typeof e.clickCount === "number" ? Math.max(0, Math.min(3, Math.round(e.clickCount))) : undefined;
      const modifiers = mods(e.modifiers);
      return { kind: "mouse", type: m, x: num(e.x), y: num(e.y), ...(button !== undefined ? { button } : {}), ...(clicks !== undefined ? { clicks } : {}), ...(modifiers !== undefined ? { modifiers } : {}) };
    }
    if (type === "mouseWheel") return { kind: "wheel", x: num(e.x), y: num(e.y), dx: num(e.deltaX), dy: num(e.deltaY) };
    const k = KEY[type];
    if (k !== undefined && typeof e.keyCode === "string" && e.keyCode.length > 0) {
      const modifiers = mods(e.modifiers);
      return { kind: "key", type: k, key: e.keyCode.slice(0, 32), ...(modifiers !== undefined ? { modifiers } : {}) };
    }
    return undefined;
  }
  if (ev.kind === "text" || ev.kind === "ime-commit") return { kind: "ime", text: ev.text.slice(0, 1024) };
  return undefined;
}

/** How long a real event the main process saw stands for the page's report of it. */
export const REAL_INPUT_WINDOW_MS = 1_000;
/** How long after a real press its moves and its release still count. */
export const PRESS_SPAN_MS = 30_000;

type RealKind = "down" | "up" | "wheel" | "key";

/** The real events the main process saw come into the viewport's own frame, each spent by the one page event it stands for. */
export class RealInput {
  private readonly seen: { kind: RealKind; at: number }[] = [];
  private pressAt = -Infinity;
  constructor(private readonly now: () => number = Date.now) {}

  /** The main process saw one (`before-mouse-event`, `before-input-event` on the viewport's own contents). */
  saw(kind: RealKind): void {
    const t = this.now();
    this.seen.push({ kind, at: t });
    if (this.seen.length > 64) this.seen.shift();
    if (kind === "down") this.pressAt = t;
  }

  /** Whether a page event counts: a down, a key or a wheel spends a real one of its kind; anything else needs a press
   *  going on, or the viewport's keyboard focus (`focused`). */
  takes(ev: TabInputEvent, focused: boolean): boolean {
    const t = this.now();
    const kind: RealKind | undefined = ev.kind === "mouse" ? (ev.type === "down" ? "down" : ev.type === "up" ? "up" : undefined) : ev.kind === "wheel" ? "wheel" : ev.kind === "key" && ev.type !== "char" ? "key" : undefined;
    if (kind === "down" || kind === "wheel" || kind === "key") {
      const i = this.seen.findIndex((s) => s.kind === kind && t - s.at <= REAL_INPUT_WINDOW_MS);
      if (i < 0) return false;
      this.seen.splice(i, 1);
      return true;
    }
    return focused || t - this.pressAt <= PRESS_SPAN_MS;
  }
}
