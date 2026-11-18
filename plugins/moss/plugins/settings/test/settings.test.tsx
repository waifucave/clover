import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { LanguageChooser } from "../client/LanguageChooser";
import { SECTIONS, SettingsModal, sectionsMatching } from "../client/SettingsModal";
import type { SettingsModalProps } from "../client/types";
import { LANGUAGES, VALUES } from "../gallery/fixtures";

afterEach(cleanup);

function setup(props: Partial<SettingsModalProps> = {}) {
  const h = {
    onSection: mock((_s: string) => undefined),
    onClose: mock(() => undefined),
    onChange: mock((_p: string, _v: unknown) => undefined),
    onOpenLanguage: mock(() => undefined),
    onRemoveDevice: mock((_id: string) => undefined),
    onRequestLevel: mock((_c: string, _l: string) => undefined),
    onOpenPluginLogs: mock((_id: string) => undefined),
  };
  const all: SettingsModalProps = { section: "appearance", values: VALUES, ...h, ...props };
  const { rerender } = render(<SettingsModal {...all} />);
  return { ...h, props: all, rerender };
}

describe("the settings window", () => {
  test("a dialog with every section listed; a section opens its page; Escape closes", () => {
    const h = setup();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(within(nav).getAllByRole("button")).toHaveLength(SECTIONS.length);
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Account", "Devices", "Appearance", "Notifications", "Plugins", "Tools", "Levels",
    ]);
    expect(within(nav).getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(nav).getByRole("button", { name: "Levels" }));
    expect(h.onSection).toHaveBeenCalledWith("levels");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  test("the search box keeps sections whose name or settings match", () => {
    expect(sectionsMatching("logs")).toEqual(["plugins"]);
    expect(sectionsMatching("lang")).toEqual(["appearance"]);
    expect(sectionsMatching("")).toEqual([...SECTIONS]);
    setup();
    const search = screen.getByRole("searchbox", { name: "Find a setting" });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "sounds" } });
    expect(within(screen.getByRole("navigation")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Notifications"]);
  });

  test("every plain control sends its change through one door", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(h.onChange).toHaveBeenLastCalledWith("appearance.theme", "dark");
    fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), { target: { value: "alpha-tab" } });
    expect(h.onChange).toHaveBeenLastCalledWith("theme", "alpha-tab");
    cleanup();
    const n = setup({ section: "notifications" });
    fireEvent.click(screen.getByRole("switch", { name: "Sounds" }));
    expect(n.onChange).toHaveBeenLastCalledWith("notifications.sounds", true);
  });

  test("plugins show their state, their OKs and their logs (spec §5.8)", () => {
    const h = setup({ section: "plugins" });
    const weather = screen.getByRole("group", { name: "Weather routine" });
    expect(weather.textContent).toContain("Waits for your OK");
    expect(weather.textContent).toContain("Reaches api.weather.example");
    expect(screen.getByRole("group", { name: "Story mode" }).textContent).toContain("Stopped after an error");
    fireEvent.click(screen.getByRole("button", { name: "Tarot panel's logs" }));
    expect(h.onOpenPluginLogs).toHaveBeenCalledWith("tarot-panel");
    fireEvent.click(screen.getByRole("switch", { name: "Tarot panel" }));
    expect(h.onChange).toHaveBeenLastCalledWith("plugins.tarot-panel.enabled", false);
  });

  test("each computer has its level; a pick is a request, the old level standing until its card is answered", () => {
    const h = setup({ section: "levels" });
    const studio = screen.getByRole("combobox", { name: "Studio's level" }) as HTMLSelectElement;
    expect(studio.value).toBe("ask-risky");
    fireEvent.change(studio, { target: { value: "automatic" } });
    expect(h.onRequestLevel).toHaveBeenCalledWith("Studio", "automatic");
    const laptop = screen.getByRole("combobox", { name: "Laptop's level" }) as HTMLSelectElement;
    expect(laptop.value).toBe("ask");
    expect(screen.getByRole("group", { name: "Laptop" }).textContent).toContain("Accept edits asked for");
  });

  test("nothing of the reference app's own features: no code page, no desktop page", () => {
    setup();
    const nav = screen.getByRole("navigation", { name: "Sections" });
    for (const name of ["Code", "Desktop app", "Capabilities", "Customize"]) expect(within(nav).queryByRole("button", { name })).toBeNull();
  });

  test("appearance opens the language chooser; devices can be removed, but never this one", () => {
    const h = setup({ section: "appearance" });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(h.onOpenLanguage).toHaveBeenCalledTimes(1);
    cleanup();
    const d = setup({ section: "devices" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Laptop" }));
    expect(d.onRemoveDevice).toHaveBeenCalledWith("d2");
    expect(screen.queryByRole("button", { name: "Remove Studio" })).toBeNull();
  });

  test("Usage is the usage plugin's section, after MOSS's own; Settings has none of its own (R3)", () => {
    expect(SECTIONS).not.toContain("usage" as never);
    setup({ section: "moss-usage#settings", extraSections: [{ id: "moss-usage#settings", title: "Usage", render: () => <p>Usage today</p> }] });
    const nav = [...document.querySelectorAll(".cl-settings__section")].map((b) => b.textContent);
    expect(nav[nav.length - 1]).toBe("Usage");
    expect(screen.getByText("Usage today")).toBeTruthy();
  });

  test("an item marks its row on each page that has rows: a device, a plugin, a computer (no Bots page in MOSS Code)", () => {
    const h = setup({ section: "devices", item: "d2" });
    const marked = () => [...document.querySelectorAll<HTMLElement>("[data-marked]")].map((el) => el.dataset.item);
    expect(marked()).toEqual(["d2"]);
    expect(screen.getByText("Laptop").closest(".cl-settings__row")!.getAttribute("aria-current")).toBe("true");
    h.rerender(<SettingsModal {...h.props} section="plugins" item={VALUES.plugins[1]!.id} />);
    expect(marked()).toEqual([VALUES.plugins[1]!.id]);
    h.rerender(<SettingsModal {...h.props} section="levels" item="Cloud computer" />);
    expect(marked()).toEqual(["Cloud computer"]);
  });

  test("devices: make another computer the main one, and pair a device by a code or by joining one", () => {
    const onMakeMain = mock((_id: string) => undefined);
    const onPairBegin = mock(() => undefined);
    const onPairJoin = mock((_c: string) => undefined);
    const { rerender, props } = setup({ section: "devices", onMakeMain, onPairBegin, onPairJoin });
    // Studio is the main one already; the phone can't be.
    expect(screen.queryByRole("button", { name: "Make Studio the main computer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make iPhone the main computer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Make Laptop the main computer" }));
    expect(onMakeMain).toHaveBeenCalledWith("d2");
    fireEvent.click(screen.getByRole("button", { name: "Show a code" }));
    expect(onPairBegin).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Code from another device" }), { target: { value: "KQ7-M2P" } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(onPairJoin).toHaveBeenCalledWith("KQ7-M2P");
    const onPairConfirm = mock(() => undefined);
    rerender(<SettingsModal {...props} onMakeMain={onMakeMain} onPairBegin={onPairBegin} pairing={{ code: "KQ7-M2P" }} />);
    expect(screen.getByRole("status").textContent).toContain("KQ7-M2P");
    rerender(<SettingsModal {...props} onPairBegin={onPairBegin} onPairConfirm={onPairConfirm} pairing={{ words: ["amber", "river", "lantern", "moss"] }} />);
    expect(screen.getByRole("status").textContent).toContain("amber · river · lantern · moss");
    fireEvent.click(screen.getByRole("button", { name: "They match" }));
    expect(onPairConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("the language chooser", () => {
  test("each language in itself and in the app's language; the current one checked; a pick reaches the host", () => {
    const onPick = mock((_id: string) => undefined);
    render(<LanguageChooser languages={LANGUAGES} current="en-US" onPick={onPick} onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "Language" })).toBeTruthy();
    const current = screen.getByRole("radio", { name: /English \(United States\)/ });
    expect(current.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /日本語/ }));
    expect(onPick).toHaveBeenCalledWith("ja");
  });

  test("search matches a language's own name or its name in the app's language", () => {
    render(<LanguageChooser languages={LANGUAGES} current="en-US" onPick={() => undefined} onClose={() => undefined} />);
    const search = screen.getByRole("searchbox", { name: "Find a language" });
    fireEvent.change(search, { target: { value: "deutsch" } });
    expect(screen.getAllByRole("radio").map((r) => r.querySelector(".cl-languages__name")?.textContent)).toEqual(["German"]);
    fireEvent.change(search, { target: { value: "japanese" } });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "klingon" } });
    expect(screen.getByText("No language matches")).toBeTruthy();
  });
});

describe("the Tools tab", () => {
  const tools = {
    plugins: [{
      pluginId: "reel", name: "Reel", server: "reel-reel", tools: [
        { name: "Export", permission: "ask" as const, cardRules: [{ bot: "alpha", botName: "Alpha", computers: ["Delta"] }] },
        { name: "Trim", permission: "allow" as const, isNew: true, cardRules: [] },
      ],
    }],
  };

  test("each plugin is a heading with its tools by their own names, three choices each, and a row that sets them all", () => {
    const onSetTool = mock((_s: string, _t: string | undefined, _p: string) => undefined);
    setup({ section: "tools", tools, onSetTool });
    expect(screen.getByText("Reel")).toBeTruthy();
    expect(screen.getByText("Export")).toBeTruthy();
    expect(screen.queryByText("mcp__reel-reel__Export")).toBeNull();
    const group = screen.getByRole("radiogroup", { name: "What Export may do" });
    expect(within(group).getAllByRole("radio").map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([["Always allow", "false"], ["Ask", "true"], ["Always block", "false"]]);
    fireEvent.click(within(group).getByRole("radio", { name: "Always allow" }));
    expect(onSetTool).toHaveBeenLastCalledWith("reel-reel", "Export", "allow");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "What every tool of Reel may do" })).getByRole("radio", { name: "Always block" }));
    expect(onSetTool).toHaveBeenLastCalledWith("reel-reel", undefined, "deny");
  });

  test("a mixed plugin shows no row value; a tool added later is marked new; the plain words say what Always allow means once", () => {
    setup({ section: "tools", tools });
    const row = screen.getByRole("radiogroup", { name: "What every tool of Reel may do" });
    expect(within(row).getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(screen.getByText("New: asks until you set it")).toBeTruthy();
    expect(screen.getAllByText(/runs without asking, whatever it is given|Always allow means the tool runs without asking, whatever it is given/)).toHaveLength(1);
  });

  test("each tool also has whether it is offered: off, on demand or always on, the plugin's own default marked, and it never reads as Always block", () => {
    const withSetting = { plugins: [{ pluginId: "reel", name: "Reel", server: "reel-reel", tools: [
      { name: "Export", permission: "deny" as const, availability: "on-demand" as const, declared: "on-demand" as const, cardRules: [] },
      { name: "Trim", permission: "ask" as const, availability: "off" as const, declared: "preload" as const, cardRules: [] },
    ] }] };
    const onSetAvailability = mock((_s: string, _t: string | undefined, _a: string) => undefined);
    setup({ section: "tools", tools: withSetting, onSetAvailability });
    const offered = screen.getByRole("radiogroup", { name: "Whether Export is offered" });
    expect(within(offered).getAllByRole("radio").map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([["Off", "false"], ["On demand (default)", "true"], ["Always on", "false"]]);
    // The permission beside it is its own: Export is blocked and still offered.
    expect(within(screen.getByRole("radiogroup", { name: "What Export may do" })).getByRole("radio", { name: "Always block" }).getAttribute("aria-checked")).toBe("true");
    // Trim's declared default is marked even though the user turned it off.
    const trim = screen.getByRole("radiogroup", { name: "Whether Trim is offered" });
    expect(within(trim).getAllByRole("radio").map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([["Off", "true"], ["On demand", "false"], ["Always on (default)", "false"]]);
    fireEvent.click(within(trim).getByRole("radio", { name: "On demand" }));
    expect(onSetAvailability).toHaveBeenLastCalledWith("reel-reel", "Trim", "on-demand");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Whether every tool of Reel is offered" })).getByRole("radio", { name: "Always on" }));
    expect(onSetAvailability).toHaveBeenLastCalledWith("reel-reel", undefined, "always");
  });

  test("a tool set to on demand says a conversation already running may keep it loaded until it starts over; off and always on say nothing of the kind", () => {
    const withSetting = { plugins: [{ pluginId: "reel", name: "Reel", server: "reel-reel", tools: [
      { name: "Export", permission: "ask" as const, availability: "on-demand" as const, declared: "on-demand" as const, cardRules: [] },
      { name: "Trim", permission: "ask" as const, availability: "off" as const, declared: "preload" as const, cardRules: [] },
      { name: "Cut", permission: "ask" as const, availability: "always" as const, declared: "preload" as const, cardRules: [] },
    ] }] };
    setup({ section: "tools", tools: withSetting, onSetAvailability: mock(() => undefined) });
    expect(screen.getAllByText("A conversation already running may keep it loaded until it starts over.")).toHaveLength(1);
  });

  test("an engine that doesn't serve the tool setting shows the three permissions only", () => {
    setup({ section: "tools", tools });
    expect(screen.queryByRole("radiogroup", { name: "Whether Export is offered" })).toBeNull();
    expect(screen.queryByText("Offered to bots and agents")).toBeNull();
  });

  test("a card's Always allow for one bot is on the tool's row and is taken back there", () => {
    const onTakeBackRule = mock((_s: string, _t: string, _b: string) => undefined);
    setup({ section: "tools", tools, onTakeBackRule });
    expect(screen.getByText("Always allowed for Alpha, on Delta only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take back Alpha's Always allow for Export" }));
    expect(onTakeBackRule).toHaveBeenCalledWith("reel-reel", "Export", "alpha");
  });
});

describe("one at a time (spec §5.4)", () => {
  const point = (over: Partial<NonNullable<SettingsModalProps["oneAtATime"]>[number]> = {}) => ({
    point: "deck.mode", title: "Deck mode",
    fillers: [{ pluginId: "one", entryId: "one", name: "First" }, { pluginId: "two", entryId: "two", name: "Second" }],
    active: { pluginId: "one", entryId: "one" }, ...over,
  });

  test("a picker per point with two or more fillers on the Plugins page, titled by its title; a press picks one", () => {
    const onPickActive = mock((_p: string, _e: { pluginId: string; entryId: string }) => undefined);
    setup({ section: "plugins", oneAtATime: [point(), point({ point: "deck.lone", title: "Lone", fillers: [{ pluginId: "one", entryId: "lone", name: "Only" }] })], onPickActive });
    const group = screen.getByRole("radiogroup", { name: "Deck mode" });
    expect(within(group).getAllByRole("radio").map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([["First", "true"], ["Second", "false"]]);
    expect(screen.queryByRole("radiogroup", { name: "Lone" })).toBeNull();
    expect(screen.getByText("Only one of these is used at a time.")).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "Second" }));
    expect(onPickActive).toHaveBeenCalledWith("deck.mode", { pluginId: "two", entryId: "two" });
  });

  test("a pick that isn't running: the one standing in is pressed, and the row says so", () => {
    setup({ section: "plugins", oneAtATime: [point({ chosen: { pluginId: "three", entryId: "three" } })] });
    expect(screen.getByText("The one you picked isn't running, so First is used for now.")).toBeTruthy();
  });
});
