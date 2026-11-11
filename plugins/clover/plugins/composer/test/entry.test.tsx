// The composer on the runtime: sends, stops, model and level changes through the core.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { card, computerView, fakeApi, fakeApprovals, fakeCore, settle } from "../../shell/runtime/testkit";
import type { BotView, ComputerView, EntryComponent, SessionView } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { ComposerEntry } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import type { SlashCommand } from "../client/slash";

afterEach(cleanup);

const ALPHA: BotView = { id: "alpha", name: "Alpha", model: "openai/gpt-6", effort: "medium", userLayer: [], state: "idle", computer: "Studio", mainSession: "s_alpha" };
const STUDIO: ComputerView = computerView("Studio", { device: "d1", level: "ask-risky", link: "self", isMain: true });
const session = (extra: Partial<SessionView>): SessionView => ({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, ...extra });

async function mount(s: SessionView = session({}), opts: { level?: "applied" | "card"; entries?: Parameters<typeof runtimeWith>[0]["entries"]; component?: EntryComponent; refuse?: string; kept?: Map<string, string>; models?: { id: string; name: string; providerName: string; signedIn?: boolean }[]; commands?: SlashCommand[]; run?: (name: string, args: unknown) => unknown } = {}) {
  const core = fakeCore({ "computer.setLevel": () => (opts.level === "applied" ? { applied: true } : { applied: false, card: "card-level" }) });
  // The composer spot's host callbacks: the core decides what each one is (a bot's user layer, a session's model).
  const host: string[][] = [];
  let held: BotView = ALPHA; // what the daemon holds: a pick changes it
  const composerHost = {
    models: async () => ({ models: opts.models ?? [{ id: "openai/gpt-6", name: "GPT-6", providerName: "OpenAI" }, { id: "xai/grok-5", name: "Grok 5", providerName: "xAI" }] }),
    setModel: async (model: string, effort?: string) => { host.push(["setModel", model, effort ?? ""]); held = { ...held, model, ...(effort !== undefined ? { effort } : {}) }; },
    interrupt: async () => { host.push(["interrupt"]); },
    stop: async () => { host.push(["stop"]); },
    ...(opts.commands
      ? {
          commands: async () => ({ commands: opts.commands! }),
          // The run is recorded at once, as the host takes it: inside the key press or click, or not at all.
          runCommand: (name: string, args?: unknown) => {
            host.push(["runCommand", name, JSON.stringify(args ?? null)]);
            return Promise.resolve().then(() => ({ result: opts.run ? opts.run(name, args) : undefined }));
          },
        }
      : {}),
  };
  const approvals = fakeApprovals();
  const sends: { to: unknown; message: unknown }[] = [];
  const api = fakeApi({
    bots: { list: async () => [ALPHA], get: async () => held, watch: () => () => undefined },
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
    ...(opts.kept ? { kept: opts.kept } : {}),
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

  test("after a pick the label says the model the daemon now holds, at once", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Model: GPT-6, medium" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Grok 5/ }));
    await act(() => settle());
    expect(screen.getByRole("button", { name: /^Model: Grok 5/ })).toBeTruthy();
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

  describe("the slash menu", () => {
    const ECHO: SlashCommand = { name: "echo.say", pluginId: "echo", pluginName: "Echo", description: "Says it back", args: { type: "object", required: ["text"], properties: { text: { type: "string" } } }, scope: "both", own: false };
    const MINE: SlashCommand = { name: "alpha.wave", pluginId: "alpha", pluginName: "Alpha", description: "Waves", own: true };
    const AGENTS_ONLY: SlashCommand = { name: "coder.lint", pluginId: "coder", pluginName: "Coder", description: "Lints", scope: "agents", own: false };

    test("a / lists the running plugins' commands for this session, the bot's own first; a pick runs it with the rest of the line, never sends it", async () => {
      const { host, sends } = await mount(session({}), { commands: [MINE, ECHO, AGENTS_ONLY], run: (_n, a) => `heard ${(a as { text: string }).text}` });
      const box = screen.getByRole("textbox", { name: "Message to Alpha" });
      fireEvent.change(box, { target: { value: "/" } });
      await act(() => settle());
      const options = screen.getAllByRole("option").map((o) => o.textContent);
      // The agents-only plugin's command isn't offered in a bot's conversation.
      expect(options.length).toBe(2);
      expect(options[0]).toContain("/wave");
      expect(options[0]).toContain("This bot's");
      expect(options[1]).toContain("/say");
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "/say hello there" } });
      await act(() => settle());
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      expect(host.filter((h) => h[0] === "runCommand")).toEqual([["runCommand", "echo.say", JSON.stringify({ text: "hello there" })]]);
      await act(() => settle());
      expect(sends).toEqual([]);
      const row = screen.getByRole("status", { name: "Result of /say" });
      expect(row.textContent).toContain("heard hello there");
      // The draft went to the plugin, so the box is empty; the row stays until dismissed.
      expect((screen.getByRole("textbox", { name: "Message to Alpha" }) as HTMLTextAreaElement).value).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("status", { name: "Result of /say" })).toBeNull();
    });

    test("a refusal shows as a row, and the line stays to fix", async () => {
      const { host } = await mount(session({}), { commands: [ECHO], run: () => { throw new Error("Error invoking remote method 'clover:composer': Error: echo.say: args at /text fail \"maxLength\""); } });
      fireEvent.change(screen.getByRole("textbox", { name: "Message to Alpha" }), { target: { value: "/say too long" } });
      await act(() => settle());
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      await act(() => settle());
      expect(host.filter((h) => h[0] === "runCommand").length).toBe(1);
      const row = screen.getByRole("status", { name: "/say didn't run" });
      expect(row.textContent).toContain('echo.say: args at /text fail "maxLength"');
      expect(row.textContent).not.toContain("invoking remote method");
      expect((screen.getByRole("combobox") as HTMLTextAreaElement).value).toBe("/say too long");
    });

    test("args that don't fit the schema are refused here, and nothing runs", async () => {
      const { host } = await mount(session({}), { commands: [MINE] });
      fireEvent.change(screen.getByRole("textbox", { name: "Message to Alpha" }), { target: { value: "/wave at everyone" } });
      await act(() => settle());
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      await act(() => settle());
      expect(host.filter((h) => h[0] === "runCommand")).toEqual([]);
      expect(screen.getByRole("status", { name: "/wave didn't run" }).textContent).toContain("takes nothing after its name");
    });

    test("in an agent's tab, a bots-only plugin's command isn't offered and an agents-only one is", async () => {
      await mount(session({ kind: "agent", bot: undefined }), { commands: [ECHO, AGENTS_ONLY, { ...MINE, scope: "bots" }] });
      fireEvent.change(screen.getByRole("textbox", { name: "Message to Codex" }), { target: { value: "/" } });
      await act(() => settle());
      const shown = screen.getAllByRole("option").map((o) => o.querySelector(".cl-composer__slash-name")?.textContent);
      expect(shown).toEqual(["/say", "/lint"]);
    });

    test("a host with no commands (another plugin's composer) leaves / as plain text", async () => {
      const { sends } = await mount();
      fireEvent.change(screen.getByRole("textbox", { name: "Message to Alpha" }), { target: { value: "/say hi" } });
      await act(() => settle());
      expect(screen.queryByRole("listbox")).toBeNull();
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Message to Alpha" }), { key: "Enter" });
      await act(() => settle());
      expect(sends).toEqual([{ to: { session: "s_alpha" }, message: { text: "/say hi" } }]);
    });
  });

  test("the draft outlives a reload of the window's document (a plugin with its own layer installed), per conversation", async () => {
    const kept = new Map<string, string>();
    await mount(session({}), { kept });
    fireEvent.change(screen.getByRole("textbox", { name: "Message to Alpha" }), { target: { value: "half a thought" } });
    await act(() => settle());
    // The document goes with no unmount (a reload runs no cleanup): the window's storage as it was.
    const atReload = new Map(kept);
    cleanup();
    await mount(session({}), { kept: atReload });
    expect((screen.getByRole("textbox", { name: "Message to Alpha" }) as HTMLTextAreaElement).value).toBe("half a thought");
    // Another conversation's composer starts empty.
    cleanup();
    await mount(session({ id: "s_other" }), { kept: new Map(atReload) });
    expect((screen.getByRole("textbox", { name: "Message to Alpha" }) as HTMLTextAreaElement).value).toBe("");
  });
});
