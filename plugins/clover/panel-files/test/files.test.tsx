import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { visiblePaths } from "../client/filter";
import { FilesPanel } from "../client/FilesPanel";
import { LISTING, OPEN_FILE, ROOT } from "../gallery/fixtures";

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
      [`${ROOT}/plugins`, `${ROOT}/plugins/clover`, ...["panel-browser", "panel-diff", "panel-files", "panel-terminal"].map((n) => `${ROOT}/plugins/clover/${n}`)].sort(),
    );
  });
});
