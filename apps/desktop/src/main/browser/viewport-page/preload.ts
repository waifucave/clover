// The browser view's viewport page (design B, the owner's decision 92): it draws a bot tab's offscreen frames, CPU
// bitmaps of the changed area, on a canvas, and sends the person's input back: mouse, wheel, keys, IME composition,
// paste and edit commands. Ported from spike S7's viewport (`spikes/s7-browser`, round twelve), where every kind of
// input worked through it on all three OSes. It runs as the viewport page's sandboxed preload; the main process side
// is `../viewport.ts`. Bundled to one CommonJS file (`BROWSER_ASSETS` in `../assets.ts`); `electron` stays a require.
//
// Main → here:  frame (meta, BGRA pixels), control (bool), cursor (type)
// Here → main:  input (an Electron input event, or {kind}), ack (seq), size ({w, h})

export {};

interface Ipc {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
}
const ipc = (require("electron") as { ipcRenderer: Ipc }).ipcRenderer;
const CH = "clover-browser-viewport";

interface FrameMeta { seq: number; fullW: number; fullH: number; x: number; y: number; w: number; h: number }

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let keys: HTMLTextAreaElement | null = null;
let control = false;
let composing = false;

function sizeCanvas(w: number, h: number): void {
  if (canvas === null || (canvas.width === w && canvas.height === h)) return;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

// Frames: the changed rectangle in BGRA, drawn where it goes.
ipc.on(`${CH}:frame`, (_e, meta: FrameMeta, px: Uint8Array) => {
  if (ctx === null) return;
  sizeCanvas(meta.fullW, meta.fullH);
  const n = meta.w * meta.h;
  if (n > 0 && px.byteLength >= n * 4) {
    const out = new ImageData(meta.w, meta.h);
    const src = new Uint32Array(px.buffer, px.byteOffset, n);
    const dst = new Uint32Array(out.data.buffer);
    for (let i = 0; i < n; i++) {
      const v = src[i]!; // BGRA in memory: 0xAARRGGBB as a little-endian word
      dst[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff);
    }
    ctx.putImageData(out, meta.x, meta.y);
  }
  ipc.send(`${CH}:ack`, meta.seq);
});

ipc.on(`${CH}:control`, (_e, on: boolean) => {
  control = on;
  if (on) keys?.focus();
  else if (ctx !== null && canvas !== null) ctx.clearRect(0, 0, canvas.width, canvas.height);
});

const CSS_CURSORS = new Set(["default", "pointer", "text", "crosshair", "wait", "help", "move", "progress", "not-allowed", "grab", "grabbing", "cell", "copy", "alias", "zoom-in", "zoom-out", "col-resize", "row-resize", "e-resize", "n-resize", "ne-resize", "nw-resize", "s-resize", "se-resize", "sw-resize", "w-resize", "ns-resize", "ew-resize", "nesw-resize", "nwse-resize", "vertical-text", "context-menu", "none"]);
ipc.on(`${CH}:cursor`, (_e, type: string) => {
  const css = type === "hand" ? "pointer" : type === "nodrop" ? "no-drop" : CSS_CURSORS.has(type) ? type : "default";
  if (canvas !== null) canvas.style.cursor = css;
});

type Mod = "shift" | "control" | "alt" | "meta" | "leftbuttondown" | "middlebuttondown" | "rightbuttondown";
function mods(e: MouseEvent | KeyboardEvent): Mod[] {
  const m: Mod[] = [];
  if (e.shiftKey) m.push("shift");
  if (e.ctrlKey) m.push("control");
  if (e.altKey) m.push("alt");
  if (e.metaKey) m.push("meta");
  if ("buttons" in e) {
    if (e.buttons & 1) m.push("leftbuttondown");
    if (e.buttons & 4) m.push("middlebuttondown");
    if (e.buttons & 2) m.push("rightbuttondown");
  }
  return m;
}
const BUTTONS = ["left", "middle", "right"] as const;
// DOM key names → Electron's accelerator key codes.
const KEYS: Record<string, string> = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space", Escape: "Escape", Enter: "Enter",
  Backspace: "Backspace", Delete: "Delete", Tab: "Tab", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
};
const EDIT: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", z: "undo", y: "redo" };

function send(ev: Record<string, unknown>): void {
  ipc.send(`${CH}:input`, ev);
}

function setup(): void {
  canvas = document.getElementById("frame") as HTMLCanvasElement;
  ctx = canvas.getContext("2d", { alpha: false });
  keys = document.getElementById("keys") as HTMLTextAreaElement;
  const at = (e: MouseEvent): { x: number; y: number } => ({ x: Math.round(e.offsetX), y: Math.round(e.offsetY) });
  canvas.addEventListener("mousedown", (e) => {
    if (!control) return;
    e.preventDefault();
    keys?.focus();
    send({ type: "mouseDown", ...at(e), button: BUTTONS[e.button] ?? "left", clickCount: e.detail || 1, modifiers: mods(e) });
  });
  canvas.addEventListener("mouseup", (e) => {
    if (!control) return;
    e.preventDefault();
    send({ type: "mouseUp", ...at(e), button: BUTTONS[e.button] ?? "left", clickCount: e.detail || 1, modifiers: mods(e) });
  });
  canvas.addEventListener("mousemove", (e) => { if (control) send({ type: "mouseMove", ...at(e), modifiers: mods(e) }); });
  canvas.addEventListener("mouseleave", (e) => { if (control) send({ type: "mouseLeave", ...at(e), modifiers: mods(e) }); });
  // The page's own menu comes from the tab (`context-menu`), drawn by the app: never the viewport page's.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    if (!control) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    // The DOM's positive deltaY scrolls down; Chromium's wheel event's scrolls up.
    send({ type: "mouseWheel", ...at(e), deltaX: -e.deltaX * k, deltaY: -e.deltaY * k, canScroll: true, hasPreciseScrollingDeltas: e.deltaMode === 0, modifiers: mods(e) });
  }, { passive: false });

  keys.addEventListener("keydown", (e) => {
    if (!control || composing || e.isComposing || e.keyCode === 229) return;
    const cmd = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (cmd && k === "v") return; // the textarea's paste event carries it
    e.preventDefault();
    if (cmd && EDIT[k] !== undefined) { send({ kind: "edit", cmd: EDIT[k] }); return; }
    send({ type: "keyDown", keyCode: KEYS[e.key] ?? e.key, modifiers: mods(e) });
    if (e.key.length === 1 && !cmd) send({ type: "char", keyCode: e.key, modifiers: mods(e) });
  });
  keys.addEventListener("keyup", (e) => {
    if (!control || composing || e.isComposing) return;
    const cmd = e.ctrlKey || e.metaKey;
    if (cmd && EDIT[e.key.toLowerCase()] !== undefined) return;
    e.preventDefault();
    send({ type: "keyUp", keyCode: KEYS[e.key] ?? e.key, modifiers: mods(e) });
  });
  keys.addEventListener("compositionstart", () => { composing = true; });
  keys.addEventListener("compositionupdate", (e) => { if (control) send({ kind: "ime-set", text: e.data }); });
  keys.addEventListener("compositionend", (e) => {
    composing = false;
    if (control) send({ kind: "ime-commit", text: e.data });
    if (keys !== null) keys.value = "";
  });
  keys.addEventListener("input", (e) => {
    const ie = e as InputEvent;
    // Text that came without a key the viewport sent on (an emoji picker, dictation) goes in as typed text.
    if (control && !composing && ie.inputType === "insertText" && typeof ie.data === "string" && ie.data !== "") send({ kind: "text", text: ie.data });
    if (!composing && keys !== null) keys.value = "";
  });
  keys.addEventListener("paste", (e) => {
    if (!control) return;
    e.preventDefault();
    send({ kind: "paste" });
  });
  const tellSize = (): void => ipc.send(`${CH}:size`, { w: window.innerWidth, h: window.innerHeight });
  window.addEventListener("resize", tellSize);
  tellSize();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
else setup();
