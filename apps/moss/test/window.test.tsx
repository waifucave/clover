// MOSS's window under happy-dom, with a stub bridge: what a bot wrote is drawn as text and never as markup (the
// reviewer's list for lane MA, item 4), every face has its mood in words beside it, a piece the engine doesn't serve
// yet shows as waiting, and the cards go where the router placed them (the conversation's own, else the strip).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import type { ConversationPage, MossBridge, MossView } from "../src/shared/view";

GlobalRegistrator.register();
// The kit draws on a canvas, which happy-dom has none of: a 2D context that draws nothing.
const noop = new Proxy({}, { get: () => () => undefined });
(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => noop;
afterAll(async () => { await GlobalRegistrator.unregister(); });

const { act, render } = await import("@testing-library/react");
const { App } = await import("../src/window/App");
const { createElement: h } = await import("react");

const EVIL = `<img src=x onerror="window.__pwned=1"><b>bold</b><script>window.__pwned=2</script>`;

function view(over: Partial<MossView> = {}): MossView {
  return {
    connection: { kind: "connected" }, pieces: { bots: "ready" },
    bots: [
      { id: "juniper", name: "Juniper", mood: "working", tool: "mcp__moss__Browser", last: { text: EVIL, from: "bot", at: Date.now() - 60_000 }, unread: true },
      { id: "kite", name: "Kite", mood: "asking", unread: false },
    ],
    cards: [], ...over,
  };
}

function stub(v: MossView, page: ConversationPage | { waiting: true }): MossBridge {
  const none = () => () => {};
  return {
    view: async () => v, onView: none, showing: () => {}, conversation: async () => page, onMessage: none,
    send: async () => ({ ok: true }), pickImages: async () => [], createBot: async () => ({ ok: false, why: "no" }), markRead: () => {},
    routines: async () => [], pictures: async () => [], openPicture: async () => false, closePicture: () => {}, onPictureFrame: none,
    cardFrame: async () => undefined, onCardHeight: none, talk: () => {}, plugins: async () => [], setAvailability: async () => false,
    addPlugin: async () => ({ ok: false, why: "no" }), settings: async () => ({ account: "waiting", signIns: "waiting", computers: "waiting", devices: "waiting" }),
    botSettings: async () => ({ waiting: true }), setBotSetting: async () => false, setLevel: async () => false,
  };
}

async function draw(v: MossView, page: ConversationPage | { waiting: true }) {
  (window as unknown as { moss: MossBridge }).moss = stub(v, page);
  const r = render(h(App));
  await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
  return r;
}

describe("MOSS's window", () => {
  test("a bot's markup is text: no element, no script runs", async () => {
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [{ id: "1", from: "bot", text: EVIL, at: Date.now() }, { id: "2", from: "user", text: "<i>me</i>", at: Date.now() }] });
    const bubbles = [...r.container.querySelectorAll("[data-bubble]")];
    expect(bubbles.length).toBe(2);
    expect(bubbles[0]?.textContent).toBe(EVIL);
    for (const b of bubbles) expect(b.children.length).toBe(0);
    // The list's last line too.
    expect(r.container.querySelector("[data-bot-row=juniper] .row__last")?.textContent).toBe(EVIL);
    expect(r.container.querySelector("[data-bot-row=juniper] .row__last")?.children.length).toBe(0);
    expect(r.container.querySelectorAll("img, b, i, script").length).toBe(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    r.unmount();
  });

  test("every face has its mood in words beside it", async () => {
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [] });
    for (const row of r.container.querySelectorAll("[data-bot-row]")) {
      expect(row.querySelector("canvas[data-face]")).not.toBeNull();
      expect(row.querySelector("[data-mood-words]")?.textContent?.length).toBeGreaterThan(0);
    }
    expect(r.container.querySelector("[data-bot-row=kite] [data-mood-words]")?.textContent).toBe("Needs you");
    expect(r.container.querySelector("[data-bot-row=juniper] [data-mood-words]")?.textContent).toBe("Working · Browser");
    r.unmount();
  });

  test("a conversation the engine doesn't serve yet says so", async () => {
    const r = await draw(view(), { waiting: true });
    expect(r.container.textContent).toContain("Waiting for the engine to serve Juniper's conversation.");
    r.unmount();
  });

  test("the cards go where the router placed them", async () => {
    const r = await draw(view({ cards: [{ id: "card_a1b2c3", bot: "juniper", kind: "tool", place: "conversation" }, { id: "card_d4e5f6", bot: "kite", kind: "tool", place: "strip" }] }), { bot: "juniper", hasMore: false, messages: [] });
    expect(r.container.querySelector(".messages [data-card=card_a1b2c3]")).not.toBeNull();
    expect(r.container.querySelector(".strip [data-card=card_d4e5f6]")).not.toBeNull();
    expect(r.container.querySelector(".strip")?.textContent).toContain("Kite needs you");
    r.unmount();
  });
});
