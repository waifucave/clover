import { describe, expect, test } from "bun:test";
import type { ShellState } from "@waifucave/clover-plugin-sdk";
import { cleanReport, hearsShell, ownsShownBot, providedNow, routeShell } from "../src/main/ui/shell-calls";

const state = (over: Partial<ShellState> = {}): ShellState => ({
  tab: { kind: "bot", id: "alpha" }, bot: "alpha",
  sidebar: { collapsed: false, side: "bots" }, panels: { open: [], available: ["session", "browser"] }, safeArea: { left: 80, top: 44 }, ...over,
});
const win = (s = state()) => ({ state: s, apps: [{ id: "archive", title: "Archive" }], account: { name: "Delta", detail: "laptop" } });
const both = ["shell.read", "shell.control"];
const call = (method: unknown, args: unknown = {}, over: { id?: string; caps?: string[]; window?: ReturnType<typeof win> | undefined; gesture?: boolean } = {}) => {
  let spent = 0;
  const r = () => routeShell({ method, args, plugin: { id: over.id ?? "alpha", capabilities: over.caps ?? both }, window: "window" in over ? over.window : win(), takeGesture: () => (over.gesture === false ? false : (spent++, true)) });
  return { run: r, spent: () => spent };
};

describe("shell.* from a plugin's frame", () => {
  test("the reads answer with where the window is, with no gesture", () => {
    const c = call("state", {}, { gesture: false });
    expect(c.run()).toEqual({ kind: "answer", value: state() });
    expect(call("apps", {}, { gesture: false }).run()).toEqual({ kind: "answer", value: [{ id: "archive", title: "Archive" }] });
    expect(call("account", {}, { gesture: false }).run()).toEqual({ kind: "answer", value: { name: "Delta", detail: "laptop" } });
    // Without `shell.read` the account is as closed as the state.
    expect(() => call("account", {}, { caps: ["shell.control"] }).run()).toThrow();
    // The main process's own read of the sidebar's buttons wins over what the shell said.
    const own = routeShell({ method: "apps", args: {}, plugin: { id: "alpha", capabilities: both }, window: win(), appButtons: () => [{ id: "notes", title: "Notes" }], takeGesture: () => false });
    expect(own).toEqual({ kind: "answer", value: [{ id: "notes", title: "Notes" }] });
  });

  test("the acts are the shell's own data, each by one gesture", () => {
    const c = call("togglePanel", { view: "browser" });
    expect(c.run()).toEqual({ kind: "act", act: { kind: "panel", view: "browser" } });
    expect(c.spent()).toBe(1);
    expect(call("openPanel", { view: "session" }).run()).toEqual({ kind: "act", act: { kind: "panel", view: "session", to: "open" } });
    expect(call("closePanel", { view: "session" }).run()).toEqual({ kind: "act", act: { kind: "panel", view: "session", to: "closed" } });
    expect(call("toggleSidebar").run()).toEqual({ kind: "act", act: { kind: "sidebar" } });
    expect(call("setSidebar", { collapsed: true }).run()).toEqual({ kind: "act", act: { kind: "sidebar", collapsed: true } });
    expect(call("openBotEditor", {}).run()).toEqual({ kind: "act", act: { kind: "editor" } });
    expect(call("openSettings", { section: "models" }).run()).toEqual({ kind: "act", act: { kind: "settings", section: "models" } });
    expect(call("go", { target: { bot: "luna" } }).run()).toEqual({ kind: "act", act: { kind: "go", target: { bot: "luna" } } });
    expect(call("go", { target: { bot: "example-notes/notes" } }).run()).toEqual({ kind: "act", act: { kind: "go", target: { bot: "example-notes/notes" } } });
    expect(call("go", { target: { side: "code" } }).run()).toEqual({ kind: "act", act: { kind: "go", target: { side: "code" } } });
    expect(call("go", { target: { page: "plugins" } }).run()).toEqual({ kind: "act", act: { kind: "go", target: { page: "plugins" } } });
  });

  test("an act with no user press is refused and spends nothing", () => {
    for (const m of ["toggleSidebar", "openBotEditor"]) expect(() => call(m, {}, { gesture: false }).run()).toThrow(/key press or click/);
    expect(() => call("go", { target: { bot: "luna" } }, { gesture: false }).run()).toThrow(/key press or click/);
  });

  test("dragWindow is the user's own press, which main saw: it asks for no gesture here", () => {
    expect(call("dragWindow", {}, { gesture: false }).run()).toEqual({ kind: "drag" });
  });

  test("provide says which essential handles the plugin's controls offer: only the two, no gesture", () => {
    expect(call("provide", { parts: ["sidebar", "drag", "other"] }, { gesture: false }).run()).toEqual({ kind: "provide", parts: ["sidebar", "drag"] });
    expect(call("provide", { parts: [] }, { gesture: false }).run()).toEqual({ kind: "provide", parts: [] });
    expect(call("provide", {}, { gesture: false }).run()).toEqual({ kind: "provide", parts: [] });
  });

  test("a plugin without the capability has no such call", () => {
    expect(() => call("state", {}, { caps: ["shell.control"] }).run()).toThrow(/capability/);
    expect(() => call("toggleSidebar", {}, { caps: ["shell.read"] }).run()).toThrow(/capability/);
    expect(call("state", {}, { caps: ["shell.read"] }).run().kind).toBe("answer");
  });

  test("it reaches the window only while one of the plugin's own bots shows its tab", () => {
    expect(() => call("state", {}, { id: "luna" }).run()).toThrow(/shows its tab/);
    expect(() => call("toggleSidebar", {}, { window: win(state({ bot: undefined, tab: { kind: "settings" } })) }).run()).toThrow(/shows its tab/);
    expect(() => call("state", {}, { window: undefined }).run()).toThrow(/shows its tab/);
    // A child plugin of Alpha (its sidebar) is Alpha's; a plugin whose id only begins the same is not.
    expect(call("state", {}, { id: "alpha/sidebar" }).run().kind).toBe("answer");
    expect(ownsShownBot("alphabet", state())).toBe(false);
    expect(ownsShownBot("alpha", state({ bot: "alpha/side-bot" }))).toBe(true);
  });

  test("the arguments are checked: unknown methods, panel names, places", () => {
    expect(() => call("window.close").run()).toThrow(/not a shell call/);
    expect(() => call(undefined).run()).toThrow(/not a shell call/);
    expect(() => call("togglePanel", { view: "../x" }).run()).toThrow(/panel view/);
    expect(() => call("togglePanel", {}).run()).toThrow(/panel view/);
    expect(() => call("go", { target: { bot: "a", app: "b" } }).run()).toThrow(/one place/);
    expect(() => call("go", { target: { url: "x" } }).run()).toThrow(/not a place/);
    expect(() => call("go", { target: "plugins" }).run()).toThrow(/one place/);
  });

  test("only plugins that hold shell.read and own the shown bot hear the window", () => {
    expect(hearsShell({ id: "alpha", capabilities: new Set(["shell.read"]) }, state())).toBe(true);
    expect(hearsShell({ id: "alpha", capabilities: new Set(["shell.control"]) }, state())).toBe(false);
    expect(hearsShell({ id: "luna", capabilities: new Set(["shell.read"]) }, state())).toBe(false);
  });

  test("a report from the shell is kept as data: names, numbers, nothing else", () => {
    const r = cleanReport({ state: { ...state(), extra: "no", panels: { open: ["session", "../x", 3], available: ["browser"] }, safeArea: { left: 80, top: -5 } }, apps: [{ id: "archive", title: "Archive", icon: "x" }, { id: "bad id!", title: "no" }, "junk"] });
    expect(r?.state.panels).toEqual({ open: ["session"], available: ["browser"] });
    expect(r?.state.safeArea).toEqual({ left: 80, top: 0 });
    expect(r?.apps).toEqual([{ id: "archive", title: "Archive", icon: "x" }]);
    expect(cleanReport({ state: state(), account: { name: "Delta", detail: "laptop", extra: 1 } })?.account).toEqual({ name: "Delta", detail: "laptop" });
    // Settings over the tab: `dialog` is kept as that one word, anything else dropped.
    expect(cleanReport({ state: { ...state(), dialog: "settings" } })?.state.dialog).toBe("settings");
    expect(cleanReport({ state: { ...state(), dialog: "evil" } })?.state).not.toHaveProperty("dialog");
    expect(cleanReport({ state: state(), account: { name: 3 } })?.account).toBeUndefined();
    expect((r?.state as unknown as Record<string, unknown>).extra).toBeUndefined();
    expect(cleanReport({ state: { tab: { kind: "weird" } } })).toBeUndefined();
    expect(cleanReport(null)).toBeUndefined();
  });
});

describe("the handles a shown bot's own frames offer (shell.provide)", () => {
  const on = (bot: string | undefined): ShellState => ({ tab: bot ? { kind: "bot", id: bot } : { kind: "app", id: "reel" }, ...(bot ? { bot } : {}), sidebar: { collapsed: false, side: "bots" }, panels: { open: [], available: [] }, safeArea: { left: 0, top: 0 } });
  test("a frame's word is kept while another page shows and counts again when its bot's tab is back; a gone frame is forgotten", () => {
    const provides = new Map<string, ReadonlySet<string>>([["alpha:7:1", new Set(["sidebar"])], ["alpha:7:2", new Set(["sidebar", "drag"])], ["luna:9:1", new Set(["drag"])]]);
    const alive = new Set(["alpha:7:1", "alpha:7:2", "luna:9:1"]);
    expect(providedNow(provides, on("alpha"), (k) => alive.has(k))).toEqual({ sidebar: true, drag: true });
    // An app's page: nothing offered, and nothing forgotten.
    expect(providedNow(provides, on(undefined), (k) => alive.has(k))).toEqual({ sidebar: false, drag: false });
    expect(provides.size).toBe(3);
    // Back on her tab (her frames kept, never asked again): the same handles at once.
    expect(providedNow(provides, on("alpha"), (k) => alive.has(k))).toEqual({ sidebar: true, drag: true });
    // Only the shown bot's frames count; a frame that is gone (asleep, unloaded) is dropped.
    expect(providedNow(provides, on("luna"), (k) => alive.has(k))).toEqual({ sidebar: false, drag: true });
    alive.delete("alpha:7:2");
    expect(providedNow(provides, on("alpha"), (k) => alive.has(k))).toEqual({ sidebar: true, drag: false });
    expect([...provides.keys()]).toEqual(["alpha:7:1", "luna:9:1"]);
  });
});
