import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BrowserPanel, BrowserTabs } from "../client/BrowserPanel";
import { TABS } from "../gallery/fixtures";

afterEach(cleanup);

describe("the browser panel", () => {
  test("tabs switch, close and open", () => {
    const onSelect = mock((_id: string) => undefined);
    const onClose = mock((_id: string) => undefined);
    const onNew = mock(() => undefined);
    render(<BrowserTabs tabs={TABS} active="b1" onSelect={onSelect} onClose={onClose} onNew={onNew} />);
    expect(screen.getByRole("tab", { name: "Battle bench" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Plugin index" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Battle bench" }));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(onSelect).toHaveBeenCalledWith("b2");
    expect(onClose).toHaveBeenCalledWith("b1");
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  test("the address bar hands what was typed to the browser on Enter; the page is lane L's view", () => {
    const onNavigate = mock((_u: string) => undefined);
    render(<BrowserPanel tab={TABS[0]} onNavigate={onNavigate} renderView={(tab) => <div data-testid="live">{tab.id}</div>} />);
    const address = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    expect(address.value).toBe("http://localhost:8771/bench.html");
    fireEvent.change(address, { target: { value: "clover.dev/docs" } });
    fireEvent.keyDown(address, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith("clover.dev/docs");
    expect(screen.getByTestId("live").textContent).toBe("b1");
  });

  test("without a live view, a placeholder frame says what goes there", () => {
    render(<BrowserPanel tab={TABS[0]} />);
    expect(screen.getByRole("region", { name: "Page: Battle bench" }).textContent).toContain("The live page shows here");
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("annotate tools: one at a time, pressed again to put down, and a way out", () => {
    const onTool = mock((_t: string | null) => undefined);
    const { rerender } = render(<BrowserPanel tab={TABS[0]} annotate={{ tool: null, onTool }} />);
    fireEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    expect(onTool).toHaveBeenLastCalledWith("box");
    rerender(<BrowserPanel tab={TABS[0]} annotate={{ tool: "box", onTool }} />);
    expect(screen.getByRole("button", { name: "Draw a box" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    expect(onTool).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Stop marking up" }));
    expect(onTool).toHaveBeenLastCalledWith(null);
  });
});
