// Round twelve: the viewport's preload (the browser view's side of Winter's model, in Electron). It draws a bot tab's
// offscreen frames — GPU shared textures imported by the main process and sent here as VideoFrames, or CPU bitmaps of
// the changed rectangle — on a canvas, and while it holds control it sends the person's input back: mouse, wheel,
// keys, IME composition, paste and edit commands. It runs in the viewer's isolated world (sandboxed), so it draws and
// listens on the page's DOM directly. Bundled to out/electron/vp-preload.cjs; `electron` stays a require.
//
// Main → here:  vp-bitmap (meta, pixels BGRA), shared textures (meta as the extra argument), vp-control (bool),
//               vp-cursor (type), vp-caret (rect), vp-stats? (reply on vp-stats)
// Here → main:  vp-input (an Electron input event or {kind}), vp-size ({w, h}), vp-probe ({trial, tDrawn, tShown}),
//               vp-stats (the counters)

declare const require: (m: string) => unknown;

interface Ipc {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
}
interface Imported { getVideoFrame(): VideoFrame; release(): void }
interface SharedTextureApi { setSharedTextureReceiver(cb: (data: { importedSharedTexture: Imported }, ...args: any[]) => Promise<void>): void }
const electron = require("electron") as { ipcRenderer: Ipc; sharedTexture?: SharedTextureApi };
const ipc = electron.ipcRenderer;

interface FrameMeta {
  seq: number;
  /** "frame" or "popup" (shared textures say which widget drew them). */
  widget: string;
  /** The whole frame's size in pixels. */
  fullW: number;
  fullH: number;
  /** Bitmaps: where the changed rectangle goes. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** A latency trial this frame closes (it holds the box's change). */
  trial?: number;
}

const stats = {
  frames: 0, textures: 0, bitmaps: 0, popups: 0, popupSizes: [] as string[], lastSeq: 0, lastSize: "", sizes: [] as string[],
  drawMs: [] as number[], errors: [] as string[], inputs: 0, control: false, cursor: "", textureReceiver: false,
  firstFrameAt: 0, lastFrameAt: 0,
};

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let ime: HTMLTextAreaElement | null = null;
let control = false;
let composing = false;

function err(where: string, e: unknown): void {
  stats.errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  if (stats.errors.length > 20) stats.errors.shift();
}

function sizeCanvas(w: number, h: number): void {
  if (canvas === null) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    stats.sizes.push(`${Date.now()}:${w}x${h}`);
    if (stats.sizes.length > 30) stats.sizes.shift();
  }
  stats.lastSize = `${w}x${h}`;
}

function drawn(meta: FrameMeta, t0: number): void {
  const t1 = performance.now();
  stats.drawMs.push(t1 - t0);
  if (stats.drawMs.length > 300) stats.drawMs.shift();
  stats.frames++;
  stats.lastSeq = meta.seq;
  const now = Date.now();
  if (stats.firstFrameAt === 0) stats.firstFrameAt = now;
  stats.lastFrameAt = now;
  ipc.send("vp-ack", meta.seq, stats.lastSize);
  if (meta.trial !== undefined) {
    const trial = meta.trial;
    const tDrawn = now;
    // two rAFs: the first runs before the frame holding this draw is made, the second once it has been
    requestAnimationFrame(() => requestAnimationFrame(() => ipc.send("vp-probe", { trial, tDrawn, tShown: Date.now(), seq: meta.seq })));
  }
}

// --- frames: shared textures --------------------------------------------------------------------------------------------
if (electron.sharedTexture !== undefined) {
  try {
    electron.sharedTexture.setSharedTextureReceiver(async (data, meta: FrameMeta) => {
      const imported = data.importedSharedTexture;
      try {
        const t0 = performance.now();
        const frame = imported.getVideoFrame();
        try {
          if (meta.widget === "popup") {
            // Electron gives a popup's texture no position: the viewport can't place it (round twelve's finding)
            stats.popups++;
            stats.popupSizes.push(`${frame.displayWidth}x${frame.displayHeight}`);
            if (stats.popupSizes.length > 10) stats.popupSizes.shift();
          } else if (ctx !== null) {
            sizeCanvas(frame.displayWidth, frame.displayHeight);
            ctx.drawImage(frame, 0, 0);
            stats.textures++;
            drawn(meta, t0);
          }
        } finally {
          frame.close();
        }
      } catch (e) {
        err("texture", e);
      } finally {
        imported.release();
      }
    });
    stats.textureReceiver = true;
  } catch (e) {
    err("setSharedTextureReceiver", e);
  }
}

// --- frames: bitmaps of the changed rectangle (BGRA) -------------------------------------------------------------------
ipc.on("vp-bitmap", (_e, meta: FrameMeta, px: Uint8Array) => {
  if (ctx === null) return;
  try {
    const t0 = performance.now();
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
    stats.bitmaps++;
    drawn(meta, t0);
  } catch (e) {
    err("bitmap", e);
  }
});

// --- control, cursor, caret --------------------------------------------------------------------------------------------
ipc.on("vp-control", (_e, on: boolean) => {
  control = on;
  stats.control = on;
  if (on) ime?.focus();
});
const CSS_CURSORS = new Set(["default", "pointer", "text", "crosshair", "wait", "help", "move", "progress", "not-allowed", "grab", "grabbing", "cell", "copy", "alias", "zoom-in", "zoom-out", "col-resize", "row-resize", "e-resize", "n-resize", "ne-resize", "nw-resize", "s-resize", "se-resize", "sw-resize", "w-resize", "ns-resize", "ew-resize", "nesw-resize", "nwse-resize", "vertical-text", "context-menu", "none"]);
ipc.on("vp-cursor", (_e, type: string) => {
  const css = type === "hand" ? "pointer" : type === "nodrop" ? "no-drop" : CSS_CURSORS.has(type) ? type : "default";
  if (canvas !== null) canvas.style.cursor = css;
  stats.cursor = css;
});
ipc.on("vp-caret", (_e, r: { x: number; y: number; h: number }) => {
  // the OS draws IME candidates beside the focused element's caret: keep the proxy where the page's caret is
  if (ime === null) return;
  ime.style.left = `${Math.round(r.x)}px`;
  ime.style.top = `${Math.round(r.y)}px`;
  ime.style.height = `${Math.max(10, Math.round(r.h))}px`;
});
ipc.on("vp-stats?", () => { ipc.send("vp-stats", { ...stats, drawMs: stats.drawMs.slice(), errors: stats.errors.slice(), focused: document.activeElement?.id ?? "", hasFocus: document.hasFocus() }); });

// --- input --------------------------------------------------------------------------------------------------------------
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
// DOM key names → Electron's accelerator key codes
const KEYS: Record<string, string> = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space", Escape: "Escape", Enter: "Enter",
  Backspace: "Backspace", Delete: "Delete", Tab: "Tab", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
};
function keyCodeOf(key: string): string {
  return KEYS[key] ?? key;
}
function send(ev: Record<string, unknown>): void {
  stats.inputs++;
  ipc.send("vp-input", ev);
}
const EDIT: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", z: "undo", y: "redo" };

function setup(): void {
  canvas = document.getElementById("vp") as HTMLCanvasElement;
  ctx = canvas.getContext("2d", { alpha: false });
  ime = document.getElementById("ime") as HTMLTextAreaElement;
  const at = (e: MouseEvent): { x: number; y: number } => ({ x: Math.round(e.offsetX), y: Math.round(e.offsetY) });
  canvas.addEventListener("mousedown", (e) => {
    if (!control) return;
    e.preventDefault();
    ime?.focus();
    send({ type: "mouseDown", ...at(e), button: BUTTONS[e.button] ?? "left", clickCount: e.detail || 1, modifiers: mods(e) });
  });
  canvas.addEventListener("mouseup", (e) => {
    if (!control) return;
    e.preventDefault();
    send({ type: "mouseUp", ...at(e), button: BUTTONS[e.button] ?? "left", clickCount: e.detail || 1, modifiers: mods(e) });
  });
  canvas.addEventListener("mousemove", (e) => { if (control) send({ type: "mouseMove", ...at(e), modifiers: mods(e) }); });
  canvas.addEventListener("mouseleave", (e) => { if (control) send({ type: "mouseLeave", ...at(e), modifiers: mods(e) }); });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    if (!control) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    // DOM: positive deltaY scrolls down; Chromium's wheel event: positive scrolls up
    send({ type: "mouseWheel", ...at(e), deltaX: -e.deltaX * k, deltaY: -e.deltaY * k, canScroll: true, hasPreciseScrollingDeltas: e.deltaMode === 0, modifiers: mods(e) });
  }, { passive: false });

  ime.addEventListener("keydown", (e) => {
    if (!control || composing || e.isComposing || e.keyCode === 229) return;
    const cmd = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (cmd && k === "v") return; // the textarea's paste event carries it
    e.preventDefault();
    if (cmd && EDIT[k] !== undefined) { send({ kind: "edit", cmd: EDIT[k] }); return; }
    send({ type: "keyDown", keyCode: keyCodeOf(e.key), modifiers: mods(e) });
    if (e.key.length === 1 && !cmd) send({ type: "char", keyCode: e.key, modifiers: mods(e) });
  });
  ime.addEventListener("keyup", (e) => {
    if (!control || composing || e.isComposing) return;
    const cmd = e.ctrlKey || e.metaKey;
    if (cmd && EDIT[e.key.toLowerCase()] !== undefined) return;
    e.preventDefault();
    send({ type: "keyUp", keyCode: keyCodeOf(e.key), modifiers: mods(e) });
  });
  ime.addEventListener("compositionstart", () => { composing = true; if (control) send({ kind: "ime-start" }); });
  ime.addEventListener("compositionupdate", (e) => { if (control) send({ kind: "ime-set", text: e.data }); });
  ime.addEventListener("compositionend", (e) => {
    composing = false;
    if (control) send({ kind: "ime-commit", text: e.data });
    if (ime !== null) ime.value = "";
  });
  ime.addEventListener("input", (e) => {
    const ie = e as InputEvent;
    // text that came without a key the viewport sent on (an emoji picker, dictation): put it in as typed text
    if (control && !composing && ie.inputType === "insertText" && typeof ie.data === "string" && ie.data !== "") send({ kind: "text", text: ie.data });
    if (!composing && ime !== null) ime.value = "";
  });
  ime.addEventListener("paste", (e) => {
    if (!control) return;
    e.preventDefault();
    send({ kind: "paste", text: e.clipboardData?.getData("text/plain") ?? "" });
  });
  const tellSize = (): void => ipc.send("vp-size", { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio });
  window.addEventListener("resize", tellSize);
  tellSize();
  ime.focus();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
else setup();
