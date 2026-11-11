// A real press on a sealed button is never lost in silence (the first-card race of try 11's packaged run): before the
// page is ready to take it, the card says to press again; the page says when it is ready (body[data-ready]); and the
// press then answers. Both card pages: the island's button frame and the app's own fallback card. The page's script runs
// here in happy-dom with an IntersectionObserver stub that reports the button whole and visible.
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
import { PRESS_AGAIN_TEXT, buttonPage, ownCardPage } from "../src/main/sealed-pages";

function load(html: string, answers: string[]) {
  const g = globalThis as unknown as Record<string, unknown>;
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? "";
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  document.body.innerHTML = body;
  delete document.body.dataset.ready;
  g.IntersectionObserver = class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe(t: Element) { this.cb([{ target: t, intersectionRatio: 1, isVisible: true }]); }
  };
  for (const b of document.querySelectorAll(".seal-button")) (b as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({ width: 80, height: 32 });
  g.cloverSealed = { visible: () => {}, size: () => {}, answer: async (o: string) => { answers.push(o); return { accepted: true }; } };
  new Function(script)();
  window.dispatchEvent(new Event("DOMContentLoaded"));
  return { win: window, doc: document };
}
const press = (_win: unknown, type: "pointerdown" | "click", el: Element) => {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  el.dispatchEvent(e);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a press before the page is ready", () => {
  test("the island's button frame: says to press again, then answers once ready", async () => {
    const answers: string[] = [];
    const html = buttonPage({ cardId: "c1", token: "t", option: "approve", label: "Approve", kind: "approve" });
    const { win, doc } = load(html, answers);
    const btn = doc.querySelector(".seal-button")!;
    press(win, "pointerdown", btn);
    expect(answers).toEqual([]);
    expect(doc.querySelector(".state")!.textContent).toBe(PRESS_AGAIN_TEXT);
    expect(doc.body.dataset.ready).toBe("no");
    expect((btn as HTMLElement).dataset.again).toBe("yes");
    await wait(800);
    expect(doc.body.dataset.ready).toBe("yes");
    press(win, "pointerdown", btn);
    await wait(20);
    expect(answers).toEqual(["approve"]);
    window.dispatchEvent(new Event("pagehide"));
  });
  test("the fallback card: says to press again, then answers once the pointer is in and a second has passed", async () => {
    const answers: string[] = [];
    const html = ownCardPage({ cardId: "c1", token: "t", origin: "x", issuedAt: 0, expiresAt: null, options: [{ id: "approve", kind: "approve", label: "Approve" }, { id: "deny", kind: "deny", label: "Deny" }], fields: {} } as never);
    const { win, doc } = load(html, answers);
    const btn = doc.querySelector(".seal-button[data-kind=approve]")!;
    press(win, "click", btn);
    expect(answers).toEqual([]);
    expect(doc.querySelector(".state")!.textContent).toBe(PRESS_AGAIN_TEXT);
    expect((btn as HTMLElement).dataset.again).toBe("yes");
    expect(btn.getAttribute("title")).toBe(PRESS_AGAIN_TEXT);
    doc.dispatchEvent(new Event("pointerover"));
    await wait(1_150);
    expect(doc.body.dataset.ready).toBe("yes");
    press(win, "click", btn);
    await wait(20);
    expect(answers).toEqual(["approve"]);
    window.dispatchEvent(new Event("pagehide"));
  });
});

describe("a press at any moment of a fresh page", () => {
  test("20 fresh island button pages, each pressed every 60 ms from load: every press before ready says so, the first after answers, never twice", async () => {
    for (let i = 0; i < 20; i++) {
      const answers: string[] = [];
      const { win, doc } = load(buttonPage({ cardId: `c${i}`, token: "t", option: "approve", label: "Approve", kind: "approve" }), answers);
      const btn = doc.querySelector(".seal-button")!;
      let early = 0;
      for (let t = 0; t < 12 && answers.length === 0; t++) {
        press(win, "pointerdown", btn);
        await wait(0);
        if (answers.length === 0) { expect(doc.querySelector(".state")!.textContent).toBe(PRESS_AGAIN_TEXT); early++; }
        await wait(60);
      }
      expect(answers).toEqual(["approve"]);
      expect(early).toBeGreaterThan(0);
      window.dispatchEvent(new Event("pagehide"));
    }
  }, 30_000);
});
