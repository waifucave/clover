// The pill on all three OSes (G-M3): bottom centre above what the OS draws along the bottom, a window no bigger than
// the pill's canvas that takes clicks only on the pill, and a normal window on Wayland.
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import type { Rect, SurfaceEnvironment, SurfaceHostApi, SurfaceWindowSpec } from "@waifucave/clover-plugin-island";
import { PILL } from "../src/model/metrics";
import { RESTING_CANVAS, pillMode, pillRegions, pillWindow } from "../src/model/placement";
import { memoryOf, type PillBot } from "../src/model/targets";
import { PillSurface } from "../src/ui/PillSurface";
import { PillApp, PillHostContext, type PillHost } from "../src/ui/host";

const MAC: SurfaceEnvironment = {
  os: "macos",
  // A Dock 70 tall along the bottom, the menu bar 32 along the top.
  display: { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 32, width: 1512, height: 880 }, notch: { x: 663.5, y: 0, width: 185, height: 32 } },
};
const EXTERNAL: SurfaceEnvironment = {
  os: "macos",
  display: { bounds: { x: 1512, y: -200, width: 2560, height: 1440 }, workArea: { x: 1512, y: -175, width: 2560, height: 1415 }, notch: null },
};
const WINDOWS: SurfaceEnvironment = {
  os: "windows",
  display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, notch: null },
};
const X11: SurfaceEnvironment = {
  os: "linux",
  session: "x11",
  display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 32, width: 1920, height: 1048 }, notch: null },
};
const WAYLAND: SurfaceEnvironment = { ...X11, session: "wayland" };

const BOTS: PillBot[] = [{ id: "alpha", name: "Alpha" }];

function fakeHost() {
  const windows: SurfaceWindowSpec[] = [];
  const regions: (readonly Rect[])[] = [];
  const host: SurfaceHostApi = { setWindow: (w) => void windows.push(w), setInteractiveRegions: (r) => void regions.push(r) };
  return { host, windows, regions };
}

describe("where the pill sits", () => {
  test("an overlay at the bottom centre everywhere but Wayland, where it is a normal window", () => {
    expect([MAC, EXTERNAL, WINDOWS, X11, WAYLAND].map(pillMode)).toEqual(["overlay", "overlay", "overlay", "overlay", "window"]);
  });

  test("above the Dock, the taskbar or a bottom panel: the pill's bottom dockGap above the work area's bottom", () => {
    for (const env of [MAC, EXTERNAL, WINDOWS, X11]) {
      const w = pillWindow(env, RESTING_CANVAS);
      const { bounds, workArea } = env.display;
      expect(w).toMatchObject({ overlay: true, alwaysOnTop: true, transparent: true, frame: false, clickThrough: true, inTaskSwitcher: false, visible: true });
      expect(w.bounds.width).toBe(RESTING_CANVAS.width);
      expect(Math.abs(w.bounds.x + w.bounds.width / 2 - (bounds.x + bounds.width / 2))).toBeLessThanOrEqual(0.5);
      // The pill (inside the shadow's margin) ends dockGap above the work area.
      expect(w.bounds.y + w.bounds.height - PILL.shadowPad).toBe(workArea.y + workArea.height - PILL.dockGap);
    }
  });

  test("clicks are the pill's only on the pill: the shadow's margin passes them through", () => {
    const canvas = { width: 608, height: 140 };
    expect(pillRegions(WINDOWS, canvas)).toEqual([{ x: PILL.shadowPad, y: PILL.shadowPad, width: 608 - 2 * PILL.shadowPad, height: 140 - 2 * PILL.shadowPad }]);
  });

  test("on Wayland: a framed window in the task switcher, the pill's own size with no shadow's margin, every click its own", () => {
    const w = pillWindow(WAYLAND, RESTING_CANVAS);
    expect(w).toMatchObject({ overlay: false, alwaysOnTop: false, transparent: false, frame: true, clickThrough: false, inTaskSwitcher: true, visible: true });
    expect(w.bounds.width).toBe(PILL.compactWidth);
    expect(w.bounds.height).toBe(PILL.pillHeight);
    expect(pillRegions(WAYLAND, RESTING_CANVAS)).toEqual([{ x: 0, y: 0, width: PILL.compactWidth, height: PILL.pillHeight }]);
  });
});

describe("PillSurface", () => {
  test("the window follows the pill's canvas as it grows, and the host hears each change once", async () => {
    const { host, windows, regions } = fakeHost();
    const { container } = render(<PillSurface environment={WINDOWS} host={host} target={{ id: "bot:alpha", name: "Alpha" }} reducedMotion />);
    await act(async () => {});
    const first = windows.at(-1)!;
    expect(first.overlay).toBe(true);
    const count = windows.length;
    // Typing widens the pill: the window grows with it, still centred and still above the taskbar.
    const field = container.querySelector("textarea")!;
    act(() => {
      fireEvent.change(field, { target: { value: "dim the lights in the studio" } });
    });
    await act(async () => {});
    const grown = windows.at(-1)!;
    expect(grown.bounds.width).toBeGreaterThan(first.bounds.width);
    expect(grown.bounds.y + grown.bounds.height).toBe(first.bounds.y + first.bounds.height);
    expect(regions.at(-1)![0]!.width).toBe(grown.bounds.width - 2 * PILL.shadowPad);
    // Nothing changed: nothing sent again.
    const after = windows.length;
    act(() => {
      fireEvent.change(field, { target: { value: "dim the lights in the studio!" } });
    });
    await act(async () => {});
    expect(windows.length - after).toBeLessThanOrEqual(1);
    expect(windows.length).toBeGreaterThan(count);
    expect(container.querySelector(".clp-surface")?.getAttribute("data-mode")).toBe("overlay");
  });

  test("PillApp places its window when the host gives the display; without one it draws as before", async () => {
    const { host: window, windows } = fakeHost();
    const host: PillHost = { bots: BOTS, memory: memoryOf(), send: async () => {}, environment: WAYLAND, window };
    const { container } = render(
      <PillHostContext.Provider value={host}>
        <PillApp props={{ surface: "pill" }} />
      </PillHostContext.Provider>,
    );
    await act(async () => {});
    expect(container.querySelector(".clp-surface")?.getAttribute("data-mode")).toBe("window");
    expect(windows.at(-1)!.frame).toBe(true);
  });
});
