// `app.window.capture` (the daemon asks for the user's `clover-core app screenshot`): a picture of what one of the
// app's windows draws, by Electron's own capture of its page (`webContents.capturePage`). Never the screen: no
// `desktopCapturer`, no `screencapture`, nothing that needs Screen Recording or raises a privacy prompt. A window is
// never shown, focused, raised or resized for it: a hidden or minimised window is reported "not drawn", with no
// picture (an offscreen-rendered window, which paints while hidden, is captured).
//
// A window is its page plus the views laid over it (a plugin's web page part, the browser's live view, each a
// WebContentsView placed at a part's frame). Each visible view is captured too and composited over the page where it is
// placed, so the picture is what the window shows; the views are listed with whether each made it in.
//
// The frame list (`frames`) names each document by its origin, its part's mount id, its size and its visibility: ids and
// sizes only, never a page's text. A frame is asked with no user gesture, so the question can't count as the user's.
import type { AppCaptureParams, AppCaptureResult, CapturedWindow } from "@waifucave/clover-protocol";

type Rect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

/** The parts of Electron's NativeImage the capture uses. */
export interface ImageLike {
  isEmpty(): boolean;
  getSize(): Size;
  /** BGRA, 4 bytes a pixel, rows top to bottom. */
  toBitmap(): Buffer;
  toPNG(): Buffer;
  resize(size: Size): ImageLike;
}
export interface FrameLike {
  readonly origin: string;
  readonly url: string;
  readonly osProcessId: number;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}
export interface ContentsLike {
  isDestroyed(): boolean;
  capturePage(rect?: undefined, opts?: { stayHidden?: boolean; stayAwake?: boolean }): Promise<ImageLike>;
  readonly mainFrame: { readonly framesInSubtree: readonly FrameLike[] } | null;
}
export interface ViewLike {
  getBounds(): Rect;
  getVisible?(): boolean;
  readonly webContents?: ContentsLike;
}
/** The parts of a BrowserWindow the capture reads; nothing here shows, moves or resizes it. */
export interface WindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  getBounds(): Rect;
  getContentBounds(): Rect;
  readonly webContents: ContentsLike & { isOffscreen(): boolean };
  readonly contentView: { readonly children: readonly ViewLike[] };
}

export interface CaptureDeps {
  /** The windows by name: `main`, then each surface (`island`, `pill`…). */
  windows(): readonly { name: string; win: WindowLike }[];
  /** The scale factor of the display a window is on. */
  scaleOf(bounds: Rect): number;
  /** An image from a BGRA bitmap (nativeImage.createFromBitmap). */
  fromBitmap(bitmap: Buffer, size: Size): ImageLike;
  /** The largest PNG sent whole; a larger one is drawn again at half the size (default 5 MB, under a message's 8). */
  maxPngBytes?: number;
  /** How long a frame has to say its size. */
  frameTimeoutMs?: number;
}

const MAX_PNG_BYTES = 5_000_000;

/** A surface's name: its entry id (`clover/island#island` → `island`). */
export function surfaceName(id: string): string {
  return id.includes("#") ? id.slice(id.lastIndexOf("#") + 1) : id;
}

const timeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/** The frames of a page: origin, mount, surface, size and visibility, never text. */
async function framesOf(contents: ContentsLike, ms: number): Promise<NonNullable<CapturedWindow["frames"]>> {
  if (contents.isDestroyed() || contents.mainFrame === null) return [];
  return Promise.all(contents.mainFrame.framesInSubtree.map(async (f) => {
    let mount: string | undefined;
    let surface: string | undefined;
    let sealed: "card" | "placeholder" | undefined;
    try {
      const u = new URL(f.url);
      mount = u.searchParams.get("mount") ?? undefined;
      surface = u.searchParams.get("surface") ?? undefined;
      // A card's frame says which kind it is (its origin is opaque, its address holds its token): never more.
      if (u.protocol === "clover-sealed:") sealed = u.host === "placeholder" ? "placeholder" : "card";
    } catch {
      // A frame with no URL yet.
    }
    // No user gesture: the question must never count as the user's activation in that page.
    const r = await timeout(f.executeJavaScript("[innerWidth, innerHeight, document.visibilityState]", false), ms) as [number, number, string] | undefined;
    const sized = Array.isArray(r) && typeof r[0] === "number" && typeof r[1] === "number";
    return {
      origin: (f.origin || "null").slice(0, 512),
      ...(mount !== undefined ? { mount: mount.slice(0, 128) } : {}),
      ...(surface !== undefined ? { surface: surface.slice(0, 128) } : {}),
      ...(sized ? { width: Math.max(0, Math.round(r[0])), height: Math.max(0, Math.round(r[1])), visibility: String(r[2]).slice(0, 32) } : { silent: true }),
      ...(f.osProcessId > 0 ? { pid: f.osProcessId } : {}),
      ...(sealed !== undefined ? { sealed } : {}),
    };
  }));
}

/** Copies `top` (BGRA) over `base` (BGRA) at (x, y), clipped to the base. */
export function blit(base: Buffer, baseSize: Size, top: Buffer, topSize: Size, x: number, y: number): void {
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(baseSize.width, x + topSize.width), y1 = Math.min(baseSize.height, y + topSize.height);
  if (x1 <= x0 || y1 <= y0) return;
  for (let row = y0; row < y1; row++) {
    const from = ((row - y) * topSize.width + (x0 - x)) * 4;
    top.copy(base, (row * baseSize.width + x0) * 4, from, from + (x1 - x0) * 4);
  }
}

/** One window's picture and frames. `fit`: the picture drawn at exactly that many pixels (a render window's asked size,
 *  whatever the display's scale). */
export async function captureOne(deps: CaptureDeps, name: string, win: WindowLike, params: AppCaptureParams, fit?: Size): Promise<CapturedWindow> {
  const bounds = win.getBounds();
  const visible = win.isVisible() && !win.isMinimized();
  const offscreen = win.webContents.isOffscreen();
  const views = win.contentView.children.map((v) => ({ v, bounds: v.getBounds(), visible: (v.getVisible?.() ?? true) && v.webContents !== undefined && !v.webContents.isDestroyed() }));
  const frameMs = deps.frameTimeoutMs ?? 1_000;
  const frames = params.frames === true
    ? [...await framesOf(win.webContents, frameMs), ...(await Promise.all(views.filter((x) => x.visible).map((x) => framesOf(x.v.webContents!, frameMs)))).flat()].slice(0, 256)
    : undefined;
  const base: CapturedWindow = {
    name, bounds, scale: deps.scaleOf(bounds), visible, drawn: false,
    views: views.map((x) => ({ bounds: x.bounds, visible: x.visible, composited: false })),
    ...(frames !== undefined ? { frames } : {}),
  };
  if (!visible && !offscreen) return { ...base, note: win.isMinimized() ? "minimised: not drawn" : "hidden: not drawn" };
  if (params.image === false) return { ...base, drawn: true };
  const page = await win.webContents.capturePage(undefined, { stayHidden: true });
  if (page.isEmpty()) return { ...base, note: "nothing painted yet: not drawn" };
  const size = page.getSize();
  const content = win.getContentBounds();
  const ratio = content.width > 0 ? size.width / content.width : 1;
  // The views, over the page where they are placed (their bounds are in the window's content, in points).
  let image = page;
  const composited = base.views.map((v) => ({ ...v }));
  const shown = views.map((x, i) => ({ ...x, i })).filter((x) => x.visible && x.bounds.width > 0 && x.bounds.height > 0);
  if (shown.length > 0) {
    const bitmap = Buffer.from(page.toBitmap());
    for (const x of shown) {
      const shot = await x.v.webContents!.capturePage(undefined, { stayHidden: true }).catch(() => undefined);
      if (shot === undefined || shot.isEmpty()) continue;
      const want = { width: Math.round(x.bounds.width * ratio), height: Math.round(x.bounds.height * ratio) };
      const fit = shot.getSize().width === want.width && shot.getSize().height === want.height ? shot : shot.resize(want);
      blit(bitmap, size, fit.toBitmap(), fit.getSize(), Math.round(x.bounds.x * ratio), Math.round(x.bounds.y * ratio));
      composited[x.i]!.composited = true;
    }
    image = deps.fromBitmap(bitmap, size);
  }
  if (fit !== undefined && (image.getSize().width !== fit.width || image.getSize().height !== fit.height)) image = image.resize(fit);
  const max = deps.maxPngBytes ?? MAX_PNG_BYTES;
  let png = image.toPNG();
  let reduced = false;
  let pixels = image.getSize();
  if (png.length > max) {
    const half = image.resize({ width: Math.max(1, Math.round(pixels.width / 2)), height: Math.max(1, Math.round(pixels.height / 2)) });
    png = half.toPNG();
    pixels = half.getSize();
    reduced = true;
  }
  if (png.length > max) return { ...base, views: composited, drawn: true, note: `the picture is ${Math.round(png.length / 1e6)} MB even at half size: not sent` };
  return { ...base, views: composited, drawn: true, png: png.toString("base64"), pixels, ...(reduced ? { reduced } : {}) };
}

/** The answer to `app.window.capture`: one window (with its picture unless `image: false`), or `all` (every window,
 *  no picture). An unknown name is an error that lists the names there are. */
export async function captureWindows(deps: CaptureDeps, params: AppCaptureParams): Promise<AppCaptureResult> {
  const all = deps.windows().filter((w) => !w.win.isDestroyed());
  if (params.window === "all") return { windows: await Promise.all(all.map((w) => captureOne(deps, w.name, w.win, { ...params, image: false }))) };
  const one = all.find((w) => w.name === params.window);
  if (one === undefined) throw new Error(`no window named ${params.window} (there are: ${all.map((w) => w.name).join(", ") || "none"})`);
  return { windows: [await captureOne(deps, one.name, one.win, params)] };
}
