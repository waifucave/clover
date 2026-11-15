// `app.window.capture` on fake windows (capture.ts): the page's own picture with its views composited where they are
// placed, a hidden or minimised window reported not drawn and never shown, a picture too large drawn at half size,
// the frame list with ids and sizes only (asked with no user gesture), and an unknown name refused.
import { describe, expect, test } from "bun:test";
import { blit, captureWindows, surfaceName, type CaptureDeps, type ContentsLike, type FrameLike, type ImageLike, type WindowLike } from "../src/main/capture";

type Size = { width: number; height: number };

/** A BGRA image filled with one colour (or a given bitmap); `toPNG` is the bitmap's bytes with a marker in front. */
function image(size: Size, fill: [number, number, number, number] | Buffer, pngExtra = 0): ImageLike {
  const bitmap = Buffer.isBuffer(fill) ? Buffer.from(fill) : Buffer.alloc(size.width * size.height * 4);
  if (!Buffer.isBuffer(fill)) for (let i = 0; i < bitmap.length; i += 4) bitmap.set(fill, i);
  return {
    isEmpty: () => size.width === 0 || size.height === 0,
    getSize: () => size,
    toBitmap: () => Buffer.from(bitmap),
    toPNG: () => Buffer.concat([Buffer.from("PNG:"), bitmap, Buffer.alloc(pngExtra * size.width * size.height)]),
    resize: (s) => image(s, [9, 9, 9, 255], pngExtra),
  };
}

const forbidden = () => { throw new Error("the capture must never show, focus, raise, move or resize a window"); };

function frame(url: string, answer: unknown, origin = url.slice(0, url.indexOf("/", url.indexOf("//") + 2))): FrameLike & { gestures: unknown[] } {
  const gestures: unknown[] = [];
  return { origin, url, osProcessId: 77, gestures, executeJavaScript: async (_code: string, gesture?: boolean) => { gestures.push(gesture); if (answer === "hang") return new Promise(() => {}); return answer; } };
}

function contents(shot: ImageLike, frames: FrameLike[] = [], offscreen = false): ContentsLike & { isOffscreen(): boolean; captured: unknown[] } {
  const captured: unknown[] = [];
  return { captured, isDestroyed: () => false, isOffscreen: () => offscreen, mainFrame: { framesInSubtree: frames }, capturePage: async (_r, opts) => { captured.push(opts); return shot; } };
}

function window(o: { visible?: boolean; minimized?: boolean; content?: Size; page: ReturnType<typeof contents>; views?: { bounds: { x: number; y: number; width: number; height: number }; visible?: boolean; contents?: ContentsLike }[] }): WindowLike {
  const content = o.content ?? { width: 4, height: 2 };
  return {
    isDestroyed: () => false, isVisible: () => o.visible ?? true, isMinimized: () => o.minimized ?? false,
    getBounds: () => ({ x: 10, y: 20, ...content }), getContentBounds: () => ({ x: 10, y: 20, ...content }),
    webContents: o.page,
    contentView: { children: (o.views ?? []).map((v) => ({ getBounds: () => v.bounds, getVisible: () => v.visible ?? true, ...(v.contents ? { webContents: v.contents } : {}) })) },
    // What the capture must never touch.
    show: forbidden, showInactive: forbidden, focus: forbidden, moveTop: forbidden, setBounds: forbidden, setSize: forbidden, setPosition: forbidden, restore: forbidden,
  } as WindowLike;
}

function deps(windows: { name: string; win: WindowLike }[], extra: Partial<CaptureDeps> = {}): CaptureDeps {
  return { windows: () => windows, scaleOf: () => 2, fromBitmap: (b, s) => image(s, b), frameTimeoutMs: 50, ...extra };
}

describe("app.window.capture", () => {
  test("a visible window: its page at the display's scale, a web view composited where it is placed", async () => {
    // The page is 4x2 points at scale 2 (8x4 pixels, red); a view at (2,0) 2x1 points is blue (4x2 pixels).
    const page = contents(image({ width: 8, height: 4 }, [0, 0, 255, 255]));
    const view = contents(image({ width: 4, height: 2 }, [255, 0, 0, 255]));
    const r = await captureWindows(deps([{ name: "main", win: window({ page, views: [{ bounds: { x: 2, y: 0, width: 2, height: 1 }, contents: view }, { bounds: { x: 0, y: 1, width: 1, height: 1 }, visible: false, contents: contents(image({ width: 2, height: 2 }, [0, 255, 0, 255])) }] }) }]), { window: "main" });
    const w = r.windows[0]!;
    expect({ name: w.name, bounds: w.bounds, scale: w.scale, visible: w.visible, drawn: w.drawn, pixels: w.pixels, views: w.views }).toEqual({
      name: "main", bounds: { x: 10, y: 20, width: 4, height: 2 }, scale: 2, visible: true, drawn: true, pixels: { width: 8, height: 4 },
      views: [{ bounds: { x: 2, y: 0, width: 2, height: 1 }, visible: true, composited: true }, { bounds: { x: 0, y: 1, width: 1, height: 1 }, visible: false, composited: false }],
    });
    const bitmap = Buffer.from(w.png!, "base64").subarray(4);
    const px = (x: number, y: number) => [...bitmap.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
    expect([px(0, 0), px(4, 0), px(7, 1), px(4, 2), px(3, 0)]).toEqual([[0, 0, 255, 255], [255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 255, 255]]);
    // The page was asked to stay hidden: the capture never makes a page visible.
    expect(page.captured).toEqual([{ stayHidden: true }]);
  });

  test("a hidden or minimised window is not drawn and never captured; an offscreen one is", async () => {
    const hidden = contents(image({ width: 8, height: 4 }, [1, 1, 1, 255]));
    const small = contents(image({ width: 8, height: 4 }, [1, 1, 1, 255]));
    const off = contents(image({ width: 8, height: 4 }, [1, 2, 3, 255]), [], true);
    const d = deps([{ name: "main", win: window({ visible: false, page: hidden }) }, { name: "island", win: window({ minimized: true, page: small }) }, { name: "pill", win: window({ visible: false, page: off }) }]);
    const main = (await captureWindows(d, { window: "main" })).windows[0]!;
    const island = (await captureWindows(d, { window: "island" })).windows[0]!;
    const pill = (await captureWindows(d, { window: "pill" })).windows[0]!;
    expect([main, island].map((w) => ({ drawn: w.drawn, visible: w.visible, png: w.png, note: w.note }))).toEqual([
      { drawn: false, visible: false, png: undefined, note: "hidden: not drawn" },
      { drawn: false, visible: false, png: undefined, note: "minimised: not drawn" },
    ]);
    expect([hidden.captured, small.captured]).toEqual([[], []]);
    expect({ drawn: pill.drawn, visible: pill.visible, has: typeof pill.png }).toEqual({ drawn: true, visible: false, has: "string" });
  });

  test("a picture over the limit is drawn at half size; still over, it is not sent", async () => {
    const big = contents(image({ width: 8, height: 4 }, [5, 5, 5, 255], 10));
    const r = (await captureWindows(deps([{ name: "main", win: window({ page: big }) }], { maxPngBytes: 300 }), { window: "main" })).windows[0]!;
    expect({ reduced: r.reduced, pixels: r.pixels, sent: typeof r.png }).toEqual({ reduced: true, pixels: { width: 4, height: 2 }, sent: "string" });
    const r2 = (await captureWindows(deps([{ name: "main", win: window({ page: big }) }], { maxPngBytes: 10 }), { window: "main" })).windows[0]!;
    expect({ drawn: r2.drawn, png: r2.png }).toEqual({ drawn: true, png: undefined });
    expect(r2.note).toContain("not sent");
  });

  test("frames: origin, mount, size and visibility, asked with no user gesture; a silent frame is said so; no text", async () => {
    const shell = frame("clover-core://app/?surface=main", [1280, 820, "visible"]);
    const part = frame("clover-plugin://clover/?mount=ab12", [300, 200, "hidden"]);
    const hung = frame("clover-plugin://acme/?mount=cd34", "hang");
    const page = contents(image({ width: 8, height: 4 }, [0, 0, 0, 255]), [shell, part, hung]);
    const r = (await captureWindows(deps([{ name: "main", win: window({ page }) }]), { window: "main", frames: true, image: false })).windows[0]!;
    expect(r.frames).toEqual([
      { origin: "clover-core://app", surface: "main", width: 1280, height: 820, visibility: "visible", pid: 77 },
      { origin: "clover-plugin://clover", mount: "ab12", width: 300, height: 200, visibility: "hidden", pid: 77 },
      { origin: "clover-plugin://acme", mount: "cd34", silent: true, pid: 77 },
    ]);
    expect([...shell.gestures, ...part.gestures, ...hung.gestures]).toEqual([false, false, false]);
    expect(r.png).toBeUndefined();
    expect(page.captured).toEqual([]);
  });

  test("all: every window, no pictures; an unknown name lists the ones there are", async () => {
    const a = contents(image({ width: 8, height: 4 }, [0, 0, 0, 255]));
    const b = contents(image({ width: 8, height: 4 }, [0, 0, 0, 255]));
    const d = deps([{ name: "main", win: window({ page: a }) }, { name: surfaceName("clover/island#island"), win: window({ visible: false, page: b }) }]);
    const all = await captureWindows(d, { window: "all" });
    expect(all.windows.map((w) => ({ name: w.name, drawn: w.drawn, png: w.png }))).toEqual([{ name: "main", drawn: true, png: undefined }, { name: "island", drawn: false, png: undefined }]);
    expect([a.captured, b.captured]).toEqual([[], []]);
    await expect(captureWindows(d, { window: "pill" })).rejects.toThrow("no window named pill (there are: main, island)");
  });

  test("blit clips a view that runs past the page's edge", () => {
    const base = Buffer.alloc(2 * 2 * 4);
    blit(base, { width: 2, height: 2 }, Buffer.alloc(2 * 2 * 4, 7), { width: 2, height: 2 }, 1, 1);
    expect([...base]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 7, 7, 7]);
  });
});
