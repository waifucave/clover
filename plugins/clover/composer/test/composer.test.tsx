import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer } from "../client/Composer";
import type { ComposerAttachment, ComposerProps } from "../client/types";
import { ATTACHMENTS, MODELS } from "../gallery/stories";

afterEach(cleanup);

function setup(props: Partial<ComposerProps> = {}) {
  const onSend = mock((_m: { text: string; attachments: ComposerAttachment[] }) => undefined);
  const onChange = mock((_v: string) => undefined);
  const result = render(<Composer botName="Alpha" value="" onChange={onChange} onSend={onSend} {...props} />);
  const field = screen.getByRole("textbox", { name: "Message to Alpha" }) as HTMLTextAreaElement;
  return { ...result, onSend: (props.onSend as typeof onSend | undefined) ?? onSend, onChange, field };
}

/** A composer that keeps its own draft, as the host does. */
function Controlled({ onSend }: { onSend: (m: { text: string }) => void }) {
  const [value, setValue] = useState("");
  return <Composer botName="Alpha" value={value} onChange={setValue} onSend={(m) => { onSend(m); setValue(""); }} />;
}

describe("writing and sending", () => {
  test("typing reaches the host; the placeholder names the bot", () => {
    const { field, onChange } = setup();
    expect(field.placeholder).toBe("Message Alpha");
    fireEvent.change(field, { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  test("Enter sends the text and attachments; the host clears the draft", () => {
    const sent: string[] = [];
    render(<Controlled onSend={(m) => sent.push(m.text)} />);
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "ship it" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sent).toEqual(["ship it"]);
    expect(field.value).toBe("");
  });

  test("the send happens inside the key press itself, so the app can count it as the user's", () => {
    const { field, onSend } = setup({ value: "now" });
    let calledDuringDispatch = false;
    const late = () => {
      calledDuringDispatch = onSend.mock.calls.length > 0;
    };
    document.addEventListener("keydown", late);
    try {
      fireEvent.keyDown(field, { key: "Enter" });
    } finally {
      document.removeEventListener("keydown", late);
    }
    expect(calledDuringDispatch).toBe(true);
  });

  test("a click on Send sends inside the click", () => {
    const { onSend } = setup({ value: "now", attachments: ATTACHMENTS });
    let calledDuringDispatch = false;
    const late = () => {
      calledDuringDispatch = onSend.mock.calls.length > 0;
    };
    document.addEventListener("click", late);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    } finally {
      document.removeEventListener("click", late);
    }
    expect(calledDuringDispatch).toBe(true);
    expect(onSend).toHaveBeenCalledWith({ text: "now", attachments: ATTACHMENTS });
  });

  test("Shift+Enter and an input method's Enter do not send", () => {
    const { field, onSend } = setup({ value: "line one" });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("nothing to send: Send is off and Enter does nothing", () => {
    const { field, onSend } = setup({ value: "   " });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("while the bot works", () => {
  test("with nothing typed, the one round button stops the turn; Escape does too", () => {
    const onStop = mock(() => undefined);
    const { field } = setup({ running: true, onStop });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  test("with a draft, sending interrupts: Send and Stop both show, and the hint says so", () => {
    const onStop = mock(() => undefined);
    const { field, onSend } = setup({ running: true, onStop, value: "use staging" });
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByText("Sending now interrupts Alpha.")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({ text: "use staging", attachments: [] });
  });
});

describe("asleep and limits", () => {
  test("asleep: the draft stays editable, sending waits, and the note says why", () => {
    const { field, onSend, onChange } = setup({ value: "later", asleep: { reason: "Studio can't be reached" } });
    expect(screen.getByRole("status").textContent).toBe("Alpha is asleep: Studio can't be reached. Your message waits here until it's back.");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "later, please" } });
    expect(onChange).toHaveBeenCalledWith("later, please");
  });

  test("more attachments than a message carries: an alert, and no send", () => {
    const many = Array.from({ length: 21 }, (_, i): ComposerAttachment => ({ id: `f${i}`, kind: "file", name: `f${i}` }));
    setup({ attachments: many });
    expect(screen.getByRole("alert").textContent).toBe("A message can carry at most 20 attachments.");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("attachments", () => {
  test("chips show each attachment; remove and attach reach the host", () => {
    const onRemoveAttachment = mock((_id: string) => undefined);
    const onAttach = mock(() => undefined);
    const { container } = setup({ attachments: ATTACHMENTS, onRemoveAttachment, onAttach });
    expect(container.querySelectorAll(".cl-composer__thumb").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove island-b.png" }));
    expect(onRemoveAttachment).toHaveBeenCalledWith("a2");
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  test("pasted and dropped files are handed over; pasted text is not", () => {
    const onAddFiles = mock((_f: File[]) => undefined);
    const { field, container } = setup({ onAddFiles });
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(field, { clipboardData: { files: [file], types: ["Files"] } });
    expect(onAddFiles).toHaveBeenCalledWith([file]);
    fireEvent.paste(field, { clipboardData: { files: [], types: ["text/plain"] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    const root = container.querySelector(".cl-composer") as HTMLElement;
    fireEvent.dragEnter(root, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByText("Drop files to attach them")).toBeTruthy();
    fireEvent.drop(root, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(onAddFiles).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Drop files to attach them")).toBeNull();
  });
});

describe("model, voice and actions", () => {
  test("the model pill opens a menu; a model or an effort reaches the host", () => {
    const onChange = mock((_c: { model: string; effort?: string }) => undefined);
    setup({ model: { ...MODELS, onChange } });
    const pill = screen.getByRole("button", { name: "Model: Opus 5.5" });
    expect(pill.textContent).toContain("medium");
    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Model and effort" });
    expect(screen.getByRole("menuitemradio", { name: /Opus 5.5/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "high" }));
    expect(onChange).toHaveBeenCalledWith({ model: "anthropic/opus-5.5", effort: "high" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Sonnet 5/ }));
    expect(onChange).toHaveBeenLastCalledWith({ model: "anthropic/sonnet-5", effort: "medium" });
    expect(menu.isConnected).toBe(false);
    fireEvent.click(pill);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("push-to-talk: press starts, release ends, by pointer or keyboard; listening locks the field", () => {
    const onPressStart = mock(() => undefined);
    const onPressEnd = mock(() => undefined);
    const { rerender } = render(<Composer botName="Alpha" value="" onChange={() => undefined} onSend={() => undefined} voice={{ listening: false, onPressStart, onPressEnd }} />);
    const mic = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(mic, { pointerId: 1 });
    fireEvent.pointerUp(mic, { pointerId: 1 });
    fireEvent.keyDown(mic, { key: " " });
    fireEvent.keyUp(mic, { key: " " });
    expect(onPressStart).toHaveBeenCalledTimes(2);
    expect(onPressEnd).toHaveBeenCalledTimes(2);
    rerender(<Composer botName="Alpha" value="" onChange={() => undefined} onSend={() => undefined} voice={{ listening: true, onPressStart, onPressEnd }} />);
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(field.readOnly).toBe(true);
    expect(field.placeholder).toBe("Listening… release to stop");
    expect(screen.getByRole("button", { name: "Hold to talk" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("composer.action: a plugin replaces one button and hides another", () => {
    setup({
      onAttach: () => undefined,
      voice: { listening: false, onPressStart: () => undefined, onPressEnd: () => undefined },
      renderAction: (id, standard) => (id === "voice" ? <button type="button">Suggest</button> : id === "attach" ? null : standard),
    });
    expect(screen.getByRole("button", { name: "Suggest" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hold to talk" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});
