import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SessionView } from "../client/SessionView";
import { BOT_COLUMN, SESSION } from "../gallery/fixtures";

afterEach(cleanup);

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
