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
  render(<SettingsModal section="appearance" values={VALUES} {...h} {...props} />);
  return h;
}

describe("the settings window", () => {
  test("a dialog with every section listed; a section opens its page; Escape closes", () => {
    const h = setup();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(within(nav).getAllByRole("button")).toHaveLength(SECTIONS.length);
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Account", "Devices", "Appearance", "Notifications", "Plugins", "Levels", "Bots", "Usage",
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

  test("a page with nothing to set yet says so", () => {
    setup({ section: "usage" });
    expect(screen.getByText("Nothing to set here yet.")).toBeTruthy();
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
