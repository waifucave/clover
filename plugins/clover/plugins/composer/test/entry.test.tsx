// The composer on the runtime: sends, stops, model and level changes through the core.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { card, computerView, fakeApi, fakeApprovals, fakeCore, settle } from "../../shell/runtime/testkit";
import type { BotView, ComputerView, EntryComponent, SessionView } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { ComposerEntry } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const ALPHA: BotView = { id: "alpha", name: "Alpha", model: "openai/gpt-6", effort: "medium", userLayer: [], state: "idle", computer: "Studio", mainSession: "s_alpha" };
const STUDIO: ComputerView = computerView("Studio", { device: "d1", level: "ask-risky", link: "self", isMain: true });
const session = (extra: Partial<SessionView>): SessionView => ({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, ...extra });

async function mount(s: SessionView = session({}), opts: { level?: "applied" | "card"; entries?: Parameters<typeof runtimeWith>[0]["entries"]; component?: EntryComponent } = {}) {
  const core = fakeCore({
    "session.send": () => ({ seq: 9 }),
    "session.interrupt": () => ({ ok: true }),
    "session.setModel": () => ({ ok: true }),
    "bot.setUserLayer": () => ({ applied: true }),
    "computer.setLevel": () => (opts.level === "applied" ? { applied: true } : { applied: false, card: "card-level" }),
    "models.list": () => ({ models: [{ id: "openai/gpt-6", label: "GPT-6", provider: "OpenAI" }, { id: "xai/grok-5", label: "Grok 5", provider: "xAI" }] }),
  });
  const approvals = fakeApprovals();
  const api = fakeApi({
    bots: { list: async () => [ALPHA], get: async () => ALPHA, watch: () => () => undefined },
    conversation: { get: async () => s },
    computers: { list: async () => [STUDIO] },
  });
  const runtime = runtimeWith({
    api: () => api,
    core: () => core,
    approvals,
    spot: (name) => (name === "composer.action" ? { shape: "keyed" } : undefined),
    entries: opts.entries ?? [],
    component: () => opts.component,
  });
  render(
    <UiRuntimeProvider runtime={runtime}>
      <ComposerEntry props={{ bot: { id: s.kind === "bot" ? "alpha" : "codex", name: s.kind === "bot" ? "Alpha" : "Codex" }, session: s.id }} />
    </UiRuntimeProvider>,
  );
  await act(() => settle());
  return { core, approvals };
}

describe("the composer entry", () => {
  test("sends the draft as the user's message, with an id and the time, and clears it", async () => {
    const { core } = await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to Alpha" }), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const sent = core.calls.find((c) => c.method === "session.send")!.params as { id: string; message: { text: string; clientMessageId: string; sentAt: number } };
    expect(sent.id).toBe("s_alpha");
    expect(sent.message.text).toBe("Hello");
    expect(sent.message.clientMessageId.length).toBeGreaterThan(8);
    expect(typeof sent.message.sentAt).toBe("number");
    expect((screen.getByRole("textbox", { name: "Message to Alpha" }) as HTMLTextAreaElement).value).toBe("");
  });

  test("a running turn shows Stop, which interrupts it", async () => {
    const { core } = await mount(session({ status: "prompting" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(core.calls.filter((c) => c.method === "session.interrupt").map((c) => c.params)).toEqual([{ id: "s_alpha" }]);
  });

  test("a bot's model is its user layer; an agent's is the session's", async () => {
    const bot = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Model: GPT-6, medium" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Grok 5/ }));
    expect(bot.core.calls.filter((c) => c.method === "bot.setUserLayer").map((c) => c.params)).toEqual([{ id: "alpha", patch: { model: "xai/grok-5", effort: "medium" } }]);
    cleanup();
    const agent = await mount(session({ id: "agent-1", kind: "agent", parent: "s_alpha", backend: "Codex", model: "openai/gpt-6" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model: GPT-6/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Grok 5/ }));
    expect(agent.core.calls.filter((c) => c.method === "session.setModel").map((c) => c.params)).toEqual([{ id: "agent-1", model: "xai/grok-5" }]);
  });

  test("a level change raises a card: the pill shows it asked for until the card goes", async () => {
    const { core, approvals } = await mount();
    approvals.set([card("card-level")]);
    fireEvent.click(screen.getByRole("button", { name: "Approval level on Studio: Ask when risky" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Fully automatic/ }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "computer.setLevel").map((c) => c.params)).toEqual([{ name: "Studio", level: "automatic" }]);
    expect(screen.getByRole("button", { name: "Approval level on Studio: Ask when risky, Fully automatic asked for" })).toBeTruthy();
    act(() => approvals.set([]));
    await act(() => settle());
    expect(screen.getByRole("button", { name: "Approval level on Studio: Ask when risky" })).toBeTruthy();
  });

  test("a card in this session holds the pills", async () => {
    const { approvals } = await mount();
    act(() => approvals.set([card("c1", { session: "s_alpha" })]));
    expect((screen.getByRole("button", { name: /^Model:/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a plugin that fills `composer.action` for a key draws that button", async () => {
    const Suggest: EntryComponent = ({ props }) => <button type="button">{`Suggest for ${(props.bot as { name: string }).name}`}</button>;
    await mount(session({}), { component: Suggest, entries: [{ pluginId: "suggest", id: "send", spot: "composer.action", key: "send", component: "Suggest", source: "installed", enabledAt: 1 }] });
    expect(screen.getByRole("button", { name: "Suggest for Alpha" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
});
