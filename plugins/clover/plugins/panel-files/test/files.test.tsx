import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { inside } from "../client/entry";
import { visiblePaths } from "../client/filter";
import { FilesPanel, FilesTitle } from "../client/FilesPanel";
import { COMPUTER, LISTING, OPEN_FILE, ROOT } from "../gallery/fixtures";

afterEach(cleanup);

describe("the files panel", () => {
  test("folders first, then files; a folder opens, and one not listed yet asks the host", () => {
    const onList = mock((_p: string) => undefined);
    render(<FilesPanel root={ROOT} listing={LISTING} onList={onList} onOpen={() => undefined} />);
    const names = screen.getAllByRole("treeitem").map((i) => i.textContent);
    expect(names).toEqual([".github", "docs", "packages", "plugins", ".gitignore", "package.json", "README.md"]);
    fireEvent.click(screen.getByRole("treeitem", { name: "docs" }));
    expect(screen.getByRole("treeitem", { name: "clover-spec.md" })).toBeTruthy();
    expect(onList).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("treeitem", { name: "packages" }));
    expect(onList).toHaveBeenCalledWith(`${ROOT}/packages`);
    expect(screen.getByText("Listing…")).toBeTruthy();
  });

  test("a file opens in the viewer, with line numbers", () => {
    const onOpen = mock((_p: string) => undefined);
    const { rerender } = render(<FilesPanel root={ROOT} listing={LISTING} onOpen={onOpen} />);
    expect(screen.getByText("No file open")).toBeTruthy();
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }));
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}/README.md`);
    rerender(<FilesPanel root={ROOT} listing={LISTING} onOpen={onOpen} open={OPEN_FILE} />);
    const code = screen.getByLabelText(`Contents of ${OPEN_FILE.path}`);
    expect(code.querySelectorAll(".cl-files__line")).toHaveLength(OPEN_FILE.text.split("\n").length);
  });

  test("a filter keeps matches and the folders on the way to them; ? searches inside files", () => {
    const onSearch = mock((_q: string) => undefined);
    render(<FilesPanel root={ROOT} listing={LISTING} onOpen={() => undefined} onSearch={onSearch} />);
    const filter = screen.getByRole("searchbox", { name: "Filter files" });
    fireEvent.change(filter, { target: { value: "spec" } });
    expect(screen.getAllByRole("treeitem").map((i) => i.textContent)).toEqual(["docs", "clover-spec.md"]);
    fireEvent.change(filter, { target: { value: "nothing-like-this" } });
    expect(screen.getByText("No file matches")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "? useState" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onSearch).toHaveBeenCalledWith("useState");
  });

  test("visiblePaths leaves the tree whole with no filter", () => {
    expect(visiblePaths(ROOT, LISTING, "")).toBeUndefined();
    expect(visiblePaths(ROOT, LISTING, "?x")).toBeUndefined();
    expect([...visiblePaths(ROOT, LISTING, "panel-")!].sort()).toEqual(
      [`${ROOT}/plugins`, `${ROOT}/plugins/clover`, ...["panel-diff", "panel-files", "panel-terminal"].map((n) => `${ROOT}/plugins/clover/${n}`)].sort(),
    );
  });
});

describe("the tree for the keyboard (review minor)", () => {
  test("one item takes Tab; the arrows move, Right opens and steps in, Left closes and steps out", () => {
    const onList = mock((_p: string) => undefined);
    render(<FilesPanel root={ROOT} listing={LISTING} onList={onList} onOpen={() => undefined} />);
    const items = () => screen.getAllByRole("treeitem");
    expect(items().filter((i) => i.tabIndex === 0).map((i) => i.textContent)).toEqual([".github"]);
    const github = screen.getByRole("treeitem", { name: ".github" });
    github.focus();
    fireEvent.keyDown(github, { key: "ArrowDown" });
    const docs = screen.getByRole("treeitem", { name: "docs" });
    expect(document.activeElement).toBe(docs);
    fireEvent.keyDown(docs, { key: "ArrowRight" });
    expect(docs.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(docs, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "clover-plan.md" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "docs" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("treeitem", { name: "docs" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "README.md" }));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: ".github" }));
    // Only one item takes Tab at a time: the one last moved to.
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1);
  });

  test("a listing that loops back on itself draws each folder once and never hangs", () => {
    const loop = `${ROOT}/loop`;
    const listing = { ...LISTING, [ROOT]: [...LISTING[ROOT]!, { path: loop, name: "loop", type: "dir" as const }], [loop]: [{ path: ROOT, name: "back-to-root", type: "dir" as const }] };
    render(<FilesPanel root={ROOT} listing={listing} initialOpen={[loop, ROOT]} onOpen={() => undefined} />);
    expect(screen.getAllByRole("treeitem", { name: "back-to-root" })).toHaveLength(1);
    expect(screen.getByRole("treeitem", { name: "back-to-root" }).getAttribute("aria-expanded")).toBe("false");
    expect(visiblePaths(ROOT, listing, "back")).toBeDefined();
  });
});

describe("hidden characters (review SF5)", () => {
  test("a name and the file's lines show bidi and zero-width characters as marks, and the file says it holds some", () => {
    const sneaky = { path: `${ROOT}/rea\u200Bdme.md`, name: "rea\u200Bdme.md", type: "file" as const };
    const listing = { ...LISTING, [ROOT]: [...LISTING[ROOT]!, sneaky] };
    const { container } = render(
      <FilesPanel root={ROOT} listing={listing} onOpen={() => undefined} open={{ path: sneaky.path, text: 'const ok = "yes\u202E\u2066";' }} />,
    );
    expect(screen.getByRole("treeitem", { name: /rea.*Hidden character U\+200B, zero-width space.*dme\.md/ })).toBeTruthy();
    expect([...container.querySelectorAll(".cl-files__code .cl-files-hidden")].map((m) => m.textContent)).toEqual(["U+202E", "U+2066"]);
    expect(screen.getByText("Has hidden characters")).toBeTruthy();
    expect(container.querySelector(".cl-files__code")?.textContent).not.toMatch(/[\u202E\u2066]/);
  });

  test("tag characters and variation selectors show as marks too (review round 3)", () => {
    const { container } = render(<FilesPanel root={ROOT} listing={LISTING} onOpen={() => undefined} open={{ path: `${ROOT}/README.md`, text: "Read me.\u{E0068}\u{E0069}\uFE0E" }} />);
    expect([...container.querySelectorAll(".cl-files__code .cl-files-hidden")].map((m) => m.textContent)).toEqual(["U+E0068", "U+E0069", "U+FE0E"]);
    expect(screen.getByRole("img", { name: 'Hidden character U+E0068, tag for "h"' })).toBeTruthy();
  });
});

describe("a code session's folder (the owner's scope ruling)", () => {
  test("the header names the session's folder and its computer", () => {
    render(<FilesTitle root={ROOT} computer={COMPUTER} />);
    expect(screen.getByLabelText("Files in clover, on Studio")).toBeTruthy();
    expect(screen.getByText("on Studio")).toBeTruthy();
  });

  test("the tree shows the folder and what's inside it, never anything outside it", () => {
    const outside = "/Users/sam/projects/garden-planner";
    const listing = { ...LISTING, [outside]: [{ path: `${outside}/beds.csv`, name: "beds.csv", type: "file" as const }] };
    render(<FilesPanel root={ROOT} listing={listing} onOpen={() => undefined} />);
    expect(screen.queryByText("beds.csv")).toBeNull();
    expect(screen.getByText("README.md")).toBeTruthy();
  });
});

describe("the Files panel's fence (review item 7)", () => {
  test("it never takes a `..` or `.` segment as inside", () => {
    expect(inside("home/Laptop/code/tarot", "home/Laptop/code/tarot/src/a.ts")).toBe(true);
    expect(inside("home/Laptop/code/tarot", "home/Laptop/code/tarot/../secrets")).toBe(false);
    expect(inside("home/Laptop/code/tarot", "home/Laptop/code/tarot/./a")).toBe(false);
    expect(inside("home/Laptop/code/tarot", "home/Laptop/code/tarot-other/a")).toBe(false);
  });
});
