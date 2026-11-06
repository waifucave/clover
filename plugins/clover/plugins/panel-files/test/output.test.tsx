// One output in the right panel, and the folder fence (review item 7).
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { fakeApi, fakeFiles, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { inside } from "../client/entry";
import { OutputEntry } from "../client/output";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

function show(path: string) {
  const reads: string[] = [];
  const api = fakeApi({
    files: fakeFiles({
      readText: async (p) => {
        reads.push(p);
        return "# This week\n\n<script>alert(1)</script>";
      },
      readBytes: async (p) => {
        reads.push(p);
        return new Uint8Array([137, 80, 78, 71]);
      },
    }),
  });
  const header = document.createElement("div");
  document.body.append(header);
  render(
    <UiRuntimeProvider runtime={runtimeWith({ api: () => api })}>
      <OutputEntry props={{ path, header }} />
    </UiRuntimeProvider>,
  );
  return { reads, header };
}

describe("an output in the right panel", () => {
  test("a page shows as its source, read only (nothing it holds runs), its name in the header row", async () => {
    const { reads, header } = show("home/Studio/.clover/outputs/s_alpha/this-week.md");
    await act(() => settle());
    expect(reads).toEqual(["home/Studio/.clover/outputs/s_alpha/this-week.md"]);
    expect(screen.getByLabelText(/this-week\.md/).textContent).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
    expect(header.textContent).toBe("this-week.md");
    header.remove();
  });

  test("an image shows as itself; nothing outside a session's outputs is read", async () => {
    const { reads } = show("home/Studio/.clover/outputs/s_alpha/plot.png");
    await act(() => settle());
    expect(screen.getByRole("img", { name: "plot.png" })).toBeTruthy();
    cleanup();
    const other = show("home/Studio/.clover/outputs/s_alpha/../../secrets.txt");
    await act(() => settle());
    expect(other.reads).toEqual([]);
    expect(screen.getByText("Only a session's own outputs open here.")).toBeTruthy();
    expect(reads).toHaveLength(1);
  });

  test("the Files panel's fence never takes a `..` or `.` segment as inside", () => {
    expect(inside("home/Laptop/code/tarot", "home/Laptop/code/tarot/src/a.ts")).toBe(true);
    expect(inside("home/Laptop/code/tarot", "home/Laptop/code/tarot/../secrets")).toBe(false);
    expect(inside("home/Laptop/code/tarot", "home/Laptop/code/tarot/./a")).toBe(false);
    expect(inside("home/Laptop/code/tarot", "home/Laptop/code/tarot-other/a")).toBe(false);
  });
});
