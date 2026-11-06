import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BrowserChrome } from "../client/BrowserChrome";
import { BrowserTabs } from "../client/BrowserTabs";
import { TABS } from "../gallery/fixtures";

afterEach(cleanup);

describe("the tab row", () => {
  test("tabs switch, close and open", () => {
    const onSelect = mock((_id: string) => undefined);
    const onClose = mock((_id: string) => undefined);
    const onNew = mock(() => undefined);
    render(<BrowserTabs tabs={TABS} active="b1" onSelect={onSelect} onClose={onClose} onNew={onNew} />);
    expect(screen.getByRole("tab", { name: "Docs preview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Plugin index" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Docs preview" }));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(onSelect).toHaveBeenCalledWith("b2");
    expect(onClose).toHaveBeenCalledWith("b1");
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  test("with no tab active, none is selected; without onNew there is no + button", () => {
    render(<BrowserTabs tabs={TABS} active={undefined} onSelect={() => undefined} onClose={() => undefined} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "false"]);
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
  });

  test("a loading page turns the globe, and a held tab shows a hand with its meaning", () => {
    const { container } = render(
      <BrowserTabs
        tabs={[
          { id: "a", title: "One", url: "https://one.test/", loading: true },
          { id: "b", title: "Two", url: "https://two.test/", held: true },
        ]}
        active="a"
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(container.querySelectorAll("[data-spin]")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: /^One$/ }).getAttribute("aria-busy")).toBe("true");
    const held = screen.getByRole("tab", { name: "Two" });
    expect(held.getAttribute("title")).toContain("You are using this tab. The bot waits until you let go.");
    expect(held.parentElement?.hasAttribute("data-held")).toBe(true);
  });
});

describe("the chrome", () => {
  test("the address bar hands what was typed to the container on Enter", () => {
    const onNavigate = mock((_u: string) => undefined);
    render(<BrowserChrome tab={TABS[0]} onNavigate={onNavigate} />);
    const address = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    expect(address.value).toBe("http://localhost:4321/docs/");
    fireEvent.change(address, { target: { value: "clover.dev/docs" } });
    fireEvent.keyDown(address, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith("clover.dev/docs");
  });

  test("Escape gives the bar back to the page; a blank address goes nowhere", () => {
    const onNavigate = mock((_u: string) => undefined);
    render(<BrowserChrome tab={TABS[0]} onNavigate={onNavigate} />);
    const address = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    fireEvent.change(address, { target: { value: "   " } });
    fireEvent.keyDown(address, { key: "Enter" });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.change(address, { target: { value: "half a thou" } });
    fireEvent.keyDown(address, { key: "Escape" });
    expect(address.value).toBe("http://localhost:4321/docs/");
  });

  test("typing is not taken away when the page changes under it, and the page's address returns after an open", async () => {
    const { rerender } = render(<BrowserChrome tab={TABS[0]} onNavigate={() => true} />);
    const address = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    fireEvent.change(address, { target: { value: "exam" } });
    rerender(<BrowserChrome tab={{ ...TABS[0]!, url: "http://localhost:4321/docs/next" }} onNavigate={() => true} />);
    expect(address.value).toBe("exam");
    fireEvent.change(address, { target: { value: "example.com" } });
    await act(async () => {
      fireEvent.keyDown(address, { key: "Enter" });
    });
    expect(address.value).toBe("http://localhost:4321/docs/next");
  });

  test("an address that could not be opened stays in the bar, with the failure by it", async () => {
    render(<BrowserChrome tab={TABS[0]} onNavigate={() => false} error="Couldn't open that address." />);
    const address = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
    fireEvent.change(address, { target: { value: "file:///x" } });
    await act(async () => {
      fireEvent.keyDown(address, { key: "Enter" });
    });
    expect(address.value).toBe("file:///x");
    expect(screen.getByRole("alert").textContent).toBe("Couldn't open that address.");
    expect(address.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
  });

  test("without a live view, a placeholder frame says what goes there; with one, the frame is empty", () => {
    const { rerender } = render(<BrowserChrome tab={TABS[0]} />);
    expect(screen.getByRole("region", { name: "Page: Docs preview" }).textContent).toContain("The live page shows here");
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<BrowserChrome tab={TABS[0]} live />);
    expect(screen.getByRole("region", { name: "Page: Docs preview" }).textContent).toBe("");
  });

  test("with no tab: the frame says so and the address bar is off", () => {
    render(<BrowserChrome tab={undefined} />);
    expect(screen.getByRole("region", { name: "No tab open" }).textContent).toContain("No tab open");
    expect((screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement).disabled).toBe(true);
  });

  test("the annotate tools sit in a strip below the page, never inside its frame", () => {
    const { container } = render(<BrowserChrome tab={TABS[0]} annotate={{ tool: null, onTool: () => undefined }} />);
    const strip = screen.getByRole("toolbar", { name: "Mark up the page" });
    expect(container.querySelector(".cl-browser__frame")?.contains(strip)).toBe(false);
    expect(strip.previousElementSibling?.className).toBe("cl-browser__frame");
  });

  test("annotate tools: one at a time, pressed again to put down, and a way out", () => {
    const onTool = mock((_t: string | null) => undefined);
    const { rerender } = render(<BrowserChrome tab={TABS[0]} annotate={{ tool: null, onTool }} />);
    fireEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    expect(onTool).toHaveBeenLastCalledWith("box");
    rerender(<BrowserChrome tab={TABS[0]} annotate={{ tool: "box", onTool }} />);
    expect(screen.getByRole("button", { name: "Draw a box" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Draw a box" }));
    expect(onTool).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Stop marking up" }));
    expect(onTool).toHaveBeenLastCalledWith(null);
  });
});
