// browser-press: the main process's reading of a part's Clover Browser call (browser-calls.ts).
import { expect, test } from "bun:test";
import { BrowserAreaFrames, browserReach, browserRefusal, isBrowserEvent } from "../src/main/ui/browser-calls";

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

test("the Clover Browser's events: the tab changes and a browser watch's values; nothing else", () => {
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
