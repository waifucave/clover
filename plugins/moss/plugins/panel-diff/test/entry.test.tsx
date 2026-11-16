// The changes on the runtime: the session's diff from the core, its base and target in the panel's header row.
import { fakeCore, settle, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DiffEntry } from "../client/entry";
import { FILES } from "../gallery/fixtures";

afterEach(cleanup);

describe("the diff entry", () => {
  test("reads the diff, opens the first file, and asks again for another target", async () => {
    const core = fakeCore({ "session.diff": ({ target }) => ({ base: "main", target: target ?? "working tree", targets: ["last commit"], files: target ? FILES.slice(0, 1) : FILES }) });
    const header = document.createElement("div");
    document.body.append(header);
    render(
      <TestLayer runtime={runtimeWith({ core: () => core })}>
        <DiffEntry props={{ session: "code-1", header }} />
      </TestLayer>,
    );
    await act(() => settle());
    expect(within(header).getByLabelText("Comparing main with working tree")).toBeTruthy();
    fireEvent.change(within(header).getByRole("combobox", { name: "Compare with" }), { target: { value: "last commit" } });
    await act(() => settle());
    expect(core.calls.map((c) => c.params)).toEqual([{ id: "code-1" }, { id: "code-1", target: "last commit" }]);
    expect(within(header).getByLabelText("Comparing main with last commit")).toBeTruthy();
    fireEvent.click(within(header).getByRole("radio", { name: "Split" }));
    expect(within(header).getByRole("radio", { name: "Split" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByText(FILES[0]!.path.split("/").pop()!).length).toBeGreaterThan(0);
    header.remove();
  });

  test("a refusal shows why; an empty list shows the core's notice and No changes", async () => {
    const refusing = fakeCore({ "session.diff": () => { throw new Error("no session code-1"); } });
    render(
      <TestLayer runtime={runtimeWith({ core: () => refusing })}>
        <DiffEntry props={{ session: "code-1" }} />
      </TestLayer>,
    );
    await act(() => settle());
    expect(screen.getByRole("status").textContent).toBe("The changes couldn't be read: no session code-1");
    cleanup();
    const empty = fakeCore({ "session.diff": () => ({ base: "", target: "working tree", targets: [], files: [], notice: "This folder isn't a git repository, so there are no changes to compare." }) });
    render(
      <TestLayer runtime={runtimeWith({ core: () => empty })}>
        <DiffEntry props={{ session: "code-1" }} />
      </TestLayer>,
    );
    await act(() => settle());
    expect(screen.getByText("This folder isn't a git repository, so there are no changes to compare.")).toBeTruthy();
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  test("a plugin whose call the core refuses (no capability for the session's diff) shows why, and no list", async () => {
    const core = fakeCore({ "session.diff": () => { throw new Error("session.diff needs the conversation.read capability"); } });
    render(
      <TestLayer runtime={runtimeWith({ core: () => core })}>
        <DiffEntry props={{ session: "code-1" }} />
      </TestLayer>,
    );
    await act(() => settle());
    expect(screen.getByRole("status").textContent).toContain("needs the conversation.read capability");
  });
});
