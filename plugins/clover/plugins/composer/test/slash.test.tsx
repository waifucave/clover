// The slash menu: its rules (slash.ts) and its keys in the composer.
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer } from "../client/Composer";
import { argsFor, armedFor, BUILT_IN_NAMES, displayNames, inScope, matchCommands, refusalText, resultText, RESULT_MAX, slashLine, type SlashCommand } from "../client/slash";
import type { ComposerSlash } from "../client/types";

afterEach(cleanup);

const cmd = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({ name, pluginId: name.split(".")[0]!, pluginName: name.split(".")[0]!, description: `${name} does it`, own: false, ...extra });

describe("the slash rules", () => {
  test("a command line is / and a name; a path or plain text isn't one", () => {
    expect(slashLine("/")).toEqual({ token: "", rest: "" });
    expect(slashLine("/dra")).toEqual({ token: "dra", rest: "" });
    expect(slashLine("/tarot.draw  three cards ")).toEqual({ token: "tarot.draw", rest: "three cards" });
    expect(slashLine("/Users/me/notes.txt")).toBeUndefined();
    expect(slashLine("hello /draw")).toBeUndefined();
    // A / then a space or a line break is text: a paste that starts with one never runs a command.
    expect(slashLine("/ hello")).toBeUndefined();
    expect(slashLine("/\npasted text")).toBeUndefined();
    expect(slashLine("")).toBeUndefined();
  });

  test("a short name shows unless another plugin's command or a built-in has it, then the full name", () => {
    const names = displayNames([cmd("tarot.draw"), cmd("paint.draw"), cmd("tarot.shuffle"), cmd("evil.help"), cmd("evil.Model")]);
    expect(names.get("tarot.draw")).toBe("tarot.draw");
    expect(names.get("paint.draw")).toBe("paint.draw");
    expect(names.get("tarot.shuffle")).toBe("shuffle");
    expect(BUILT_IN_NAMES.has("help")).toBe(true);
    expect(names.get("evil.help")).toBe("evil.help");
    expect(names.get("evil.Model")).toBe("evil.Model");
  });

  test("matching: an exact name first, then prefixes, then the rest that hold it; all for a bare /", () => {
    const list = [cmd("a.redraw"), cmd("b.draw"), cmd("c.drawing"), cmd("d.other")];
    expect(matchCommands(list, "").map((i) => i.command.name)).toEqual(["a.redraw", "b.draw", "c.drawing", "d.other"]);
    expect(matchCommands(list, "draw").map((i) => i.command.name)).toEqual(["b.draw", "c.drawing", "a.redraw"]);
    expect(matchCommands(list, "b.dr").map((i) => i.command.name)).toEqual(["b.draw"]);
    expect(matchCommands(list, "zzz")).toEqual([]);
  });

  test("Enter runs a row only when its name is typed in full or it alone starts with what is typed", () => {
    const list = [cmd("evil.say"), cmd("echo.say"), cmd("evil.help"), cmd("tarot.draw"), cmd("tarot.dream")];
    const at = (t: string) => matchCommands(list, t);
    const armed = (t: string) => { const rows = at(t); return armedFor(rows, rows[0], t); };
    // Two plugins' `say`: neither answers to the short name, so neither runs on it.
    expect(at("say").map((i) => i.display)).toEqual(["evil.say", "echo.say"]);
    expect(armed("say")).toBe(false);
    expect(armed("echo.say")).toBe(true);
    // A built-in's name: the plugin's command shows in full and doesn't run on the bare name.
    expect(armed("help")).toBe(false);
    // A prefix two rows share runs nothing; one only one row has runs it; nothing typed runs nothing.
    expect(armed("dr")).toBe(false);
    expect(armed("dre")).toBe(true);
    expect(armed("")).toBe(false);
  });

  test("scope: a bots-only plugin's commands in bot conversations, an agents-only one's in agent tabs", () => {
    expect(inScope(cmd("x.a", { scope: "bots" }), "bot")).toBe(true);
    expect(inScope(cmd("x.a", { scope: "bots" }), "agent")).toBe(false);
    expect(inScope(cmd("x.a", { scope: "agents" }), "coding")).toBe(true);
    expect(inScope(cmd("x.a", { scope: "agents" }), "side-thread")).toBe(false);
    expect(inScope(cmd("x.a", { scope: "both" }), "agent")).toBe(true);
    expect(inScope(cmd("x.a"), "bot")).toBe(true);
  });

  test("the rest of the line becomes the args by the command's schema", () => {
    expect(argsFor(undefined, "", "x")).toEqual({ ok: true });
    expect(argsFor(undefined, "more", "x")).toEqual({ ok: false, why: "/x takes nothing after its name." });
    expect(argsFor({ type: "string" }, " hi there ", "x")).toEqual({ ok: true, args: "hi there" });
    expect(argsFor({ type: "integer" }, "3", "x")).toEqual({ ok: true, args: 3 });
    expect(argsFor({ type: "integer" }, "three", "x").ok).toBe(false);
    expect(argsFor({ type: "boolean" }, "true", "x")).toEqual({ ok: true, args: true });
    const obj = { type: "object", required: ["text"], properties: { text: { type: "string" }, loud: { type: "boolean" } } };
    expect(argsFor(obj, "", "x")).toEqual({ ok: true, args: {} });
    expect(argsFor(obj, "say this", "x")).toEqual({ ok: true, args: { text: "say this" } });
    expect(argsFor(obj, '{"text": "a", "loud": true}', "x")).toEqual({ ok: true, args: { text: "a", loud: true } });
    expect(argsFor(obj, "{not json", "x")).toEqual({ ok: false, why: "/x couldn't read that as JSON." });
    expect(argsFor({ type: "object", properties: { only: { type: "string" } } }, "fill", "x")).toEqual({ ok: true, args: { only: "fill" } });
    expect(argsFor({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } }, "fill", "x").ok).toBe(false);
  });

  test("a result reads as one short line of text; a refusal without the transport's words", () => {
    expect(resultText(undefined)).toBe("Done.");
    expect(resultText("drawn: the Moon")).toBe("drawn: the Moon");
    expect(resultText({ text: "ok" })).toBe("ok");
    expect(resultText({ message: "fine" })).toBe("fine");
    expect(resultText({ cards: [1, 2] })).toBe('{"cards":[1,2]}');
    expect(resultText("<b>x</b>\n\nline")).toBe("<b>x</b> line");
    expect(resultText("y".repeat(1000)).length).toBe(RESULT_MAX);
    expect(refusalText(new Error("Error invoking remote method 'clover:composer': Error: no command x.y is running here"))).toBe("no command x.y is running here");
    expect(refusalText(undefined)).toBe("The command didn't run.");
  });
});

/** A composer that keeps its draft, with a slash menu of `commands` whose runs are recorded. */
function Host({ commands, onSend, runs, cardPending }: { commands: SlashCommand[]; onSend: (t: string) => void; runs: [string, string][]; cardPending?: boolean }) {
  const [value, setValue] = useState("");
  const [opened, setOpened] = useState(0);
  const slash: ComposerSlash = {
    commands,
    onOpen: () => setOpened((n) => n + 1),
    onRun: (command, rest) => runs.push([command.name, rest]),
    onDismissResult: () => undefined,
  };
  return (
    <>
      <span data-testid="opened">{opened}</span>
      <Composer botName="Alpha" value={value} onChange={setValue} onSend={(m) => { onSend(m.text); setValue(""); }} slash={slash} cardPending={cardPending ?? false} />
    </>
  );
}

describe("the slash menu's keys", () => {
  const list = [cmd("alpha.wave", { own: true }), cmd("tarot.draw"), cmd("tarot.dream")];

  function setup(cardPending = false) {
    const sent: string[] = [];
    const runs: [string, string][] = [];
    render(<Host commands={list} onSend={(t) => sent.push(t)} runs={runs} cardPending={cardPending} />);
    const box = () => (screen.queryByRole("combobox") ?? screen.getByRole("textbox")) as HTMLTextAreaElement;
    return { sent, runs, box };
  }

  test("/ opens the list (read again each time) with focus kept in the box, as a combobox", () => {
    const { box } = setup();
    fireEvent.change(box(), { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Plugin commands" })).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBe(3);
    expect(box().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id);
    expect(screen.getByTestId("opened").textContent).toBe("1");
    fireEvent.change(box(), { target: { value: "" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box(), { target: { value: "/" } });
    expect(screen.getByTestId("opened").textContent).toBe("2");
  });

  test("arrows move, Enter runs the one picked with the rest of the line, inside the key press, and nothing is sent", () => {
    const { box, runs, sent } = setup();
    fireEvent.change(box(), { target: { value: "/dr 3 cards" } });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    let during = false;
    const late = () => { during = runs.length > 0; };
    document.addEventListener("keydown", late);
    try {
      fireEvent.keyDown(box(), { key: "Enter" });
    } finally {
      document.removeEventListener("keydown", late);
    }
    expect(during).toBe(true);
    expect(runs).toEqual([["tarot.dream", "3 cards"]]);
    expect(sent).toEqual([]);
  });

  test("a click runs it; Send on a command line runs the one picked, never sends", () => {
    const { box, runs, sent } = setup();
    fireEvent.change(box(), { target: { value: "/wave" } });
    fireEvent.click(screen.getAllByRole("option")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(runs).toEqual([["alpha.wave", ""], ["alpha.wave", ""]]);
    expect(sent).toEqual([]);
  });

  test("a short name two plugins share, or a bare /, runs nothing on Enter; an arrow pick does", () => {
    const sent: string[] = [];
    const runs: [string, string][] = [];
    render(<Host commands={[cmd("evil.say"), cmd("echo.say")]} onSend={(t) => sent.push(t)} runs={runs} />);
    const box = () => screen.getByRole("combobox") as HTMLTextAreaElement;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.change(box(), { target: { value: "/say my words" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(runs).toEqual([]);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(runs).toEqual([["echo.say", "my words"]]);
    expect(sent).toEqual([]);
  });

  test("Tab completes the name; a name nothing matches runs nothing and sends nothing", () => {
    const { box, runs, sent } = setup();
    fireEvent.change(box(), { target: { value: "/drea" } });
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe("/dream ");
    fireEvent.change(box(), { target: { value: "/nothing here" } });
    expect(screen.getByRole("listbox").textContent).toContain("No command /nothing.");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(runs).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("Esc sets the list aside, and then Enter sends the line as a message", () => {
    const { box, runs, sent } = setup();
    fireEvent.change(box(), { target: { value: "/draw is a word" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(runs).toEqual([]);
    expect(sent).toEqual(["/draw is a word"]);
  });

  test("while a card waits, the list is closed and Enter on a command line does nothing", () => {
    const { box, runs, sent } = setup(true);
    fireEvent.change(box(), { target: { value: "/draw" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(runs).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("a composing input method's Enter picks its candidate, not a command", () => {
    const { box, runs } = setup();
    fireEvent.change(box(), { target: { value: "/draw" } });
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true, keyCode: 229 });
    expect(runs).toEqual([]);
  });
});

