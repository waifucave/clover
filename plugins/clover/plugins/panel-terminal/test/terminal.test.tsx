import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { keyToData } from "../client/keys";
import { TerminalPanel, TerminalTabs } from "../client/TerminalPanel";
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

  test("keys go to the PTY as the bytes a terminal sends", () => {
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
  });

  test("a paste has its own door, whole, so the host can bracket it and ask before several lines run (review SF2)", () => {
    const onInput = mock((_d: string) => undefined);
    const onPaste = mock((_t: string) => undefined);
    const { rerender } = render(<TerminalPanel tabs={TABS} active="t1" chunks={FEED} onInput={onInput} onPaste={onPaste} />);
    const log = screen.getByRole("log");
    fireEvent.paste(log, { clipboardData: { getData: () => "rm -rf build\nbun run build\n" } });
    expect(onPaste).toHaveBeenCalledWith("rm -rf build\nbun run build\n");
    expect(onInput).not.toHaveBeenCalled();
    // Without the paste door, a paste goes nowhere: never into the shell as keys.
    rerender(<TerminalPanel tabs={TABS} active="t1" chunks={FEED} onInput={onInput} />);
    fireEvent.paste(screen.getByRole("log"), { clipboardData: { getData: () => "echo hi\n" } });
    expect(onInput).not.toHaveBeenCalled();
  });

  test("Tab stays the shell's; F6 leaves the terminal and Shift+F6 goes back, and the terminal says so (WCAG 2.1.2)", () => {
    const onInput = mock((_d: string) => undefined);
    render(
      <div>
        <button type="button">Before</button>
        <TerminalPanel tabs={TABS} active="t1" chunks={FEED} onInput={onInput} />
        <button type="button">After</button>
      </div>,
    );
    const log = screen.getByRole("log");
    log.focus();
    fireEvent.keyDown(log, { key: "Tab" });
    expect(onInput).toHaveBeenLastCalledWith("\t");
    expect(document.activeElement).toBe(log);
    fireEvent.keyDown(log, { key: "F6" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
    log.focus();
    fireEvent.keyDown(log, { key: "F6", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Before" }));
    expect(document.getElementById(log.getAttribute("aria-describedby")!)?.textContent).toBe("The terminal keeps Tab. F6 leaves it.");
  });

  test("tabs switch, close and open", () => {
    const onSelect = mock((_id: string) => undefined);
    const onClose = mock((_id: string) => undefined);
    const onNew = mock(() => undefined);
    render(<TerminalTabs tabs={TABS} active="t1" onSelect={onSelect} onClose={onClose} onNew={onNew} />);
    expect(screen.getByRole("tab", { name: "zsh" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "bun dev" }));
    fireEvent.click(screen.getByRole("button", { name: "Close bun dev" }));
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(onSelect).toHaveBeenCalledWith("t2");
    expect(onClose).toHaveBeenCalledWith("t2");
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  test("on Windows and Linux, Ctrl+V and Ctrl+Shift+V paste: they send nothing and leave the paste to happen (review round 3)", () => {
    for (const platform of ["windows", "linux"] as const) {
      const onInput = mock((_d: string) => undefined);
      const { unmount } = render(<TerminalPanel tabs={TABS} active="t1" chunks={FEED} onInput={onInput} onPaste={() => undefined} platform={platform} />);
      const log = screen.getByRole("log");
      // Not prevented, so the browser goes on to paste, through the paste door.
      expect(fireEvent.keyDown(log, { key: "v", ctrlKey: true })).toBe(true);
      expect(fireEvent.keyDown(log, { key: "V", ctrlKey: true, shiftKey: true })).toBe(true);
      expect(onInput).not.toHaveBeenCalled();
      // Ctrl+C still interrupts.
      fireEvent.keyDown(log, { key: "c", ctrlKey: true });
      expect(onInput).toHaveBeenCalledWith("\x03");
      unmount();
    }
  });

  test("on macOS, Ctrl+V is the shell's own (^V) and ⌘V pastes", () => {
    expect(keyToData({ key: "v", ctrlKey: true, metaKey: false, altKey: false }, "mac")).toBe("\x16");
    expect(keyToData({ key: "v", ctrlKey: false, metaKey: true, altKey: false }, "mac")).toBeUndefined();
    expect(keyToData({ key: "v", ctrlKey: true, metaKey: false, altKey: false }, "linux")).toBeUndefined();
    expect(keyToData({ key: "V", ctrlKey: true, metaKey: false, altKey: false }, "windows")).toBeUndefined();
  });

  test("keyToData: modifiers that aren't the terminal's send nothing", () => {
    expect(keyToData({ key: "Shift", ctrlKey: false, metaKey: false, altKey: false })).toBeUndefined();
    expect(keyToData({ key: "b", ctrlKey: false, metaKey: false, altKey: true })).toBe("\x1bb");
  });
});
