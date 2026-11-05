import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer } from "../client/Composer";
import type { ComposerAttachment, ComposerProps } from "../client/types";
import { ATTACHMENTS, LEVEL, MODELS } from "../gallery/stories";

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

  test("a held Enter sends once: its repeats send nothing", () => {
    const { field, onSend } = setup({ value: "hello" });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Enter", repeat: true });
    fireEvent.keyDown(field, { key: "Enter", repeat: true });
    expect(onSend).toHaveBeenCalledTimes(1);
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
    // Text pasted together with an image still lands in the field: only the file goes to the host.
    const both = createEvent.paste(field, {
      clipboardData: { files: [file], types: ["Files", "text/plain"], getData: (t: string) => (t === "text/plain" ? "the caption" : "") },
    });
    fireEvent(field, both);
    expect(onAddFiles).toHaveBeenCalledTimes(2);
    expect(both.defaultPrevented).toBe(false);
    const root = container.querySelector(".cl-composer") as HTMLElement;
    fireEvent.dragEnter(root, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByText("Drop files to attach them")).toBeTruthy();
    fireEvent.drop(root, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(onAddFiles).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("Drop files to attach them")).toBeNull();
  });
});

describe("model, voice and actions", () => {
  test("the model pill opens a menu; a model or an effort reaches the host, and focus comes back", () => {
    const onChange = mock((_c: { model: string; effort?: string }) => undefined);
    setup({ model: { ...MODELS, onChange } });
    const pill = screen.getByRole("button", { name: "Model: GPT-6, medium" });
    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Model and effort" });
    // Focus starts on the checked model; arrow keys move through every item.
    expect(document.activeElement?.textContent).toContain("GPT-6");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Grok 5");
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement?.textContent).toBe("max");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("GPT-6");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "high" }));
    expect(onChange).toHaveBeenCalledWith({ model: "openai/gpt-6", effort: "high" });
    expect(menu.isConnected).toBe(false);
    expect(document.activeElement).toBe(pill);
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Grok 5/ }));
    expect(onChange).toHaveBeenLastCalledWith({ model: "xai/grok-5", effort: "medium" });
    fireEvent.click(pill);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(pill);
  });

  test("the level pill names its computer and offers Clover's five levels; a pick is a request (review SF1)", () => {
    const onRequest = mock((_l: string) => undefined);
    setup({ level: { ...LEVEL, onRequest } });
    fireEvent.click(screen.getByRole("button", { name: "Approval level on Studio: Ask when risky" }));
    expect(screen.getByRole("menu", { name: "Approval level on Studio" })).toBeTruthy();
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.querySelector(".cl-composer__menu-label")?.textContent)).toEqual([
      "Read only", "Ask first", "Ask when risky", "Accept edits", "Fully automatic",
    ]);
    expect(screen.getByText("A change raises a card for you to answer, and applies only then.")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Accept edits/ }));
    expect(onRequest).toHaveBeenCalledWith("accept-edits");
    // Picking the level it already has asks for nothing.
    fireEvent.click(screen.getByRole("button", { name: /^Approval level on Studio/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Ask when risky/ }));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  test("a level asked for shows beside the old one, which stands until the card is answered", () => {
    setup({ level: { ...LEVEL, requested: "automatic" } });
    const pill = screen.getByRole("button", { name: "Approval level on Studio: Ask when risky, Fully automatic asked for" });
    expect(pill.getAttribute("data-level")).toBe("risky");
    expect(pill.textContent).toContain("Fully automatic asked for");
    fireEvent.click(pill);
    expect(screen.getByRole("menuitemradio", { name: /Ask when risky/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Fully automatic/ }).textContent).toContain("Asked for");
  });

  test("a card arriving closes the menu, and the pills wait while it is pending (review item 1)", () => {
    const props = { botName: "Alpha", value: "", onChange: () => undefined, onSend: () => undefined, model: MODELS, level: LEVEL };
    const { rerender } = render(<Composer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    rerender(<Composer {...props} cardPending />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect((screen.getByRole("button", { name: /^Model:/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^Approval level on / }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("Send and Stop never look alike", () => {
    setup({ value: "and use staging", running: true, onStop: () => undefined });
    const send = screen.getByRole("button", { name: "Send" });
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(send.className).toBe("cl-composer__send");
    expect(stop.className).toBe("cl-composer__stop");
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

  test("push-to-talk never sticks on: blur, a lost pointer, a hidden or unfocused window, or unmounting end it (review item 7)", () => {
    const onPressStart = mock(() => undefined);
    const onPressEnd = mock(() => undefined);
    const { unmount } = render(<Composer botName="Alpha" value="" onChange={() => undefined} onSend={() => undefined} voice={{ listening: false, onPressStart, onPressEnd }} />);
    const mic = screen.getByRole("button", { name: "Hold to talk" });
    // Only the primary button holds.
    fireEvent.pointerDown(mic, { pointerId: 1, button: 2 });
    expect(onPressStart).toHaveBeenCalledTimes(0);
    const ends: [string, () => void][] = [
      ["blur", () => fireEvent.blur(mic)],
      ["lost capture", () => fireEvent(mic, new Event("lostpointercapture", { bubbles: true }))],
      ["window blur", () => window.dispatchEvent(new Event("blur"))],
    ];
    for (const [, end] of ends) {
      fireEvent.pointerDown(mic, { pointerId: 1, button: 0 });
      end();
    }
    expect(onPressStart).toHaveBeenCalledTimes(3);
    expect(onPressEnd).toHaveBeenCalledTimes(3);
    // A second press while held starts nothing new; an end with nothing held ends nothing.
    fireEvent.pointerDown(mic, { pointerId: 1, button: 0 });
    fireEvent.pointerDown(mic, { pointerId: 1, button: 0 });
    expect(onPressStart).toHaveBeenCalledTimes(4);
    unmount();
    expect(onPressEnd).toHaveBeenCalledTimes(4);
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
