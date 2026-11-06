// The command palette and the shortcuts (spec §5.2 "Commands").
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fieldsOf, Palette } from "../client/Palette";
import { bindings, chordOf, commandFor, parseChord, showChord } from "../client/shortcuts";

afterEach(cleanup);

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  chordOf({ key: k, code: /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("shortcuts", () => {
  test("Mod is ⌘ on macOS and Ctrl elsewhere, and shows as each OS writes it", () => {
    expect(commandFor(key("t", { metaKey: true, shiftKey: true }), new Map([["tarot.draw", "Mod+Shift+T"]]), "mac")).toBe("tarot.draw");
    expect(commandFor(key("t", { ctrlKey: true, shiftKey: true }), new Map([["tarot.draw", "Mod+Shift+T"]]), "other")).toBe("tarot.draw");
    expect(commandFor(key("t", { ctrlKey: true, shiftKey: true }), new Map([["tarot.draw", "Mod+Shift+T"]]), "mac")).toBeUndefined();
    expect(showChord("Mod+Shift+T", "mac")).toBe("⇧⌘T");
    expect(showChord("CmdOrCtrl+Shift+T", "other")).toBe("Ctrl+Shift+T");
    expect(parseChord("Hyper+T")).toBeUndefined();
  });

  test("a core shortcut wins over a default, the user's binding over both defaults and the core's leftovers; a shared default binds neither", () => {
    const commands = [
      { name: "a.quit", key: "Mod+Q" },
      { name: "b.draw", key: "Mod+Shift+D" },
      { name: "c.dup", key: "Alt+J" },
      { name: "d.dup", key: "Alt+J" },
      { name: "e.mine", key: "Mod+Shift+E" },
      { name: "f.taken", key: "Mod+Shift+M" },
    ];
    const user = { "e.mine": null, "f.other": "Mod+Shift+M", "g.core": "Mod+K" };
    expect(Object.fromEntries(bindings(commands, user, "mac"))).toEqual({ "f.other": "Mod+Shift+M", "b.draw": "Mod+Shift+D" });
  });
});

describe("the palette", () => {
  const commands = [
    { name: "tarot.draw", pluginId: "tarot", description: "Draws a card" },
    { name: "tarot.spread", pluginId: "tarot", description: "Lays out a spread", args: { type: "object", properties: { cards: { type: "integer", title: "Cards" }, deck: { enum: ["major", "full"] }, note: { type: "string" } }, required: ["cards"] } },
  ];

  function open(extra: Partial<Parameters<typeof Palette>[0]> = {}) {
    const onRun = mock(async (_n: string, _a: Record<string, unknown> | undefined) => undefined);
    const onRebind = mock((_n: string, _k: string | null) => undefined);
    const onClose = mock(() => undefined);
    const go = mock(() => undefined);
    render(<Palette commands={commands} places={[{ id: "bot:luna", title: "Luna", detail: "Bot", go }]} bound={new Map([["tarot.draw", "Mod+Shift+D"]])} platform="mac" onRun={onRun} onRebind={onRebind} onClose={onClose} {...extra} />);
    return { onRun, onRebind, onClose, go };
  }

  test("lists places and commands with their shortcuts; typing filters; Enter runs the one the arrows are on", async () => {
    const { onRun, onClose } = open();
    const list = screen.getByRole("listbox", { name: "Results" });
    expect(within(list).getAllByRole("option").map((o) => o.querySelector(".cl-palette__name")?.textContent)).toEqual(["Luna", "tarot.draw", "tarot.spread"]);
    expect(within(list).getByText("⇧⌘D")).toBeTruthy();
    const search = screen.getByRole("combobox", { name: "Search commands and bots" });
    fireEvent.change(search, { target: { value: "draw" } });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    await act(async () => undefined);
    expect(onRun).toHaveBeenCalledWith("tarot.draw", undefined);
    expect(onClose).toHaveBeenCalled();
  });

  test("a command with args asks for them by their schema, and checks what's needed", async () => {
    const { onRun } = open();
    fireEvent.click(screen.getByText("tarot.spread"));
    const form = screen.getByRole("form", { name: "What tarot.spread needs" });
    fireEvent.click(within(form).getByRole("button", { name: "Run" }));
    expect(within(form).getByRole("alert").textContent).toBe("Cards is needed.");
    fireEvent.change(within(form).getByRole("spinbutton"), { target: { value: "3" } });
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "major" } });
    fireEvent.click(within(form).getByRole("button", { name: "Run" }));
    await act(async () => undefined);
    expect(onRun).toHaveBeenCalledWith("tarot.spread", { cards: 3, deck: "major" });
    expect(fieldsOf(commands[1]!.args).map((f) => [f.name, f.type, f.required])).toEqual([["cards", "number", true], ["deck", "enum", false], ["note", "string", false]]);
  });

  test("a place opens; a command's shortcut can be changed to the next key pressed, or removed", () => {
    const { go, onRebind } = open();
    fireEvent.click(screen.getByRole("button", { name: "Change tarot.spread's shortcut" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Shift" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "s", code: "KeyS", metaKey: true, altKey: true });
    expect(onRebind).toHaveBeenCalledWith("tarot.spread", "Mod+Alt+S");
    fireEvent.click(screen.getByRole("button", { name: "Remove tarot.draw's shortcut" }));
    expect(onRebind).toHaveBeenLastCalledWith("tarot.draw", null);
    fireEvent.click(screen.getByText("Luna"));
    expect(go).toHaveBeenCalled();
  });

  test("a command that fails says why and stays open", async () => {
    const onRun = mock(async () => {
      throw new Error("not installed");
    });
    open({ onRun });
    fireEvent.click(screen.getByText("tarot.draw"));
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toBe("tarot.draw didn't run: not installed");
  });
});
