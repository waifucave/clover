import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { card, fakeApi, fakeApprovals, fakeCore, settle, uiPluginView } from "../../shell/runtime/testkit";
import type { BotView } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { BotEditor } from "../client/BotEditor";
import { BotEditorEntry } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { ALPHA, AVATARS, MODELS, THEMES } from "../gallery/fixtures";

afterEach(cleanup);

const noop = () => undefined;

const ALPHA_VIEW: BotView = { id: "alpha", name: "Alpha", model: "openai/gpt-6", effort: "medium", userLayer: ["theme"], theme: "alpha#alpha-tab", state: "idle", mainSession: "s_alpha", voice: { provider: "Fish Audio", voice: "Alpha" } };

async function mount(view: BotView = ALPHA_VIEW, setUserLayer: () => { applied: true } | { applied: false; card: string } = () => ({ applied: true })) {
  const core = fakeCore({
    "bot.setUserLayer": setUserLayer,
    "models.catalog": () => ({ models: [{ id: "openai/gpt-6", label: "GPT-6", provider: "OpenAI", efforts: ["low", "medium"] }, { id: "xai/grok-5", label: "Grok 5" }] as never }),
    "plugin.ui": () => ({ plugins: [uiPluginView("clover/base-theme", [{ id: "base", file: "base.css" }], []), uiPluginView("alpha", [{ id: "alpha-tab", file: "tab.css" }], [])] }),
    "plugin.list": () => ({ plugins: [{ id: "chibi-pack", name: "Chibi pack" } as never, { id: "alpha", name: "Alpha" } as never] }),
  });
  const api = fakeApi({
    bots: { list: async () => [view], get: async () => view, watch: () => noop },
    points: {
      "avatar.packs": [
        { pluginId: "chibi-pack", entryId: "mint", value: { id: "mint", name: "Mint", file: "assets/mint.vrm", format: "vrm", portrait: "assets/mint.png" } },
        { pluginId: "chibi-pack", entryId: "rose", value: { id: "rose", file: "assets/rose.vrm", format: "vrm" } },
      ],
    },
  });
  const approvals = fakeApprovals();
  const routes: unknown[] = [];
  const runtime = runtimeWith({ api: () => api, core: () => core, approvals });
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
    render(<BotEditor bot={ALPHA} own={["avatar", "theme"]} model={{ value: "openai/gpt-6", models: MODELS }} avatars={AVATARS} themes={THEMES} onChange={noop} onBack={noop} />);
    expect(screen.getAllByRole("button", { name: /^Reset the / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Reset the avatar", "Reset the theme"]);
  });

  test("the effort picker shows only for a model that has efforts", () => {
    const { rerender } = render(<BotEditor bot={ALPHA} own={[]} model={{ value: "openai/gpt-6", models: MODELS }} avatars={[]} themes={[]} onChange={noop} onBack={noop} />);
    expect(screen.queryByRole("combobox", { name: "Effort" })).not.toBeNull();
    rerender(<BotEditor bot={ALPHA} own={[]} model={{ value: "xai/grok-5", models: MODELS }} avatars={[]} themes={[]} onChange={noop} onBack={noop} />);
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
  });

  test("a model the catalog doesn't list still shows as picked", () => {
    render(<BotEditor bot={ALPHA} own={[]} model={{ value: "local/llama-9", models: MODELS }} avatars={[]} themes={[]} onChange={noop} onBack={noop} />);
    expect((screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value).toBe("local/llama-9");
  });

  test("with no packs, the avatar row says where they come from", () => {
    render(<BotEditor bot={ALPHA} own={[]} model={{ value: "openai/gpt-6", models: MODELS }} avatars={[]} themes={[]} onChange={noop} onBack={noop} />);
    expect(screen.getByText(/No avatar packs are installed yet/)).toBeTruthy();
  });
});

describe("the bot editor on the runtime", () => {
  test("shows the bot, its avatars from the packs (named by their plugin) and the installed themes, the base theme as Plain", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Edit Alpha" })).toBeTruthy();
    const avatars = within(screen.getByRole("radiogroup", { name: "Avatar" }));
    // Rose has no name of its own (its id stands in) and no portrait (its initial stands in).
    expect(avatars.getAllByRole("radio").map((r) => r.textContent)).toEqual(["MintFrom Chibi pack", "RroseFrom Chibi pack"]);
    const theme = screen.getByRole("combobox", { name: "Theme" }) as HTMLSelectElement;
    expect([...theme.options].map((o) => o.textContent)).toEqual(["The bot's own", "Plain", "Alpha"]);
    expect(theme.value).toBe("alpha#alpha-tab");
  });

  test("each change is a patch to the user layer; Reset clears the field", async () => {
    const { core } = await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Alpha Prime" } });
    fireEvent.click(within(screen.getByRole("textbox", { name: "Name" }).closest("form")!).getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "xai/grok-5" } });
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Reset the theme" }));
    await act(() => settle());
    // A pack's portrait shows from the pack's own asset URL (review item 8); the user layer keeps the pack's path.
    expect(document.querySelector('img[src="clover-asset://chibi-pack/assets/mint.png"]')).toBeTruthy();
    const patches = core.calls.filter((c) => c.method === "bot.setUserLayer").map((c) => c.params);
    expect(patches).toEqual([
      { id: "alpha", patch: { name: "Alpha Prime" } },
      { id: "alpha", patch: { model: "xai/grok-5" } },
      { id: "alpha", patch: { avatar: { file: "assets/mint.vrm", format: "vrm", portrait: "assets/mint.png" } } },
      { id: "alpha", patch: { theme: null } },
    ]);
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
