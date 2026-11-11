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

async function mount(view: BotView = ALPHA_VIEW, setUserLayer: () => { applied: true } | { applied: false; card: string } = () => ({ applied: true }), extra: Parameters<typeof fakeCore>[0] = {}) {
  const core = fakeCore({
    "bot.setUserLayer": setUserLayer,
    "models.list": () => ({ models: [{ id: "openai/gpt-6", label: "GPT-6", provider: "OpenAI", efforts: ["low", "medium"] }, { id: "xai/grok-5", label: "Grok 5" }] as never }),
    "plugin.ui": () => ({ plugins: [uiPluginView("clover/base-theme", [{ id: "base", file: "base.css" }], []), uiPluginView("alpha", [{ id: "alpha-tab", file: "tab.css" }], [])] }),
    "plugin.list": () => ({ plugins: [{ id: "chibi-pack", name: "Chibi pack" } as never, { id: "alpha", name: "Alpha" } as never] }),
    ...extra,
  });
  const api = fakeApi({
    bots: { list: async () => [view], get: async () => view, watch: () => noop },
    points: {
      // The two renderers Clover ships, as they declare their formats (clover/vrm's and clover/live2d's manifests).
      "avatar.formats": [
        { pluginId: "clover/vrm", entryId: "vrm", value: { id: "vrm", format: "vrm", name: "VRM", entry: { extensions: [".vrm"] }, files: { kinds: [{ ext: [".vrm", ".glb"], type: "binary" }], maxFiles: 1 }, import: { accepts: ["file"] } } },
        { pluginId: "clover/live2d", entryId: "live2d", value: { id: "live2d", format: "live2d", name: "Live2D (Cubism)", entry: { extensions: [".model3.json", ".zip"] }, files: { kinds: [{ ext: [".json"], type: "json" }] }, import: { accepts: ["folder", "zip"] } } },
      ],
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

  test("the LAN switch is off by default, says what it allows, and is the whole field: no Reset even when set", () => {
    const patches: unknown[] = [];
    const { rerender } = render(<BotEditor bot={ALPHA} own={[]} model={{ value: "openai/gpt-6", models: MODELS }} avatars={[]} themes={[]} onChange={(p) => patches.push(p)} onBack={noop} />);
    const lan = screen.getByRole("switch", { name: "Local network" });
    expect(lan.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Lets Alpha's browser tabs open pages on devices on your local network, such as your router or a printer.")).toBeTruthy();
    fireEvent.click(lan);
    rerender(<BotEditor bot={ALPHA} own={["lan"]} lan model={{ value: "openai/gpt-6", models: MODELS }} avatars={[]} themes={[]} onChange={(p) => patches.push(p)} onBack={noop} />);
    expect(screen.getByRole("switch", { name: "Local network" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: /^Reset the local network/ })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Local network" }));
    // On writes true; off clears the field (never false: off is the default).
    expect(patches).toEqual([{ lan: true }, { lan: null }]);
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
    const patches = core.calls.filter((c) => c.method === "bot.setUserLayer").map((c) => c.params);
    expect(patches).toEqual([
      { id: "alpha", patch: { name: "Alpha Prime" } },
      { id: "alpha", patch: { model: "xai/grok-5" } },
      { id: "alpha", patch: { avatar: { file: "assets/mint.vrm", format: "vrm", portrait: "assets/mint.png" } } },
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

  test("no row when nothing rearranges the tab", async () => {
    await mount(ALPHA_VIEW, undefined, { "ui.settings": () => ({ picks: [], lists: [] }) as never });
    expect(screen.queryByText("Rearranged by")).toBeNull();
  });
});

describe("the avatar importer", () => {
  test("a pick names the use, shows only a name, imports on a second click with the token, and says how it went", async () => {
    const { core } = await mount(ALPHA_VIEW, undefined, {
      "ui.pick": () => ({ token: "pick-1", name: "Mochi\u202e.zip" }),
      "bot.importAvatar": () => ({ format: "live2d", name: "Live2D (Cubism)", files: 12, bytes: 3 * 1024 * 1024 }),
    });
    // What it takes comes from the installed renderers' declarations, not from formats the editor knows by name.
    expect(screen.getByText(/^Your own model: /).textContent).toBe("Your own model: a .vrm or .glb file (VRM); a folder or .zip with a .model3.json (Live2D (Cubism)). It is copied into Clover; the original stays where it is.");
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar…" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.pick")?.params).toEqual({ kind: "file", use: "bot.importAvatar" });
    expect(screen.getByText(/^Picked: /).textContent).not.toContain("\u202e");
    fireEvent.click(screen.getByRole("button", { name: "Import and use" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "bot.importAvatar")?.params).toEqual({ id: "alpha", path: "pick-1" });
    expect(screen.getByRole("status").textContent).toContain("Imported a Live2D (Cubism) model (12 files, 3.0 MB)");
    // The token is spent: the import button is gone until another pick.
    expect(screen.queryByRole("button", { name: "Import and use" })).toBeNull();
  });

  test("a folder pick asks for a folder; a cancelled pick and a refused import say so in plain words", async () => {
    let cancel = true;
    const { core } = await mount(ALPHA_VIEW, undefined, {
      "ui.pick": () => (cancel ? { cancelled: true } : { token: "pick-2", name: "model" }),
      "bot.importAvatar": () => { throw new Error("no .model3.json in there"); },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder instead" }));
    await act(() => settle());
    expect(core.calls.find((c) => c.method === "ui.pick")?.params).toEqual({ kind: "folder", use: "bot.importAvatar" });
    expect(screen.getByRole("status").textContent).toBe("Nothing picked.");
    cancel = false;
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar…" }));
    await act(() => settle());
    fireEvent.click(screen.getByRole("button", { name: "Import and use" }));
    await act(() => settle());
    expect(screen.getByRole("status").textContent).toBe("That didn't work: no .model3.json in there");
  });

  test("the model's own note shows under the avatar, and the user can change or clear it (their own value for that avatar)", async () => {
    const view: BotView = { ...ALPHA_VIEW, userLayer: ["avatar"], avatar: { src: "/_a/alpha/m-1/x.model3.json", format: "live2d", credit: "Free for personal use, credit the artist." } };
    const { core } = await mount(view, undefined, {});
    const box = screen.getByRole("textbox", { name: "Credit note" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Free for personal use, credit the artist.");
    expect(screen.getByText("From the model's own notes")).not.toBeNull();
    fireEvent.change(box, { target: { value: "Rigging by someone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await act(() => settle());
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "bot.setUserLayer").map((c) => c.params)).toEqual([
      { id: "alpha", patch: { avatarCredit: "Rigging by someone" } },
      { id: "alpha", patch: { avatarCredit: null } },
    ]);
  });

  test("before the second click, an import says it replaces the avatar the user imported before (and says nothing when there is none)", async () => {
    const own: BotView = { ...ALPHA_VIEW, userLayer: ["avatar"], avatar: { src: "/_a/alpha/m-1/x.model3.json", format: "live2d" } };
    const had = await mount(own, undefined, { "ui.pick": () => ({ token: "pick-1", name: "m.zip" }) });
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar…" }));
    await act(() => settle());
    expect(screen.getByText("This replaces the avatar you imported before.")).not.toBeNull();
    void had;
    cleanup();
    await mount(ALPHA_VIEW, undefined, { "ui.pick": () => ({ token: "pick-2", name: "m.zip" }) });
    fireEvent.click(screen.getByRole("button", { name: "Choose avatar…" }));
    await act(() => settle());
    expect(screen.queryByText("This replaces the avatar you imported before.")).toBeNull();
  });
});
