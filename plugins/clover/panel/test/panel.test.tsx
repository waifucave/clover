import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PanelHost } from "../client/PanelHost";
import { PanelToggles, toggleView } from "../client/PanelToggles";
import { SessionView } from "../client/SessionView";
import { SESSION } from "../gallery/fixtures";

afterEach(cleanup);

describe("the toggles", () => {
  test("each toggle says whether its view is open, and a click reaches the host", () => {
    const onToggle = mock((_id: string) => undefined);
    render(<PanelToggles open={["terminal"]} onToggle={onToggle} onMore={() => undefined} />);
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
});

describe("the host", () => {
  test("holds two views one above the other, each with expand and close; a view can bring its own header", () => {
    const onClose = mock((_id: string) => undefined);
    const onExpand = mock((_id: string) => undefined);
    render(
      <PanelHost
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
});

describe("the session column", () => {
  test("shows where the session runs, and its phone switch reaches the host", () => {
    const onToggle = mock((_on: boolean) => undefined);
    render(<SessionView {...SESSION} environment={{ ...SESSION.environment!, remote: { on: false, onToggle } }} />);
    expect(screen.getByText("This computer")).toBeTruthy();
    expect(screen.getByText("lane/f-m1", { selector: ".cl-session__row--static .cl-session__name" })).toBeTruthy();
    const remote = screen.getByRole("switch", { name: "Reach it from your phone" });
    expect(remote.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(remote);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  test("context use is a meter; connectors say how many need signing in again", () => {
    render(<SessionView {...SESSION} />);
    const meter = screen.getByRole("meter", { name: "14% of the context used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("14");
    expect(screen.getByRole("button", { name: "2 to sign in again" })).toBeTruthy();
    // Context folds by default and opens to its detail.
    expect(screen.queryByText(/28,000 of 200,000/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unfold Context" }));
    expect(screen.getByText(/28,000 of 200,000/)).toBeTruthy();
  });

  test("outputs open; changes show their stat, create a PR, and list the PRs", () => {
    const onOpen = mock((_id: string) => undefined);
    const onCreatePr = mock(() => undefined);
    render(<SessionView {...SESSION} outputs={{ ...SESSION.outputs!, onOpen }} changes={{ ...SESSION.changes!, onCreatePr }} />);
    fireEvent.click(screen.getByRole("button", { name: /Panel layout review/ }));
    expect(onOpen).toHaveBeenCalledWith("o1");
    expect(screen.getByRole("button", { name: "lane/f-m1: 41 files, 2844 added, 365 removed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(onCreatePr).toHaveBeenCalledTimes(1);
    const prs = screen.getByText("F-M1: the conversation parts").closest("ul") as HTMLElement;
    expect(within(prs).getByText("clover #155 · Open")).toBeTruthy();
    expect(within(prs).getByText("clover #152 · Merged")).toBeTruthy();
  });

  test("a section folds", () => {
    render(<SessionView {...SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: "Fold Outputs" }));
    expect(screen.queryByText("Panel layout review")).toBeNull();
  });
});
