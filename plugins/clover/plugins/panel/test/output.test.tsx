// One output in the right panel: one no-follow read (review N1), its hidden characters marked (N6), and its preview
// as `file.preview`'s (a plugin's, in its own sealed part, handed only a plain file's path).
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { directlyIn, mediaTypeOf } from "../../shell/runtime/files";
import type { UiEntry } from "../../shell/runtime/resolve";
import { SPOT_DECLS } from "../../shell/runtime/catalog";
import { fakeApi, fakeFiles, settle } from "../../shell/runtime/testkit";
import type { EntryComponent } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { OutputEntry } from "../client/output";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const FOLDER = "home/Studio/.clover/outputs/s_alpha";

/** Shows `path`; `links` are links on the way (the tree's no-follow read refuses them, its no-follow stat names them). */
function show(path: string, opts: { links?: string[]; previewer?: { key: string; component: EntryComponent } } = {}) {
  const calls: [string, string, unknown][] = [];
  const isLink = (p: string) => (opts.links ?? []).includes(p);
  const api = fakeApi({
    files: fakeFiles({
      stat: async (p, o?: unknown) => {
        calls.push(["stat", p, o]);
        return { path: p, type: isLink(p) ? ("symlink" as const) : ("file" as const), size: 1, modifiedAt: 0, executable: false };
      },
      readText: async (p, o?: unknown) => {
        calls.push(["readText", p, o]);
        if (isLink(p)) throw new Error("refused: a link on the way");
        return "# This week\n\n<script>alert(1)</script>\nsafe\u202Etxt.exe";
      },
      readBytes: async (p, o?: unknown) => {
        calls.push(["readBytes", p, o]);
        if (isLink(p)) throw new Error("refused: a link on the way");
        return new Uint8Array([137, 80, 78, 71]);
      },
    }),
  });
  const entries: UiEntry[] = opts.previewer ? [{ pluginId: "md-preview", id: "preview", spot: "file.preview", key: opts.previewer.key, component: "Preview", source: "installed", enabledAt: 1 }] : [];
  const header = document.createElement("div");
  document.body.append(header);
  render(
    <UiRuntimeProvider runtime={runtimeWith({ api: () => api, spot: (n) => SPOT_DECLS[n], entries, component: (_p, n) => (n === "Preview" ? opts.previewer?.component : undefined) })}>
      <OutputEntry props={{ path, folder: FOLDER, header }} />
    </UiRuntimeProvider>,
  );
  return { calls, header };
}

const NO_FOLLOW = { noFollow: true };

describe("an output in the right panel", () => {
  test("a page is read in ONE no-follow call and shows as its source, read only, its hidden characters marked", async () => {
    const { calls, header } = show(`${FOLDER}/this-week.md`);
    await act(() => settle());
    // No stat first: nothing for a runner to race between a check and the read (N1).
    expect(calls).toEqual([["readText", `${FOLDER}/this-week.md`, NO_FOLLOW]]);
    const viewer = screen.getByLabelText(/this-week\.md/);
    expect(viewer.textContent).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
    // The right-to-left override shows as a mark, and the view warns (N6).
    expect(viewer.querySelector(".cl-files-hidden")?.textContent).toBe("U+202E");
    expect(document.querySelector(".cl-files__warning")).toBeTruthy();
    expect(header.textContent).toBe("this-week.md");
    header.remove();
  });

  test("an image is read the same way and shows as itself", async () => {
    const { calls } = show(`${FOLDER}/plot.png`);
    await act(() => settle());
    expect(calls).toEqual([["readBytes", `${FOLDER}/plot.png`, NO_FOLLOW]]);
    expect(screen.getByRole("img", { name: "plot.png" })).toBeTruthy();
  });

  test("only one name directly in the session's outputs opens: nothing nested, nothing outside, no `..`", async () => {
    for (const path of [`${FOLDER}/../../secrets.txt`, `${FOLDER}/dir/x.md`, `${FOLDER}/./x.md`, "home/Studio/.clover/outputs/s_other/x.md"]) {
      const { calls } = show(path);
      await act(() => settle());
      expect([path, calls]).toEqual([path, []]);
      expect(screen.getByText("Only a session's own outputs open here.")).toBeTruthy();
      cleanup();
    }
    expect([directlyIn(`${FOLDER}/a.md`, FOLDER), directlyIn(`${FOLDER}/a/b.md`, FOLDER), directlyIn(`${FOLDER}//a.md`, FOLDER)]).toEqual([true, false, false]);
  });

  test("a link a runner planted (or swapped in) is refused by the read itself, and says so", async () => {
    const planted = `${FOLDER}/notes.md`;
    const { calls } = show(planted, { links: [planted] });
    await act(() => settle());
    // The refused read, then a no-follow stat only to say why.
    expect(calls).toEqual([["readText", planted, NO_FOLLOW], ["stat", planted, NO_FOLLOW]]);
    expect(screen.getByRole("alert").textContent).toContain("doesn't follow it");
  });

  test("a plugin that fills `file.preview` for the type draws it in its own sealed part, handed only the path and type", async () => {
    const seen: unknown[] = [];
    const Preview: EntryComponent = ({ props }) => {
      seen.push(props);
      return <div data-testid="md-preview">rendered</div>;
    };
    const { calls } = show(`${FOLDER}/this-week.md`, { previewer: { key: "text/*", component: Preview } });
    await act(() => settle());
    // The host checks what the path is (no-follow) and reads nothing itself: the plugin reads through its own API.
    expect(calls).toEqual([["stat", `${FOLDER}/this-week.md`, NO_FOLLOW]]);
    expect(seen.at(-1)).toEqual({ path: `${FOLDER}/this-week.md`, mediaType: "text/markdown" });
    const part = screen.getByTestId("md-preview").closest("[data-clover-entry]")!;
    expect(part.getAttribute("data-clover-entry")).toBe("md-preview#preview");
    expect(part.hasAttribute("data-clover-frame")).toBe(true);
    cleanup();
    // A link is never handed to it.
    seen.length = 0;
    show(`${FOLDER}/notes.md`, { links: [`${FOLDER}/notes.md`], previewer: { key: "text/*", component: Preview } });
    await act(() => settle());
    expect(seen).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("doesn't follow it");
  });

  test("media types by name", () => {
    expect(["a.PNG", "b.md", "c.glb", "d", "e.unknownext", ".hidden"].map(mediaTypeOf)).toEqual(["image/png", "text/markdown", "model/gltf-binary", "application/octet-stream", "application/octet-stream", "application/octet-stream"]);
  });
});
