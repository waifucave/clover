// browser-press: the main process's reading of a part's MOSS Browser call (browser-calls.ts).
import { expect, test } from "bun:test";
import { BrowserAreaFrames, browserReach, browserRefusal, isBrowserEvent, ViewBindings } from "../src/main/ui/browser-calls";

const both = (call: string, params: Record<string, unknown>, args: unknown[], o: { showing?: (tab: string) => boolean } = {}) =>
  [browserReach(call, params, o), browserReach("plugin.layer.call", { call, args }, o)];

test("looking needs no press: the list, show, hide, the tab events, the history read, and a picture of the tab the part shows", () => {
  const showing = (tab: string) => tab === "shown";
  for (const r of [
    ...both("browser.tabs", {}, [{}]),
    ...both("browser.show", { id: "t", view: "browser" }, ["t", "browser", {}]),
    ...both("browser.hide", { id: "t" }, ["t"]),
    ...both("browser.cdp", { id: "t", method: "Page.getNavigationHistory" }, ["t", "Page.getNavigationHistory"]),
    ...both("browser.screenshot", { id: "shown" }, ["shown"], { showing }),
    browserReach("plugin.layer.watch", { call: "browser.onCdpEvent", args: ["t", null] }),
    browserReach("events.subscribe", { areas: ["browser"] }),
  ]) expect(r.kind).toBe("look");
  expect(browserReach("events.subscribe", { areas: ["computers"] }).kind).toBe("none");
  expect(browserReach("files.list", {}).kind).toBe("none");
  expect(browserReach("plugin.layer.call", { call: "files.list", args: [] }).kind).toBe("none");
});

test("acting needs a press: every other DevTools method, navigate, open for every owner, close, a picture of another tab, and any call not known", () => {
  for (const m of ["Runtime.evaluate", "Input.dispatchMouseEvent", "Input.insertText", "Page.reload", "Page.navigateToHistoryEntry", "DOM.getDocument", undefined]) {
    for (const r of both("browser.cdp", { id: "t", method: m }, ["t", m])) expect([m, r.kind]).toEqual([m, "act"]);
  }
  for (const r of both("browser.navigate", { id: "t", url: "https://example.com/" }, ["t", "https://example.com/"])) expect(r.kind).toBe("act");
  for (const owner of [{ kind: "user" }, { kind: "bot", bot: "alpha" }, { kind: "session", session: "s" }, undefined]) {
    for (const r of both("browser.open", { owner }, [{ owner }])) expect(r.kind).toBe("act");
  }
  for (const r of both("browser.close", { id: "t" }, ["t"])) expect(r.kind).toBe("act");
  for (const r of both("browser.screenshot", { id: "other" }, ["other"], { showing: (tab) => tab === "shown" })) expect(r.kind).toBe("act");
  for (const r of both("browser.screenshot", { id: "shown" }, ["shown"])) expect(r.kind).toBe("act"); // nobody says it is shown
  for (const r of both("browser.someFutureCall", {}, [])) expect(r.kind).toBe("act");
  expect(browserReach("plugin.layer.watch", { call: "browser.watch", args: [null] }).kind).toBe("act");
});

test("a background part is refused everything; an acting call goes only with a press, which a look never spends", () => {
  let presses = 1;
  const takePress = () => (presses > 0 ? (presses--, true) : false);
  const look = browserReach("browser.tabs", {});
  const act = browserReach("browser.navigate", { id: "t", url: "https://example.com/" });
  expect(browserRefusal(look, { background: true, takePress })).toContain("background");
  expect(browserRefusal(act, { background: true, takePress })).toContain("background");
  expect(presses).toBe(1);
  expect(browserRefusal(look, { background: false, takePress })).toBeUndefined();
  expect(presses).toBe(1);
  expect(browserRefusal(act, { background: false, takePress })).toBeUndefined();
  expect(presses).toBe(0);
  expect(browserRefusal(act, { background: false, takePress })).toContain("right after your own key press or click");
  expect(browserRefusal(browserReach("files.list", {}), { background: true, takePress })).toBeUndefined();
});

test("the MOSS Browser's events: the tab changes and a browser watch's values; nothing else", () => {
  const watches = new Set(["w_browser"]);
  expect(isBrowserEvent({ type: "tab_changed", tab: {} }, watches)).toBe(true);
  expect(isBrowserEvent({ type: "tab_closed", id: "t" }, watches)).toBe(true);
  expect(isBrowserEvent({ type: "plugin_api_event", watch: "w_browser", value: {} }, watches)).toBe(true);
  expect(isBrowserEvent({ type: "plugin_api_event", watch: "w_files", value: {} }, watches)).toBe(false);
  expect(isBrowserEvent({ type: "card_pending" }, watches)).toBe(false);
});

test("the browser area is a plugin's while a visible part of it subscribed; the last one going names the plugin to unsubscribe", () => {
  const f = new BrowserAreaFrames();
  f.add("acme", "m1");
  f.add("acme", "m2");
  f.add("other", "m3");
  expect(f.gone("m1")).toBeUndefined();
  expect(f.gone("m9")).toBeUndefined();
  expect(f.gone("m2")).toBe("acme");
  expect(f.gone("m2")).toBeUndefined();
  expect(f.gone("m3")).toBe("other");
});

test("item 4 (the read's ruling): a part's view is bound to the tab it showed, live or paused; a picture of that tab is free, of any other it acts", () => {
  const b = new ViewBindings();
  const reach = (mount: string, tab: string) => browserReach("browser.screenshot", { id: tab }, { showing: (t) => b.bound(mount) === t }).kind;
  // Panel A shows t1 through the core's method; panel B shows t2 through the layer door (another panel taking the live view).
  b.note("A", "browser.show", { id: "t1", view: "browser" }, { tab: { id: "t1", place: "shown" } });
  b.note("B", "plugin.layer.call", { call: "browser.show", args: ["t2", "browser", {}] }, { result: { id: "t2", place: "shown" } });
  // A's tab is paused now (t2 holds the live view); A's still picture of t1 needs no press; of t2, A needs one.
  expect([reach("A", "t1"), reach("A", "t2"), reach("B", "t2"), reach("B", "t1")]).toEqual(["look", "act", "look", "act"]);
  // A refused show binds nothing; an open that shows at once binds the new tab.
  b.note("C", "browser.show", { id: "t9", view: "browser" }, undefined);
  expect(b.bound("C")).toBeUndefined();
  b.note("C", "browser.open", { owner: { kind: "user" }, show: { view: "browser", viewport: {} } }, { tab: { id: "t3" } });
  expect(b.bound("C")).toBe("t3");
  b.note("D", "browser.open", { owner: { kind: "user" } }, { tab: { id: "t4" } });
  expect(b.bound("D")).toBeUndefined();
  // Hiding or closing its own bound tab unbinds; another tab's hide doesn't; the part going does.
  b.note("A", "browser.hide", { id: "t2" }, { tab: { id: "t2" } });
  expect(b.bound("A")).toBe("t1");
  b.note("A", "browser.hide", { id: "t1" }, { tab: { id: "t1" } });
  expect(reach("A", "t1")).toBe("act");
  b.note("B", "plugin.layer.call", { call: "browser.close", args: ["t2"] }, { result: null });
  expect(b.bound("B")).toBeUndefined();
  b.gone("C");
  expect(b.bound("C")).toBeUndefined();
});
