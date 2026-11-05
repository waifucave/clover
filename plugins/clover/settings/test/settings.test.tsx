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
  };
  render(<SettingsModal section="code" values={VALUES} {...h} {...props} />);
  return h;
}

describe("the settings window", () => {
  test("a dialog with every section listed; a section opens its page; Escape closes", () => {
    const h = setup();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(within(nav).getAllByRole("button")).toHaveLength(SECTIONS.length);
    expect(within(nav).getByRole("button", { name: "Code" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(nav).getByRole("button", { name: "Appearance" }));
    expect(h.onSection).toHaveBeenCalledWith("appearance");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  test("the search box keeps sections whose name or settings match", () => {
    expect(sectionsMatching("branch")).toEqual(["code"]);
    expect(sectionsMatching("lang")).toEqual(["appearance"]);
    expect(sectionsMatching("")).toEqual([...SECTIONS]);
    setup();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "sounds" } });
    expect(within(screen.getByRole("navigation")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Notifications"]);
  });

  test("every control sends its change through one door", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("switch", { name: "Label sessions by state" }));
    expect(h.onChange).toHaveBeenLastCalledWith("code.labelSessions", false);
    fireEvent.click(screen.getByRole("radio", { name: "Everything" }));
    expect(h.onChange).toHaveBeenLastCalledWith("code.transcript", "everything");
    fireEvent.change(screen.getByRole("textbox", { name: "Branch prefix" }), { target: { value: "sam/" } });
    expect(h.onChange).toHaveBeenLastCalledWith("code.branchPrefix", "sam/");
    fireEvent.change(screen.getByRole("combobox", { name: "Answer style" }), { target: { value: "terse" } });
    expect(h.onChange).toHaveBeenLastCalledWith("code.outputStyle", "terse");
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
    setup({ section: "privacy" });
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
    const search = screen.getByRole("searchbox", { name: "Search languages" });
    fireEvent.change(search, { target: { value: "deutsch" } });
    expect(screen.getAllByRole("radio").map((r) => r.querySelector(".cl-languages__name")?.textContent)).toEqual(["German"]);
    fireEvent.change(search, { target: { value: "japanese" } });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "klingon" } });
    expect(screen.getByText("No language matches")).toBeTruthy();
  });
});
