// The chrome as parts a bot's layout places (`client/chrome.tsx`): a placed part leaves the standard bar, no bar shows only what the layout
// places, the sidebar's button and a place to drag always exist, and a window outside the shell (no context) draws none of it.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChromeActions, ChromeDrag, ChromeEdit, ChromePanels, ChromeSession, ChromeSidebar, ChromeTitle } from "../client/chrome";
import { BotTab, Window, shapeOf, type WindowProps } from "../client/Window";
import type { ChromeApi } from "../client/chrome";

afterEach(cleanup);

const chromeApi = (over: Partial<Omit<ChromeApi, "place" | "panels">> = {}): Omit<ChromeApi, "place" | "panels"> => ({
  bot: { id: "alpha", name: "Alpha" },
  kind: "bot",
  title: "Alpha",
  open: [],
  available: ["session", "browser"],
  toggleView: () => undefined,
  editBot: () => undefined,
  sidebarCollapsed: false,
  toggleSidebar: () => undefined,
  ...over,
});

function frame(skin: Record<string, string> | undefined, children: React.ReactNode, props: Partial<WindowProps> = {}, chrome = chromeApi()) {
  return (
    <Window sidebar={<div>sidebar</div>} title="Alpha" skin={skin} shape={shapeOf(skin)} chrome={chrome} panel={<div>the panel</div>} {...props}>
      <BotTab conversation={<div>{children}</div>} composer={<div>composer</div>} />
    </Window>
  );
}

const bar = () => document.querySelector(".cl-window__bar");

describe("the standard bar", () => {
  test("a bot that says nothing keeps the bar with its title and buttons, and its window is the standard shape", async () => {
    const { container } = render(frame(undefined, null));
    await act(async () => undefined);
    expect(bar()).not.toBeNull();
    expect(screen.getByRole("heading", { name: /Alpha/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Alpha" })).toBeTruthy();
    const w = container.querySelector(".cl-window")!;
    expect(w.getAttribute("data-bar-mode")).toBe("standard");
    expect(w.getAttribute("data-panel-mode")).toBe("column");
    expect(container.querySelector(".cl-chrome-fallback")).toBeNull();
  });

  test("a part the layout places leaves the bar and shows where it is placed", async () => {
    render(frame(undefined, <><ChromeTitle /><ChromeEdit /></>));
    await act(async () => undefined);
    // The title is drawn once (the placed one), the edit button once; the bar keeps the rest.
    expect(document.querySelectorAll(".cl-window__title").length).toBe(1);
    expect(document.querySelector(".cl-window__bar .cl-window__title")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Edit Alpha" }).length).toBe(1);
    expect(document.querySelector(".cl-window__bar [aria-label='Edit Alpha']")).toBeNull();
  });
});

describe("no bar", () => {
  const none = { "bar.mode": "none" };

  test("the bar is gone, an unplaced title and button are not shown, the sidebar's button and a drag place are added", async () => {
    render(frame(none, null));
    await act(async () => undefined);
    expect(bar()).toBeNull();
    expect(screen.queryByRole("heading", { name: /Alpha/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Alpha" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide the sidebar" })).toBeTruthy();
    expect(document.querySelector(".cl-chrome-drag--fallback")).not.toBeNull();
  });

  test("a layout that places the sidebar's button and a drag region gets no fallback", async () => {
    render(frame(none, <><ChromeSidebar /><ChromeDrag /><ChromeTitle /></>));
    await act(async () => undefined);
    expect(document.querySelector(".cl-chrome-fallback")).toBeNull();
    expect(document.querySelector(".cl-chrome-drag--fallback")).toBeNull();
    expect(document.querySelectorAll(".cl-chrome-drag").length).toBe(1);
    expect(screen.getAllByRole("button", { name: "Hide the sidebar" }).length).toBe(1);
    expect(screen.getByRole("heading", { name: /Alpha/ })).toBeTruthy();
  });

  test("a bot's own controls that offer the handles (shell.provide) spare the fallback", async () => {
    const { rerender } = render(frame(none, null, { provides: { sidebar: true, drag: false } }));
    await act(async () => undefined);
    expect(document.querySelector(".cl-chrome-fallback")).toBeNull();
    expect(document.querySelector(".cl-chrome-drag--fallback")).not.toBeNull();
    rerender(frame(none, null, { provides: { sidebar: true, drag: true } }));
    await act(async () => undefined);
    expect(document.querySelector(".cl-chrome-drag--fallback")).toBeNull();
  });

  test("a bot's plugin may fill the bar with its own content; the standard one is the fallback", async () => {
    render(frame(undefined, null, { barFill: (stock) => <div data-testid="own-bar">{stock ? "mine" : ""}</div> }));
    await act(async () => undefined);
    expect(screen.getByTestId("own-bar").textContent).toBe("mine");
  });

  test("the sidebar's button toggles it, and says which way", async () => {
    const toggleSidebar = mock(() => undefined);
    render(frame(none, <ChromeSidebar />, {}, chromeApi({ sidebarCollapsed: true, toggleSidebar })));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Show the sidebar" }));
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
  });

  test("a press on a placed toggle is the app's own press", async () => {
    const toggleView = mock((_id: string) => undefined);
    render(frame(none, <><ChromeSession /><ChromeActions /></>, {}, chromeApi({ toggleView })));
    await act(async () => undefined);
    fireEvent.click(screen.getAllByRole("button", { name: /Details/ })[0]!);
    expect(toggleView).toHaveBeenCalledWith("session");
  });
});

describe("panels", () => {
  test("a layout that places chrome.panels holds the panels, and the window draws no column of its own", async () => {
    const { container } = render(frame(undefined, <ChromePanels />, { toggles: undefined }));
    await act(async () => undefined);
    expect(screen.getAllByText("the panel").length).toBe(1);
    expect(container.querySelector(".cl-window__panel")).toBeNull();
    expect(container.querySelector(".cl-chrome-panels")?.textContent).toBe("the panel");
  });

  test("without the part the panel is the window's column, in the shape's mode", async () => {
    const { container } = render(frame({ "panel.mode": "drawer", "panel.width": "400" }, null));
    await act(async () => undefined);
    const w = container.querySelector(".cl-window") as HTMLElement;
    expect(container.querySelector(".cl-window__panel")?.textContent).toBe("the panel");
    expect(w.getAttribute("data-panel-mode")).toBe("drawer");
    expect(w.hasAttribute("data-panel-over")).toBe(true);
    expect(w.style.getPropertyValue("--cl-shape-panel-width")).toBe("400px");
  });
});

describe("the sidebar: never the bot's", () => {
  test("a theme's old sidebar names change nothing: the sidebar is in the grid as on every tab, with no shape of its own", async () => {
    const old = { "sidebar.mode": "none", "sidebar.inset": "16", "sidebar.density": "roomy", "sidebar.material": "none", "sidebar.width": "300", sidebar: "#16132B", "sidebar.text": "#FFFFFF" };
    const plain = render(frame(undefined, null)).container.querySelector(".cl-window") as HTMLElement;
    const attrs = (w: Element) => [...w.attributes].filter((a) => a.name !== "style").map((a) => `${a.name}=${a.value}`).sort();
    const plainAttrs = attrs(plain);
    const plainStyle = plain.getAttribute("style");
    cleanup();
    const { container } = render(frame(old, null));
    await act(async () => undefined);
    const w = container.querySelector(".cl-window") as HTMLElement;
    expect(attrs(w)).toEqual(plainAttrs);
    expect(w.getAttribute("style")).toBe(plainStyle);
    expect(container.querySelector(".cl-window__sidebar")?.textContent).toBe("sidebar");
    expect(container.querySelector(".cl-window__sidebar .cl-skin-paint")).toBeNull();
  });

  test("with no bar, the bot's own word that its controls draw the sidebar's toggle only drops the shell's fallback button", async () => {
    const { container, rerender } = render(frame({ "bar.mode": "none" }, null));
    await act(async () => undefined);
    expect(container.querySelector(".cl-chrome-fallback")).not.toBeNull();
    rerender(frame({ "bar.mode": "none" }, null, { provides: { sidebar: true, drag: true } }));
    await act(async () => undefined);
    expect(container.querySelector(".cl-chrome-fallback")).toBeNull();
    expect(container.querySelector(".cl-window__sidebar")?.textContent).toBe("sidebar");
  });

  test("a value outside the choices is the standard", () => {
    const s = shapeOf({ "bar.mode": "hidden", "sidebar.width": "9999", "panel.mode": "popup" });
    expect(s).toEqual({ bar: "standard", panel: "column", vars: {} });
  });
});

describe("outside the shell", () => {
  test("the parts draw nothing without the shell's context", () => {
    const { container } = render(<><ChromeTitle /><ChromeEdit /><ChromeSidebar /><ChromePanels /><ChromeDrag /></>);
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });
});
