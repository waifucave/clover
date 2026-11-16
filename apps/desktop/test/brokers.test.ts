// The host's brokers (S9 §3): menus as data placed by the core, drags as grants between parts, and where a surface
// window sits and takes clicks.
import { describe, expect, test } from "bun:test";
import { HANG_COMPOSITOR_MS, HANG_RESTART_MS, HangWatch, hangVerdict } from "../src/main/hang";
import { ClickThrough, frameGesture, MENU_INPUT_WINDOW_MS, MenuGate, SEND_INPUT_WINDOW_MS, SEND_HOLD_MAX_MS, SEND_RELEASE_WINDOW_MS, SendGate, sendImages, sendTarget, PointerLog, VIEW_USE_WINDOW_MS, THIRD_PARTY_SURFACE_MAX, ViewFrames, mayOpen, openRefusal, PRESS_REPORT_MS, mayPlaceView, openTarget, surfaceBounds, viewRect, checkDragOffer, checkMenu, checkRegions, inRegions, mayClaim, menuPoint, surfacePlacement, surfaceSize, MENU_LIMITS } from "../src/main/ui/brokers";

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
    expect(checkDragOffer({ type: "application/x-moss-file", data: { path: "a" } }, new Set())).toHaveProperty("error");
    expect(checkDragOffer({ type: "application/x-other", data: 1 }, new Set())).toHaveProperty("error");
    expect(checkDragOffer({ type: "text/plain", data: "x".repeat(300_000) }, new Set())).toHaveProperty("error");
    expect(checkDragOffer({ type: "text/plain", data: { not: "text" } }, new Set())).toHaveProperty("error");
  });

  test("the core mints a file's grant: its place in the folder tree, named by the core, nothing the plugin added", () => {
    const files = new Set(["files"]);
    expect(checkDragOffer({ type: "application/x-moss-file", data: { path: "home/Laptop/notes/todo.md", name: "photo.png", size: 3, bytes: "AAAA" } }, files))
      .toEqual({ type: "application/x-moss-file", data: { path: "home/Laptop/notes/todo.md", name: "todo.md" } });
    expect(checkDragOffer({ type: "application/x-moss-file", data: "bots/alpha/memory/a.md" }, files)).toEqual({ type: "application/x-moss-file", data: { path: "bots/alpha/memory/a.md", name: "a.md" } });
    // Not a place in the tree: a plain path, a way out, an empty segment, the tree's root itself.
    for (const bad of ["a", "/etc/passwd", "home/Laptop/../../etc", "home//x", "home/./x", "home", "C:\\Users"]) {
      expect(checkDragOffer({ type: "application/x-moss-file", data: { path: bad } }, files), bad).toHaveProperty("error");
    }
  });

  test("and a message's: its session and seq", () => {
    const read = new Set(["conversation.read"]);
    expect(checkDragOffer({ type: "application/x-moss-message", data: { session: "s_1", seq: 4, text: "forged" } }, read)).toEqual({ type: "application/x-moss-message", data: { session: "s_1", seq: 4 } });
    expect(checkDragOffer({ type: "application/x-moss-message", data: { session: "s 1", seq: 4 } }, read)).toHaveProperty("error");
    expect(checkDragOffer({ type: "application/x-moss-message", data: { session: "s_1", seq: -1 } }, read)).toHaveProperty("error");
  });

  test("a claim: only by a plugin that may hold that kind", () => {
    expect(mayClaim("text/plain", new Set())).toBe(true);
    expect(mayClaim("application/x-moss-message", new Set())).toBe(false);
    expect(mayClaim("application/x-moss-message", new Set(["conversation.read"]))).toBe(true);
    expect(mayClaim("unknown/kind", new Set(["files"]))).toBe(false);
  });
});

describe("surface windows", () => {
  const display = { x: 0, y: 0, width: 1512, height: 982 };
  const workArea = { x: 0, y: 33, width: 1512, height: 949 };

  test("where the entry says (top-center, bottom-center), else centred; no surface's name decides", () => {
    expect(surfacePlacement({ placement: "top-center", size: { width: 400, height: 80 }, display, workArea })).toEqual({ x: 556, y: 0, width: 400, height: 80 });
    expect(surfacePlacement({ placement: "bottom-center", size: { width: 400, height: 60 }, display, workArea })).toEqual({ x: 556, y: 898, width: 400, height: 60 });
    expect(surfacePlacement({ size: { width: 400, height: 300 }, display, workArea })).toEqual({ x: 556, y: 358, width: 400, height: 300 });
  });

  test("click regions: rects inside the window, checked; the cursor's place decides", () => {
    const regions = checkRegions([{ x: -10, y: 0, width: 50, height: 20 }, { x: 0, y: 0, width: "w", height: 1 }, { x: 300, y: 0, width: 500, height: 40 }], { width: 360, height: 120 });
    expect(regions).toEqual([{ x: 0, y: 0, width: 50, height: 20 }, { x: 300, y: 0, width: 60, height: 40 }]);
    expect(inRegions({ x: 10, y: 10 }, regions)).toBe(true);
    expect(inRegions({ x: 100, y: 10 }, regions)).toBe(false);
    expect(checkRegions("everywhere", { width: 1, height: 1 })).toEqual([]);
  });
});

describe("surfaces outside the moss tree", () => {
  const workArea = { width: 1512, height: 949 };
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

  test("Settings at a section and an item, or a bot's tab; nothing else, and only for the moss tree", () => {
    expect(openTarget({ kind: "settings", section: "devices", item: "laptop" })).toEqual({ kind: "settings", section: "devices", item: "laptop" });
    expect(openTarget({ kind: "settings" })).toEqual({ kind: "settings" });
    expect(openTarget({ kind: "settings", section: "Devices!" })).toBeUndefined();
    expect(openTarget({ kind: "bot", bot: "alpha" })).toEqual({ kind: "bot", bot: "alpha" });
    expect(openTarget({ kind: "url", url: "https://example.com" })).toBeUndefined();
    // By capability, never by id (F2).
    expect(mayOpen(new Set(["shell.control"]))).toBe(true);
    expect(mayOpen(new Set(["approvals", "overlay"]))).toBe(false);
    // And the user's press in that frame: none, refused; without the capability the press isn't spent.
    let spent = 0;
    const press = (ok: boolean) => () => (spent++, ok);
    expect(openRefusal(new Set(["shell.control"]), press(true))).toBeUndefined();
    expect(openRefusal(new Set(["shell.control"]), press(false))).toContain("key press or click");
    expect(openRefusal(new Set(["devices.read"]), press(true))).toContain("shell.control");
    expect(spent).toBe(2);
  });
});

describe("native views (the MOSS Browser's live view, ruling R8)", () => {
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

describe("sends counted as the user's (§5.5)", () => {
  test("one key press or click the main process saw covers one send, within a second, in that window", () => {
    let now = 0;
    const g = new SendGate(() => now);
    expect(g.take(1)).toBe(false);
    g.input(1);
    expect(g.take(2)).toBe(false);
    expect(g.take(1)).toBe(true);
    expect(g.take(1)).toBe(false);
    g.input(1);
    now += SEND_INPUT_WINDOW_MS + 1;
    expect(g.take(1)).toBe(false);
  });

  test("a button held on Send past the window still sends: the release the main process saw is an input too", () => {
    let now = 0;
    const g = new SendGate(() => now);
    g.input(1); // the press
    now += SEND_INPUT_WINDOW_MS * 3; // held a while
    g.input(1); // the release (index.ts: before-mouse-event mouseUp), the click's own moment
    now += 5;
    expect(g.take(1)).toBe(true);
    expect(g.take(1)).toBe(false);
    // With no release seen, the press alone has run out.
    g.input(1);
    now += SEND_INPUT_WINDOW_MS * 3;
    expect(g.take(1)).toBe(false);
  });

  test("where the words may go, and the pictures with them", () => {
    expect(sendTarget({ bot: "alpha" })).toEqual({ bot: "alpha" });
    expect(sendTarget({ session: "s_alpha:main" })).toEqual({ session: "s_alpha:main" });
    expect(sendTarget({ target: "moss/pill#codex" })).toEqual({ target: "moss/pill#codex" });
    for (const bad of [{ bot: "Alpha!" }, { bot: "alpha", session: "x" }, { target: "nohash" }, "alpha", null]) expect(sendTarget(bad)).toBeUndefined();
    expect(sendImages([{ mediaType: "image/png", data: new Uint8Array([1, 2]) }])).toEqual([{ mediaType: "image/png", data: "AQI=" }]);
    expect(sendImages([{ mediaType: "image/gif", data: new Uint8Array([1]) }])).toHaveProperty("error");
    expect(sendImages(Array.from({ length: 5 }, () => ({ mediaType: "image/png", data: new Uint8Array([1]) })))).toHaveProperty("error");
    expect(sendImages(undefined)).toEqual([]);
  });
});

describe("a surface's click-through follows the cursor, with no timer where the OS forwards its moves", () => {
  test("clicks inside its regions, through everywhere else, and every click while it has none or hides", () => {
    const applied: boolean[] = [];
    const c = new ClickThrough((ignore) => applied.push(ignore));
    const regions = [{ x: 0, y: 0, width: 100, height: 40 }];
    c.set(regions, true, { x: 200, y: 10 });
    expect(applied).toEqual([true]);
    // Moving over a region takes clicks; moving within it changes nothing; leaving the window lets them through.
    c.move({ x: 10, y: 10 });
    c.move({ x: 20, y: 20 });
    c.move(undefined);
    expect(applied).toEqual([true, false, true]);
    // Hidden, or with no regions: a normal window again, whatever the cursor does.
    c.set(regions, false, { x: 200, y: 10 });
    c.move({ x: 200, y: 10 });
    expect(applied).toEqual([true, false, true, false]);
    c.set([], true, { x: 200, y: 10 });
    expect(applied.at(-1)).toBe(false);
    expect(c.active).toBe(false);
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

describe("a send after a hold (hold-to-talk): the release the main process saw gives the pressed frame one send within 30 s", () => {
  const A = "10:1";
  const B = "10:2";
  const key = (k = "Space") => ({ kind: "key" as const, key: k });
  // A key held `seconds` in `frames`, released in `at`.
  const holdKey = (g: SendGate, seconds: number, now: { t: number }, frames: string[] = [A], at: string = frames[0]!) => {
    g.press(1, { ...key(), frames });
    now.t += seconds * 1000;
    g.release(1, { ...key(), frame: at });
  };
  const holdMouse = (g: SendGate, seconds: number, now: { t: number }, frames: string[] = [A]) => {
    const h = g.press(1, { kind: "mouse", key: "left" });
    g.holdFrames(1, h, frames);
    now.t += seconds * 1000;
    g.release(1, { kind: "mouse", key: "left" });
  };

  test("a button held 6 s, released, then a send at 5 s and at 29 s after the release passes; 31 s is refused", () => {
    for (const [after, ok] of [[5, true], [29, true], [30, true], [31, false]] as const) {
      const now = { t: 0 };
      const g = new SendGate(() => now.t);
      holdMouse(g, 6, now);
      now.t += after * 1000;
      expect(g.takeRelease(1, A)).toBe(ok);
    }
  });

  test("a key held and released works the same (in the frame the key went down in)", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    holdKey(g, 7, now);
    now.t += 3_000;
    expect(g.takeRelease(1, A)).toBe(true);
  });

  test("one release covers one send, in any of the press's frames (a part inside its layer)", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    holdMouse(g, 1, now, [A, B]);
    expect(g.takeRelease(1, B)).toBe(true);
    expect(g.takeRelease(1, B)).toBe(false);
    expect(g.takeRelease(1, A)).toBe(false); // the press's other frame lost its allowance with the send
  });

  test("one click, two sends: the release's send leaves no one-second record for a second", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    g.holdFrames(1, g.press(1, { kind: "mouse", key: "left" }), [A]); // the mouse down (its frame found)...
    g.input(1); // ...the mouse up refreshes the window's one-second record
    g.release(1, { kind: "mouse", key: "left" });
    expect(g.takeRelease(1, A)).toBe(true); // the click's send
    expect(g.take(1)).toBe(false); // a second one inside the second is refused
    // A key held under a second does the same.
    g.press(1, { ...key(), frames: [A] });
    now.t += 200;
    g.release(1, { ...key(), frame: A });
    expect(g.takeRelease(1, A)).toBe(true);
    expect(g.take(1)).toBe(false);
  });

  test("a press that already sent (a key's send on its key down) gives no allowance on its release", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    g.press(1, { ...key(), frames: [A] });
    expect(g.take(1)).toBe(true);
    g.release(1, { ...key(), frame: A });
    expect(g.takeRelease(1, A)).toBe(false);
  });

  test("a press in frame A, focus moved to B, the key released there: B gets nothing, and A only gets it if the release is A's", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    holdKey(g, 1, now, [A], B); // the release came to B (a page moved focus)
    expect(g.takeRelease(1, B)).toBe(false);
    expect(g.takeRelease(1, A)).toBe(false);
    // A mouse press's frames are where the pointer was, whichever frame is focused when it is released.
    holdMouse(g, 1, now, [A]);
    expect(g.takeRelease(1, B)).toBe(false);
    expect(g.takeRelease(1, A)).toBe(true);
  });

  test("a release that comes before the frame under the pointer is found is credited when it is", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    const h = g.press(1, { kind: "mouse", key: "left" });
    g.release(1, { kind: "mouse", key: "left" });
    expect(g.takeRelease(1, A)).toBe(false);
    g.holdFrames(1, h, [A]);
    expect(g.takeRelease(1, A)).toBe(true);
  });

  test("a new press in ANY frame of the window ends the window's allowances: a key as a mouse press", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    holdKey(g, 1, now, [A]);
    g.press(1, { ...key("a"), frames: [B] }); // a key in another frame
    expect(g.takeRelease(1, A)).toBe(false);
    holdKey(g, 1, now, [A]);
    g.press(1, { kind: "mouse", key: "left" });
    expect(g.takeRelease(1, A)).toBe(false);
    // The new hold's own release starts over.
    g.holdFrames(1, g.press(1, { kind: "mouse", key: "left" }), [A]);
    g.release(1, { kind: "mouse", key: "left" });
    expect(g.takeRelease(1, A)).toBe(true);
  });

  test("a press nobody released (a right button, a release that went elsewhere) expires and gives nothing", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    const h = g.press(1, { kind: "mouse", key: "right" });
    g.holdFrames(1, h, [A]);
    g.release(1, { kind: "mouse", key: "left" }); // another button's release is not its release
    expect(g.takeRelease(1, A)).toBe(false);
    now.t += SEND_HOLD_MAX_MS + 1;
    g.release(1, { kind: "mouse", key: "right" }); // far too late
    expect(g.takeRelease(1, A)).toBe(false);
    // Another key's release is not the key's release.
    g.press(1, { ...key("Space"), frames: [A] });
    g.release(1, { ...key("a"), frame: A });
    expect(g.takeRelease(1, A)).toBe(false);
  });

  test("it is the frame's own: not another window's; a reload, navigation or the window closing drops it", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    holdMouse(g, 1, now);
    expect(g.takeRelease(2, A)).toBe(false);
    expect(g.takeRelease(1, A)).toBe(true);
    holdMouse(g, 1, now);
    g.forgetFrame(A);
    expect(g.takeRelease(1, A)).toBe(false);
    holdMouse(g, 1, now);
    g.forget(1);
    expect(g.takeRelease(1, A)).toBe(false);
  });

  test("only input the main process saw gives one: no press seen, nothing", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    // A page's own dispatchEvent never reaches before-input-event / before-mouse-event, so nothing is recorded.
    expect(g.takeRelease(1, A)).toBe(false);
    g.release(1, { kind: "mouse", key: "left" });
    expect(g.takeRelease(1, A)).toBe(false);
    // A background part's window has no input, and index.ts records nothing for it.
    expect(new SendGate(() => now.t).takeRelease(9, "20:1")).toBe(false);
  });

  test("the one-second rule stays for a send with no release behind it", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    g.press(1, { ...key(), frames: [A] });
    expect(g.take(1)).toBe(true); // a click button sends at once
    g.press(1, { ...key(), frames: [A] });
    now.t += SEND_INPUT_WINDOW_MS + 1;
    expect(g.take(1)).toBe(false);
    expect(SEND_RELEASE_WINDOW_MS).toBe(30_000);
  });
});

describe("a held key binding's release (§5.4 `hold`): its owner's documents get the press's one send within 30 s", () => {
  const FOCUSED = "10:1"; // the frame the key went down in (another plugin's, say)
  const OWNER = "20:1"; // the binding's owner's document in the window
  const OTHER = "30:1"; // a third document, not the owner's
  /** The binding's key down as main sees it (`press` first, then the binding takes the window's newest press). */
  const down = (g: SendGate) => {
    g.press(1, { kind: "key", key: " ", frames: [FOCUSED] });
    return g.newest(1)!;
  };

  test("the release gives the owner's documents the allowance, spent once, within 30 s; another document gets none", () => {
    for (const [after, ok] of [[5, true], [30, true], [31, false]] as const) {
      const now = { t: 0 };
      const g = new SendGate(() => now.t);
      const h = down(g);
      now.t += 4_000;
      g.creditHeld(1, h, [OWNER]);
      now.t += after * 1000;
      expect(g.takeRelease(1, OTHER)).toBe(false);
      expect(g.takeRelease(1, OWNER)).toBe(ok);
      expect(g.takeRelease(1, OWNER)).toBe(false);
    }
  });

  test("none for a plugin without user.send (main gives no documents), and none in another window", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    const h = down(g);
    g.creditHeld(1, h, []);
    expect(g.takeRelease(1, OWNER)).toBe(false);
    const h2 = down(g);
    g.creditHeld(1, h2, [OWNER]);
    expect(g.takeRelease(2, OWNER)).toBe(false);
  });

  test("ended by a new press: one before the release leaves it nothing, one after takes it away", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    const h = down(g);
    g.press(1, { kind: "mouse", key: "left" }); // a click while the key is held
    g.creditHeld(1, h, [OWNER]);
    expect(g.takeRelease(1, OWNER)).toBe(false);
    const h2 = down(g);
    g.creditHeld(1, h2, [OWNER]);
    g.press(1, { kind: "key", key: "a", frames: [FOCUSED] });
    expect(g.takeRelease(1, OWNER)).toBe(false);
  });

  test("one press, one send: the key's own release in its frame and the owner's share it, and a send on the key down spends both", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    const h = down(g);
    g.release(1, { kind: "key", key: " ", frame: FOCUSED });
    g.creditHeld(1, h, [OWNER]);
    expect(g.takeRelease(1, OWNER)).toBe(true);
    expect(g.takeRelease(1, FOCUSED)).toBe(false);
    const h2 = down(g);
    expect(g.take(1)).toBe(true);
    g.creditHeld(1, h2, [OWNER]);
    expect(g.takeRelease(1, OWNER)).toBe(false);
  });

  test("a modifier let go first: the owner's documents send once; the key's own up after that send gives no second one", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    const h = down(g);
    g.release(1, { kind: "key", key: "Control", frame: FOCUSED }); // another key's up: not the press's
    g.creditHeld(1, h, [OWNER]);
    expect(g.takeRelease(1, OWNER)).toBe(true);
    now.t += 700;
    g.release(1, { kind: "key", key: " ", frame: FOCUSED }); // the space let go after the send
    expect(g.takeRelease(1, FOCUSED)).toBe(false);
    expect(g.takeRelease(1, OWNER)).toBe(false);
  });

  test("lost when the owner's document navigates, and nothing for a press held past two minutes", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    const h = down(g);
    g.creditHeld(1, h, [OWNER]);
    g.forgetFrame(OWNER);
    expect(g.takeRelease(1, OWNER)).toBe(false);
    const h2 = down(g);
    now.t += SEND_HOLD_MAX_MS + 1;
    g.creditHeld(1, h2, [OWNER]);
    expect(g.takeRelease(1, OWNER)).toBe(false);
  });
});

describe("a gesture counts only for the frame it happened in", () => {
  test("a press in frame A never unlocks a call from frame B; a refused call spends nobody's gesture", () => {
    const gate = new SendGate(() => 0);
    gate.input(1); // the user clicked in the window, in frame A (the main process saw it; B's activation stayed false)
    // The polling plugin frame B: no transient activation of its own, so it gets nothing and takes nothing.
    for (let i = 0; i < 20; i++) expect(frameGesture(false, () => gate.take(1))).toBe(false);
    expect(frameGesture(undefined, () => gate.take(1))).toBe(false);
    expect(frameGesture("true", () => gate.take(1))).toBe(false);
    // Frame A's own call still has the gesture, once.
    expect(frameGesture(true, () => gate.take(1))).toBe(true);
    expect(frameGesture(true, () => gate.take(1))).toBe(false);
  });
});

describe("a part's gestured call spends only a press in its own frame (F2, read 52)", () => {
  const W = 3;
  test("a press in frame A, then a gestured call from frame B, is refused and leaves the press for A", () => {
    let t = 1_000;
    const g = new SendGate(() => t);
    g.press(W, { kind: "key", key: "Enter", frames: ["doc:A"] });
    expect(g.takeIn(W, "doc:B")).toBe(false);
    expect(g.takeIn(W, "doc:A")).toBe(true);
    // One press, one call.
    expect(g.takeIn(W, "doc:A")).toBe(false);
    // A new press, past the second: nothing.
    g.press(W, { kind: "key", key: "a", frames: ["doc:A"] });
    t += SEND_INPUT_WINDOW_MS + 1;
    expect(g.takeIn(W, "doc:A")).toBe(false);
  });

  test("a press on a sealed card's button unlocks no part's write: its innermost frame is the sealed frame, not the document that placed it", () => {
    const g = new SendGate(() => 5_000);
    const hold = g.press(W, { kind: "mouse", key: "left" });
    g.holdFrames(W, hold, ["moss-doc", "plugin:acme", "sealed:card-1"]);
    expect(g.takeIn(W, "plugin:acme")).toBe(false);
    expect(g.takeIn(W, "moss-doc")).toBe(false);
  });

  test("the bundled tree's parts share one document: a press anywhere in it is that document's; a press in a plugin's frame nested in it is the plugin's alone", () => {
    const g = new SendGate(() => 9_000);
    const h1 = g.press(W, { kind: "mouse", key: "left" });
    g.holdFrames(W, h1, ["moss-doc"]);
    expect(g.takeIn(W, "moss-doc")).toBe(true);
    const h2 = g.press(W, { kind: "mouse", key: "left" });
    g.holdFrames(W, h2, ["moss-doc", "plugin:acme"]);
    expect(g.takeIn(W, "moss-doc")).toBe(false);
    expect(g.takeIn(W, "plugin:acme")).toBe(true);
    // A press on the window's own root (no frame) is no part's.
    const h3 = g.press(W, { kind: "mouse", key: "left" });
    g.holdFrames(W, h3, []);
    expect(g.takeIn(W, "moss-doc")).toBe(false);
  });

  test("a click's frame is found a moment after the press: a call waits for it (settle), then is judged; with no press it doesn't wait", async () => {
    const g = new SendGate();
    await g.settle(W, 50);
    const hold = g.press(W, { kind: "mouse", key: "left" });
    expect(g.takeIn(W, "doc:A")).toBe(false); // not known yet: nothing spent
    setTimeout(() => g.holdFrames(W, hold, ["doc:A"]), 10);
    await g.settle(W, 1_000);
    expect(g.takeIn(W, "doc:A")).toBe(true);
    // A press whose frames never come: settle gives up, and the call is refused.
    g.press(W, { kind: "mouse", key: "left" });
    await g.settle(W, 20);
    expect(g.takeIn(W, "doc:A")).toBe(false);
  });

  test("a call that came in time is still in time when the walk is slow: the window is measured to its arrival", () => {
    let t = 1_000;
    const g = new SendGate(() => t);
    const h = g.press(W, { kind: "mouse", key: "left" });
    const arrived = t + 200;
    t += 2_400; // the walk took 2.4 s to name the frame
    g.holdFrames(W, h, ["part"]);
    expect(g.takeIn(W, "part", t)).toBe(false); // measured now: late
    expect(g.takeIn(W, "part", arrived)).toBe(true);
    expect(g.takeIn(W, "part", arrived)).toBe(false); // once
  });

  test("the frame's own report names where a mouse press landed: first report wins, none without a recent press, fresh per press", () => {
    let t = 1_000;
    const g = new SendGate(() => t);
    expect(g.seen(W, ["doc", "x"])).toBe(false); // no press: dropped
    g.press(W, { kind: "mouse", key: "left" });
    expect(g.seen(W, ["doc", "x"])).toBe(true); // a report from frame x credits x
    expect(g.seen(W, ["doc", "y"])).toBe(false); // a second report is ignored
    expect(g.takeIn(W, "y")).toBe(false);
    expect(g.takeIn(W, "doc")).toBe(false); // the outer document is not x
    expect(g.takeIn(W, "x")).toBe(true);
    t += 100;
    g.press(W, { kind: "mouse", key: "left" }); // a new press starts fresh
    expect(g.takeIn(W, "x")).toBe(false); // no report yet: no frame takes it
    expect(g.seen(W, ["doc", "y"])).toBe(true);
    expect(g.takeIn(W, "y")).toBe(true);
    t += 100;
    g.press(W, { kind: "mouse", key: "left" });
    t += PRESS_REPORT_MS + 1;
    expect(g.seen(W, ["doc", "x"])).toBe(false); // too late
    t = 50_000;
    g.press(W, { kind: "key", key: "a", frames: ["doc"] });
    expect(g.seen(W, ["doc", "x"])).toBe(false); // a key press keeps its focused frame
  });

  test("a frame that navigated loses the press it reported, and its outer frames don't inherit it", () => {
    const g = new SendGate(() => 7);
    g.press(W, { kind: "mouse", key: "left" });
    g.seen(W, ["doc", "x"]);
    g.forgetFrame("x");
    expect(g.takeIn(W, "x")).toBe(false);
    expect(g.takeIn(W, "doc")).toBe(false);
  });

  test("another window's press is never this window's", () => {
    const g = new SendGate(() => 1);
    g.press(1, { kind: "key", key: "Enter", frames: ["doc:A"] });
    expect(g.takeIn(2, "doc:A")).toBe(false);
    expect(g.takeIn(1, "doc:A")).toBe(true);
  });
});

describe("SendGate.takeIn is timed by the press itself (browser-press, read 53 item 6)", () => {
  test("an old press's frames plus fresh window input of another kind unlocks nothing; a press spent by take is not spent again", () => {
    let now = 1_000;
    const g = new SendGate(() => now);
    g.press(1, { kind: "mouse", key: "left" });
    expect(g.seen(1, ["tree:1", "panel:A"])).toBe(true);
    now += 600;
    g.input(1); // input the main process saw that is no new press (a release, a background window's key)
    now += 600; // the press is 1.2 s old, the input 0.6 s
    expect(g.takeIn(1, "panel:A")).toBe(false);
    // A fresh press, spent by the window rule (`take`): its frame can't spend it again.
    now += 5_000;
    g.press(1, { kind: "key", key: "Enter", frames: ["tree:1", "panel:A"] });
    expect(g.take(1)).toBe(true);
    expect(g.takeIn(1, "panel:A")).toBe(false);
    // And the other way round: spent by its frame, the window rule finds nothing.
    now += 5_000;
    g.press(1, { kind: "key", key: "Enter", frames: ["tree:1", "panel:A"] });
    expect(g.takeIn(1, "panel:A")).toBe(true);
    expect(g.take(1)).toBe(false);
    expect(g.takeIn(1, "panel:A")).toBe(false);
  });
});

describe("MOSS Voice's talk button on the press record (F1 on F2): a hold in its own frame gives that frame the one send after the release", () => {
  // The button is drawn in the moss layer's document (MOSS), a frame in the window's core root (ROOT); another plugin's frame
  // in the same window (OTHER) never takes its press. What happens in between: the button's own plugin-API calls (the microphone
  // turn, the stream to its host half) are no gestured call and spend nothing; the words come back seconds after the release.
  const W = 3;
  const ROOT = "1:1";
  const MOSS = "1:2";
  const OTHER = "1:3";

  test("a real mouse hold: main sees the press, the moss document's own trusted pointerdown (moss:press-seen) names its frame, the release credits it", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    g.press(W, { kind: "mouse", key: "left" });
    now.t += 20;
    // The preload in the moss document reports; main binds it to that frame and the frames it sits in (frameChainOf).
    expect(g.seen(W, [ROOT, MOSS])).toBe(true);
    expect(g.pressFrames(W)).toEqual([ROOT, MOSS]);
    now.t += 4_000; // held while recording
    g.release(W, { kind: "mouse", key: "left" });
    now.t += 6_000; // the host half writes it down
    expect(g.takeRelease(W, OTHER)).toBe(false);
    expect(g.takeRelease(W, MOSS)).toBe(true);
    // One hold, one send.
    expect(g.takeRelease(W, MOSS)).toBe(false);
    expect(g.takeIn(W, MOSS)).toBe(false);
  });

  test("the report may come after the release (a busy renderer): the release is credited when it does", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    g.press(W, { kind: "mouse", key: "left" });
    now.t += 300;
    g.release(W, { kind: "mouse", key: "left" });
    expect(g.takeRelease(W, MOSS)).toBe(false);
    now.t += 100;
    expect(g.seen(W, [ROOT, MOSS])).toBe(true);
    now.t += 5_000;
    expect(g.takeRelease(W, MOSS)).toBe(true);
  });

  for (const key of [" ", "Enter"]) {
    test(`${key === " " ? "Space" : "Enter"} held on the focused button: the key's frames are the focused frame's (the moss document), the key-up there credits it`, () => {
      const now = { t: 0 };
      const g = new SendGate(() => now.t);
      // before-input-event: the first key down (auto-repeats are no new press), frames from the focused frame (frameChainOf).
      g.press(W, { kind: "key", key, frames: [ROOT, MOSS] });
      now.t += 3_000;
      g.release(W, { kind: "key", key, frame: MOSS });
      now.t += 8_000;
      expect(g.takeRelease(W, OTHER)).toBe(false);
      expect(g.takeRelease(W, MOSS)).toBe(true);
      expect(g.takeRelease(W, MOSS)).toBe(false);
    });
  }

  test("a key released in another frame (the focus moved) credits nothing; the button drops such a hold itself (its blur)", () => {
    const now = { t: 0 };
    const g = new SendGate(() => now.t);
    g.press(W, { kind: "key", key: " ", frames: [ROOT, MOSS] });
    g.release(W, { kind: "key", key: " ", frame: OTHER });
    expect(g.takeRelease(W, MOSS)).toBe(false);
  });
});

