// The files on the runtime: the session's folder and nothing outside it, through the plugin API's `files`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fakeApi, fakeFiles, settle } from "../../shell/runtime/testkit";
import type { FileStat, SessionView } from "../../shell/runtime/types";
import { SPOT_DECLS } from "../../shell/runtime/catalog";
import type { EntryComponent } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { FilesEntry, inside } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";
import { LISTING, OPEN_FILE, ROOT } from "../gallery/fixtures";

afterEach(cleanup);

const CODE: SessionView = { id: "code-1", kind: "coding", computer: "Studio", root: ROOT, status: "idle", startedAt: 0, updatedAt: 0 };
const stat = (path: string, type: FileStat["type"]): FileStat => ({ path, type, size: 1, modifiedAt: 0, executable: false });

describe("the files entry", () => {
  test("watches the folder: a change lists the folders it touched and reads the open file again; a resync lists all", async () => {
    const listed: string[] = [];
    let fire: ((e: { type: "changed"; paths: string[] } | { type: "resync" }) => void) | undefined;
    let stopped = false;
    const api = fakeApi({
      conversation: { get: async () => CODE },
      files: fakeFiles({
        list: async (path) => {
          listed.push(path);
          return (LISTING[path] ?? []).map((e) => stat(e.path, e.type));
        },
        readText: async () => "v2",
        grep: async () => ({ matches: [], truncated: false }),
        watch: async (_path, fn) => {
          fire = fn;
          return () => void (stopped = true);
        },
      }),
    });
    const { unmount } = render(
      <UiRuntimeProvider runtime={runtimeWith({ api: () => api })}>
        <FilesEntry props={{ session: "code-1" }} />
      </UiRuntimeProvider>,
    );
    await act(() => settle());
    fireEvent.click(screen.getByRole("treeitem", { name: "docs" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "README.md" }));
    await act(() => settle());
    listed.length = 0;
    act(() => fire!({ type: "changed", paths: [`${ROOT}/docs/new.md`, `${ROOT}/README.md`, "home/Studio/elsewhere/x"] }));
    await act(() => settle());
    expect(listed.sort()).toEqual([ROOT, `${ROOT}/docs`].sort());
    expect(screen.getByLabelText(`Contents of ${ROOT}/README.md`).textContent).toContain("v2");
    listed.length = 0;
    act(() => fire!({ type: "resync" }));
    await act(() => settle());
    expect(listed.sort()).toEqual([ROOT, `${ROOT}/docs`].sort());
    unmount();
    expect(stopped).toBe(true);
  });

  test("an image opens as its preview, read in one no-follow call; a type a plugin previews goes to its sealed part", async () => {
    const calls: [string, string, unknown][] = [];
    const seen: unknown[] = [];
    const Preview: EntryComponent = ({ props }) => {
      seen.push(props);
      return <div data-testid="json-preview">tree</div>;
    };
    const api = fakeApi({
      conversation: { get: async () => CODE },
      files: fakeFiles({
        list: async (path) => (path === ROOT ? [stat(`${ROOT}/logo.png`, "file"), stat(`${ROOT}/package.json`, "file")] : []),
        stat: async (p, o?: unknown) => (calls.push(["stat", p, o]), stat(p, "file")),
        readText: async (p, o?: unknown) => (calls.push(["readText", p, o]), "{}"),
        readBytes: async (p, o?: unknown) => (calls.push(["readBytes", p, o]), new Uint8Array([137, 80])),
        grep: async () => ({ matches: [], truncated: false }),
      }),
    });
    render(
      <UiRuntimeProvider
        runtime={runtimeWith({
          api: () => api,
          spot: (n) => SPOT_DECLS[n],
          entries: [{ pluginId: "json-view", id: "preview", spot: "file.preview", key: "application/json", component: "Preview", source: "installed", enabledAt: 1 }],
          component: (_p, n) => (n === "Preview" ? Preview : undefined),
        })}
      >
        <FilesEntry props={{ session: "code-1" }} />
      </UiRuntimeProvider>,
    );
    await act(() => settle());
    fireEvent.click(screen.getByRole("treeitem", { name: "logo.png" }));
    await act(() => settle());
    expect(calls).toEqual([["readBytes", `${ROOT}/logo.png`, { noFollow: true }]]);
    expect(screen.getByRole("img", { name: "logo.png" })).toBeTruthy();
    calls.length = 0;
    fireEvent.click(screen.getByRole("treeitem", { name: "package.json" }));
    await act(() => settle());
    expect(calls.filter((c) => c[0] === "stat")).toEqual([["stat", `${ROOT}/package.json`, { noFollow: true }]]);
    expect(seen.at(-1)).toEqual({ path: `${ROOT}/package.json`, mediaType: "application/json" });
    expect(screen.getByTestId("json-preview").closest("[data-clover-frame]")).toBeTruthy();
  });

  test("a file the conversation named opens when it is in the folder; one outside never does", async () => {
    const read: string[] = [];
    const api = fakeApi({
      conversation: { get: async () => CODE },
      files: fakeFiles({ list: async () => [], readText: async (p) => (read.push(p), "body"), grep: async () => ({ matches: [], truncated: false }) }),
    });
    const at = (reveal: string) => (
      <UiRuntimeProvider runtime={runtimeWith({ api: () => api })}>
        <FilesEntry props={{ session: "code-1", reveal }} />
      </UiRuntimeProvider>
    );
    const { rerender } = render(at(`${ROOT}/README.md`));
    await act(() => settle());
    expect(screen.getByLabelText(`Contents of ${ROOT}/README.md`).textContent).toContain("body");
    rerender(at("home/Studio/secrets.txt"));
    await act(() => settle());
    expect(read).toEqual([`${ROOT}/README.md`]);
  });

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
      files: fakeFiles({
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
      }),
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
