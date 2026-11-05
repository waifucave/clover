// The viewport: how the person sees a bot's offscreen tab (design B, the owner's decision 92; Winter's panel, S7 §7).
// It is an app-owned view placed where the browser view's frame is (lane E's runtime says where); its page
// (`viewport-page/`) draws the tab's frames and sends the person's input back, and the tab is laid out at the view's
// size while shown. Nothing about the tab changes but its size and frame rate, so it never reloads.
import { ipcMain, WebContentsView, type BaseWindow, type IpcMainEvent, type KeyboardInputEvent, type MouseInputEvent, type MouseWheelInputEvent, type NativeImage, type Rectangle } from "electron";
import type { OffscreenTab } from "./tab";

export const VIEWPORT_CHANNEL = "clover-browser-viewport";

export interface ViewportAssets {
  /** The viewport page's sandboxed preload, bundled to one CommonJS file. */
  preload: string;
  /** The viewport page. */
  html: string;
}

/** The person's input, as the viewport page sends it. */
export type ViewportInput =
  | ({ type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseLeave" | "mouseWheel" | "keyDown" | "keyUp" | "char" } & Record<string, unknown>)
  | { kind: "edit"; cmd: "selectAll" | "copy" | "cut" | "undo" | "redo" }
  | { kind: "paste" }
  | { kind: "text"; text: string }
  | { kind: "ime-set"; text: string }
  | { kind: "ime-commit"; text: string };

/** Inputs that mean the person is using the tab (a plain move over it doesn't). */
const TAKING = new Set(["mouseDown", "mouseWheel", "keyDown", "char"]);

export class Viewport {
  readonly view: WebContentsView;
  private tab: OffscreenTab | undefined;
  private parent: BaseWindow | undefined;
  private seq = 0;
  private readonly inFlight = new Set<number>();
  private needFull = false;
  private took = false;
  private dragData: unknown;
  private dragEntered = false;
  private readonly onInput = (e: IpcMainEvent, ev: ViewportInput): void => { if (e.sender === this.view.webContents) this.input(ev); };
  private readonly onAck = (e: IpcMainEvent, seq: number): void => { if (e.sender === this.view.webContents) this.inFlight.delete(seq); };

  constructor(assets: ViewportAssets, private readonly hooks: { took(tab: OffscreenTab): void }) {
    this.view = new WebContentsView({
      webPreferences: { preload: assets.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    this.view.setBackgroundColor("#00000000");
    // The viewport page is the app's own; it never navigates or opens anything.
    this.view.webContents.on("will-navigate", (e) => e.preventDefault());
    this.view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void this.view.webContents.loadFile(assets.html);
    ipcMain.on(`${VIEWPORT_CHANNEL}:input`, this.onInput);
    ipcMain.on(`${VIEWPORT_CHANNEL}:ack`, this.onAck);
  }

  get attached(): OffscreenTab | undefined {
    return this.tab;
  }

  attach(tab: OffscreenTab, target: { window: BaseWindow; bounds: Rectangle }): void {
    if (this.tab !== undefined && this.tab !== tab) this.detach();
    this.place(target);
    this.tab = tab;
    this.took = false;
    this.needFull = true;
    this.inFlight.clear();
    this.send("control", true);
    // The browser hands a drag to the viewport, which turns the person's moves into drag events (S7 §7.2: Electron
    // cancels a drag in an offscreen tab as soon as it starts).
    void tab.debugger.internal("Input.setInterceptDrags", { enabled: true }).catch(() => undefined);
    tab.contents.invalidate();
  }

  /** The browser view's frame moved, or the window it's in changed. */
  place(target: { window: BaseWindow; bounds: Rectangle }): void {
    if (this.parent !== target.window) {
      if (this.parent !== undefined && !this.parent.isDestroyed()) this.parent.contentView.removeChildView(this.view);
      target.window.contentView.addChildView(this.view);
      this.parent = target.window;
    }
    this.view.setBounds(target.bounds);
  }

  detach(): void {
    const tab = this.tab;
    this.tab = undefined;
    this.dragData = undefined;
    this.dragEntered = false;
    this.send("control", false);
    if (tab !== undefined && !tab.closed) void tab.debugger.internal("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
    if (this.parent !== undefined && !this.parent.isDestroyed()) this.parent.contentView.removeChildView(this.view);
    this.parent = undefined;
  }

  destroy(): void {
    this.detach();
    ipcMain.removeListener(`${VIEWPORT_CHANNEL}:input`, this.onInput);
    ipcMain.removeListener(`${VIEWPORT_CHANNEL}:ack`, this.onAck);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  }

  /** A frame the attached tab painted: its changed rectangle goes to the page; a full frame when it fell behind. */
  paint(tab: OffscreenTab, dirty: Rectangle, image: NativeImage): void {
    if (tab !== this.tab || image.isEmpty() || this.view.webContents.isDestroyed()) return;
    // At most a few frames in flight: when the page falls behind, skip and send the next one whole.
    if (this.inFlight.size > 3) {
      this.needFull = true;
      return;
    }
    const { width: fullW, height: fullH } = image.getSize();
    let x = Math.max(0, Math.min(dirty.x, fullW));
    let y = Math.max(0, Math.min(dirty.y, fullH));
    let w = Math.max(0, Math.min(dirty.width, fullW - x));
    let h = Math.max(0, Math.min(dirty.height, fullH - y));
    let px: Buffer;
    if (this.needFull || (x === 0 && y === 0 && w === fullW && h === fullH)) {
      this.needFull = false;
      x = 0; y = 0; w = fullW; h = fullH;
      px = image.toBitmap();
    } else {
      px = image.crop({ x, y, width: w, height: h }).toBitmap();
      if (px.length !== w * h * 4) { x = 0; y = 0; w = fullW; h = fullH; px = image.toBitmap(); }
    }
    const seq = ++this.seq;
    this.inFlight.add(seq);
    this.view.webContents.send(`${VIEWPORT_CHANNEL}:frame`, { seq, fullW, fullH, x, y, w, h }, px);
  }

  cursor(tab: OffscreenTab, type: string): void {
    if (tab === this.tab) this.send("cursor", type);
  }

  dragIntercepted(tab: OffscreenTab, data: unknown): void {
    if (tab !== this.tab) return;
    this.dragData = data;
    this.dragEntered = false;
  }

  private send(what: string, ...args: unknown[]): void {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.send(`${VIEWPORT_CHANNEL}:${what}`, ...args);
  }

  private input(ev: ViewportInput): void {
    const tab = this.tab;
    if (tab === undefined || tab.closed) return;
    const what = "type" in ev ? String(ev.type) : ev.kind;
    if (!this.took && (TAKING.has(what) || !("type" in ev))) {
      this.took = true;
      this.hooks.took(tab);
    }
    const c = tab.contents;
    if (this.dragData !== undefined && "type" in ev && (ev.type === "mouseMove" || ev.type === "mouseUp")) {
      void this.dragStep(tab, ev);
      return;
    }
    if ("type" in ev) {
      c.sendInputEvent(ev as unknown as MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent);
      return;
    }
    switch (ev.kind) {
      case "edit":
        ({ selectAll: () => c.selectAll(), copy: () => c.copy(), cut: () => c.cut(), undo: () => c.undo(), redo: () => c.redo() })[ev.cmd]?.();
        break;
      case "paste":
        // The tab's own paste, from the clipboard: the page gets a real paste event (S7 §7.2).
        c.paste();
        break;
      case "text":
        void c.insertText(ev.text);
        break;
      case "ime-set":
        void tab.debugger.internal("Input.imeSetComposition", { text: ev.text, selectionStart: ev.text.length, selectionEnd: ev.text.length }).catch(() => undefined);
        break;
      case "ime-commit":
        void tab.debugger.internal("Input.insertText", { text: ev.text }).catch(() => undefined);
        break;
    }
  }

  /** A drag the browser handed over: the person's moves become drag events, the release a drop. */
  private async dragStep(tab: OffscreenTab, ev: Record<string, unknown>): Promise<void> {
    const x = Number(ev.x), y = Number(ev.y);
    const data = this.dragData;
    try {
      if (ev.type === "mouseMove") {
        const type = this.dragEntered ? "dragOver" : "dragEnter";
        this.dragEntered = true;
        await tab.debugger.internal("Input.dispatchDragEvent", { type, x, y, data });
      } else {
        this.dragData = undefined;
        this.dragEntered = false;
        await tab.debugger.internal("Input.dispatchDragEvent", { type: "drop", x, y, data });
        tab.contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      }
    } catch {
      this.dragData = undefined;
      this.dragEntered = false;
    }
  }
}
