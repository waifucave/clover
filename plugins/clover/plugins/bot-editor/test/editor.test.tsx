import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { card, fakeApi, fakeApprovals, fakeCore, settle, uiPluginView } from "../../shell/runtime/testkit";
import type { UiEntry } from "../../shell/runtime/resolve";
import { SPOT_DECLS } from "../../shell/runtime/catalog";
import type { BotView, EntryComponent } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { BotEditor } from "../client/BotEditor";
import { BotEditorEntry } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { ALPHA, MODELS, THEMES } from "../gallery/fixtures";

afterEach(cleanup);

const noop = () => undefined;

const ALPHA_VIEW: BotView = { id: "alpha", name: "Alpha", model: "openai/gpt-6", effort: "medium", userLayer: ["theme"], theme: "alpha#alpha-tab", state: "idle", mainSession: "s_alpha", voice: { provider: "Fish Audio", voice: "Alpha" } };

async function mount(view: BotView = ALPHA_VIEW, setUserLayer: () => { applied: true } | { applied: false; card: string } = () => ({ applied: true }), extra: Parameters<typeof fakeCore>[0] = {}, entries: UiEntry[] = [], Section?: EntryComponent) {
  const core = fakeCore({
    "bot.setUserLayer": setUserLayer,
    "models.list": () => ({ models: [{ id: "openai/gpt-6", label: "GPT-6", provider: "OpenAI", efforts: ["low", "medium"] }, { id: "xai/grok-5", label: "Grok 5" }] as never }),
    "plugin.ui": () => ({ plugins: [uiPluginView("clover/base-theme", [{ id: "base", file: "base.css" }], []), uiPluginView("alpha", [{ id: "alpha-tab", file: "tab.css" }], [])] }),
    "plugin.list": () => ({ plugins: [{ id: "chibi-pack", name: "Chibi pack" } as never, { id: "alpha", name: "Alpha" } as never] }),
    ...extra,
  });
  const api = fakeApi({
    bots: { list: async () => [view], get: async () => view, watch: () => noop },
  });
  const approvals = fakeApprovals();
  const routes: unknown[] = [];
  const runtime = runtimeWith({ api: () => api, core: () => core, approvals, spot: (name) => SPOT_DECLS[name], entries, component: (_p, name) => (name === "Section" ? Section : undefined) });
  render(
    <UiRuntimeProvider runtime={runtime}>
      <BotEditorEntry props={{ route: "bot-editor", params: { bot: "alpha" }, navigate: (r) => routes.push(r) }} />
    </UiRuntimeProvider>,
  );
  await act(() => settle());
  return { core, approvals, routes };
}

describe("the bot editor (props)", () => {
  test("only the fields the user set offer Reset", () => {
    render(<BotEditor bot={ALPHA} own={["name", "theme"]} model={{ value: "openai/gpt-6", models: MODELS }} themes={THEMES} onChange={noop} onBack={noop} />);
    expect(screen.getAllByRole("button", { name: /^Reset the / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Reset the name", "Reset the theme"]);
  });

  test("the effort picker shows only for a model that has efforts", () => {
    const { rerender } = render(<BotEditor bot={ALPHA} own={[]} model={{ value: "openai/gpt-6", models: MODELS }} themes={[]} onChange={noop} onBack={noop} />);
    expect(screen.queryByRole("combobox", { name: "Effort" })).not.toBeNull();
    rerender(<BotEditor bot={ALPHA} own={[]} model={{ value: "xai/grok-5", models: MODELS }} themes={[]} onChange={noop} onBack={noop} />);
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
  });

  test("a model the catalog doesn't list still shows as picked", () => {
    render(<BotEditor bot={ALPHA} own={[]} model={{ value: "local/llama-9", models: MODELS }} themes={[]} onChange={noop} onBack={noop} />);
    expect((screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value).toBe("local/llama-9");
  });

  test("the LAN switch is off by default, says what it allows, and is the whole field: no Reset even when set", () => {
    const patches: unknown[] = [];
    const { rerender } = render(<BotEditor bot={ALPHA} own={[]} model={{ value: "openai/gpt-6", models: MODELS }} themes={[]} onChange={(p) => patches.push(p)} onBack={noop} />);
    const lan = screen.getByRole("switch", { name: "Local network" });
    expect(lan.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Lets Alpha's browser tabs open pages on devices on your local network, such as your router or a printer.")).toBeTruthy();
    fireEvent.click(lan);
    rerender(<BotEditor bot={ALPHA} own={["lan"]} lan model={{ value: "openai/gpt-6", models: MODELS }} themes={[]} onChange={(p) => patches.push(p)} onBack={noop} />);
    expect(screen.getByRole("switch", { name: "Local network" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: /^Reset the local network/ })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Local network" }));
    // On writes true; off clears the field (never false: off is the default).
    expect(patches).toEqual([{ lan: true }, { lan: null }]);
  });
});

describe("the bot editor on the runtime", () => {
  test("shows the bot and the installed themes, the base theme as Plain", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Edit Alpha" })).toBeTruthy();
    const theme = screen.getByRole("combobox", { name: "Theme" }) as HTMLSelectElement;
    expect([...theme.options].map((o) => o.textContent)).toEqual(["The bot's own", "Plain", "Alpha"]);
    expect(theme.value).toBe("alpha#alpha-tab");
  });

  test("each change is a patch to the user layer; Reset clears the field", async () => {
    const { core } = await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Alpha Prime" } });
    fireEvent.click(within(screen.getByRole("textbox", { name: "Name" }).closest("form")!).getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "xai/grok-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset the theme" }));
    await act(() => settle());
    const patches = core.calls.filter((c) => c.method === "bot.setUserLayer").map((c) => c.params);
    expect(patches).toEqual([
      { id: "alpha", patch: { name: "Alpha Prime" } },
      { id: "alpha", patch: { model: "xai/grok-5" } },
      { id: "alpha", patch: { theme: null } },
    ]);
  });

  test("the LAN switch reads the bot's lan and writes it through bot.setUserLayer", async () => {
    const { core } = await mount();
    const lan = screen.getByRole("switch", { name: "Local network" });
    expect(lan.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(lan);
    await act(() => settle());
    cleanup();
    const on = await mount({ ...ALPHA_VIEW, userLayer: ["theme", "lan"], lan: true });
    expect(screen.getByRole("switch", { name: "Local network" }).getAttribute("aria-checked")).toBe("true");
    // The user layer's other fields keep their Reset; lan has none.
    expect(screen.getAllByRole("button", { name: /^Reset the / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Reset the theme"]);
    fireEvent.click(screen.getByRole("switch", { name: "Local network" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "bot.setUserLayer").map((c) => c.params)).toEqual([{ id: "alpha", patch: { lan: true } }]);
    expect(on.core.calls.filter((c) => c.method === "bot.setUserLayer").map((c) => c.params)).toEqual([{ id: "alpha", patch: { lan: null } }]);
  });

  test("a change that comes back as a card says so until the card goes", async () => {
    const { approvals } = await mount(ALPHA_VIEW, () => ({ applied: false, card: "card-model" }));
    approvals.set([card("card-model")]);
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "xai/grok-5" } });
    await act(() => settle());
    expect(screen.getByRole("status").textContent).toBe("Waiting for your answer on the card.");
    act(() => approvals.set([]));
    await act(() => settle());
    expect(screen.queryByText("Waiting for your answer on the card.")).toBeNull();
  });

  test("Back goes to the bot's tab", async () => {
    const { routes } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Back to the bot" }));
    expect(routes).toEqual([{ route: "bot", params: { bot: "alpha" } }]);
  });
});

describe("other plugins rearranging the bot's tab", () => {
  test("lists each plugin whose layout patch applies to this bot, in turn order, and switches one off for this bot only", async () => {
    const patch = (pluginId: string, entry: Record<string, unknown>) => ({ ...uiPluginView(pluginId), ui: [{ spot: "bot.tab", id: "move", layout: "move.json", ...entry }] });
    const lists = [{ spot: "status", order: [], hidden: [] }, { spot: "bot.tab", bot: "alpha", order: [], hidden: ["zeta#move"] }];
    const { core } = await mount(ALPHA_VIEW, undefined, {
      "plugin.ui": () => ({ plugins: [patch("zeta", { order: 10 }), patch("mover", { when: { bot: "alpha" } }), patch("elsewhere", { when: { bot: "luna" } }), uiPluginView("alpha")] }),
      "plugin.list": () => ({ plugins: [{ id: "mover", name: "Mover" } as never, { id: "zeta", name: "Zeta" } as never] }),
      "ui.settings": () => ({ picks: [], lists }) as never,
      "ui.set": () => ({ applied: true }) as never,
    });
    const switches = screen.getAllByRole("switch", { name: /rearranges this tab$/ });
    expect(switches.map((s) => [s.getAttribute("aria-label"), s.getAttribute("aria-checked")])).toEqual([["Zeta rearranges this tab", "false"], ["Mover rearranges this tab", "true"]]);
    fireEvent.click(screen.getByRole("switch", { name: "Mover rearranges this tab" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "ui.set").map((c) => c.params)).toEqual([{ patch: { lists: [{ spot: "bot.tab", bot: "alpha", order: [], hidden: ["zeta#move", "mover#move"] }] } }]);
    expect(screen.getByRole("switch", { name: "Mover rearranges this tab" }).getAttribute("aria-checked")).toBe("false");
  });

  test("hidden by plugins: each part a plugin's hide takes out of this bot's tab, with its plugin, and a switch that shows it again", async () => {
    const tidy = { ...uiPluginView("tidy"), ui: [{ spot: "bot.header.action", id: "no-pin", hide: true, target: "mover#pin", when: { bot: "alpha" } }, { spot: "composer.action", key: "model", id: "no-model", hide: true }, { spot: "status", id: "x", hide: true, target: "z", when: { bot: "luna" } }] };
    const mover = { ...uiPluginView("mover"), ui: [{ spot: "bot.header.action", id: "pin", component: "Pin", title: "Pin" }] };
    const lists = [{ spot: "composer.action", bot: "alpha", order: [], hidden: [], shown: ["tidy#no-model"] }];
    const { core } = await mount(ALPHA_VIEW, undefined, {
      "plugin.ui": () => ({ plugins: [tidy, mover, uiPluginView("alpha")] }),
      "plugin.list": () => ({ plugins: [{ id: "tidy", name: "Tidy" } as never] }),
      "ui.settings": () => ({ picks: [], lists }) as never,
      "ui.set": () => ({ applied: true }) as never,
    });
    expect(screen.getByText("Hidden by plugins")).not.toBeNull();
    const switches = screen.getAllByRole("switch", { name: /^Show / });
    expect(switches.map((s) => [s.getAttribute("aria-label"), s.getAttribute("aria-checked")])).toEqual([["Show Pin", "false"], ["Show Composer button: model", "true"]]);
    expect(screen.getByText("Pin, hidden by Tidy")).not.toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show Pin" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "ui.set").map((c) => c.params)).toEqual([{ patch: { lists: [{ spot: "bot.header.action", bot: "alpha", order: [], hidden: [], shown: ["tidy#no-pin"] }] } }]);
    expect(screen.getByRole("switch", { name: "Show Pin" }).getAttribute("aria-checked")).toBe("true");
  });

  test("no row when nothing rearranges the tab", async () => {
    await mount(ALPHA_VIEW, undefined, { "ui.settings": () => ({ picks: [], lists: [] }) as never });
    expect(screen.queryByText("Rearranged by")).toBeNull();
  });
});

describe("the sections other plugins add (`bot.editor.section`)", () => {
  const section = (pluginId: string): UiEntry => ({ pluginId, id: "avatar", spot: "bot.editor.section", component: "Section", fields: { title: "Avatar" } } as unknown as UiEntry);
  const Section: EntryComponent = ({ props }) => <section aria-label="a plugin's section">{JSON.stringify(props)}</section>;

  test("with no plugin filling it, the editor has no avatar section at all: no packs, no import, no row", async () => {
    await mount();
    expect(screen.queryByRole("region", { name: "a plugin's section" })).toBeNull();
    expect(screen.queryByText("Avatar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose avatar…" })).toBeNull();
    expect(screen.queryByText(/No avatar packs/)).toBeNull();
    // The rest of the editor stands as it was.
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
  });

  test("an entry on the spot draws between the model and the voice, handed the bot", async () => {
    await mount(ALPHA_VIEW, undefined, {}, [section("clover/character")], Section);
    const drawn = screen.getByRole("region", { name: "a plugin's section" });
    expect(JSON.parse(drawn.textContent!)).toMatchObject({ bot: { id: "alpha", name: "Alpha" } });
    const rows = [...document.querySelectorAll(".cl-bot-editor__rows > section")].map((e) => e.getAttribute("aria-label") ?? e.querySelector(".cl-bot-editor__label")?.textContent);
    expect(rows.indexOf("a plugin's section")).toBe(rows.indexOf("Model") + 1);
    expect(rows[rows.indexOf("a plugin's section") + 1]).toBe("Voice");
  });

  test("the bot's settings are a stock section headed with its name: each kind a control, saved with the bot named; a secret is left out", async () => {
    const { core } = await mount(ALPHA_VIEW, undefined, {
      "plugin.settings.get": () => ({
        settings: [
          { key: "scene", type: "enum", title: "Scene", scope: "bot", value: "meadow", options: [{ value: "meadow", title: "Meadow" }, { value: "room", title: "Room" }] },
          { key: "effects", type: "boolean", title: "Effects", scope: "bot", value: true },
          { key: "nickname", type: "string", title: "Nickname", scope: "bot", value: "Al" },
          { key: "size", type: "number", title: "Size", value: 3 },
          { key: "key", type: "secret", title: "API key", set: false },
        ],
      }) as never,
      "plugin.settings.set": () => ({ applied: true }) as never,
    });
    const section = screen.getByRole("region", { name: "Alpha" });
    expect(within(section).getAllByRole("combobox").length + within(section).getAllByRole("switch").length + within(section).getAllByRole("textbox").length + within(section).getAllByRole("spinbutton").length).toBe(4);
    expect(within(section).queryByText("API key")).toBeNull();
    fireEvent.change(within(section).getByRole("combobox", { name: "Scene" }), { target: { value: "room" } });
    fireEvent.click(within(section).getByRole("switch", { name: "Effects" }));
    await act(() => settle());
    const sets = core.calls.filter((c) => c.method === "plugin.settings.set").map((c) => c.params);
    expect(sets).toEqual([{ id: "alpha", key: "scene", value: "room", bot: "alpha", noSecret: true }, { id: "alpha", key: "effects", value: false, bot: "alpha", noSecret: true }]);
  });
});
