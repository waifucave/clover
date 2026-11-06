// The changes on the runtime: the session's diff from the core, its base and target in the panel's header row.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fakeCore, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { DiffEntry } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { FILES } from "../gallery/fixtures";

afterEach(cleanup);

describe("the diff entry", () => {
  test("reads the diff, opens the first file, and asks again for another target", async () => {
    const core = fakeCore({ "session.diff": ({ target }) => ({ base: "main", target: target ?? "working tree", targets: ["last commit"], files: target ? FILES.slice(0, 1) : FILES }) });
    const header = document.createElement("div");
    document.body.append(header);
    render(
      <UiRuntimeProvider runtime={runtimeWith({ core: () => core })}>
        <DiffEntry props={{ session: "code-1", header }} />
      </UiRuntimeProvider>,
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

  test("outside the clover tree there is no core, and nothing draws", async () => {
    const { container } = render(
      <UiRuntimeProvider runtime={runtimeWith({})}>
        <DiffEntry props={{ session: "code-1" }} />
      </UiRuntimeProvider>,
    );
    await act(() => settle());
    expect(container.innerHTML).toBe("");
  });
});
