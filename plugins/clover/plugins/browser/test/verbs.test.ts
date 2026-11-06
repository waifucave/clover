// Every verb, against the fake browser: which API calls and DevTools calls it makes, what it answers, and that every
// DevTools call stays inside the allowed domains.

import { afterEach, describe, expect, test } from "bun:test";

import type { PageRead } from "../src/page";
import { ALPHA, harness, tabView, type Harness } from "./fakes";

let current: Harness | undefined;
async function setup(...args: Parameters<typeof harness>): Promise<Harness> {
  current = await harness(...args);
  return current;
}
afterEach(() => {
  // Whatever a test did, the tool never asked for a DevTools method outside the allow list.
  expect(current?.browser.refusedMethods ?? []).toEqual([]);
  current = undefined;
});

const one = () => [tabView("t1", ALPHA)];

describe("tabs, open, close", () => {
  test("tabs says when there are none", async () => {
    const h = await setup();
    expect(await h.text({ verb: "tabs" })).toBe("You have no tabs open. Use open to start one.");
  });

  test("tabs marks the current tab, a loading one and one the person holds", async () => {
    const h = await setup([tabView("t1", ALPHA), tabView("t2", ALPHA, { loading: true, heldByUser: true, title: "" })]);
    await h.call({ verb: "reload", tab: "t1" });
    const text = await h.text({ verb: "tabs" });
    expect(text).toBe([
      "Your tabs:",
      't1: "Example Domain" at https://example.com/ (your current tab)',
      "t2: (no title) at https://example.com/ (loading, the person is using it)",
    ].join("\n"));
  });

  test("open opens a tab for the bot and makes it the current one", async () => {
    const h = await setup();
    const text = await h.text({ verb: "open", url: "example.com/docs" });
    expect(text).toBe('Opened tab tab_1 "Opened" at https://example.com/docs. It\'s your current tab now: to go somewhere else, navigate it rather than opening another.');
    expect(h.browser.calls.find((c) => c.name === "open")!.args[0]).toEqual({ owner: ALPHA, url: "https://example.com/docs", computer: "Studio" });
    await h.call({ verb: "reload" });
    expect(h.browser.sent("Page.reload")[0]!.tab).toBe("tab_1");
  });

  test("open with no url opens a blank tab", async () => {
    const h = await setup();
    expect(await h.text({ verb: "open" })).toStartWith("Opened a blank tab, tab_1.");
    expect(h.browser.calls.find((c) => c.name === "open")!.args[0]).toEqual({ owner: ALPHA, computer: "Studio" });
  });

  test("close needs the tab named, and closes it", async () => {
    const h = await setup(one());
    const r = await h.call({ verb: "close" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("close needs the tab");
    expect(await h.text({ verb: "close", tab: "t1" })).toBe("Closed tab t1.");
    expect(h.browser.tabsList).toEqual([]);
  });

  test("with several tabs and no current one, the tool asks which", async () => {
    const h = await setup([tabView("t1", ALPHA), tabView("t2", ALPHA)]);
    const r = await h.call({ verb: "read" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("You have 2 tabs open; say which one with tab: t1, t2.");
  });
});

describe("moving a tab", () => {
  test("navigate goes through the API's navigate", async () => {
    const h = await setup(one());
    expect(await h.text({ verb: "navigate", url: "https://example.org/x" })).toBe('Now on tab t1 "Navigated" at https://example.org/x.');
    expect(h.browser.calls.find((c) => c.name === "navigate")!.args).toEqual(["t1", "https://example.org/x"]);
  });

  test("navigate without a url says how", async () => {
    const h = await setup(one());
    const r = await h.call({ verb: "navigate" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('{"verb":"navigate","url":"https://example.com"}');
  });

  test("back reads the history and goes to the entry before, then waits for it to load", async () => {
    const h = await setup(one());
    expect(await h.text({ verb: "back" })).toBe('Went back: now on tab t1 "Example Domain" at https://example.com/.');
    expect(h.browser.sent("Page.navigateToHistoryEntry")[0]!.params).toEqual({ entryId: 1 });
    expect(h.browser.sent("Page.getNavigationHistory").length).toBe(1);
  });

  test("forward with nowhere to go says so", async () => {
    const h = await setup(one());
    const r = await h.call({ verb: "forward" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("There's no page after this one in the tab.");
    expect(h.browser.sent("Page.navigateToHistoryEntry")).toEqual([]);
  });

  test("reload reloads and waits for the new document", async () => {
    const h = await setup(one());
    expect(await h.text({ verb: "reload" })).toBe('Reloaded tab t1 "Example Domain" at https://example.com/.');
    expect(h.browser.sent("Page.reload").length).toBe(1);
    // The new document gets its own isolated world.
    expect(h.browser.worldsMade).toBe(1);
  });
});

describe("screenshot", () => {
  test("returns the picture as MCP image content with its mime type, and a line about it", async () => {
    const h = await setup(one());
    const r = await h.call({ verb: "screenshot" });
    expect(r.isError).toBeUndefined();
    expect(r.content).toEqual([
      { type: "text", text: 'Screenshot of tab t1 "Example Domain" at https://example.com/: 1280×800 pixels of a 1280×800 view. click and scroll take x and y in this picture\'s pixels.' },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    expect(h.browser.calls.find((c) => c.name === "screenshot")!.args).toEqual(["t1", { format: "png" }]);
  });

  test("works on a tab the person holds, and says to only look", async () => {
    const h = await setup([tabView("t1", ALPHA, { heldByUser: true })]);
    const text = await h.text({ verb: "screenshot" });
    expect(text).toContain("The person is using this tab right now, so look but don't act on it yet.");
  });

  test("a jpeg picture says image/jpeg", async () => {
    const h = await setup(one());
    h.browser.shot = { ...h.browser.shot, format: "jpeg" };
    const r = await h.call({ verb: "screenshot" });
    expect(r.content[1]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/jpeg" });
  });
});

describe("read", () => {
  const page: PageRead = {
    url: "https://example.com/login",
    title: "Sign in",
    viewport: { width: 1280, height: 800 },
    scroll: { x: 0, y: 0, width: 1280, height: 2400 },
    text: "Sign in\nEmail\nPassword",
    textLength: 22,
    elements: [
      { ref: "e1", role: "textbox", name: "Email", value: "a@b.example", box: [400, 200, 300, 36] },
      { ref: "e2", role: "textbox", name: "Password", secure: true, box: [400, 250, 300, 36] },
      { ref: "e3", role: "checkbox", name: "Remember me", checked: false, box: [400, 300, 16, 16] },
      { ref: "e4", role: "button", name: "Sign in", disabled: true, box: [400, 900, 80, 32], offscreen: true },
    ],
    omitted: 3,
    frames: 1,
  };

  test("runs the page script in an isolated world and lists refs, roles, names and boxes", async () => {
    const h = await setup(one());
    h.browser.page.read = () => page;
    const text = await h.text({ verb: "read" });
    expect(text).toBe([
      'Tab t1 "Sign in" at https://example.com/login',
      "The view is 1280×800, scrolled to 0,0 of a 1280×2400 page.",
      "",
      "Interactive elements: ref, role, name, then the box as x,y width×height in the view's pixels.",
      'e1 textbox "Email" value "a@b.example" at 400,200 300×36',
      'e2 textbox "Password" (password or payment field: never typed into or read) at 400,250 300×36',
      'e3 checkbox "Remember me" not checked at 400,300 16×16',
      'e4 button "Sign in" disabled at 400,900 80×32, out of view',
      "… and 3 more, further from the view: scroll toward them and read again.",
      "The page has 1 frame; what's inside it isn't read (take a screenshot to see it).",
      "",
      "Page text:",
      "Sign in\nEmail\nPassword",
    ].join("\n"));
    expect(h.browser.cdpCalls.map((c) => c.method)).toEqual(["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"]);
    expect(h.browser.sent("Page.createIsolatedWorld")[0]!.params).toEqual({ frameId: "frame-top", worldName: "clover-browser-tool" });
    const evaluate = h.browser.sent("Runtime.evaluate")[0]!.params!;
    expect(evaluate.contextId).toBe(101);
    expect(evaluate.returnByValue).toBe(true);
    expect(h.browser.pageCalls[0]!.args).toEqual({ maxText: 12_000, maxElements: 200 });
    // The page gets the floor's own list of secure autocomplete tokens.
    expect(h.browser.pageCalls[0]!.secure).toContain("cc-number");
  });

  test("the world is made once per document and its ref counter carries over to the next one", async () => {
    const h = await setup(one());
    h.browser.page.read = () => page;
    await h.call({ verb: "read" });
    h.browser.nextRef = 40;
    await h.call({ verb: "read" });
    expect(h.browser.worldsMade).toBe(1);
    await h.call({ verb: "navigate", url: "https://example.com/next" });
    await h.call({ verb: "read" });
    expect(h.browser.worldsMade).toBe(2);
    expect(h.browser.pageCalls.at(-1)!.base).toBe(40);
  });

  test("a world that went with its document is made again and the call tried once more", async () => {
    const h = await setup(one());
    h.browser.page.read = () => page;
    await h.call({ verb: "read" });
    h.browser.failures.set("cdp:Runtime.evaluate", new Error("Cannot find context with specified id"));
    const r = await h.call({ verb: "read" });
    expect(r.isError).toBeUndefined();
    expect(h.browser.worldsMade).toBe(2);
  });

  test("a long page says it was cut", async () => {
    const h = await setup(one());
    h.browser.page.read = () => ({ ...page, elements: [], omitted: 0, frames: 0, text: "x".repeat(12_000), textLength: 50_000 });
    const text = await h.text({ verb: "read" });
    expect(text).toContain("No interactive elements are showing.");
    expect(text).toEndWith("[Cut: the first 12000 of 50000 characters.]");
  });

  test("a script error in the page is a tool error", async () => {
    // With no fake answer for `read`, the fake page's script reports an error, as a broken script would.
    const h = await setup(one());
    const r = await h.call({ verb: "read" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("The page's script failed: no fake for read");
  });
});

describe("click", () => {
  test("by ref: finds the point in the page, then presses there, with no viewport (the point is fresh)", async () => {
    const h = await setup(one());
    h.browser.page.point = (args) => ({ x: 640, y: 210, facts: { tag: "BUTTON", autocomplete: "", contentEditable: false }, label: `button "Go" (${String(args.ref)})` });
    expect(await h.text({ verb: "click", ref: "[e7]" })).toBe('Clicked e7 (button "Go" (e7)) in tab t1. Read or take a screenshot to see what changed.');
    const mouse = h.browser.sent("Input.dispatchMouseEvent");
    expect(mouse.map((c) => c.params!.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse.every((c) => c.params!.x === 640 && c.params!.y === 210 && c.viewport === undefined)).toBe(true);
    expect(mouse[1]!.params).toEqual({ type: "mousePressed", x: 640, y: 210, button: "left", buttons: 1, clickCount: 1 });
  });

  test("double: two presses, the second with clickCount 2", async () => {
    const h = await setup(one());
    h.browser.page.point = () => ({ x: 10, y: 10, facts: { tag: "DIV" }, label: "clickable" });
    await h.call({ verb: "click", ref: "e1", double: true });
    const mouse = h.browser.sent("Input.dispatchMouseEvent").map((c) => [c.params!.type, c.params!.clickCount]);
    expect(mouse).toEqual([["mouseMoved", undefined], ["mousePressed", 1], ["mouseReleased", 1], ["mousePressed", 2], ["mouseReleased", 2]]);
  });

  test("a ref that's gone, hidden or covered is refused before any press", async () => {
    const h = await setup(one());
    h.browser.page.point = () => ({ gone: true });
    expect((await h.call({ verb: "click", ref: "e3" })).content[0]!.text).toContain("e3 isn't on the page any more");
    h.browser.page.point = () => ({ hidden: true, label: 'link "More"' });
    expect((await h.call({ verb: "click", ref: "e3" })).content[0]!.text).toContain("isn't showing on the page");
    h.browser.page.point = () => ({ x: 1, y: 1, facts: { tag: "A" }, label: 'link "More"', covered: 'button "Accept cookies"' });
    expect((await h.call({ verb: "click", ref: "e3" })).content[0]!.text).toContain('Something else is on top of e3 (link "More"): button "Accept cookies"');
    expect(h.browser.sent("Input.dispatchMouseEvent")).toEqual([]);
  });

  test("a drop-down, a file chooser or a date field is never clicked open", async () => {
    const h = await setup(one());
    h.browser.page.point = () => ({ x: 1, y: 1, facts: { tag: "SELECT" }, label: 'combobox "Country"' });
    expect((await h.call({ verb: "click", ref: "e3" })).content[0]!.text).toContain("Use select with ref e3");
    h.browser.page.point = () => ({ x: 1, y: 1, facts: { tag: "INPUT", type: "file" }, label: "file chooser" });
    expect((await h.call({ verb: "click", ref: "e4" })).content[0]!.text).toContain("file chooser, which the browser tool can't use");
    h.browser.page.point = () => ({ x: 1, y: 1, facts: { tag: "INPUT", type: "date" }, label: "date field" });
    expect((await h.call({ verb: "click", ref: "e5" })).content[0]!.text).toContain("like YYYY-MM-DD");
    expect(h.browser.sent("Input.dispatchMouseEvent")).toEqual([]);
  });

  test("by x and y: needs a screenshot first", async () => {
    const h = await setup(one());
    const r = await h.call({ verb: "click", x: 100, y: 100 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Take a screenshot first");
    expect(h.browser.cdpCalls).toEqual([]);
  });

  test("by x and y: passes the screenshot's viewport, so the core can refuse a stale point", async () => {
    const h = await setup(one());
    h.browser.page.at = () => ({ facts: { tag: "A" }, label: 'link "Pricing"', ref: "e9" });
    await h.call({ verb: "screenshot" });
    expect(await h.text({ verb: "click", x: 300, y: 120 })).toBe('Clicked at (300, 120) on e9 (link "Pricing") in tab t1. Read or take a screenshot to see what changed.');
    const mouse = h.browser.sent("Input.dispatchMouseEvent");
    expect(mouse.length).toBe(3);
    expect(mouse.every((c) => c.viewport?.width === 1280 && c.viewport?.height === 800 && c.params!.x === 300 && c.params!.y === 120)).toBe(true);
    expect(h.browser.pageCalls.find((c) => c.op === "at")!.args).toEqual({ x: 300, y: 120 });
  });

  test("by x and y on a high-density picture: scaled back to the view's pixels", async () => {
    const h = await setup(one());
    h.browser.shot = { ...h.browser.shot, width: 2560, height: 1600 };
    h.browser.page.at = () => ({ none: true });
    await h.call({ verb: "screenshot" });
    await h.call({ verb: "click", x: 1000, y: 500 });
    const pressed = h.browser.sent("Input.dispatchMouseEvent")[1]!;
    expect([pressed.params!.x, pressed.params!.y]).toEqual([500, 250]);
    expect(pressed.viewport).toEqual({ width: 1280, height: 800 });
  });

  test("by x and y outside the picture is refused", async () => {
    const h = await setup(one());
    await h.call({ verb: "screenshot" });
    const r = await h.call({ verb: "click", x: 1280, y: 10 });
    expect(r.content[0]!.text).toBe("(1280, 10) is outside your latest screenshot of this tab, which is 1280×800.");
  });

  test("by x and y after the tab changed size: refused here, before the core has to", async () => {
    const h = await setup(one());
    await h.call({ verb: "screenshot" });
    h.browser.tabsList[0]!.viewport = { width: 900, height: 600 };
    const r = await h.call({ verb: "click", x: 10, y: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Take a new screenshot");
    expect(h.browser.sent("Input.dispatchMouseEvent")).toEqual([]);
  });

  test("by x and y when the core finds the point stale: the core's refusal comes back in plain words", async () => {
    const h = await setup(one());
    h.browser.page.at = () => ({ none: true });
    await h.call({ verb: "screenshot" });
    // The tab changed size between the tool's look at it and the press.
    const realTabs = h.browser.tabs.bind(h.browser);
    h.browser.tabs = async (f) => {
      const views = await realTabs(f);
      h.browser.tabsList[0]!.viewport = { width: 1024, height: 768 };
      return views;
    };
    const r = await h.call({ verb: "click", x: 10, y: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("That point came from a screenshot taken at another size: the tab has changed size since. Take a new screenshot and use its points.");
  });

  test("with neither a ref nor a point, says how", async () => {
    const h = await setup(one());
    expect((await h.call({ verb: "click" })).content[0]!.text).toContain('like {"verb":"click","ref":"e12"}');
  });
});

describe("type", () => {
  const field = { facts: { tag: "INPUT", type: "text", autocomplete: "", contentEditable: false }, label: 'textbox "Search"', disabled: false };

  test("into a ref: checks the field, focuses and selects it, then types each character as a key", async () => {
    const h = await setup(one());
    h.browser.page.inspect = () => field;
    h.browser.page.focus = () => ({ ...field, focused: true });
    expect(await h.text({ verb: "type", ref: "e2", text: "Hi!" })).toBe('Typed 3 characters into e2 (textbox "Search"), replacing what was there.');
    expect(h.browser.ops()).toEqual(["inspect", "focus"]);
    expect(h.browser.pageCalls[1]!.args).toEqual({ ref: "e2", select: true });
    const keys = h.browser.sent("Input.dispatchKeyEvent").map((c) => [c.params!.type, c.params!.key, c.params!.modifiers]);
    expect(keys).toEqual([
      ["keyDown", "H", 8], ["keyUp", "H", 8], ["keyDown", "i", 0], ["keyUp", "i", 0], ["keyDown", "!", 8], ["keyUp", "!", 8],
    ]);
  });

  test("long or multi-line text is inserted at once, and characters with no key are inserted one by one", async () => {
    const h = await setup(one());
    h.browser.page.inspect = () => field;
    h.browser.page.focus = () => ({ ...field, focused: true });
    await h.call({ verb: "type", ref: "e2", text: "line one\nline two" });
    expect(h.browser.sent("Input.insertText").map((c) => c.params!.text)).toEqual(["line one\nline two"]);
    await h.call({ verb: "type", ref: "e2", text: "é" });
    expect(h.browser.sent("Input.insertText").map((c) => c.params!.text)).toEqual(["line one\nline two", "é"]);
    await h.call({ verb: "type", ref: "e2", text: "y".repeat(201) });
    expect(h.browser.sent("Input.insertText").at(-1)!.params!.text).toBe("y".repeat(201));
  });

  test("empty text with a ref clears the field", async () => {
    const h = await setup(one());
    h.browser.page.inspect = () => field;
    h.browser.page.focus = () => ({ ...field, focused: true });
    expect(await h.text({ verb: "type", ref: "e2", text: "" })).toBe('Cleared e2 (textbox "Search").');
    expect(h.browser.sent("Input.dispatchKeyEvent").map((c) => c.params!.key)).toEqual(["Delete", "Delete"]);
  });

  test("without a ref: types where the focus is, after checking what has it", async () => {
    const h = await setup(one());
    h.browser.page.active = () => ({ kind: "element", facts: field.facts, label: 'textbox "Search"', ref: "e2" });
    expect(await h.text({ verb: "type", text: "ok" })).toBe('Typed 2 characters into textbox "Search" (e2).');
    expect(h.browser.ops()).toEqual(["active"]);
    expect(h.browser.sent("Input.dispatchKeyEvent").length).toBe(4);
  });

  test("a date field's value is set directly, never through its picker", async () => {
    const h = await setup(one());
    h.browser.page.inspect = () => ({ facts: { tag: "INPUT", type: "date" }, label: "date field", disabled: false });
    h.browser.page.setValue = (args) => ({ value: args.value === "2026-11-05" ? "2026-11-05" : "" });
    expect(await h.text({ verb: "type", ref: "e4", text: "2026-11-05" })).toBe('Set e4 (date field) to "2026-11-05".');
    const r = await h.call({ verb: "type", ref: "e4", text: "next tuesday" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("it takes a value like YYYY-MM-DD");
    expect(h.browser.sent("Input.dispatchKeyEvent")).toEqual([]);
  });

  test("a button or a drop-down isn't typed into", async () => {
    const h = await setup(one());
    h.browser.page.inspect = () => ({ facts: { tag: "BUTTON" }, label: 'button "Go"', disabled: false });
    expect((await h.call({ verb: "type", ref: "e1", text: "x" })).content[0]!.text).toContain("isn't a text field");
    h.browser.page.inspect = () => ({ facts: { tag: "SELECT" }, label: 'combobox "Size"', disabled: false });
    expect((await h.call({ verb: "type", ref: "e1", text: "x" })).content[0]!.text).toContain("use select");
    expect(h.browser.sent("Input.dispatchKeyEvent")).toEqual([]);
  });
});

describe("key", () => {
  test("presses a key down and up, repeat times", async () => {
    const h = await setup(one());
    expect(await h.text({ verb: "key", key: "Tab", repeat: 2 })).toBe("Pressed Tab 2 times in tab t1.");
    const keys = h.browser.sent("Input.dispatchKeyEvent").map((c) => [c.params!.type, c.params!.key]);
    expect(keys).toEqual([["rawKeyDown", "Tab"], ["keyUp", "Tab"], ["rawKeyDown", "Tab"], ["keyUp", "Tab"]]);
  });

  test("a combination carries its modifiers, and on a Mac its editing commands", async () => {
    const h = await setup(one(), { mac: true });
    h.browser.page.active = () => ({ kind: "element", facts: { tag: "TEXTAREA" }, label: "textbox" });
    await h.call({ verb: "key", key: "cmd+a" });
    const down = h.browser.sent("Input.dispatchKeyEvent")[0]!.params!;
    expect(down).toMatchObject({ type: "rawKeyDown", key: "a", modifiers: 4, commands: ["selectAll"] });
  });

  test("copy, cut and paste are refused", async () => {
    const h = await setup(one());
    for (const key of ["ctrl+c", "cmd+v", "ctrl+x", "shift+Insert"]) {
      const r = await h.call({ verb: "key", key });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("clipboard");
    }
    expect(h.browser.sent("Input.dispatchKeyEvent")).toEqual([]);
  });

  test("an unknown key name says what works", async () => {
    const h = await setup(one());
    expect((await h.call({ verb: "key", key: "Hyper" })).content[0]!.text).toContain("isn't a key name");
  });
});

describe("scroll", () => {
  test("a direction scrolls with the wheel at the middle of the view, passing the tab's viewport", async () => {
    const h = await setup(one());
    expect(await h.text({ verb: "scroll", direction: "down" })).toBe("Scrolled down 640 pixels in tab t1. Read or take a screenshot to see where you are.");
    const wheel = h.browser.sent("Input.dispatchMouseEvent")[0]!;
    expect(wheel.params).toEqual({ type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 640 });
    expect(wheel.viewport).toEqual({ width: 1280, height: 800 });
  });

  test("at a point on the screenshot, by an amount, left", async () => {
    const h = await setup(one());
    await h.call({ verb: "screenshot" });
    await h.call({ verb: "scroll", direction: "left", amount: 300, x: 100, y: 700 });
    const wheel = h.browser.sent("Input.dispatchMouseEvent")[0]!;
    expect(wheel.params).toEqual({ type: "mouseWheel", x: 100, y: 700, deltaX: -300, deltaY: 0 });
    expect(wheel.viewport).toEqual({ width: 1280, height: 800 });
  });

  test("a ref is scrolled into view by the page", async () => {
    const h = await setup(one());
    h.browser.page.scrollTo = () => ({ label: 'link "Next"' });
    expect(await h.text({ verb: "scroll", ref: "e40" })).toBe('Scrolled e40 (link "Next") into view.');
    expect(h.browser.sent("Input.dispatchMouseEvent")).toEqual([]);
  });

  test("with neither, says how", async () => {
    const h = await setup(one());
    expect((await h.call({ verb: "scroll" })).content[0]!.text).toContain("scroll needs a direction");
  });
});

describe("select", () => {
  const dropdown = { facts: { tag: "SELECT", autocomplete: "" }, label: 'combobox "Country"', disabled: false };

  test("picks the option by its text", async () => {
    const h = await setup(one());
    h.browser.page.inspect = () => dropdown;
    h.browser.page.select = (args) => ({ chosen: String(args.option), label: 'combobox "Country"' });
    expect(await h.text({ verb: "select", ref: "e9", option: "Canada" })).toBe('Chose "Canada" in e9 (combobox "Country").');
    expect(h.browser.pageCalls.at(-1)!.args).toEqual({ ref: "e9", option: "Canada" });
  });

  test("a missing option lists the ones there are", async () => {
    const h = await setup(one());
    h.browser.page.inspect = () => dropdown;
    h.browser.page.select = () => ({ noOption: true, options: ["Canada", "Mexico"] });
    const r = await h.call({ verb: "select", ref: "e9", option: "Narnia" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('e9 has no option "Narnia". Its options: "Canada", "Mexico".');
  });

  test("a custom drop-down is clicked instead", async () => {
    const h = await setup(one());
    h.browser.page.inspect = () => ({ facts: { tag: "DIV" }, label: "combobox", disabled: false });
    h.browser.page.select = () => ({ notSelect: true, label: "combobox" });
    expect((await h.call({ verb: "select", ref: "e9", option: "x" })).content[0]!.text).toContain("Click it to open its list");
  });
});

describe("wait", () => {
  test("for text: looks until it shows up", async () => {
    const h = await setup(one());
    let n = 0;
    h.browser.page.probe = () => ({ readyState: "complete", url: "u", title: "t", hasText: ++n >= 3 });
    expect(await h.text({ verb: "wait", text: "Order placed" })).toStartWith('Found the text "Order placed" (after');
    expect(h.browser.pageCalls.filter((c) => c.op === "probe").map((c) => c.args)).toEqual([
      { text: "Order placed" }, { text: "Order placed" }, { text: "Order placed" },
    ]);
  });

  test("for a selector, in the safe subset", async () => {
    const h = await setup(one());
    h.browser.page.probe = (args) => ({ readyState: "complete", url: "u", title: "t", matches: args.selector === "#results li" });
    expect(await h.text({ verb: "wait", selector: "#results li" })).toStartWith("Found something matching #results li");
  });

  test("a selector that tests a value is refused: it could read a password a letter at a time", async () => {
    const h = await setup(one());
    const r = await h.call({ verb: "wait", selector: 'input[value^="a"]' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toStartWith("That selector can't be waited on:");
    expect(h.browser.cdpCalls).toEqual([]);
  });

  test("for the load: the document is complete and the tab no longer loading", async () => {
    const h = await setup([tabView("t1", ALPHA, { loading: true })]);
    let n = 0;
    h.browser.page.probe = () => {
      if (++n === 2) h.browser.tabsList[0]!.loading = false;
      return { readyState: "complete", url: "u", title: "t" };
    };
    expect(await h.text({ verb: "wait" })).toStartWith("The page has loaded (after");
  });

  test("runs out at timeoutMs and says so, without calling it an error", async () => {
    const h = await setup(one());
    h.browser.page.probe = () => ({ readyState: "complete", url: "u", title: "t", hasText: false });
    const r = await h.call({ verb: "wait", text: "never", timeoutMs: 100 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/^Waited .+; the text "never" didn't show up\.$/);
  });
});

describe("one verb at a time per tab", () => {
  test("two calls on one tab don't interleave their DevTools calls", async () => {
    const h = await setup(one());
    h.browser.page.point = () => ({ x: 5, y: 5, facts: { tag: "A" }, label: "link" });
    await Promise.all([h.call({ verb: "click", ref: "e1" }), h.call({ verb: "key", key: "Enter" })]);
    const methods = h.browser.cdpCalls.map((c) => c.method).filter((m) => m.startsWith("Input."));
    expect(methods).toEqual([
      "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
    ]);
  });
});
