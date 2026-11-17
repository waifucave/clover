// The person's input to a tab the host runs, forwarded from MOSS Code's browser panel (`host.tab.input`, spec revision 19
// §12.1, item 111; lane HS): the protocol's `TabInputEvent`s turned into Electron's own input events for the tab's page
// (`sendInputEvent`), or an IME's text (`insertText`). Pure: no Electron import (test/host-program.test.ts).
import type { TabInputEvent } from "@waifucave/moss-protocol";

export type ElectronInput =
  | { type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseEnter" | "mouseLeave"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number; modifiers?: string[] }
  | { type: "mouseWheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "keyDown" | "keyUp" | "char"; keyCode: string; modifiers?: string[] }
  | { type: "insertText"; text: string };

const MOUSE = { down: "mouseDown", up: "mouseUp", move: "mouseMove", enter: "mouseEnter", leave: "mouseLeave" } as const;
const KEY = { down: "keyDown", up: "keyUp", char: "char" } as const;
const MODIFIERS = new Set(["shift", "control", "ctrl", "alt", "meta", "cmd", "command", "isautorepeat", "capslock", "numlock", "left", "right"]);

/** One forwarded event as Electron's, its modifiers limited to the names Electron knows. */
export function electronInput(ev: TabInputEvent): ElectronInput {
  const mods = (m: readonly string[] | undefined) => (m === undefined ? undefined : m.map((x) => x.toLowerCase()).filter((x) => MODIFIERS.has(x)));
  switch (ev.kind) {
    case "mouse": {
      const m = mods(ev.modifiers);
      return { type: MOUSE[ev.type], x: Math.round(ev.x), y: Math.round(ev.y), ...(ev.button !== undefined ? { button: ev.button } : {}), ...(ev.clicks !== undefined ? { clickCount: ev.clicks } : {}), ...(m !== undefined ? { modifiers: m } : {}) };
    }
    case "wheel":
      return { type: "mouseWheel", x: Math.round(ev.x), y: Math.round(ev.y), deltaX: ev.dx, deltaY: ev.dy };
    case "key": {
      const m = mods(ev.modifiers);
      return { type: KEY[ev.type], keyCode: ev.key, ...(m !== undefined ? { modifiers: m } : {}) };
    }
    case "ime":
      return { type: "insertText", text: ev.text };
  }
}
