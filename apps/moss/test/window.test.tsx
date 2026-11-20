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

let retried: string[] = [];
let messageTo: ((bot: string, m: import("../src/shared/view").Message) => void)[] = [];
let viewTo: ((v: MossView) => void)[] = [];
let saidTo: ((cardId: string, words: string) => void)[] = [];
function stub(v: MossView, page: ConversationPage | { waiting: true }): MossBridge {
  const none = () => () => {};
  return {
    view: async () => v, onView: (fn) => { viewTo.push(fn); return () => {}; }, showing: () => {}, conversation: async () => page, onMessage: (fn) => { messageTo.push(fn); return () => {}; },
    send: async () => ({ ok: true }), pickImages: async () => [], createBot: async () => ({ ok: false, why: "no" }), markRead: () => {},
    routines: async () => [], routineInstructions: async () => ({ ok: false, why: "no" }), runRoutine: async () => ({ ok: false, why: "no" }),
    editRoutine: async () => ({ ok: false, why: "no" }), memory: async () => ({ waiting: true }), memoryFile: async () => ({ ok: false, why: "no" }),
    pictures: async () => [], openPicture: async () => false, closePicture: () => {}, onPictureFrame: none,
    cardFrame: async () => undefined, onCardHeight: none, onCardSaid: (fn) => { saidTo.push(fn); return () => {}; }, talk: () => {}, plugins: async () => [], setAvailability: async () => false,
    addPlugin: async () => ({ ok: false, why: "no" }), settings: async () => ({ account: "waiting", signIns: "waiting", computers: "waiting", devices: "waiting" }),
    botSettings: async () => ({ waiting: true }), setBotSetting: async () => false, setLevel: async () => false,
    setPermission: async () => false, signIn: async () => ({ ok: false, why: "no" }), signOut: async () => false,
    botRecord: async () => ({ waiting: true }), botInstructions: async () => ({ waiting: true }), editBot: async () => false, models: async () => ({ waiting: true }),
    setup: async () => ({ waiting: true }), setupProviders: async () => ({ waiting: true }), openTerms: async () => false, setDefaultModel: async () => ({ ok: false, why: "no" }), skipSetup: async () => false,
    archiveBot: async () => false, archivedBots: async () => [], restoreBot: async () => false, retry: async (bot) => { retried.push(bot); return { ok: true }; }, pictureInput: () => {},
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
    expect(r.container.querySelector("[data-bot-row=juniper] [data-mood-words]")?.textContent).toBe("Using the browser");
    r.unmount();
  });

  test("a running turn shows ONE status line, not a control; no tool row is drawn; an idle bot shows none", async () => {
    const page = { bot: "juniper", hasMore: false, messages: [{ id: "1", from: "user" as const, text: "go", at: Date.now() }] };
    const r = await draw(view({ bots: [{ id: "juniper", name: "Juniper", mood: "working", tool: "Read", detail: "notes.txt", unread: false }] }), page);
    const lines = r.container.querySelectorAll("[data-status-line]");
    expect(lines.length).toBe(1);
    expect(lines[0]?.querySelector("[data-status-text]")?.textContent).toBe("Reading notes.txt");
    expect(lines[0]?.querySelector("button, a, input, [tabindex], [role=button]")).toBeNull();
    expect(lines[0]?.querySelector("[role=status][aria-live=polite]")).not.toBeNull();
    // The words of a tool call never appear as a row of the conversation.
    expect(r.container.querySelectorAll("[data-bubble]").length).toBe(1);
    expect(r.container.textContent).not.toMatch(/Used |Bash|tool_/);
    r.unmount();
    const idle = await draw(view({ bots: [{ id: "juniper", name: "Juniper", mood: "idle", unread: false }] }), page);
    expect(idle.container.querySelector("[data-status-line]")).toBeNull();
    idle.unmount();
  });

  test("a reply hides the status line for that state only; the next turn's line shows again", async () => {
    messageTo = []; viewTo = [];
    const page = { bot: "juniper", hasMore: false, messages: [] };
    const running = (mood: "thinking" | "idle") => view({ bots: [{ id: "juniper", name: "Juniper", mood, unread: false }] });
    const r = await draw(running("thinking"), page);
    expect(r.container.querySelector("[data-status-text]")?.textContent).toBe("Thinking");
    await act(async () => { for (const f of messageTo) f("juniper", { id: "m1", from: "bot", text: "Here you go.", at: Date.now() }); });
    expect(r.container.querySelector("[data-status-line]")).toBeNull();
    await act(async () => { for (const f of viewTo) f(running("idle")); });
    expect(r.container.querySelector("[data-status-line]")).toBeNull();
    await act(async () => { for (const f of viewTo) f(running("thinking")); });
    expect(r.container.querySelector("[data-status-text]")?.textContent).toBe("Thinking");
    r.unmount();
  });

  test("a conversation the engine doesn't serve yet says so", async () => {
    const r = await draw(view(), { waiting: true });
    expect(r.container.textContent).toContain("Waiting for the engine to serve Juniper's conversation.");
    r.unmount();
  });

  test("a failed turn shows Try again while it is the last thing; one press asks for it once, and an older failure offers none", async () => {
    retried = [];
    const failed = { id: "f1", from: "note" as const, text: "The turn ended with an error.", at: Date.now(), failed: true as const };
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [{ id: "u1", from: "user", text: "hello", at: Date.now() }, failed] });
    const button = r.container.querySelector<HTMLButtonElement>("[data-try-again]");
    expect(button?.textContent).toBe("Try again");
    await act(async () => { button!.click(); await new Promise((res) => setTimeout(res, 20)); });
    expect(retried).toEqual(["juniper"]);
    expect(r.container.querySelector("[data-try-again]")).toBeNull();
    r.unmount();
    const later = await draw(view(), { bot: "juniper", hasMore: false, messages: [failed, { id: "u2", from: "user", text: "again", at: Date.now() }] });
    expect(later.container.querySelector("[data-try-again]")).toBeNull();
    later.unmount();
  });

  test("a refused press says why beside its card, in plain words drawn as text", async () => {
    saidTo = [];
    const r = await draw(view({ cards: [{ id: "card_a1b2c3", bot: "juniper", kind: "tool", place: "conversation" }] }), { bot: "juniper", hasMore: false, messages: [] });
    await act(async () => { for (const f of saidTo) f("card_a1b2c3", "Computer use is acting right now."); await new Promise((res) => setTimeout(res, 10)); });
    expect(r.container.querySelector("[data-card=card_a1b2c3] [data-card-said]")?.textContent).toBe("Computer use is acting right now.");
    await act(async () => { for (const f of saidTo) f("card_zzz", "<b>not this one</b>"); await new Promise((res) => setTimeout(res, 10)); });
    expect(r.container.querySelectorAll("[data-card-said]").length).toBe(1);
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

describe("the composer and dropped things", () => {
  test("a file dropped on it is said plainly (pictures only, with the paperclip), and nothing is sent", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [] });
    const composer = r.container.querySelector("[data-composer]")!;
    const sent: unknown[] = [];
    (window as unknown as { moss: MossBridge }).moss.send = async (...a: unknown[]) => { sent.push(a); return { ok: true }; };
    await act(async () => { fireEvent.drop(composer, { dataTransfer: { files: [new File(["x"], "report.pdf", { type: "application/pdf" })] } }); });
    expect(r.container.querySelector(".composer__why")?.textContent).toBe("Files aren't supported yet: MOSS sends pictures only (PNG, JPEG or WebP), attached with the paperclip.");
    await act(async () => { fireEvent.drop(composer, { dataTransfer: { files: [new File(["x"], "a.png", { type: "image/png" })] } }); });
    expect(r.container.querySelector(".composer__why")?.textContent).toBe("Dropping isn't supported yet: attach pictures with the paperclip.");
    expect(sent).toEqual([]);
    r.unmount();
  });

  test("a routine that failed shows why in the conversation, marked as a failure", async () => {
    const r = await draw(view(), { bot: "juniper", hasMore: false, messages: [{ id: "n1", from: "note", text: 'Routine "Brief": The run failed (provider): the model refused the key.', at: Date.now(), routineFailed: true }] });
    const note = r.container.querySelector("[data-routine-failed]");
    expect(note?.textContent).toContain("The run failed (provider)");
    r.unmount();
  });
});

describe("the setup guide (2026-11-20)", () => {
  const NOT_SET = { ready: false, missing: ["provider", "model"] as ("provider" | "model")[], providers: [], dismissed: false };
  async function withGuide(v: MossView, over: Partial<MossBridge>) {
    const b = { ...stub(v, { bot: "juniper", hasMore: false, messages: [] }), ...over };
    (window as unknown as { moss: MossBridge }).moss = b;
    const r = render(h(App));
    await act(async () => { await new Promise((res) => setTimeout(res, 30)); });
    return r;
  }

  test("a home that isn't set up opens it by itself; a skip goes to the engine and closes it", async () => {
    let skipped = 0;
    const r = await withGuide(view({ setup: NOT_SET }), {
      setupProviders: async () => [{ pluginId: "moss/model-anthropic", name: "Anthropic", terms: { text: "Be kind." }, auth: [{ index: 0, method: "api-key", state: "signed-out" }] }],
      skipSetup: async () => { skipped++; return true; },
    });
    expect(r.container.querySelector("[data-setup-step=providers]")).not.toBeNull();
    expect(r.container.querySelector("[data-setup-provider='moss/model-anthropic']")).not.toBeNull();
    // Next waits for a provider.
    expect((r.container.querySelector("[data-setup=next]") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { (r.container.querySelector("[data-setup=skip]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 10)); });
    expect(skipped).toBe(1);
    expect(r.container.querySelector("[data-setup-step]")).toBeNull();
    r.unmount();
  });

  test("a home that works, or a guide skipped before, doesn't show it", async () => {
    for (const setup of [{ ...NOT_SET, ready: true, missing: [] }, { ...NOT_SET, dismissed: true }]) {
      const r = await withGuide(view({ setup }), {});
      expect(r.container.querySelector("[data-setup-step]")).toBeNull();
      r.unmount();
    }
  });

  test("the terms come before a provider's way in", async () => {
    const r = await withGuide(view({ setup: NOT_SET }), {
      setupProviders: async () => [{ pluginId: "moss/model-anthropic", name: "Anthropic", terms: { text: "Be kind." }, auth: [{ index: 0, method: "api-key", state: "signed-out" }] }],
    });
    // One provider listed: it is open, its way in disabled until the terms are accepted.
    expect((r.container.querySelector(".setup__ways") as HTMLFieldSetElement).disabled).toBe(true);
    await act(async () => { (r.container.querySelector("[data-setup-terms]") as HTMLInputElement).click(); });
    expect((r.container.querySelector(".setup__ways") as HTMLFieldSetElement).disabled).toBe(false);
    r.unmount();
  });

  test("with several providers the person picks; the pick goes to the engine and done lands in the default bot's conversation", async () => {
    const two = { ready: false, missing: ["model"] as ("provider" | "model")[], providers: ["anthropic", "openai"], recommended: { anthropic: { model: "anthropic/b", effort: "medium" }, openai: { model: "openai/a" } }, dismissed: false };
    const picked: string[] = [];
    const r = await withGuide(view({ setup: two }), {
      setupProviders: async () => [{ pluginId: "moss/model-anthropic", name: "Anthropic", auth: [{ index: 0, method: "api-key", state: "signed-in" }] }],
      setup: async () => two,
      models: async () => [{ id: "anthropic/b", title: "B", provider: "Anthropic", ready: true }, { id: "openai/a", title: "A", provider: "OpenAI", ready: true }, { id: "x/off", title: "Off", provider: "X", ready: false }],
      setDefaultModel: async (m) => { picked.push(m); return { ok: true, setup: { ...two, ready: true, missing: [], default: { model: m, source: "chosen" } } }; },
    });
    await act(async () => { (r.container.querySelector("[data-setup=next]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 20)); });
    expect(r.container.querySelector("[data-setup-step=model]")).not.toBeNull();
    const select = r.container.querySelector("[data-setup-model-picker]") as HTMLSelectElement;
    // Only the added providers' models, the first added provider's recommended one pre-filled.
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual(["anthropic/b", "openai/a"]);
    expect(select.value).toBe("anthropic/b");
    await act(async () => { select.value = "openai/a"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { (r.container.querySelector("[data-setup=next]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 20)); });
    expect(picked).toEqual(["openai/a"]);
    expect(r.container.querySelector("[data-setup-step=done]")?.textContent).toContain("A answers Juniper's first message");
    await act(async () => { (r.container.querySelector("[data-setup=start]") as HTMLButtonElement).click(); await new Promise((res) => setTimeout(res, 80)); });
    expect(r.container.querySelector("[data-setup-step]")).toBeNull();
    r.unmount();
  });
});
