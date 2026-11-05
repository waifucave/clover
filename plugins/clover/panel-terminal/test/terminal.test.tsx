import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { keyToData } from "../client/keys";
import { TerminalPanel } from "../client/TerminalPanel";
import { FEED, TABS } from "../gallery/fixtures";

afterEach(cleanup);

describe("the terminal panel", () => {
  test("draws the feed in its styles, with a cursor while the process runs", () => {
    const { container } = render(<TerminalPanel tabs={TABS} active="t1" chunks={FEED} />);
    const log = screen.getByRole("log", { name: "zsh output" });
    expect(log.textContent).toContain("bun test plugins/clover/panel");
    expect(container.querySelectorAll('[data-style="error"]').length).toBe(3);
    expect(container.querySelector(".cl-term__cursor")).toBeTruthy();
  });

  test("an ended process says how it ended, and has no cursor", () => {
    const { container } = render(<TerminalPanel tabs={TABS} active="t2" chunks={[]} />);
    expect(screen.getByRole("log").textContent).toContain("Exited with code 0");
    expect(container.querySelector(".cl-term__cursor")).toBeNull();
  });

  test("keys go to the PTY as the bytes a terminal sends; paste goes as text", () => {
    const onInput = mock((_d: string) => undefined);
    render(<TerminalPanel tabs={TABS} active="t1" chunks={FEED} onInput={onInput} />);
    const log = screen.getByRole("log");
    fireEvent.keyDown(log, { key: "l" });
    fireEvent.keyDown(log, { key: "s" });
    fireEvent.keyDown(log, { key: "Enter" });
    fireEvent.keyDown(log, { key: "c", ctrlKey: true });
    fireEvent.keyDown(log, { key: "ArrowUp" });
    fireEvent.keyDown(log, { key: "c", metaKey: true });
    expect(onInput.mock.calls.map((c) => c[0])).toEqual(["l", "s", "\r", "\x03", "\x1b[A"]);
    fireEvent.paste(log, { clipboardData: { getData: () => "git status" } });
    expect(onInput).toHaveBeenLastCalledWith("git status");
  });

  test("tabs switch, close and open", () => {
    const onSelect = mock((_id: string) => undefined);
    const onClose = mock((_id: string) => undefined);
    const onNew = mock(() => undefined);
    render(<TerminalPanel tabs={TABS} active="t1" chunks={[]} onSelect={onSelect} onClose={onClose} onNew={onNew} />);
    expect(screen.getByRole("tab", { name: "zsh" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "bun dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Close bun dev" }));
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(onSelect).toHaveBeenCalledWith("t2");
    expect(onClose).toHaveBeenCalledWith("t2");
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  test("keyToData: modifiers that aren't the terminal's send nothing", () => {
    expect(keyToData({ key: "Shift", ctrlKey: false, metaKey: false, altKey: false })).toBeUndefined();
    expect(keyToData({ key: "b", ctrlKey: false, metaKey: false, altKey: true })).toBe("\x1bb");
  });
});
