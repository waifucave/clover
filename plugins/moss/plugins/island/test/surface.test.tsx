import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ISLAND, LIQUID, islandRect, stripRect, topInset } from "../src/model/geometry";
import { housingOf, islandMode, islandPlacement, overlayWindow, OVERLAY, ISLAND_WINDOW, toWindowRect, type SurfaceEnvironment } from "../src/model/placement";
import { IslandSurface, type SurfaceHostApi } from "../src/ui/IslandSurface";
import { IslandApp, IslandHostContext, useIslandHost, type IslandHost } from "../src/ui/host";
import { mockSealedKit } from "../src/mock-kit";
import { SealedKitContext } from "../src/ui/sealed";
import { APPROVAL, APPROVAL_2, QUESTION, SEALED } from "../src/fixtures";
import manifest from "../moss.json" with { type: "json" };
import * as client from "../client/index";
import { NEEDS_YOU, isReservedTab } from "../src/model/tabs";
import { setTranslator, t } from "../src/strings";

/** A 1512×982 MacBook display: a 32 px menu bar and a 185×32 camera housing at the top centre. */
const MAC_NOTCH: SurfaceEnvironment = {
  os: "macos",
  display: {
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 32, width: 1512, height: 950 },
    notch: { x: 663.5, y: 0, width: 185, height: 32 },
  },
};
const MAC_EXTERNAL: SurfaceEnvironment = {
  os: "macos",
  display: { bounds: { x: 1512, y: -200, width: 2560, height: 1440 }, workArea: { x: 1512, y: -175, width: 2560, height: 1415 }, notch: null },
};
const WINDOWS: SurfaceEnvironment = {
  os: "windows",
  display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, notch: null },
};
const GNOME_X11: SurfaceEnvironment = {
  os: "linux",
  session: "x11",
  display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 32, width: 1920, height: 1048 }, notch: null },
};
const WAYLAND: SurfaceEnvironment = { ...GNOME_X11, session: "wayland" };

describe("where the island hangs (decision 82: the same top-centre island on every OS)", () => {
  test("a Mac with a camera housing: from the housing; any other display or OS: from the top edge; Wayland: a window", () => {
    expect(islandMode(MAC_NOTCH)).toBe("notch");
    expect(islandMode(MAC_EXTERNAL)).toBe("top");
    expect(islandMode(WINDOWS)).toBe("top");
    expect(islandMode(GNOME_X11)).toBe("top");
    expect(islandMode(WAYLAND)).toBe("window");
    // A housing reported on Windows (a display that claims one) changes nothing: only a Mac's camera is a housing.
    expect(islandMode({ ...WINDOWS, display: { ...WINDOWS.display, notch: { x: 867, y: 0, width: 186, height: 30 } } })).toBe("top");
  });

  test("a housing is a real one at the top centre, never a sliver or one off to the side", () => {
    expect(housingOf(MAC_NOTCH.display)).toEqual({ width: 185, height: 32 });
    expect(housingOf({ ...MAC_NOTCH.display, notch: { x: 700, y: 0, width: 40, height: 32 } })).toBeNull();
    expect(housingOf({ ...MAC_NOTCH.display, notch: { x: 663.5, y: 0, width: 185, height: 6 } })).toBeNull();
    expect(housingOf({ ...MAC_NOTCH.display, notch: { x: 100, y: 0, width: 185, height: 32 } })).toBeNull();
    expect(housingOf({ ...MAC_NOTCH.display, notch: { x: 663.5, y: 20, width: 185, height: 32 } })).toBeNull();
  });

  test("at the housing: a transparent overlay on top, centred, out of the task switcher, that passes clicks through", () => {
    const p = islandPlacement(MAC_NOTCH);
    expect(p.shape).toEqual({ housing: { width: 185, height: 32 }, menuBarHeight: 32 });
    expect(p.window).toEqual({
      bounds: { x: Math.round((1512 - OVERLAY.width) / 2), y: 0, width: OVERLAY.width, height: topInset(p.shape) + OVERLAY.height },
      overlay: true,
      alwaysOnTop: true,
      transparent: true,
      frame: false,
      clickThrough: true,
      inTaskSwitcher: false,
      visible: true,
    });
    expect(OVERLAY.width).toBe(ISLAND.islandWidth + 2 * LIQUID.margin);
  });

  test("from the top edge: the same overlay on the display it is on, hanging below what is drawn along the top", () => {
    const external = islandPlacement(MAC_EXTERNAL);
    expect(external.shape).toEqual({ housing: null, menuBarHeight: 25 });
    expect(external.window.bounds.x).toBe(1512 + Math.round((2560 - OVERLAY.width) / 2));
    expect(external.window.bounds.y).toBe(-200);
    // Windows' taskbar is at the bottom: nothing along the top.
    expect(islandPlacement(WINDOWS).shape).toEqual({ housing: null, menuBarHeight: 0 });
    // GNOME's top bar on X11.
    expect(islandPlacement(GNOME_X11).shape.menuBarHeight).toBe(32);
    expect(islandPlacement(GNOME_X11).window.overlay).toBe(true);
  });

  test("never more than 60% of a short display's height", () => {
    const short: SurfaceEnvironment = { ...WINDOWS, display: { ...WINDOWS.display, bounds: { x: 0, y: 0, width: 1024, height: 600 } } };
    expect(islandPlacement(short).window.bounds.height).toBe(360);
  });

  test("on Wayland: a normal framed window in the task switcher, near the top centre, that takes every click", () => {
    const p = islandPlacement(WAYLAND);
    expect(p.mode).toBe("window");
    expect(p.shape).toEqual({ housing: null, menuBarHeight: 0 });
    expect(p.window).toEqual({
      bounds: { x: Math.round((1920 - ISLAND_WINDOW.width) / 2), y: 32 + 24, width: ISLAND_WINDOW.width, height: ISLAND_WINDOW.height },
      overlay: false,
      alwaysOnTop: false,
      transparent: false,
      frame: true,
      clickThrough: false,
      inTaskSwitcher: true,
      visible: true,
    });
  });

  test("a rect in the island's space (x from its centre) lands in the overlay's own space", () => {
    const p = islandPlacement(MAC_NOTCH);
    expect(toWindowRect({ x: -50, y: 0, width: 100, height: 32 }, p)).toEqual({ x: OVERLAY.width / 2 - 50, y: 0, width: 100, height: 32 });
  });
});

function fakeHost() {
  const windows: unknown[] = [];
  const regions: { x: number; y: number; width: number; height: number }[][] = [];
  const host: SurfaceHostApi = {
    setWindow: (spec) => windows.push(spec),
    setInteractiveRegions: (r) => regions.push([...r]),
  };
  return { host, windows, regions };
}

const withKit = (ui: React.ReactElement) => <SealedKitContext.Provider value={mockSealedKit(SEALED)}>{ui}</SealedKitContext.Provider>;

describe("IslandSurface", () => {
  /** The strip with its glow, in the island's space: what an overlay draws while nothing is open or waiting. */
  const stripDrawn = (shape: ReturnType<typeof islandPlacement>["shape"]) => {
    const r = stripRect(shape, true)!;
    return { x: r.x - ISLAND.stripGlowMargin, y: r.y, width: r.width + 2 * ISLAND.stripGlowMargin, height: r.height + ISLAND.stripGlowMargin };
  };

  test("an overlay's window is only what the island draws: the strip alone, then with the card; never the whole frame", () => {
    const { host, windows, regions } = fakeHost();
    const p = islandPlacement(MAC_NOTCH);
    const view = render(withKit(<IslandSurface environment={MAC_NOTCH} cards={[]} working={1} host={host} reducedMotion />));
    const strip = overlayWindow(p, [stripDrawn(p.shape)]).spec;
    expect(windows).toEqual([strip]);
    expect(strip.bounds.width).toBeLessThan(p.window.bounds.width * 0.6);
    expect(strip.bounds.height).toBeLessThan(80);
    // The strip takes every click in its window.
    expect(regions.at(-1)).toEqual([{ x: 0, y: 0, width: strip.bounds.width, height: strip.bounds.height }]);
    view.rerender(withKit(<IslandSurface environment={MAC_NOTCH} cards={[APPROVAL]} working={1} host={host} reducedMotion />));
    const withCard = windows.at(-1) as typeof strip;
    expect(withCard.bounds.height).toBeGreaterThan(strip.bounds.height + 60);
    expect(withCard.bounds.width).toBe(ISLAND.cardWidth);
    const [stripRegion, card] = regions.at(-1)!;
    expect(stripRegion!.y).toBe(0);
    expect(card!.y).toBeGreaterThanOrEqual(topInset(p.shape));
    expect(card!.x).toBe(0);
    expect(card!.width).toBe(withCard.bounds.width);
    expect(card!.y + card!.height).toBe(withCard.bounds.height);
  });

  test("one place at a time: while MOSS's window is in front the island shows no permission card, and takes it back when the window goes back", () => {
    const { host } = fakeHost();
    const at = (front: boolean, cards: React.ComponentProps<typeof IslandSurface>["cards"]) =>
      withKit(<IslandSurface environment={{ ...MAC_NOTCH, mainFront: front }} cards={cards} working={0} host={host} reducedMotion />);
    const drawn = (c: HTMLElement) => c.querySelector("[data-sealed-card]")?.getAttribute("data-sealed-card") ?? null;
    // Window not in front: the card is the island's (as before).
    const view = render(at(false, [APPROVAL]));
    expect(drawn(view.container)).toBe(APPROVAL.id);
    // Window comes forward: the island lets go of it (no frame left of it, nothing open for it); the strip stays.
    view.rerender(at(true, [APPROVAL]));
    expect(drawn(view.container)).toBeNull();
    expect(view.container.querySelector(".clv-strip")).not.toBeNull();
    // A card that arrives while the window is in front is not drawn here either.
    view.rerender(at(true, [APPROVAL, APPROVAL_2]));
    expect(drawn(view.container)).toBeNull();
    // Window goes back: the island takes the waiting cards again.
    view.rerender(at(false, [APPROVAL, APPROVAL_2]));
    expect(drawn(view.container)).not.toBeNull();
    // A question is the island's own words and stays its to show.
    view.rerender(at(true, [QUESTION]));
    expect(view.container.textContent ?? "").toContain(QUESTION.questions[0]!.question);
  });

  test("asks again only when the window changes, and when the display does", () => {
    const { host, windows } = fakeHost();
    const view = render(withKit(<IslandSurface environment={MAC_NOTCH} cards={[]} working={1} host={host} reducedMotion />));
    view.rerender(withKit(<IslandSurface environment={{ ...MAC_NOTCH }} cards={[]} working={1} host={host} reducedMotion />));
    expect(windows).toHaveLength(1);
    view.rerender(withKit(<IslandSurface environment={MAC_EXTERNAL} cards={[]} working={1} host={host} reducedMotion />));
    expect(windows).toHaveLength(2);
    expect((windows[1] as { bounds: { x: number } }).bounds.x).toBeGreaterThan(1512);
  });

  test("drawing nothing, the overlay is hidden: a screen with no housing while nothing waits or works", () => {
    const { host, windows } = fakeHost();
    render(withKit(<IslandSurface environment={WINDOWS} cards={[]} working={0} host={host} reducedMotion />));
    expect(windows.at(-1)).toMatchObject({ visible: false, bounds: { width: 0, height: 0 } });
  });

  test("open, the window is the open island and takes clicks all over it", () => {
    const { host, windows, regions } = fakeHost();
    const p = islandPlacement(MAC_NOTCH);
    const { container } = render(withKit(<IslandSurface environment={MAC_NOTCH} cards={[]} working={1} host={host} reducedMotion />));
    act(() => {
      fireEvent.click(container.querySelector(".clv-strip [data-part]") ?? container.querySelector(".clv-strip")!);
    });
    const open = windows.at(-1) as { bounds: { x: number; y: number; width: number; height: number } };
    const rect = islandRect(p.shape);
    expect(open.bounds).toEqual({ x: p.window.bounds.x + p.window.bounds.width / 2 + rect.x, y: 0, width: rect.width, height: rect.height });
    expect(regions.at(-1)).toContainEqual({ x: 0, y: 0, width: rect.width, height: rect.height });
    // The content follows: the frame inside the window is moved by the window's offset.
    const frame = container.querySelector(".clv-surface-frame") as HTMLElement;
    expect(frame.style.left).toBe(`${-(p.window.bounds.width / 2 + rect.x)}px`);
  });

  test("on Wayland: no strip and no floating card; the island stays open on Needs you, and the window takes every click", () => {
    const { host, regions } = fakeHost();
    const { container } = render(withKit(<IslandSurface environment={WAYLAND} cards={[APPROVAL, QUESTION]} host={host} />));
    expect(container.querySelector(".clv-surface")?.getAttribute("data-mode")).toBe("window");
    expect(container.querySelector(".clv-strip")).toBeNull();
    expect(container.querySelector(".clv-island")?.getAttribute("data-open")).toBe("true");
    expect(container.querySelector(".clv-card-shell")).toBeNull();
    expect(regions.at(-1)).toEqual([{ x: 0, y: 0, width: ISLAND_WINDOW.width, height: ISLAND_WINDOW.height }]);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(container.querySelector(".clv-island")?.getAttribute("data-open")).toBe("true");
  });
});

/** What the island draws in its own words, under the host's translator. */
function IslandWords() {
  useIslandHost();
  return <span>{t("moss.island.nothingNeedsYou")}</span>;
}

describe("the entries the manifest names", () => {
  test("every component the manifest names is an export of the client entry", () => {
    for (const entry of manifest.contributes.ui) expect(typeof (client as Record<string, unknown>)[entry.component]).toBe("function");
    // What an island does for every card, on top of everything: its OK card says so (the same capabilities a copy holds).
    expect(manifest.capabilities).toEqual(["approvals", "approvals.all", "bots.read", "overlay"]);
    // The island declares the slot and draws its own Needs you; every other tab (Usage, Devices) is another plugin's entry.
    expect(manifest.contributes.ui.map((e) => e.spot)).toEqual(["app.surface"]);
  });

  test("IslandApp reads the host; without one it draws nothing", async () => {
    const empty = render(<IslandApp props={{ surface: "island" }} />);
    expect(empty.container.innerHTML).toBe("");
    empty.unmount();
    const { host: window, windows } = fakeHost();
    const host: IslandHost = { environment: WINDOWS, window, cards: [], working: 0, reducedMotion: true };
    const { container } = render(
      <IslandHostContext.Provider value={host}>
        <IslandApp props={{ surface: "island" }} />
      </IslandHostContext.Provider>,
    );
    await act(async () => {});
    expect(container.querySelector(".clv-surface")?.getAttribute("data-mode")).toBe("top");
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });

  test("the host's translator gives the island its words in the user's language; Needs you stays reserved in both", async () => {
    const fr: Record<string, string> = { "moss.island.needsYou": "Pour vous", "moss.island.nothingNeedsYou": "Rien pour vous" };
    const host: IslandHost = {
      environment: WINDOWS,
      cards: [],
      t: (key) => fr[key] ?? key,
      reducedMotion: true,
    };
    render(
      <IslandHostContext.Provider value={host}>
        <IslandWords />
      </IslandHostContext.Provider>,
    );
    await act(async () => {});
    expect(screen.getByText("Rien pour vous")).toBeTruthy();
    expect(NEEDS_YOU.title).toBe("Pour vous");
    expect(isReservedTab({ id: "x", title: "Pour vous" })).toBe(true);
    expect(isReservedTab({ id: "x", title: "Needs you" })).toBe(true);
    setTranslator(null);
    expect(NEEDS_YOU.title).toBe("Needs you");
  });
});
