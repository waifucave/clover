import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { terminalStories as stories } from "../gallery/stories";

afterEach(cleanup);

test("story ids are unique and name this part", () => {
  const ids = stories.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^panel-terminal\/[a-z0-9-]+$/);
});

for (const story of stories) {
  test(`renders: ${story.id}`, () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const { container } = render(<div style={{ width: story.width ?? 880, height: story.height }}>{story.render()}</div>);
      // Something drew inside the frame.
      expect(container.firstElementChild?.children.length ?? 0).toBeGreaterThan(0);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });
}
