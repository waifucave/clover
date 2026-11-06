// The page script runs inside the tab, sent as source. These run that same source in a separate context with a tiny
// stand-in for the DOM: it must be self-contained, keep its refs between calls, start counting where it's told, and
// never return what's in a password field.

import { describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";

import { SECURE_AUTOCOMPLETE } from "../src/floor";
import { pageExpression, pageScript, type PageCall, type PageOp, type PageRead } from "../src/page";

// ---- a tiny stand-in for the DOM ------------------------------------------------------------------------------------

class FakeNode {
  isConnected = true;
  parentNode: FakeNode | null = null;
}
class FakeElement extends FakeNode {
  shadowRoot = null;
  isContentEditable = false;
  innerText = "";
  textContent = "";
  constructor(readonly tagName: string, readonly attrs: Record<string, string> = {}, readonly box = { left: 10, top: 20, width: 100, height: 30 }) {
    super();
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  getBoundingClientRect() {
    const b = this.box;
    return { left: b.left, top: b.top, width: b.width, height: b.height, right: b.left + b.width, bottom: b.top + b.height };
  }
  closest(): null {
    return null;
  }
  querySelector(): null {
    return null;
  }
}
class FakeHTMLElement extends FakeElement {}
class FakeInput extends FakeHTMLElement {
  labels: unknown[] = [];
  disabled = false;
  indeterminate = false;
  checked = false;
  constructor(public type: string, public value: string, public placeholder = "", attrs: Record<string, string> = {}) {
    super("INPUT", { type, ...attrs });
  }
}
class FakeButton extends FakeHTMLElement {
  labels: unknown[] = [];
  disabled = false;
  constructor(text: string) {
    super("BUTTON");
    this.innerText = text;
    this.textContent = text;
  }
}
class FakeOther {}

function context(elements: FakeElement[], active: FakeElement | null = null) {
  const body = { innerText: "Sign in\n\n\n  Welcome back  \n", textContent: "" };
  const g: Record<string, unknown> = {
    HTMLElement: FakeHTMLElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeOther,
    HTMLSelectElement: FakeOther,
    HTMLLabelElement: FakeOther,
    HTMLButtonElement: FakeButton,
    ShadowRoot: FakeOther,
    Text: FakeOther,
    Event: class {},
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    location: { href: "https://example.com/login" },
    document: {
      readyState: "complete",
      title: "Sign in",
      body,
      documentElement: body,
      scrollingElement: { scrollWidth: 1280, scrollHeight: 2000 },
      activeElement: active,
      querySelectorAll: () => elements,
      querySelector: (s: string) => {
        if (s === "((") throw new Error("not a valid selector");
        return s === "#found" ? {} : null;
      },
      elementFromPoint: () => null,
      getElementById: () => null,
    },
  };
  g.window = g;
  return createContext(g);
}

function run<T>(ctx: object, op: PageOp, args: Record<string, unknown> = {}, base = 1): { next: number; value?: T; error?: string } {
  const call: PageCall = { op, base, secure: SECURE_AUTOCOMPLETE, args };
  // What `returnByValue` does: the answer crosses as JSON.
  return JSON.parse(JSON.stringify(runInContext(pageExpression(call), ctx)));
}

// ---- the tests -------------------------------------------------------------------------------------------------------

describe("the script's source", () => {
  test("is one self-contained function that parses on its own", () => {
    const src = pageScript.toString();
    expect(src.startsWith("function pageScript(")).toBe(true);
    expect(src).not.toMatch(/\b__name\b|\brequire\(|\bimport\b|\bexports\b/);
    expect(() => new Function(`return ${pageExpression({ op: "probe", base: 1, secure: [], args: {} })}`)).not.toThrow();
  });
});

describe("running it", () => {
  test("probe: the load state, text (whitespace-insensitive) and a selector", () => {
    const ctx = context([]);
    expect(run(ctx, "probe", { text: "WELCOME   back", selector: "#found" }).value).toEqual({
      readyState: "complete", url: "https://example.com/login", title: "Sign in", hasText: true, matches: true,
    });
    expect(run(ctx, "probe", { text: "nope", selector: "#missing" }).value).toMatchObject({ hasText: false, matches: false });
    expect(run(ctx, "probe", { selector: "((" }).value).toMatchObject({ badSelector: "not a valid selector" });
  });

  test("read: lists what can be used, never a password's value, and skips hidden inputs", () => {
    const password = new FakeInput("password", "hunter2", "Password");
    const email = new FakeInput("email", "a@b.example", "Email");
    const card = new FakeInput("text", "4242424242424242", "Card", { autocomplete: "cc-number" });
    const hidden = new FakeInput("hidden", "csrf-token-value");
    const tiny = new FakeButton("Invisible");
    tiny.box.width = 0;
    const go = new FakeButton("Go");
    const ctx = context([email, password, card, hidden, tiny, go]);
    const r = run<PageRead>(ctx, "read", { maxText: 100, maxElements: 50 }, 5);
    const read = r.value!;
    expect(read.elements).toEqual([
      { ref: "e5", role: "textbox", name: "Email", value: "a@b.example", box: [10, 20, 100, 30] },
      { ref: "e6", role: "textbox", name: "Password", secure: true, box: [10, 20, 100, 30] },
      { ref: "e7", role: "textbox", name: "Card", secure: true, box: [10, 20, 100, 30] },
      { ref: "e8", role: "button", name: "Go", box: [10, 20, 100, 30] },
    ]);
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(JSON.stringify(r)).not.toContain("4242");
    expect(JSON.stringify(r)).not.toContain("csrf");
    expect(read.text).toBe("Sign in\n\nWelcome back");
    expect(r.next).toBe(9);
    // Refs stay with their elements on the next read.
    const again = run<PageRead>(ctx, "read", {}, 1).value!;
    expect(again.elements.map((e) => e.ref)).toEqual(["e5", "e6", "e7", "e8"]);
  });

  test("over the element cap, the ones nearest the view are kept, in page order", () => {
    const far = new FakeButton("Far");
    far.box.top = 5000;
    const near = [new FakeButton("A"), new FakeButton("B")];
    const ctx = context([far, ...near]);
    const read = run<PageRead>(ctx, "read", { maxElements: 2 }).value!;
    expect(read.elements.map((e) => e.name)).toEqual(["A", "B"]);
    expect(read.omitted).toBe(1);
  });

  test("a ref the world never gave out is gone; the focus is reported as facts for the host to judge", () => {
    const password = new FakeInput("password", "hunter2", "Password");
    const ctx = context([], password);
    // The first call makes the world, so its base is the one that counts.
    expect(run(ctx, "point", { ref: "e99" }, 3).value).toEqual({ gone: true });
    expect(run(ctx, "inspect", { ref: "e99" }, 50).value).toEqual({ gone: true });
    const focus = run(ctx, "active", {}, 50);
    expect(focus.value).toEqual({
      kind: "element", facts: { tag: "INPUT", type: "password", autocomplete: "", contentEditable: false }, label: 'textbox "Password"', ref: "e3",
    });
    expect(focus.next).toBe(4);
    expect(JSON.stringify(focus)).not.toContain("hunter2");
    expect(run(ctx, "inspect", { ref: "e3" }).value).toMatchObject({ facts: { type: "password" }, disabled: false });
  });

  test("nothing focused, and an unknown op", () => {
    const ctx = context([]);
    expect(run(ctx, "active").value).toEqual({ kind: "none" });
    expect(run(ctx, "fly" as PageOp).error).toBe("unknown page op fly");
  });
});
