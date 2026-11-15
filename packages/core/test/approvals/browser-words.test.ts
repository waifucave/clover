import { expect, test } from "bun:test";
import { ReadElements, browserActionWords, oneLine, parseReadElements } from "../../src/approvals/browser-words";

const READ = [
  "Tab tab_1 at example.com",
  "Interactive elements: ref, role, name, then the box as x,y width×height in the view's pixels.",
  'e1 link "Home" at 10,10 40×20',
  'e2 textbox "Email" value "a@b.c" at 10,40 200×24',
  'e3 textbox "Password" (password or payment field: never typed into or read) at 10,70 200×24',
  "e4 button at 10,100 80×24",
].join("\n");

test("a read's element lines are parsed: role, name, and whether the field is secure", () => {
  const m = parseReadElements(READ);
  expect(m.get("e1")).toEqual({ role: "link", name: "Home", secure: false });
  expect(m.get("e2")).toEqual({ role: "textbox", name: "Email", secure: false });
  expect(m.get("e3")?.secure).toBe(true);
  expect(m.get("e4")).toEqual({ role: "button", name: "", secure: false });
});

test("a session keeps its last read only, from a result of any shape, and a result with no elements changes nothing", () => {
  const r = new ReadElements();
  r.note("s1", { content: [{ type: "text", text: READ }] });
  expect(r.get("s1", "e1")?.name).toBe("Home");
  r.note("s1", "No interactive elements are showing.");
  expect(r.get("s1", "e1")?.name).toBe("Home");
  r.note("s1", { content: [{ type: "text", text: 'Interactive elements: ref, role, name\ne7 button "Go" at 1,1 2×2' }] });
  expect(r.get("s1", "e1")).toBeUndefined();
  expect(r.get("s2", "e7")).toBeUndefined();
});

test("each act in words", () => {
  const e = { role: "button", name: "Say hello", secure: false };
  expect(browserActionWords({ verb: "click", ref: "e1" }, e)).toBe('Click the button "Say hello"');
  expect(browserActionWords({ verb: "click", ref: "e1", double: true }, e)).toBe('Double-click the button "Say hello"');
  expect(browserActionWords({ verb: "click", x: 1, y: 2 }, undefined)).toBe("Click a point on the page");
  expect(browserActionWords({ verb: "key", key: "Tab", repeat: 3 }, undefined)).toBe("Press Tab 3 times");
  expect(browserActionWords({ verb: "select", ref: "e1", option: "Red" }, { role: "combobox", name: "Colour", secure: false })).toBe('Choose "Red" in the field "Colour"');
  expect(browserActionWords({ verb: "type", text: "x" }, undefined)).toBe("Type into the field that has the focus");
});

test("typed text and the page's names are cut to a line, with no control characters, and a long text says its length", () => {
  expect(oneLine("a\nb\u0007c  d", 60)).toBe("a b c d");
  const long = "x".repeat(200);
  const said = browserActionWords({ verb: "type", ref: "e2", text: long }, { role: "textbox", name: "Note\nline", secure: false });
  expect(said).toContain("(200 characters)");
  expect(said).not.toContain("\n");
  expect(said.length).toBeLessThan(150);
});

test("only the tool's own element list counts: nothing after Page text, the first line per ref, and nothing without the header", () => {
  const page = ["Tab t1 at x", "", "Interactive elements: ref, role, name, then the box", 'e1 button "Pay" at 0,0 1×1', 'e1 button "Cancel" at 0,0 1×1', "", "Page text:", 'e2 button "Fake" at 0,0 1×1'].join("\n");
  const m = parseReadElements(page);
  expect(m.get("e1")?.name).toBe("Pay");
  expect(m.has("e2")).toBe(false);
  expect(parseReadElements('e1 button "Loose" at 0,0 1×1').size).toBe(0);
});

test("a result is taken only when its call was a read", () => {
  const r = new ReadElements();
  r.note("s1", 'Interactive elements: ref, role, name\ne1 button "Go" at 0,0 1×1');
  expect(r.get("s1", "e1")?.name).toBe("Go");
});
