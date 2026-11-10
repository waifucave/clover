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

async function mount(s: SessionView = session({}), opts: { level?: "applied" | "card"; entries?: Parameters<typeof runtimeWith>[0]["entries"]; component?: EntryComponent; refuse?: string; models?: { id: string; name: string; providerName: string; signedIn?: boolean }[] } = {}) {
  const core = fakeCore({ "computer.setLevel": () => (opts.level === "applied" ? { applied: true } : { applied: false, card: "card-level" }) });
  // The composer spot's host callbacks: the core decides what each one is (a bot's user layer, a session's model).
  const host: string[][] = [];
  const composerHost = {
    models: async () => ({ models: opts.models ?? [{ id: "openai/gpt-6", name: "GPT-6", providerName: "OpenAI" }, { id: "xai/grok-5", name: "Grok 5", providerName: "xAI" }] }),
    setModel: async (model: string, effort?: string) => { host.push(["setModel", model, effort ?? ""]); },
    interrupt: async () => { host.push(["interrupt"]); },
    stop: async () => { host.push(["stop"]); },
  };
  const approvals = fakeApprovals();
  const sends: { to: unknown; message: unknown }[] = [];
  const api = fakeApi({
    bots: { list: async () => [ALPHA], get: async () => ALPHA, watch: () => () => undefined },
    conversation: { get: async () => s },
    computers: { list: async () => [STUDIO] },
  });
  const runtime = runtimeWith({
    api: () => api,
    core: () => core,
    composerHost: () => composerHost,
    userSend: () => async (to, message) => {
      if (opts.refuse !== undefined) throw new Error(opts.refuse);
      sends.push({ to, message });
    },
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
  return { core, approvals, sends, host };
}

describe("the composer entry", () => {
  test("sends the draft as the user's words through useUserSend (never a bare session.send), and clears it", async () => {
    const { core, sends } = await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to Alpha" }), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(() => settle());
    expect(sends).toEqual([{ to: { session: "s_alpha" }, message: { text: "Hello" } }]);
    expect(core.calls.some((c) => c.method === "session.send")).toBe(false);
    expect((screen.getByRole("textbox", { name: "Message to Alpha" }) as HTMLTextAreaElement).value).toBe("");
  });

  test("a refused send keeps the draft and says why, in a few words, by the composer", async () => {
    for (const [refuse, said] of [["the user's words go only right after their own key press or click", "press Send, or Enter, again"], ["Clover isn't running", "Clover isn't running"], ["bad request", "wasn't sent"]] as const) {
      cleanup();
      await mount(session({}), { refuse });
      const box = screen.getByRole("textbox", { name: "Message to Alpha" }) as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: "Hello" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await act(() => settle());
      expect(box.value).toBe("Hello");
      expect(screen.getByRole("alert").textContent).toContain(said);
      // Typing again takes the notice away.
      fireEvent.change(box, { target: { value: "Hello!" } });
      expect(screen.queryByRole("alert")).toBeNull();
    }
  });

  test("a running turn shows Stop, which interrupts it", async () => {
    const { core, host } = await mount(session({ status: "prompting" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(host).toEqual([["interrupt"]]);
    expect(core.calls.some((c) => c.method === "session.interrupt")).toBe(false);
  });

  test("a model pick goes through the composer spot's host callback, never a bare core call", async () => {
    const bot = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Model: GPT-6, medium" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Grok 5/ }));
    expect(bot.host).toEqual([["setModel", "xai/grok-5", "medium"]]);
    expect(bot.core.calls.some((c) => c.method === "bot.setUserLayer")).toBe(false);
    cleanup();
    const agent = await mount(session({ id: "agent-1", kind: "agent", parent: "s_alpha", backend: "Codex", model: "openai/gpt-6" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model: GPT-6/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Grok 5/ }));
    expect(agent.host).toEqual([["setModel", "xai/grok-5", ""]]);
  });

  test("the computer's level is a label, not a control: no menu, and computer.setLevel is never called", async () => {
    const { core } = await mount();
    const label = screen.getByLabelText("Approval level on Studio: Ask when risky");
    expect(label.tagName).not.toBe("BUTTON");
    fireEvent.click(label);
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(core.calls.some((c) => c.method === "computer.setLevel")).toBe(false);
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

  test("the model menu lists the signed-in providers' models first; the rest are one press away", async () => {
    const { host } = await mount(session({}), {
      models: [
        { id: "openai/gpt-6", name: "GPT-6", providerName: "OpenAI", signedIn: true },
        { id: "openai/gpt-6-mini", name: "GPT-6 mini", providerName: "OpenAI", signedIn: true },
        { id: "xai/grok-5", name: "Grok 5", providerName: "xAI", signedIn: false },
        { id: "other/x", name: "Other X", providerName: "Other", signedIn: false },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    expect(screen.getAllByRole("menuitemradio").map((e) => e.textContent)).toEqual([expect.stringContaining("GPT-6"), expect.stringContaining("GPT-6 mini")]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Show all models \(2 more\)/ }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Grok 5/ }));
    expect(host).toEqual([["setModel", "xai/grok-5", "medium"]]);
  });
});
