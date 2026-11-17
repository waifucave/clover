// The background host's side of its connection (lane HS): its answers to the engine's requests, its ready report, its
// leaving on purpose, "stop everything" with its warning, and the person's input mapped onto a tab's page.
import { expect, test } from "bun:test";
import type { TabInputEvent } from "@waifucave/moss-protocol";
import { hostBundlePath, installHostHandlers, leaveFor, sayHostReady, stopEverything, type HostRuntimeDeps } from "../src/main/host-runtime";
import { electronInput } from "../src/main/browser/tab-input";

function deps(over: Partial<HostRuntimeDeps> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const left: string[] = [];
  const inputs: { id: string; events: readonly TabInputEvent[] }[] = [];
  const answers: Record<string, unknown> = {};
  const client = { request: async <T,>(method: string, params?: unknown): Promise<T> => { calls.push({ method, params }); return (answers[method] ?? { ok: true }) as T; } };
  const d: HostRuntimeDeps = {
    release: "1.111.1", bundlePath: "/Applications/MOSS.app", safeMode: false,
    parts: () => ({ surfaces: 2, background: 1, tabs: ["t1"] }),
    client: () => client, leave: () => { left.push("left"); }, tabInput: (id, events) => { inputs.push({ id, events }); },
    log: () => {}, after: (_ms, fn) => fn(), ...over,
  };
  return { d, calls, left, inputs, answers };
}

test("the bundle a host runs from: the outermost app on macOS", () => {
  expect(hostBundlePath("/Applications/MOSS Code.app/Contents/Frameworks/MOSS Host.app/Contents/MacOS/MOSS Host", "darwin")).toBe("/Applications/MOSS Code.app");
  expect(hostBundlePath("/opt/moss-code/moss-code", "linux")).toBe("/opt/moss-code/moss-code");
});

test("the engine's requests: stop leaves after answering, adopt says what it runs, safe mode leaves for it, input reaches the tab", async () => {
  const t = deps();
  const handlers = new Map<string, (p: unknown) => unknown>();
  installHostHandlers({ handle: (m, fn) => handlers.set(m, fn) }, t.d);
  expect(handlers.get("host.adopt")!({ engine: "1.111.1" })).toEqual({ release: "1.111.1", safeMode: false, parts: { surfaces: 2, background: 1, tabs: ["t1"] } });
  expect(handlers.get("host.stop")!({ reason: "update" })).toEqual({ ok: true });
  expect(t.left).toEqual(["left"]);
  const events: TabInputEvent[] = [{ kind: "mouse", type: "down", x: 3, y: 4, button: "left", clicks: 1 }];
  handlers.get("host.tab.input")!({ id: "t1", events });
  expect(t.inputs).toEqual([{ id: "t1", events }]);
  handlers.get("host.safeMode")!({ on: true });
  await new Promise((r) => setTimeout(r, 0));
  expect(t.calls).toContainEqual({ method: "host.exiting", params: { reason: "safe-mode" } });
  expect(t.left).toEqual(["left", "left"]);
  // Out of safe mode: no exit that would read as a stop or a crash.
  const s = deps({ safeMode: true });
  const h2 = new Map<string, (p: unknown) => unknown>();
  installHostHandlers({ handle: (m, fn) => h2.set(m, fn) }, s.d);
  h2.get("host.safeMode")!({ on: false });
  expect(s.left).toEqual([]);
});

test("ready says what it runs and from which copy; leaving on purpose says why first", async () => {
  const t = deps();
  await sayHostReady(t.d.client()!, t.d);
  expect(t.calls[0]).toEqual({ method: "host.ready", params: { release: "1.111.1", bundlePath: "/Applications/MOSS.app", safeMode: false, parts: { surfaces: 2, background: 1, tabs: ["t1"] } } });
  await leaveFor(t.d, "quit-everything");
  expect(t.calls[1]).toEqual({ method: "host.exiting", params: { reason: "quit-everything" } });
  expect(t.left).toEqual(["left"]);
});

test("stop everything: the engine's word on what is mid-work, the person's answer, and only then the stop", async () => {
  const t = deps();
  t.answers["host.menu"] = { done: false, working: { turns: 1, agents: 0, routines: 0 } };
  expect(await stopEverything(t.d, async () => false)).toBe("kept");
  expect(t.calls).toEqual([{ method: "host.menu", params: { action: "quit-everything" } }]);
  expect(await stopEverything(t.d, async () => true)).toBe("stopped");
  expect(t.calls.at(-1)).toEqual({ method: "host.menu", params: { action: "quit-everything", confirmed: true } });
  const idle = deps();
  idle.answers["host.menu"] = { done: true };
  expect(await stopEverything(idle.d, async () => { throw new Error("never asked"); })).toBe("stopped");
});

test("the person's input as Electron's: mouse, wheel, keys with known modifiers only, and an IME's text", () => {
  expect(electronInput({ kind: "mouse", type: "down", x: 1.6, y: 2.2, button: "left", clicks: 2, modifiers: ["Shift", "evil"] })).toEqual({ type: "mouseDown", x: 2, y: 2, button: "left", clickCount: 2, modifiers: ["shift"] });
  expect(electronInput({ kind: "wheel", x: 1, y: 1, dx: 0, dy: -40 })).toEqual({ type: "mouseWheel", x: 1, y: 1, deltaX: 0, deltaY: -40 });
  expect(electronInput({ kind: "key", type: "char", key: "a" })).toEqual({ type: "char", keyCode: "a" });
  expect(electronInput({ kind: "ime", text: "日本" })).toEqual({ type: "insertText", text: "日本" });
});

test("host.front: the engine's word that a window is in front reaches the host's island", () => {
  const heard: boolean[] = [];
  const t = deps({ front: (f) => { heard.push(f); } });
  const handlers = new Map<string, (p: unknown) => unknown>();
  installHostHandlers({ handle: (m, fn) => handlers.set(m, fn) }, t.d);
  expect(handlers.get("host.front")!({ front: true })).toEqual({ ok: true });
  handlers.get("host.front")!({ front: false });
  expect(heard).toEqual([true, false]);
  expect(() => handlers.get("host.front")!({ front: "yes" })).toThrow();
});
