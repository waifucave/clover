import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PanelHost } from "../client/PanelHost";
import { belongsIn, PanelToggles, toggleView } from "../client/PanelToggles";

afterEach(cleanup);

describe("the toggles", () => {
  test("each toggle says whether its view is open, and a click reaches the host", () => {
    const onToggle = mock((_id: string) => undefined);
    render(<PanelToggles kind="coding" open={["terminal"]} onToggle={onToggle} onMore={() => undefined} />);
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Browser" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(onToggle).toHaveBeenCalledWith("files");
    expect(screen.getByRole("button", { name: "More panels" })).toBeTruthy();
  });

  test("at most two panel views stay open; a third pushes out the oldest; the session column is apart", () => {
    let open: string[] = [];
    for (const id of ["terminal", "diff", "browser"]) open = toggleView(open, id);
    expect(open).toEqual(["diff", "browser"]);
    open = toggleView(open, "session");
    expect(open).toEqual(["diff", "browser", "session"]);
    open = toggleView(open, "files");
    expect(open).toEqual(["session", "browser", "files"]);
    expect(toggleView(open, "browser")).toEqual(["session", "files"]);
  });

  test("a code session offers every panel; a bot's tab only its slim column and the browser", () => {
    const names = () => screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    const { unmount } = render(<PanelToggles kind="coding" open={[]} onToggle={() => undefined} />);
    expect(names()).toEqual(["Session", "Terminal", "Changes", "Browser", "Files"]);
    unmount();
    render(<PanelToggles kind="bot" open={[]} onToggle={() => undefined} />);
    expect(names()).toEqual(["Details", "Browser"]);
  });

  test("a bot's tab never offers the terminal, the changes or the files, even when the host asks", () => {
    render(<PanelToggles kind="bot" open={["files"]} onToggle={() => undefined} available={["session", "terminal", "diff", "files", "browser"]} />);
    for (const name of ["Terminal", "Changes", "Files"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByRole("button", { name: "Browser" })).toBeTruthy();
  });
});

describe("the host", () => {
  test("a panel no installed plugin fills shows the host's placeholder, which says so", () => {
    const onFindPlugin = mock((_id: string) => undefined);
    render(<PanelHost kind="coding" views={[{ id: "browser", title: "Browser" }]} onClose={() => undefined} onFindPlugin={onFindPlugin} />);
    expect(screen.getByText("No plugin shows the browser here yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find a plugin" }));
    expect(onFindPlugin).toHaveBeenCalledWith("browser");
  });

  test("holds two views one above the other, each with expand and close; a view can bring its own header", () => {
    const onClose = mock((_id: string) => undefined);
    const onExpand = mock((_id: string) => undefined);
    render(
      <PanelHost
        kind="coding"
        views={[
          { id: "browser", title: "Browser", header: <div role="tablist" aria-label="Tabs" />, content: <p>page</p> },
          { id: "terminal", title: "Terminal", content: <p>shell</p> },
          { id: "files", title: "Files", content: <p>never shown</p> },
        ]}
        onClose={onClose}
        onExpand={onExpand}
      />,
    );
    const region = screen.getByRole("region", { name: "Panel" });
    expect(region.querySelectorAll(".cl-panel__view")).toHaveLength(2);
    expect(screen.queryByText("never shown")).toBeNull();
    expect(screen.getByRole("tablist", { name: "Tabs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Browser" }));
    expect(onClose).toHaveBeenCalledWith("terminal");
    expect(onExpand).toHaveBeenCalledWith("browser");
  });

  test("in a bot's tab, the terminal, the changes and the files are never drawn; its agent and the browser are", () => {
    render(
      <PanelHost
        kind="bot"
        views={[
          { id: "files", title: "Files", content: <p>a folder</p> },
          { id: "terminal", title: "Terminal", content: <p>a shell</p>, sessions: ["coding", "bot"] },
          { id: "diff", title: "Changes", content: <p>a diff</p> },
          { id: "agent:agent-export", title: "Fix the CSV export's dates", content: <p>the agent</p> },
          { id: "browser", title: "Browser", content: <p>a page</p> },
        ]}
        onClose={() => undefined}
      />,
    );
    for (const text of ["a folder", "a shell", "a diff"]) expect(screen.queryByText(text)).toBeNull();
    expect(screen.getByText("the agent")).toBeTruthy();
    expect(screen.getByText("a page")).toBeTruthy();
  });

  test("a view's own kinds count, but never let a code-only panel into a bot's tab", () => {
    expect(belongsIn({ id: "notes", sessions: ["coding"] }, "bot")).toBe(false);
    expect(belongsIn({ id: "notes", sessions: ["coding"] }, "coding")).toBe(true);
    expect(belongsIn({ id: "notes" }, "bot")).toBe(true);
    expect(belongsIn({ id: "files", sessions: ["bot"] }, "bot")).toBe(false);
    expect(belongsIn({ id: "files" }, "coding")).toBe(true);
  });

  test("with nothing that belongs in the tab, the host draws nothing", () => {
    const { container } = render(<PanelHost kind="bot" views={[{ id: "files", title: "Files", content: <p>a folder</p> }]} onClose={() => undefined} />);
    expect(container.querySelector(".cl-panel")).toBeNull();
  });
});

