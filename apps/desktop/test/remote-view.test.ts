// The window half of the browser while the host runs the pages (lane HS): MOSS Code's panel shows a host's tab from the
// engine's pictures and sends the person's own input, and nothing else, as `browser.view.input`.
import { expect, test } from "bun:test";
import type { TabView } from "@waifucave/moss-protocol";
import { RealInput, tabInputOf, REAL_INPUT_WINDOW_MS } from "../src/main/browser/remote-input";
import { RemoteViews, type RemoteViewport } from "../src/main/browser/remote-view";
import type { ViewportInput } from "../src/main/browser/viewport";

function tab(id: string, owner: TabView["owner"], view?: string): TabView {
  return { id, computer: "c", owner, partition: "p", url: "https://example.test/", title: "", place: view !== undefined ? "shown" : "headless", viewport: { width: 800, height: 600 }, loading: false, heldByUser: false, ...(view !== undefined ? { view } : {}) };
}

function harness() {
  let now = 1_000;
  const calls: { method: string; params: unknown }[] = [];
  const vps: (RemoteViewport & { drawn: number; destroyed: boolean; send(ev: ViewportInput, focused?: boolean): void })[] = [];
  const views = new RemoteViews({
    settleMs: 0,
    request: async (method, params) => { calls.push({ method, params }); return method === "browser.view.open" ? { stream: `s${calls.length}` } : { ok: true }; },
    makeViewport: () => {
      let fn: ((ev: ViewportInput, focused: boolean) => void) | undefined;
      const vp = { real: new RealInput(() => now), drawn: 0, destroyed: false, place: () => undefined, draw: () => { vp.drawn++; }, onInput: (f: typeof fn) => { fn = f; }, destroy: () => { vp.destroyed = true; }, send: (ev: ViewportInput, focused = false) => fn?.(ev, focused) };
      vps.push(vp as never);
      return vp as never;
    },
  });
  return { views, calls, vps, advance: (ms: number) => { now += ms; } };
}
const target = { windowId: 1, bounds: { x: 10, y: 20, width: 640, height: 480 } };
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a session's tab shown in the panel's view opens a view stream at the panel's size and draws its pictures", async () => {
  const h = harness();
  h.views.enable(true);
  h.views.setTarget("browser", target);
  h.views.tabChanged(tab("t1", { kind: "session", session: "s_1" } as TabView["owner"], "browser"));
  await settle();
  expect(h.calls[0]).toEqual({ method: "browser.view.open", params: { tab: "t1", viewport: { width: 640, height: 480 } } });
  h.views.frame({ stream: "s1", format: "jpeg", width: 640, height: 480, data: "AAAA" });
  h.views.frame({ stream: "other", format: "jpeg", width: 1, height: 1, data: "AAAA" });
  expect(h.vps[0]!.drawn).toBe(1);
  // The tab moves away: the view closes its stream.
  h.views.tabChanged(tab("t1", { kind: "session", session: "s_1" } as TabView["owner"]));
  expect(h.vps[0]!.destroyed).toBe(true);
  expect(h.calls.at(-1)).toEqual({ method: "browser.view.close", params: { stream: "s1" } });
});

test("the panel asks for whatever tab is placed in its view (the engine's rule decides), and nothing while the window runs its own pages", async () => {
  const h = harness();
  h.views.setTarget("browser", target);
  h.views.tabChanged(tab("t1", { kind: "user" }, "browser"));
  expect(h.calls).toEqual([]);
  h.views.enable(true);
  h.views.tabChanged(tab("t2", { kind: "bot", bot: "b_1" } as TabView["owner"], "panel-2"));
  h.views.setTarget("panel-2", target);
  await settle();
  expect(h.calls.map((c) => (c.params as { tab: string }).tab)).toEqual(["t1", "t2"]);
});

test("the person's input goes out only after a real press in the panel's own frame; a forged one never does", async () => {
  const h = harness();
  h.views.enable(true);
  h.views.setTarget("browser", target);
  h.views.tabChanged(tab("t1", { kind: "user" }, "browser"));
  await settle();
  const vp = h.vps[0]!;
  const down: ViewportInput = { type: "mouseDown", x: 5, y: 6, button: "left", clickCount: 1 };
  // A page's word with no press the main process saw: refused.
  vp.send(down);
  expect(h.calls.filter((c) => c.method === "browser.view.input")).toEqual([]);
  // A real press in its frame: that one down goes, then its moves and release.
  vp.real.saw("down");
  vp.send(down);
  vp.send({ type: "mouseMove", x: 7, y: 8 });
  vp.send(down);
  const sent = h.calls.filter((c) => c.method === "browser.view.input").map((c) => (c.params as { events: unknown[] }).events[0]);
  expect(sent).toEqual([{ kind: "mouse", type: "down", x: 5, y: 6, button: "left", clicks: 1 }, { kind: "mouse", type: "move", x: 7, y: 8 }]);
  // A real key long ago doesn't stand for a key now.
  vp.real.saw("key");
  h.advance(REAL_INPUT_WINDOW_MS + 1);
  vp.send({ type: "keyDown", keyCode: "A" }, true);
  expect(h.calls.filter((c) => c.method === "browser.view.input").length).toBe(2);
});

test("the viewport's events as the protocol's: mouse, wheel, keys and text; the edit commands stay local", () => {
  expect(tabInputOf({ type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: -40 })).toEqual({ kind: "wheel", x: 1, y: 2, dx: 0, dy: -40 });
  expect(tabInputOf({ type: "keyDown", keyCode: "Enter", modifiers: ["shift"] })).toEqual({ kind: "key", type: "down", key: "Enter", modifiers: ["shift"] });
  expect(tabInputOf({ kind: "ime-commit", text: "日本" })).toEqual({ kind: "ime", text: "日本" });
  expect(tabInputOf({ kind: "paste" })).toBeUndefined();
  expect(tabInputOf({ kind: "edit", cmd: "copy" })).toBeUndefined();
});

test("the engine's stream commands are taken field by field; anything else is the protocol schema's to judge", async () => {
  const { streamCommandOf } = await import("../src/main/browser/stream-command");
  expect(streamCommandOf({ id: "t1", command: { kind: "stream", stream: "frames-1", on: true, codecs: ["jpeg"] } })).toEqual({ id: "t1", command: { kind: "stream", stream: "frames-1", on: true, codecs: ["jpeg"] } });
  expect(streamCommandOf({ id: "t1", command: { kind: "stream-control", stream: "s", keyframe: true } })).toEqual({ id: "t1", command: { kind: "stream-control", stream: "s", keyframe: true } });
  for (const bad of [{ id: "t1", command: { kind: "stream", stream: "s", on: "yes" } }, { id: "t1", command: { kind: "stream", stream: "s", on: true, codecs: ["gif"] } }, { id: "", command: { kind: "stream", stream: "s", on: false } }, { id: "t1", command: { kind: "navigate", url: "x" } }]) expect(streamCommandOf(bad)).toBeUndefined();
});

test("a tab re-placed several times in a moment is opened once, at the place it settles on", async () => {
  const calls: string[] = [];
  const views = new RemoteViews({
    settleMs: 30,
    request: async (method) => { calls.push(method); return method === "browser.view.open" ? { stream: "s1" } : { ok: true }; },
    makeViewport: () => ({ real: new RealInput(), place: () => undefined, draw: () => undefined, onInput: () => undefined, destroy: () => undefined }) as never,
  });
  views.enable(true);
  views.setTarget("browser", target);
  const t = tab("t1", { kind: "user" }, "browser");
  views.tabChanged(t);
  views.tabChanged({ ...t, place: "headless", view: undefined } as TabView);
  views.tabChanged(t);
  await new Promise((r) => setTimeout(r, 80));
  expect(calls).toEqual(["browser.view.open"]);
  views.dispose();
});
