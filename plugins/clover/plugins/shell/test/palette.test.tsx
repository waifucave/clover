// The command palette and the shortcuts (spec §5.2 "Commands").
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { checkArgs, noArgs, runsBare } from "../client/args";
import { fieldsOf, Palette } from "../client/Palette";
import { appShortcut } from "../../../../../apps/desktop/src/main/shortcuts";
import { APP_KEYS, bindings, chordOf, commandFor, CORE_KEYS, parseChord, reserved, showChord, writeChord } from "../client/shortcuts";
import { a11yFindings } from "../runtime/a11y";

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

describe("the keys no command takes (review N3)", () => {
  test("a plugin's default never takes an editing, focus or app key, on either platform; nor does the user's binding", () => {
    const taken = ["Mod+C", "Mod+V", "Mod+X", "Mod+Z", "Mod+Shift+Z", "Mod+A", "Mod+F", "Tab", "Shift+Tab", "Enter", "Space", "Escape", "Up", "Down", "Left", "Right", "F6", "Mod+Q", "Mod+W", "Mod+,", "Mod+K"];
    const commands = [...taken.map((k, i) => ({ name: `p.c${i}`, key: k })), { name: "p.ok", key: "Mod+Shift+D" }];
    for (const platform of ["mac", "other"] as const) {
      expect(Object.fromEntries(bindings(commands, {}, platform))).toEqual({ "p.ok": "Mod+Shift+D" });
      expect(Object.fromEntries(bindings([], { "u.copy": "Mod+C", "u.tab": "Tab", "u.ok": "Alt+J" }, platform))).toEqual({ "u.ok": "Alt+J" });
    }
    // Pressed keys by their DOM names are the same keys.
    expect(reserved(key("ArrowUp"), "mac")).toBe(true);
    expect(reserved(key(" "), "mac")).toBe(true);
    expect(reserved(key("v", { metaKey: true }), "mac")).toBe(true);
    expect(reserved(key("v", { ctrlKey: true }), "other")).toBe(true);
    expect(reserved(key("d", { metaKey: true, shiftKey: true }), "mac")).toBe(false);
  });

  test("the app keys are lane E's: every key its main process takes is reserved here, and only those", () => {
    for (const platform of ["mac", "other"] as const) {
      const node = platform === "mac" ? "darwin" : "linux";
      const theirs: string[] = [];
      for (const k of "abcdefghijklmnopqrstuvwxyz0123456789,./;'[]-=") {
        for (const shift of [false, true]) {
          const input = { type: "keyDown", key: k, control: platform === "other", meta: platform === "mac", alt: false, shift };
          if (appShortcut(input, node)) theirs.push(writeChord(chordOf({ key: k, code: /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : k, ctrlKey: input.control, metaKey: input.meta, altKey: false, shiftKey: shift }), platform));
        }
      }
      // Every key E takes is reserved here, and every app key here is one E takes.
      expect(theirs.filter((t) => !reserved(parseChord(t)!, platform))).toEqual([]);
      expect(APP_KEYS.filter((a) => !theirs.some((t) => writeChord(parseChord(t)!, platform) === writeChord(parseChord(a)!, platform)))).toEqual([]);
      expect(CORE_KEYS).toEqual(expect.arrayContaining([...APP_KEYS]));
    }
  });
});

describe("the palette", () => {
  const commands = [
    { name: "tarot.draw", pluginId: "tarot", description: "Draws a card" },
    { name: "tarot.spread", pluginId: "tarot", description: "Lays out a spread", args: { type: "object", properties: { cards: { type: "integer", title: "Cards", minimum: 1, maximum: 10 }, deck: { enum: ["major", "full"] }, note: { type: "string", pattern: "^[a-z ]*$", maxLength: 12 } }, required: ["cards"], additionalProperties: false } },
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
    // Every control named and reachable: the search takes the keys, the options are its listbox's.
    expect(a11yFindings(document.body)).toEqual([]);
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
    // The schema decides, not just "it's a number" (N4): an integer, in range; the note's pattern and length.
    const tries: [string, string, string][] = [
      ["0", "", "Cards must be at least 1."],
      ["2.5", "", "Cards isn't what this command takes."],
      ["11", "", "Cards must be at most 10."],
      ["3", "NO CAPS", "note isn't what this command takes."],
      ["3", "much too long a note", "note takes at most 12 characters."],
    ];
    for (const [cards, note, said] of tries) {
      fireEvent.change(within(form).getByRole("spinbutton"), { target: { value: cards } });
      fireEvent.change(within(form).getByRole("textbox"), { target: { value: note } });
      fireEvent.click(within(form).getByRole("button", { name: "Run" }));
      expect([cards, note, within(form).getByRole("alert").textContent]).toEqual([cards, note, said]);
    }
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "" } });
    fireEvent.change(within(form).getByRole("spinbutton"), { target: { value: "3" } });
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "major" } });
    fireEvent.click(within(form).getByRole("button", { name: "Run" }));
    await act(async () => undefined);
    expect(onRun).toHaveBeenCalledWith("tarot.spread", { cards: 3, deck: "major" });
    expect(fieldsOf(commands[1]!.args).map((f) => [f.name, f.type, f.required])).toEqual([["cards", "number", true], ["deck", "enum", false], ["note", "string", false]]);
  });

  test("the validator: types, ranges, patterns, choices, nested shapes and unknown keys; an unreadable schema never runs", () => {
    const schema = { type: "object", properties: { n: { type: "integer", minimum: 1 }, opts: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false }, tags: { type: "array", items: { type: "string" }, maxItems: 2 } }, required: ["n"], additionalProperties: false };
    expect(checkArgs(schema, { n: 2, opts: { on: true }, tags: ["a"] })).toEqual({ ok: true });
    const kinds = (v: unknown) => { const r = checkArgs(schema, v); return r.ok ? [] : r.issues.map((i) => `${i.field}:${i.kind}`); };
    expect(kinds({})).toEqual(["n:missing"]);
    expect(kinds({ n: "2" })).toEqual(["n:type"]);
    expect(kinds({ n: 2, opts: {} })).toEqual(["opts:type"]);
    expect(kinds({ n: 2, opts: { on: true, x: 1 } })).toEqual(["opts:unknown-key"]);
    expect(kinds({ n: 2, tags: ["a", "b", "c"] })).toEqual(["tags:too-big"]);
    expect(kinds({ n: 2, extra: 1 })).toEqual(["extra:unknown-key"]);
    expect(kinds(undefined)).toEqual([":type"]);
    expect(checkArgs({ $ref: "#/nowhere" }, {})).toEqual({ ok: false, unreadable: true, issues: [] });
    // A command with an object schema and nothing required runs with `{}`, never `undefined`; one with none, bare.
    expect([noArgs({ type: "object" }), runsBare({ type: "object" }), runsBare({ type: "object", required: ["a"], properties: { a: {} } }), noArgs(undefined), runsBare(undefined)]).toEqual([{}, true, false, undefined, true]);
  });

  test("a place opens; a command's shortcut can be changed to the next key pressed, or removed", () => {
    const { go, onRebind } = open();
    fireEvent.click(screen.getByRole("button", { name: "Change tarot.spread's shortcut" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Shift" });
    // A key no command takes (paste, Tab) is refused, and the row waits for another (N3).
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "v", code: "KeyV", metaKey: true });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", code: "Tab" });
    expect(onRebind).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("That key is Clover's own. Press another, or Esc");
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
