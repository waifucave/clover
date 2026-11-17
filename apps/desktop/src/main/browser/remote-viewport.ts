// The drawn half of `remote-view.ts` (lane HS): the same viewport page a local tab uses (`viewport-page/`), in an
// app-owned view over the panel's frame, drawing the engine's pictures of a tab the background host runs. Its partition
// is the viewport's own (no network, its page only), so lane E's guards leave it to this module as they do a local one.
import { BrowserWindow, ipcMain, nativeImage, WebContentsView, type IpcMainEvent } from "electron";
import { RealInput } from "./remote-input";
import type { RemoteTarget, RemoteViewport } from "./remote-view";
import { BROWSER_WEBRTC_POLICY, prepareViewportSession, VIEWPORT_PARTITION } from "./session";
import { VIEWPORT_CHANNEL, type ViewportAssets, type ViewportInput } from "./viewport";

export function electronRemoteViewport(assets: ViewportAssets, o: { log?: (line: string) => void; testPress?: boolean } = {}): RemoteViewport {
  prepareViewportSession(assets.html);
  const view = new WebContentsView({
    webPreferences: { partition: VIEWPORT_PARTITION, preload: assets.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false, spellcheck: false },
  });
  view.setBackgroundColor("#00000000");
  const wc = view.webContents;
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("will-frame-navigate", (e) => { if (!e.isMainFrame) e.preventDefault(); });
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.setWebRTCIPHandlingPolicy(BROWSER_WEBRTC_POLICY);
  const real = new RealInput();
  // What came into this view's own contents from the browser process (the hardware's input; no page or plugin posts here).
  wc.on("before-mouse-event", (_e, m) => {
    if (m.type === "mouseDown") real.saw("down");
    else if (m.type === "mouseUp") real.saw("up");
    else if (m.type === "mouseWheel") real.saw("wheel");
  });
  wc.on("before-input-event", (_e, i) => { if (i.type === "keyDown" || i.type === "keyUp") real.saw("key"); });
  let parent: BrowserWindow | undefined;
  let seq = 0;
  let listener: ((ev: ViewportInput, focused: boolean) => void) | undefined;
  const ready = wc.loadFile(assets.html).then(() => { if (!wc.isDestroyed()) wc.send(`${VIEWPORT_CHANNEL}:control`, true); }, () => undefined);
  const onInput = (e: IpcMainEvent, ev: ViewportInput): void => { if (e.sender === wc) listener?.(ev, wc.isFocused()); };
  ipcMain.on(`${VIEWPORT_CHANNEL}:input`, onInput);
  return {
    real,
    place(target: RemoteTarget) {
      const win = BrowserWindow.fromId(target.windowId);
      if (win === null || win.isDestroyed()) return;
      if (parent !== win) {
        if (parent !== undefined && !parent.isDestroyed()) parent.contentView.removeChildView(view);
        win.contentView.addChildView(view);
        parent = win;
      }
      const b = target.bounds;
      view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });
    },
    draw(frame) {
      void ready.then(() => {
        if (wc.isDestroyed()) return;
        const image = nativeImage.createFromBuffer(Buffer.from(frame.data, "base64"));
        if (image.isEmpty()) return;
        const { width, height } = image.getSize();
        if (seq === 0) o.log?.(`browser: the panel drew the host's tab (${width}x${height})`);
        wc.send(`${VIEWPORT_CHANNEL}:frame`, { seq: ++seq, fullW: width, fullH: height, x: 0, y: 0, w: width, h: height }, image.toBitmap());
      });
    },
    onInput(fn) { listener = fn; },
    ...(o.testPress === true ? {
      press(x: number, y: number) {
        if (wc.isDestroyed()) return;
        wc.focus();
        wc.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
      },
    } : {}),
    destroy() {
      ipcMain.removeListener(`${VIEWPORT_CHANNEL}:input`, onInput);
      if (parent !== undefined && !parent.isDestroyed()) parent.contentView.removeChildView(view);
      parent = undefined;
      if (!wc.isDestroyed()) wc.close();
    },
  };
}
