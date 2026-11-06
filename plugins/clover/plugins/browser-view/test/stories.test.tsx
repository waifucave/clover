import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { browserStories as stories } from "../gallery/stories";
import { installResizeObserver } from "./resize";

afterEach(cleanup);

test("story ids are unique and name this part", () => {
  const ids = stories.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^browser-view\/[a-z0-9-]+$/);
});

for (const story of stories) {
  test(`renders: ${story.id}`, async () => {
    installResizeObserver();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(<div style={{ width: story.width ?? 880, height: story.height }}>{story.render()}</div>);
      });
      // Let the panel's own calls to the stand-in browser settle.
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
      // Something drew inside the frame.
      expect(view.container.firstElementChild?.children.length ?? 0).toBeGreaterThan(0);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });
}
