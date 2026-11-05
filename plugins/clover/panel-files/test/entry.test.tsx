// The files on the runtime: the session's folder and nothing outside it, through the plugin API's `files`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fakeApi, settle } from "../../shell/runtime/testkit";
import type { FileStat, SessionView } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { FilesEntry, inside } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { LISTING, OPEN_FILE, ROOT } from "../gallery/fixtures";

afterEach(cleanup);

const CODE: SessionView = { id: "code-1", kind: "coding", computer: "Studio", root: ROOT, status: "idle", startedAt: 0, updatedAt: 0 };
const stat = (path: string, type: FileStat["type"]): FileStat => ({ path, type, size: 1, modifiedAt: 0, executable: false });

describe("the files entry", () => {
  test("`inside` keeps to the folder", () => {
    expect(inside("home/S/a", "home/S/a")).toBe(true);
    expect(inside("home/S/a", "home/S/a/b")).toBe(true);
    expect(inside("home/S/a", "home/S/ab")).toBe(false);
    expect(inside("home/S/a/", "home/S/a/b")).toBe(true);
  });

  test("lists the folder as it opens, reads a file, searches inside files, and never reaches outside", async () => {
    const listed: string[] = [];
    const read: string[] = [];
    const api = fakeApi({
      conversation: { get: async () => CODE },
      files: {
        list: async (path) => {
          listed.push(path);
          // A listing that strays outside the folder is cut back to it.
          return [...(LISTING[path] ?? []).map((e) => stat(e.path, e.type)), stat("home/Studio/secret.txt", "file")];
        },
        readText: async (path) => {
          read.push(path);
          return path === OPEN_FILE.path ? OPEN_FILE.text : "# README";
        },
        grep: async () => ({ matches: [{ path: `${ROOT}/docs/clover-spec.md`, line: 12, text: "  the panel host" }, { path: "home/Studio/other/x.md", line: 1, text: "outside" }], truncated: false }),
      },
    });
    const header = document.createElement("div");
    document.body.append(header);
    render(
      <UiRuntimeProvider runtime={runtimeWith({ api: () => api })}>
        <FilesEntry props={{ session: "code-1", header }} />
      </UiRuntimeProvider>,
    );
    await act(() => settle());
    expect(within(header).getByLabelText("Files in clover, on Studio")).toBeTruthy();
    expect(listed).toEqual([ROOT]);
    expect(screen.queryByRole("treeitem", { name: "secret.txt" })).toBeNull();
    fireEvent.click(screen.getByRole("treeitem", { name: "docs" }));
    await act(() => settle());
    expect(listed).toEqual([ROOT, `${ROOT}/docs`]);
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }));
    await act(() => settle());
    expect(read).toEqual([`${ROOT}/README.md`]);
    expect(screen.getByLabelText(`Contents of ${ROOT}/README.md`).textContent).toContain("# README");
    const filter = screen.getByRole("searchbox", { name: "Filter files" });
    fireEvent.change(filter, { target: { value: "?panel host" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    await act(() => settle());
    const matches = screen.getByRole("list", { name: "Inside files: panel host" });
    expect(within(matches).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["docs/clover-spec.md, line 12"]);
    fireEvent.click(within(matches).getByRole("button"));
    await act(() => settle());
    expect(read).toEqual([`${ROOT}/README.md`, `${ROOT}/docs/clover-spec.md`]);
    header.remove();
  });
});
