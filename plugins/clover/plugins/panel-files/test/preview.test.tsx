// A picture in the files panel goes to the `file.preview` spot, keyed by its media type: the part that fills it draws it
// (a stand-in with the acceptance fixture's own shape: it draws the file's name and media type), none says so, and no text read is made.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fakeApi, fakeFiles, settle } from "../../shell/runtime/testkit";
import type { FileStat, SessionView } from "../../shell/runtime/types";
import type { UiEntry } from "../../shell/runtime/resolve";
import { runtimeWith } from "../../shell/runtime/ui";
import { FilesEntry } from "../client/entry";
import { previewTypeOf } from "../client/media";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const ImagePreview = ({ props }: { props: { path: string; mediaType: string } }) => <div data-acceptance-preview="main">{props.path.split("/").at(-1)} ({props.mediaType})</div>;

const ROOT = "home/Studio/proj";
const CODE: SessionView = { id: "code-1", kind: "coding", computer: "Studio", root: ROOT, status: "idle", startedAt: 0, updatedAt: 0 };
const stat = (name: string): FileStat => ({ path: `${ROOT}/${name}`, type: "file", size: 1, modifiedAt: 0, executable: false });
const FILLER: UiEntry = { pluginId: "acceptance-preview", id: "file.preview", spot: "file.preview", key: "image/*", component: "ImagePreview", source: "installed", enabledAt: 1 };

function mount(withFiller: boolean) {
  const reads: string[] = [];
  const api = fakeApi({
    conversation: { get: async () => CODE },
    files: fakeFiles({
      list: async () => [stat("logo.png"), stat("notes.txt")],
      readText: async (path) => { reads.push(path); return "some notes"; },
      grep: async () => ({ matches: [], truncated: false }),
      watch: async () => () => undefined,
    }),
  });
  const runtime = runtimeWith({
    api: () => api,
    spot: (name) => (name === "file.preview" ? { shape: "keyed" } : undefined),
    entries: withFiller ? [FILLER] : [],
    component: (pluginId, name) => (pluginId === "acceptance-preview" && name === "ImagePreview" ? (ImagePreview as never) : undefined),
  });
  render(<UiRuntimeProvider runtime={runtime}><FilesEntry props={{ session: "code-1" }} /></UiRuntimeProvider>);
  return reads;
}

describe("file.preview in the files panel", () => {
  test("the media type is read off a picture's name only", () => {
    expect([previewTypeOf("a/b/logo.PNG"), previewTypeOf("x.svg"), previewTypeOf("notes.txt"), previewTypeOf("dir.png/readme"), previewTypeOf("Makefile")]).toEqual(["image/png", "image/svg+xml", undefined, undefined, undefined]);
  });

  test("a picture shows through the part that fills the spot, with no text read", async () => {
    const reads = mount(true);
    await act(() => settle());
    fireEvent.click(screen.getByRole("treeitem", { name: "logo.png" }));
    await act(() => settle());
    expect(screen.getByLabelText(`Preview of ${ROOT}/logo.png`).textContent).toContain("logo.png (image/png)");
    expect(reads).toEqual([]);
  });

  test("with no part filling it a note says so; a text file is still read as text", async () => {
    const reads = mount(false);
    await act(() => settle());
    fireEvent.click(screen.getByRole("treeitem", { name: "logo.png" }));
    await act(() => settle());
    expect(screen.getByLabelText(`Preview of ${ROOT}/logo.png`).textContent).toContain("No preview for image/png here.");
    fireEvent.click(screen.getByRole("treeitem", { name: "notes.txt" }));
    await act(() => settle());
    expect(screen.getByLabelText(`Contents of ${ROOT}/notes.txt`).textContent).toContain("some notes");
    expect(reads).toEqual([`${ROOT}/notes.txt`]);
  });
});
