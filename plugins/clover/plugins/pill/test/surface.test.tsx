// The pill on all three OSes (G-M3): bottom centre above what the OS draws along the bottom, a window no bigger than
// the pill's canvas that takes clicks only on the pill, and a normal window on Wayland.
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import type { Rect, SurfaceEnvironment, SurfaceHostApi, SurfaceWindowSpec } from "@waifucave/clover-plugin-island";
import { PILL } from "../src/model/metrics";
import { RESTING_CANVAS, pieceRects, pillMode, pillRegions, pillWindow } from "../src/model/placement";
import { estimatedMenuHeight } from "../src/model/metrics";
import { DispatchPill } from "../src/ui/DispatchPill";
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

describe("what takes clicks, and the menu's height (#189's review)", () => {
  test("one region per drawn piece: the pill, the menu on its own side and width, the agents' row; never the space beside them", () => {
    const main = { width: 560, height: 44 };
    const canvas = { width: 608, height: 44 + 8 + 236 + 8 + 44 + 48 };
    const rects = pieceRects(canvas, { main, menu: { width: 240, height: 236, side: "leading" }, agents: true });
    expect(rects).toEqual([
      { x: 24, y: canvas.height - 24 - 44, width: 560, height: 44 },
      { x: 24, y: canvas.height - 24 - 44 - 8 - 236, width: 240, height: 236 },
      { x: 24, y: 24, width: 560, height: 44 },
    ]);
    const trailing = pieceRects(canvas, { main, menu: { width: 240, height: 236, side: "trailing" } })[1]!;
    expect(trailing.x + trailing.width).toBe(24 + 560);
    const regions = pillRegions(WINDOWS, canvas, { main, menu: { width: 240, height: 236, side: "leading" }, agents: true });
    expect(regions).toHaveLength(3);
    // The empty space right of the menu passes clicks through.
    const menuRegion = regions[1]!;
    expect(menuRegion.x + menuRegion.width).toBeLessThan(24 + 300);
    // On Wayland the window drops the shadow's margin: the regions move with it, inside the window.
    const w = pillWindow(WAYLAND, canvas);
    for (const r of pillRegions(WAYLAND, canvas, { main, agents: true })) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(w.bounds.width);
      expect(r.y + r.height).toBeLessThanOrEqual(w.bounds.height);
    }
  });

  test("the estimate counts the hairline and the gaps, and stops at the cap where the rows scroll", () => {
    expect(estimatedMenuHeight(6, 1)).toBeGreaterThan(12 + 34 * 6);
    expect(estimatedMenuHeight(40, 1)).toBe(PILL.menuMaxHeight);
    expect(estimatedMenuHeight(0, 0)).toBe(0);
  });

  test("the open menu's height is the one drawn (getBoundingClientRect), so the window never clips it", async () => {
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains("clp-menu")) return { x: 0, y: 0, top: 0, left: 0, right: 250, bottom: 236, width: 250, height: 236, toJSON() {} } as DOMRect;
      return real.call(this);
    };
    try {
      const sizes: { width: number; height: number }[] = [];
      const targets = [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Luna" },
        { id: "c", name: "Mori" },
        { id: "d", name: "Codex", detail: "Agents" },
        { id: "e", name: "Scene", detail: "Blender" },
        { id: "f", name: "Lights", detail: "Home" },
      ];
      render(<DispatchPill target={targets[0]!} targets={targets} initialMenu="targets" onCanvas={(s) => sizes.push(s)} reducedMotion />);
      await act(async () => {});
      expect(sizes.at(-1)!.height).toBe(PILL.pillHeight + PILL.stackGap + 236 + 2 * PILL.shadowPad);
    } finally {
      Element.prototype.getBoundingClientRect = real;
    }
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
    // One region, the pill itself, with a few pixels for its grow under the pointer.
    expect(regions.at(-1)!.length).toBe(1);
    expect(regions.at(-1)![0]!.width).toBe(grown.bounds.width - 2 * PILL.shadowPad + 12);
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
