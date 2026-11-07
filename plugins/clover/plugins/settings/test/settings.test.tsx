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
    onPluginSetting: mock((_p: string, _k: string, _v: unknown) => undefined),
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
      "Account", "Devices", "Appearance", "Notifications", "Plugins", "Levels", "Bots",
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
    expect(n.onPluginSetting).toHaveBeenLastCalledWith("clover/notifications", "sounds", true);
    // A notifier with no settings of its own says so.
    expect(screen.getByText("It has no settings of its own.")).toBeTruthy();
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

  test("Usage is the usage plugin's section, after Clover's own; Settings has none of its own (R3)", () => {
    expect(SECTIONS).not.toContain("usage" as never);
    setup({ section: "clover-usage#settings", extraSections: [{ id: "clover-usage#settings", title: "Usage", render: () => <p>Usage today</p> }] });
    const nav = [...document.querySelectorAll(".cl-settings__section")].map((b) => b.textContent);
    expect(nav[nav.length - 1]).toBe("Usage");
    expect(screen.getByText("Usage today")).toBeTruthy();
  });

  test("a plugin's row (S2): a found plugin's OK is reviewed on a card, no switch when blocked, refused or invalid, and Clover's own stays on", () => {
    const onReviewOk = mock((_id: string) => undefined);
    const row = (id: string, name: string, state: SettingsModalProps["values"]["plugins"][number]["state"], enabled = false) => ({ id, name, source: "index", state, enabled, oks: [] });
    const plugins = [
      row("clover", "Clover", "running", true),
      row("tarot", "Tarot", "found"),
      row("blocked-one", "Blocked one", "blocked"),
      row("refused-one", "Refused one", "refused"),
      row("invalid-one", "Invalid one", "invalid"),
      row("weather", "Weather", "running", true),
      row("story", "Story", "off"),
    ];
    const h = setup({ section: "plugins", values: { ...VALUES, plugins }, onReviewOk });
    const controls = (name: string) => {
      const r = screen.getByRole("group", { name });
      return [within(r).queryAllByRole("switch").length, within(r).queryAllByRole("button", { name: /OK/ }).length];
    };
    expect(plugins.map((p) => [p.name, ...controls(p.name)])).toEqual([
      ["Clover", 0, 0],
      ["Tarot", 0, 1],
      ["Blocked one", 0, 0],
      ["Refused one", 0, 0],
      ["Invalid one", 0, 0],
      ["Weather", 1, 0],
      ["Story", 1, 0],
    ]);
    expect(within(screen.getByRole("group", { name: "Clover" })).getByText("Part of Clover")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review Tarot's OK" }));
    expect(onReviewOk).toHaveBeenCalledWith("tarot");
    fireEvent.click(within(screen.getByRole("group", { name: "Weather" })).getByRole("switch"));
    expect(h.onChange).toHaveBeenCalledWith("plugins.weather.enabled", false);
  });

  test("an item marks its row on each page that has rows: a device, a plugin, a computer, a bot", () => {
    const h = setup({ section: "devices", item: "d2" });
    const marked = () => [...document.querySelectorAll<HTMLElement>("[data-marked]")].map((el) => el.dataset.item);
    expect(marked()).toEqual(["d2"]);
    expect(screen.getByText("Laptop").closest(".cl-settings__row")!.getAttribute("aria-current")).toBe("true");
    h.rerender(<SettingsModal {...h.props} section="plugins" item={VALUES.plugins[1]!.id} />);
    expect(marked()).toEqual([VALUES.plugins[1]!.id]);
    h.rerender(<SettingsModal {...h.props} section="levels" item="Cloud computer" />);
    expect(marked()).toEqual(["Cloud computer"]);
    h.rerender(<SettingsModal {...h.props} section="bots" item="alpha" />);
    expect(marked()).toEqual(["alpha"]);
    h.rerender(<SettingsModal {...h.props} section="bots" item="nobody" />);
    expect(marked()).toEqual([]);
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
