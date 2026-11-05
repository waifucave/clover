import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DiffLayoutSwitch, DiffPanel, DiffTitle } from "../client/DiffPanel";
import { splitRows } from "../client/split";
import { FILES } from "../gallery/fixtures";

afterEach(cleanup);

const first = FILES[0]!;

describe("the diff panel", () => {
  test("one row per file, with its counts; a file opens to its hunks", () => {
    const { container } = render(<DiffPanel files={FILES} layout="unified" />);
    expect(screen.getByRole("list", { name: "Changed files" }).children).toHaveLength(FILES.length);
    const toggle = screen.getByRole("button", { name: `Unfold ${first.path}, Changed, 6 lines added, 2 removed` });
    expect(container.querySelector(".cl-diff-line")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll('.cl-diff-line[data-kind="add"]')).toHaveLength(6);
    expect(container.querySelectorAll('.cl-diff-line[data-kind="del"]')).toHaveLength(2);
    expect(screen.getByText("@@ -21,9 +21,13 @@ export function PanelToggles")).toBeTruthy();
  });

  test("a file too large, or binary, says so and doesn't open", () => {
    render(<DiffPanel files={FILES} layout="unified" />);
    const large = screen.getByRole("button", { name: /^plugins\/clover\/shell\/client\/Sidebar.tsx, Changed/ }) as HTMLButtonElement;
    expect(large.disabled).toBe(true);
    expect(within(large).getByText("Too big to draw here")).toBeTruthy();
    expect(screen.getByText("Binary file")).toBeTruthy();
    expect(screen.getByText("from plugins/clover/shell/gallery/window.tsx")).toBeTruthy();
  });

  test("split pairs removals with the additions after them", () => {
    const rows = splitRows(first.hunks![0]!.lines);
    expect(rows[2]).toEqual({ left: first.hunks![0]!.lines[2], right: first.hunks![0]!.lines[4] });
    // Three additions against two removals: the third addition has no partner.
    expect(rows[4]?.left).toBeUndefined();
    expect(rows[4]?.right?.text).toContain("const pressed = open.includes(id);");
    const { container } = render(<DiffPanel files={FILES} layout="split" initialOpen={[first.path]} />);
    expect(container.querySelectorAll(".cl-diff-split").length).toBe(rows.length);
    expect(container.querySelectorAll('.cl-diff-line[data-kind="empty"]').length).toBeGreaterThan(0);
  });

  test("the header compares base with a target, and the layout switch reaches the host", () => {
    const onTarget = mock((_t: string) => undefined);
    const onChange = mock((_l: string) => undefined);
    render(
      <>
        <DiffTitle base="main" target="working tree" targets={["last commit"]} onTarget={onTarget} />
        <DiffLayoutSwitch layout="unified" onChange={onChange} />
      </>,
    );
    expect(screen.getByLabelText("Comparing main with working tree")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Compare with" }), { target: { value: "last commit" } });
    expect(onTarget).toHaveBeenCalledWith("last commit");
    fireEvent.click(screen.getByRole("radio", { name: "Split" }));
    expect(onChange).toHaveBeenCalledWith("split");
  });

  test("a file opens in its own view", () => {
    const onOpenFile = mock((_p: string) => undefined);
    render(<DiffPanel files={FILES} layout="unified" onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByRole("button", { name: `Open ${first.path}` }));
    expect(onOpenFile).toHaveBeenCalledWith(first.path);
  });
});

describe("hidden characters (review SF5: the Trojan Source attack)", () => {
  const sneaky = {
    path: "src/access\u200B.ts",
    status: "modified" as const,
    added: 1,
    removed: 0,
    hunks: [
      {
        header: "@@ -1,3 +1,4 @@",
        lines: [
          { kind: "context" as const, old: 1, new: 1, text: "const role = user.role;" },
          { kind: "add" as const, new: 2, text: 'if (role != "admin\u202E \u2066// check later\u2069 \u2066") {' },
        ],
      },
    ],
  };

  test("a bidi control or a zero-width character shows as a mark naming it, and is never drawn itself", () => {
    const { container } = render(<DiffPanel files={[sneaky]} layout="unified" initialOpen={[sneaky.path]} />);
    const marks = [...container.querySelectorAll(".cl-diff-hidden")];
    expect(marks.map((m) => m.textContent)).toEqual(["U+200B", "U+202E", "U+2066", "U+2069", "U+2066"]);
    expect(screen.getAllByRole("img", { name: "Hidden character U+202E, right-to-left override" })).toHaveLength(1);
    const line = container.querySelector('.cl-diff-line[data-kind="add"] .cl-diff-line__text')!;
    expect(line.textContent).not.toMatch(/[\u202E\u2066\u2069]/);
  });

  test("a file that holds any says so in its row, and in its name for screen readers", () => {
    render(<DiffPanel files={[sneaky, ...FILES]} layout="unified" />);
    const row = screen.getByRole("button", { name: /Has hidden characters$/ });
    expect(row.textContent).toContain("Has hidden characters");
    expect(screen.getAllByText("Has hidden characters")).toHaveLength(1);
  });

  test("the same in the split layout", () => {
    const { container } = render(<DiffPanel files={[sneaky]} layout="split" initialOpen={[sneaky.path]} />);
    expect(container.querySelectorAll(".cl-diff-split .cl-diff-hidden").length).toBe(4);
  });
});
