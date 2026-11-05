import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PanelHost } from "../client/PanelHost";
import { belongsIn, PanelToggles, toggleView } from "../client/PanelToggles";
import { SessionView } from "../client/SessionView";
import { BOT_COLUMN, SESSION } from "../gallery/fixtures";

afterEach(cleanup);

describe("the toggles", () => {
  test("each toggle says whether its view is open, and a click reaches the host", () => {
    const onToggle = mock((_id: string) => undefined);
    render(<PanelToggles kind="code" open={["terminal"]} onToggle={onToggle} onMore={() => undefined} />);
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
    const { unmount } = render(<PanelToggles kind="code" open={[]} onToggle={() => undefined} />);
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
    render(<PanelHost kind="code" views={[{ id: "browser", title: "Browser" }]} onClose={() => undefined} onFindPlugin={onFindPlugin} />);
    expect(screen.getByText("No plugin shows the browser here yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find a plugin" }));
    expect(onFindPlugin).toHaveBeenCalledWith("browser");
  });

  test("holds two views one above the other, each with expand and close; a view can bring its own header", () => {
    const onClose = mock((_id: string) => undefined);
    const onExpand = mock((_id: string) => undefined);
    render(
      <PanelHost
        kind="code"
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
          { id: "terminal", title: "Terminal", content: <p>a shell</p>, sessions: ["code", "bot"] },
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
    expect(belongsIn({ id: "notes", sessions: ["code"] }, "bot")).toBe(false);
    expect(belongsIn({ id: "notes", sessions: ["code"] }, "code")).toBe(true);
    expect(belongsIn({ id: "notes" }, "bot")).toBe(true);
    expect(belongsIn({ id: "files", sessions: ["bot"] }, "bot")).toBe(false);
    expect(belongsIn({ id: "files" }, "code")).toBe(true);
  });

  test("with nothing that belongs in the tab, the host draws nothing", () => {
    const { container } = render(<PanelHost kind="bot" views={[{ id: "files", title: "Files", content: <p>a folder</p> }]} onClose={() => undefined} />);
    expect(container.querySelector(".cl-panel")).toBeNull();
  });
});

describe("the session column", () => {
  test("shows where the session runs: the computer, its level, the folders and the branch; no phone switch", () => {
    const onChange = mock(() => undefined);
    render(<SessionView {...SESSION} environment={{ ...SESSION.environment!, level: { label: "Ask before risky", onChange } }} />);
    expect(screen.getByText("This computer")).toBeTruthy();
    expect(screen.getByText("Level: Ask before risky")).toBeTruthy();
    expect(screen.getByText("lane/f-m1", { selector: ".cl-session__row--static .cl-session__name" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    // Every device already sees every bot (spec §6.4): nothing here switches one on.
    expect(screen.queryByRole("switch")).toBeNull();
  });

  test("a level change asked for shows as asked, the old level standing until its card is answered", () => {
    render(<SessionView {...SESSION} environment={{ ...SESSION.environment!, level: { label: "Ask before risky", requested: "Automatic", onChange: () => undefined } }} />);
    expect(screen.getByText("Level: Ask before risky")).toBeTruthy();
    expect(screen.getByText("Automatic asked for")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  test("outputs are named in Clover's own kinds", () => {
    render(<SessionView {...SESSION} />);
    expect(screen.getAllByText("Page").length).toBe(2);
    expect(screen.queryByText("Artifact")).toBeNull();
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

  test("there is no Save: a session's setup isn't kept from here", () => {
    render(<SessionView {...SESSION} />);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("a bot's slim column shows its agents, context and outputs, and nothing about a folder", () => {
    const onOpenAgent = mock((_id: string) => undefined);
    // Even if the host passes a code session's parts, a bot's column leaves them out.
    render(<SessionView {...SESSION} {...BOT_COLUMN} onOpenAgent={onOpenAgent} openAgent="agent-export" />);
    for (const title of ["Agents and tasks", "Context", "Outputs"]) expect(screen.getByText(title)).toBeTruthy();
    for (const title of ["Where it runs", "Connectors", "Changes"]) expect(screen.queryByText(title)).toBeNull();
    expect(screen.queryByRole("button", { name: "Create PR" })).toBeNull();
    const agent = screen.getByRole("button", { name: /Fix the CSV export's dates/ });
    expect(agent.getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Weekly notes digest/ }));
    expect(onOpenAgent).toHaveBeenCalledWith("task-digest");
  });

  test("a section folds", () => {
    render(<SessionView {...SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: "Fold Outputs" }));
    expect(screen.queryByText("Panel layout review")).toBeNull();
  });
});
