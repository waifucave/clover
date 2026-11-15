// `app.window.render` with a fake render window and shell (render.ts): a place is drawn in a window of its own at the
// size asked, by the route the sidebar uses, captured once it shows and closed after (or at the timeout); Settings is
// never drawn; `window` is the user's main window as it is, never while Settings shows there; one render at a time.
import { describe, expect, test } from "bun:test";
import type { ShellState } from "@waifucave/clover-plugin-sdk";
import type { ShellAct } from "@waifucave/clover-plugin-sdk/ui/bridge";
import type { CapturedWindow } from "@waifucave/clover-protocol";
import { RENDER_TARGETS, RenderQueue, renderPlace, type RenderDeps, type RenderHandle } from "../src/main/render";

const known = { bots: ["alpha", "luna"], pages: ["ex-timeline", "reel"] };
const state = (tab: ShellState["tab"], extra: Partial<ShellState> = {}): ShellState => ({ tab, ...(tab.kind === "bot" ? { bot: tab.id } : {}), sidebar: { collapsed: false, side: "bots" }, panels: { open: [], available: [] }, safeArea: { left: 80, top: 44 }, ...extra });
const shot = (size: { width: number; height: number }, drawn = true): CapturedWindow => ({ name: "render", bounds: { x: 0, y: 0, ...size }, scale: 1, visible: false, drawn, ...(drawn ? { png: "UE5H", pixels: size } : { note: "nothing painted yet: not drawn" }), views: [], frames: [{ origin: "clover-core://app", width: size.width, height: size.height, visibility: "visible" }] });

function fake(o: { never?: boolean; openFails?: boolean; hang?: boolean; settingsInRender?: boolean; settingsAtCapture?: boolean; main?: ShellState; mainDrawn?: boolean } = {}) {
  const log: string[] = [];
  const opened: { size: { width: number; height: number }; acts: ShellAct[]; closed: boolean }[] = [];
  const deps: RenderDeps = {
    known: () => known,
    open: async (size, early) => {
      log.push(`open ${size.width}x${size.height}`);
      if (o.openFails) throw new Error("no GPU");
      if (o.hang) {
        early?.(() => log.push("destroyed while loading"));
        return new Promise<RenderHandle>(() => {});
      }
      const w = { size, acts: [] as ShellAct[], closed: false };
      opened.push(w);
      let now: ShellState | undefined;
      let checks = 0;
      let frames = 0;
      const h: RenderHandle = {
        state: () => {
          // The shell reports its first place after a check or two, then what the act asked for.
          if (++checks >= 2 && now === undefined) now = state({ kind: "bot", id: "alpha" });
          return now;
        },
        act: (a) => {
          w.acts.push(a);
          log.push(`act ${JSON.stringify(a)}`);
          if (o.never || a.kind !== "go") return;
          const t = a.target as Record<string, string>;
          now = o.settingsInRender ? state({ kind: "app", id: t.app ?? "x" }, { dialog: "settings" }) : t.app ? state({ kind: "app", id: t.app }) : t.bot ? state({ kind: "bot", id: t.bot }) : t.page ? state({ kind: t.page as "plugins" }) : state({ kind: "agent", id: "c1" }, { sidebar: { collapsed: false, side: "code" } });
        },
        // Frames keep coming for a few reads after the place shows (history, a card's frames), then stop.
        frameCount: () => (frames = Math.min(frames + 1, 5)),
        capture: async () => {
          log.push(`capture at ${frames} frames`);
          if (o.settingsAtCapture && now !== undefined) now = { ...now, dialog: "settings" };
          return shot(size);
        },
        console: () => [{ plugin: "reel", level: "error", message: "TypeError: x is undefined" }],
        close: () => { w.closed = true; log.push("close"); },
      };
      return h;
    },
    look: async () => { log.push("look main"); return { ...shot({ width: 1280, height: 820 }, o.mainDrawn ?? true), name: "main", visible: o.mainDrawn ?? true, ...(o.mainDrawn === false ? { note: "hidden: not drawn" } : {}) }; },
    mainState: () => o.main,
    shrink: (_png, edge) => ({ png: "c21hbGw=", width: edge, height: Math.round(edge * 1640 / 2560) }),
    timeoutMs: 300,
    settleMs: 0,
    quietMs: 5,
    sleep: async () => {},
  };
  return { deps, log, opened };
}

describe("app.window.render", () => {
  test("a plugin's page is drawn in a window of its own at the size asked, by the sidebar's route, then closed", async () => {
    const f = fake();
    const r = await renderPlace(f.deps, { target: "app:reel", size: { width: 860, height: 820 }, frames: true });
    expect(r).toMatchObject({ target: "app:reel", size: { width: 860, height: 820 }, shown: true, drawn: true, png: "UE5H", pixels: { width: 860, height: 820 }, where: { tab: { kind: "app", id: "reel" } } });
    expect(r.frames?.length).toBe(1);
    expect(r.console).toEqual([{ plugin: "reel", level: "error", message: "TypeError: x is undefined" }]);
    expect(f.log).toEqual(["open 860x820", `act ${JSON.stringify({ kind: "go", target: { app: "reel" } })}`, "capture at 5 frames", "close"]);
    expect(r.preview).toBeUndefined();
  });

  test("each target is the shell's own act: a bot's tab, Plugins, Archive, the coding side", async () => {
    for (const [target, act] of [["bot:luna", { bot: "luna" }], ["plugins", { page: "plugins" }], ["archive", { page: "archive" }], ["code", { side: "code" }], ["ex-timeline", { app: "ex-timeline" }]] as const) {
      const f = fake();
      const r = await renderPlace(f.deps, { target, size: { width: 1280, height: 820 } });
      expect({ target, shown: r.shown, acts: f.opened[0]!.acts, closed: f.opened[0]!.closed }).toEqual({ target, shown: true, acts: [{ kind: "go", target: act } as ShellAct], closed: true });
    }
  });

  test("Settings is never drawn, and an unknown place is refused with the render's targets: no window opens", async () => {
    const f = fake();
    for (const target of ["settings", "settings:devices"]) expect(await renderPlace(f.deps, { target, size: { width: 1280, height: 820 } })).toMatchObject({ shown: false, drawn: false, reason: "Settings isn't drawn for a bot" });
    const r = await renderPlace(f.deps, { target: "app:nope", size: { width: 1280, height: 820 } });
    expect(r.shown).toBe(false);
    expect(r.reason).toContain(`targets: ${RENDER_TARGETS}; bots: alpha, luna; pages: ex-timeline, reel`);
    expect(f.log).toEqual([]);
  });

  test("a place that never shows says so after the time, and its window is closed", async () => {
    const f = fake({ never: true });
    const r = await renderPlace(f.deps, { target: "app:reel", size: { width: 1280, height: 820 } });
    expect({ shown: r.shown, reason: r.reason, closed: f.opened[0]!.closed }).toEqual({ shown: false, reason: "the page reel didn't show within 0 s", closed: true });
    expect(f.log.some((l) => l.startsWith("capture"))).toBe(false);
  });

  test("a render window whose page never loads is destroyed at the timeout", async () => {
    const f = fake({ hang: true });
    const r = await renderPlace({ ...f.deps, timeoutMs: 10 }, { target: "app:reel", size: { width: 1280, height: 820 } });
    expect({ shown: r.shown, reason: r.reason }).toEqual({ shown: false, reason: "the page reel didn't draw within 0 s" });
    expect(f.log).toEqual(["open 1280x820", "destroyed while loading"]);
  }, 10_000);

  test("Settings showing in the render window itself is never captured", async () => {
    // The shell reports the place with Settings over it: the place counts as not shown (no dialog over it), so it times out.
    const f = fake({ settingsInRender: true });
    const r = await renderPlace(f.deps, { target: "app:reel", size: { width: 1280, height: 820 } });
    expect(r.shown).toBe(false);
    expect(f.log.some((l) => l.startsWith("capture"))).toBe(false);
    // Settings opening in it during the capture: the picture isn't handed over.
    const g = fake({ settingsAtCapture: true });
    expect(await renderPlace(g.deps, { target: "app:reel", size: { width: 1280, height: 820 } })).toEqual({ target: "app:reel", size: { width: 1280, height: 820 }, shown: false, drawn: false, reason: "Settings showed in the render window: it isn't captured for a bot" });
    expect(g.opened[0]!.closed).toBe(true);
  });

  test("a render window that can't open says why", async () => {
    const f = fake({ openFails: true });
    const r = await renderPlace(f.deps, { target: "app:reel", size: { width: 1280, height: 820 } });
    expect({ shown: r.shown, reason: r.reason }).toEqual({ shown: false, reason: "the render window failed: no GPU" });
  });

  test("a large picture comes with a smaller copy for the model", async () => {
    const f = fake();
    const r = await renderPlace(f.deps, { target: "app:reel", size: { width: 2560, height: 1640 } });
    expect(r.preview).toEqual({ png: "c21hbGw=", width: 1568, height: 1005 });
    expect(r.png).toBe("UE5H");
  });

  test("window: the user's own window as it is, never while Settings shows over it, and hidden is not drawn", async () => {
    const at = state({ kind: "bot", id: "alpha" });
    const ok = fake({ main: at });
    expect(await renderPlace(ok.deps, { target: "window", size: { width: 1280, height: 820 } })).toMatchObject({ shown: true, drawn: true, png: "UE5H", where: { tab: { kind: "bot", id: "alpha" } } });
    expect(ok.log).toEqual(["look main"]);
    const settings = fake({ main: { ...at, dialog: "settings" } });
    expect(await renderPlace(settings.deps, { target: "window", size: { width: 1280, height: 820 } })).toMatchObject({ shown: false, drawn: false, reason: "Settings is showing in the user's window: it isn't captured for a bot" });
    expect(settings.log).toEqual([]);
    // A window whose shell hasn't said where it is might show Settings: fail closed.
    const unknown = fake();
    expect(await renderPlace(unknown.deps, { target: "window", size: { width: 1280, height: 820 } })).toMatchObject({ shown: false, drawn: false, reason: "the user's window hasn't said what it shows: it isn't captured for a bot" });
    expect(unknown.log).toEqual([]);
    const hidden = fake({ main: at, mainDrawn: false });
    expect(await renderPlace(hidden.deps, { target: "window", size: { width: 1280, height: 820 } })).toMatchObject({ shown: false, drawn: false, reason: "the user's window is hidden: not drawn" });
  });

  test("one render at a time: the second opens only after the first closed", async () => {
    const q = new RenderQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = q.run(async () => { order.push("first in"); await new Promise<void>((r) => { release = r; }); order.push("first out"); });
    const second = q.run(async () => { order.push("second in"); });
    while (order.length === 0) await new Promise((r) => setTimeout(r, 1));
    expect({ order: [...order], waiting: q.waiting }).toEqual({ order: ["first in"], waiting: 2 });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second in"]);
    // A render that failed doesn't stop the next.
    await q.run(async () => { throw new Error("x"); }).catch(() => undefined);
    expect(await q.run(async () => "next")).toBe("next");
  });
});
