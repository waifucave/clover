// The host's brokers (S9 §3): menus as data placed by the core, drags as grants between parts, and where a surface
// window sits and takes clicks.
import { describe, expect, test } from "bun:test";
import { HANG_COMPOSITOR_MS, HANG_RESTART_MS, HangWatch, hangVerdict } from "../src/main/hang";
import { MENU_INPUT_WINDOW_MS, MenuGate, PointerLog, VIEW_USE_WINDOW_MS, THIRD_PARTY_SURFACE_MAX, ViewFrames, mayOpen, mayPlaceView, openTarget, surfaceBounds, viewRect, checkDragOffer, checkMenu, checkRegions, inRegions, mayClaim, menuPoint, surfaceMayFloat, surfacePlacement, surfaceSize, MENU_LIMITS } from "../src/main/ui/brokers";

describe("the menu broker", () => {
  test("a menu is data: items with ids and plain labels, separators, checkboxes and submenus", () => {
    const r = checkMenu({ items: [{ id: "a", label: "Copy" }, { type: "separator" }, { id: "b", label: "Wrap", type: "checkbox", checked: true }, { label: "More", submenu: [{ id: "c", label: "Line\nbreak" }] }] });
    expect(r).toEqual({ items: [{ id: "a", label: "Copy", enabled: true }, { type: "separator" }, { id: "b", label: "Wrap", enabled: true, type: "checkbox", checked: true }, { label: "More", enabled: true, submenu: [{ id: "c", label: "Line break", enabled: true }] }] });
  });

  test("refused: no items, no label, no id, a repeated id, too many, too deep", () => {
    expect(checkMenu({ items: [] })).toHaveProperty("error");
    expect(checkMenu({ items: [{ id: "a" }] })).toHaveProperty("error");
    expect(checkMenu({ items: [{ label: "x" }] })).toHaveProperty("error");
    expect(checkMenu({ items: [{ id: "a", label: "x" }, { id: "a", label: "y" }] })).toHaveProperty("error");
    expect(checkMenu({ items: Array.from({ length: MENU_LIMITS.items + 1 }, (_, i) => ({ id: `i${i}`, label: "x" })) })).toHaveProperty("error");
    expect(checkMenu({ items: [{ label: "1", submenu: [{ label: "2", submenu: [{ label: "3", submenu: [{ id: "x", label: "4" }] }] }] }] })).toHaveProperty("error");
    expect(checkMenu("menu")).toHaveProperty("error");
  });

  test("the point is clamped inside the asking frame, then offset by each frame's place, outermost first", () => {
    const chain = [{ x: 0, y: 0, width: 1280, height: 820 }, { x: 380, y: 760, width: 760, height: 56 }];
    expect(menuPoint({ x: 7, y: 5 }, chain)).toEqual({ x: 387, y: 765 });
    // A frame can't put its menu outside itself.
    expect(menuPoint({ x: -500, y: 9999 }, chain)).toEqual({ x: 380, y: 816 });
    expect(menuPoint({ x: Number.NaN, y: 1 }, chain)).toEqual({ x: 380, y: 761 });
    expect(menuPoint({ x: 1, y: 1 }, [])).toBeUndefined();
  });
});

describe("the menu gate", () => {
  test("a menu opens only right after the user's input in its window, uses that input up, and one at a time", () => {
    let now = 1_000;
    const gate = new MenuGate(() => now);
    expect(gate.take(1)).toMatchObject({ ok: false });
    gate.input(1);
    expect(gate.take(2)).toMatchObject({ ok: false });
    expect(gate.take(1)).toEqual({ ok: true });
    // One click, one menu; and none while one is open.
    gate.input(1);
    expect(gate.take(1)).toMatchObject({ ok: false, reason: "another menu is open" });
    gate.done();
    expect(gate.take(1)).toEqual({ ok: true });
    gate.done();
    expect(gate.take(1)).toMatchObject({ ok: false });
    gate.input(1);
    now += MENU_INPUT_WINDOW_MS + 1;
    expect(gate.take(1)).toMatchObject({ ok: false });
  });
});

describe("the drag broker", () => {
  test("an offer: a known kind, data that fits, from a plugin that may hand it out", () => {
    expect(checkDragOffer({ type: "text/plain", data: "hi" }, new Set())).toEqual({ type: "text/plain", data: "hi" });
    expect(checkDragOffer({ type: "application/x-clover-file", data: { path: "a" } }, new Set())).toHaveProperty("error");
    expect(checkDragOffer({ type: "application/x-clover-file", data: { path: "a" } }, new Set(["files"]))).toEqual({ type: "application/x-clover-file", data: { path: "a" } });
    expect(checkDragOffer({ type: "application/x-other", data: 1 }, new Set())).toHaveProperty("error");
    expect(checkDragOffer({ type: "text/plain", data: "x".repeat(300_000) }, new Set())).toHaveProperty("error");
  });

  test("a claim: only by a plugin that may hold that kind", () => {
    expect(mayClaim("text/plain", new Set())).toBe(true);
    expect(mayClaim("application/x-clover-message", new Set())).toBe(false);
    expect(mayClaim("application/x-clover-message", new Set(["conversation.read"]))).toBe(true);
    expect(mayClaim("unknown/kind", new Set(["files"]))).toBe(false);
  });
});

describe("surface windows", () => {
  const display = { x: 0, y: 0, width: 1512, height: 982 };
  const workArea = { x: 0, y: 33, width: 1512, height: 949 };

  test("the island at the top centre, the pill at the bottom centre, others centred, or where the entry says", () => {
    expect(surfacePlacement({ surface: "island", size: { width: 400, height: 80 }, display, workArea })).toEqual({ x: 556, y: 0, width: 400, height: 80 });
    expect(surfacePlacement({ surface: "pill", size: { width: 400, height: 60 }, display, workArea })).toEqual({ x: 556, y: 898, width: 400, height: 60 });
    expect(surfacePlacement({ surface: "x", size: { width: 400, height: 300 }, display, workArea })).toEqual({ x: 556, y: 358, width: 400, height: 300 });
    expect(surfacePlacement({ surface: "x", placement: "top-center", size: { width: 400, height: 80 }, display, workArea }).y).toBe(0);
  });

  test("click regions: rects inside the window, checked; the cursor's place decides", () => {
    const regions = checkRegions([{ x: -10, y: 0, width: 50, height: 20 }, { x: 0, y: 0, width: "w", height: 1 }, { x: 300, y: 0, width: 500, height: 40 }], { width: 360, height: 120 });
    expect(regions).toEqual([{ x: 0, y: 0, width: 50, height: 20 }, { x: 300, y: 0, width: 60, height: 40 }]);
    expect(inRegions({ x: 10, y: 10 }, regions)).toBe(true);
    expect(inRegions({ x: 100, y: 10 }, regions)).toBe(false);
    expect(checkRegions("everywhere", { width: 1, height: 1 })).toEqual([]);
  });
});

describe("surfaces outside the clover tree", () => {
  const workArea = { width: 1512, height: 949 };
  test("only the clover tree's surfaces float above everything", () => {
    expect(surfaceMayFloat("clover/island")).toBe(true);
    expect(surfaceMayFloat("fixture-surface")).toBe(false);
    expect(surfaceMayFloat("cloverx/island")).toBe(false);
  });

  test("sizes stay inside the work area, and a third party's inside a smaller box", () => {
    expect(surfaceSize({ width: 5000, height: 5000 }, { width: 100, height: 100 }, { trusted: true, workArea })).toEqual({ width: 1512, height: 949 });
    expect(surfaceSize({ width: 5000, height: 5000 }, { width: 100, height: 100 }, { trusted: false, workArea })).toEqual(THIRD_PARTY_SURFACE_MAX);
    expect(surfaceSize({ width: 1, height: "x" }, { width: 100, height: 70 }, { trusted: false, workArea })).toEqual({ width: 40, height: 70 });
    expect(surfaceSize({ height: 120 }, { width: 360, height: 40 }, { trusted: false, workArea: { width: 300, height: 100 } })).toEqual({ width: 300, height: 100 });
  });
});

describe("lane G's surface host: a whole place on the screen, and places the app opens", () => {
  const display = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } };
  test("a surface's bounds stay on its display; a third party's in the work area and its smaller box", () => {
    expect(surfaceBounds({ x: 556, y: 0, width: 400, height: 80 }, display, true)).toEqual({ x: 556, y: 0, width: 400, height: 80 });
    expect(surfaceBounds({ x: 1400, y: -50, width: 400, height: 80 }, display, true)).toEqual({ x: 1112, y: 0, width: 400, height: 80 });
    expect(surfaceBounds({ x: 556, y: 0, width: 4000, height: 80 }, display, false)).toEqual({ x: 556, y: 37, width: 800, height: 80 });
    expect(surfaceBounds({ x: 0, y: 0, width: "w", height: 1 }, display, true)).toBeUndefined();
  });

  test("Settings at a section and an item, or a bot's tab; nothing else, and only for the clover tree", () => {
    expect(openTarget({ kind: "settings", section: "devices", item: "laptop" })).toEqual({ kind: "settings", section: "devices", item: "laptop" });
    expect(openTarget({ kind: "settings" })).toEqual({ kind: "settings" });
    expect(openTarget({ kind: "settings", section: "Devices!" })).toBeUndefined();
    expect(openTarget({ kind: "bot", bot: "alpha" })).toEqual({ kind: "bot", bot: "alpha" });
    expect(openTarget({ kind: "url", url: "https://example.com" })).toBeUndefined();
    expect(mayOpen("clover/island")).toBe(true);
    expect(mayOpen("fixture-surface")).toBe(false);
  });
});

describe("native views (the Clover Browser's live view, ruling R8)", () => {
  test("a view's frame is clipped to the part's own frame, then placed in the window", () => {
    const chain = [{ x: 0, y: 0, width: 1280, height: 820 }, { x: 900, y: 45, width: 380, height: 775 }];
    expect(viewRect({ x: 0, y: 80, width: 380, height: 695 }, chain)).toEqual({ x: 900, y: 125, width: 380, height: 695 });
    // A part can't put a view outside itself.
    expect(viewRect({ x: -900, y: -45, width: 1280, height: 820 }, chain)).toEqual({ x: 900, y: 45, width: 380, height: 775 });
    expect(viewRect({ x: 400, y: 0, width: 10, height: 10 }, chain)).toBeUndefined();
    expect(mayPlaceView(new Set(["browser"]))).toBe(true);
    expect(mayPlaceView(new Set())).toBe(false);
  });

  test("the view follows the place the person used last; a new place takes it; a place gone gives it back", () => {
    const seen: [string, unknown][] = [];
    const v = new ViewFrames((name, t) => seen.push([name, t]));
    const a = { x: 900, y: 125, width: 380, height: 695 };
    const b = { x: 500, y: 125, width: 380, height: 695 };
    v.report("browser", "m1", 1, a, false);
    expect(v.target("browser")).toEqual({ windowId: 1, bounds: a });
    v.report("browser", "m2", 1, b, false);
    expect(v.target("browser")).toEqual({ windowId: 1, bounds: b });
    // Moving the first panel doesn't take the view back; using it does.
    v.report("browser", "m1", 1, { ...a, y: 130 }, false);
    expect(v.target("browser")?.bounds).toEqual(b);
    v.report("browser", "m1", 1, { ...a, y: 130 }, true);
    expect(v.target("browser")?.bounds).toEqual({ ...a, y: 130 });
    // The panel with the view hides: the view goes nowhere, not to the other panel.
    v.report("browser", "m1", 1, undefined, false);
    expect(v.target("browser")).toBeUndefined();
    v.drop("m1");
    expect(v.target("browser")?.bounds).toEqual(b);
    v.dropWindow(1);
    expect(v.target("browser")).toBeUndefined();
    expect(seen.map(([, t]) => (t === undefined ? "none" : (t as { bounds: { x: number } }).bounds.x))).toEqual([900, 500, 900, "none", 500, "none"]);
  });
});

describe("a hang restarts the app into safe mode (ruling R9)", () => {
  test("a window unresponsive for 15 s restarts it once; answering again in time doesn't", () => {
    const timers = new Map<number, () => void>();
    let n = 0;
    const fake = { set: ((fn: () => void) => { timers.set(++n, fn); return n; }) as unknown as typeof setTimeout, clear: ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout };
    const restarted: number[] = [];
    const w = new HangWatch((id) => restarted.push(id), fake);
    w.unresponsive(1);
    w.responsive(1);
    expect(timers.size).toBe(0);
    w.unresponsive(1);
    w.unresponsive(2);
    for (const fn of [...timers.values()]) fn();
    expect(restarted).toEqual([1]);
  });
});

describe("a window that stays unresponsive while its documents answer (the GPU or compositor case)", () => {
  test("it gets the longer window; a root that stops answering meanwhile brings the restart sooner, never later", () => {
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let n = 0;
    const fake = { set: ((fn: () => void, ms: number) => { timers.set(++n, { fn, ms }); return n; }) as unknown as typeof setTimeout, clear: ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout };
    const restarted: number[] = [];
    const w = new HangWatch((id) => restarted.push(id), fake);
    w.unresponsive(1, HANG_COMPOSITOR_MS, 0);
    expect([...timers.values()].map((t) => t.ms)).toEqual([HANG_COMPOSITOR_MS]);
    // The root then stops answering: the sooner end wins.
    w.unresponsive(1, HANG_RESTART_MS, 1_000);
    expect([...timers.values()].map((t) => t.ms)).toEqual([HANG_RESTART_MS]);
    // A later "longer" never pushes it back.
    w.unresponsive(1, HANG_COMPOSITOR_MS, 2_000);
    expect([...timers.values()].map((t) => t.ms)).toEqual([HANG_RESTART_MS]);
    // Coming back in time cancels it; staying away restarts the app, once.
    w.responsive(1);
    expect(timers.size).toBe(0);
    w.unresponsive(1, HANG_COMPOSITOR_MS, 3_000);
    for (const t of [...timers.values()]) t.fn();
    expect(restarted).toEqual([1]);
  });

  test("every document answering means the longer window, not a restart now; a silent root means the short one", () => {
    expect(hangVerdict([{ kind: "root", osPid: 10, answered: true }, { kind: "layer", osPid: 20, answered: true }], 1)).toEqual({ restart: false, later: true, kill: [] });
    expect(hangVerdict([{ kind: "root", osPid: 10, answered: false }], 1)).toEqual({ restart: true, later: false, kill: [] });
    expect(HANG_COMPOSITOR_MS).toBe(60_000);
  });
});

describe("which document hung (the E-M1 check's should-fix)", () => {
  test("a plugin layer that doesn't answer has its process stopped; only a silent core root restarts the app", () => {
    expect(hangVerdict([{ kind: "root", osPid: 10, answered: true }, { kind: "layer", osPid: 20, answered: true }, { kind: "layer", osPid: 30, answered: false }, { kind: "layer", osPid: 30, answered: false }], 1)).toEqual({ restart: false, later: true, kill: [30] });
    expect(hangVerdict([{ kind: "root", osPid: 10, answered: false }, { kind: "layer", osPid: 20, answered: true }], 1)).toEqual({ restart: true, later: false, kill: [] });
    // Never the app's own process, nor one that holds a core root, nor a frame with no process known.
    expect(hangVerdict([{ kind: "root", osPid: 10, answered: true }, { kind: "layer", osPid: 10, answered: false }, { kind: "layer", osPid: 1, answered: false }, { kind: "layer", answered: false }], 1)).toEqual({ restart: false, later: true, kill: [] });
  });
});

describe("a view's use counts only after main saw the mouse-down there", () => {
  test("a mouse-down inside the view's place, just before; not elsewhere, not long ago, not in another window", () => {
    let now = 0;
    const p = new PointerLog(() => now);
    const rect = { x: 900, y: 125, width: 380, height: 695 };
    expect(p.pressedIn(1, rect)).toBe(false);
    p.down(1, 950, 300);
    expect(p.pressedIn(1, rect)).toBe(true);
    expect(p.pressedIn(2, rect)).toBe(false);
    expect(p.pressedIn(1, { ...rect, x: 0, width: 100 })).toBe(false);
    now += VIEW_USE_WINDOW_MS + 1;
    expect(p.pressedIn(1, rect)).toBe(false);
  });
});
