import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ISLAND, LIQUID, islandRect, stripRect, topInset } from "../src/model/geometry";
import { housingOf, islandMode, islandPlacement, OVERLAY, ISLAND_WINDOW, toWindowRect, type SurfaceEnvironment } from "../src/model/placement";
import { deviceGroups, deviceRows, devicesSummary, orderDevices, seenAgo, type DeviceView } from "../src/model/devices";
import { IslandSurface, type SurfaceHostApi } from "../src/ui/IslandSurface";
import { DevicesList, DevicesTab, type DevicesSource } from "../src/ui/DevicesTab";
import { IslandApp, DevicesTabEntry, IslandHostContext, type IslandHost } from "../src/ui/host";
import { mockSealedKit } from "../src/mock-kit";
import { SealedKitContext } from "../src/ui/sealed";
import { APPROVAL, QUESTION, SEALED } from "../src/fixtures";
import manifest from "../clover.json" with { type: "json" };
import * as client from "../client/index";

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
  test("asks for its window once, and again only when the display changes", () => {
    const { host, windows } = fakeHost();
    const view = render(withKit(<IslandSurface environment={MAC_NOTCH} cards={[]} host={host} reducedMotion />));
    view.rerender(withKit(<IslandSurface environment={{ ...MAC_NOTCH }} cards={[]} host={host} reducedMotion />));
    expect(windows).toEqual([islandPlacement(MAC_NOTCH).window]);
    view.rerender(withKit(<IslandSurface environment={MAC_EXTERNAL} cards={[]} host={host} reducedMotion />));
    expect(windows).toEqual([islandPlacement(MAC_NOTCH).window, islandPlacement(MAC_EXTERNAL).window]);
  });

  test("an overlay takes clicks only on the strip, then on the card when one arrives", () => {
    const { host, regions } = fakeHost();
    const p = islandPlacement(MAC_NOTCH);
    const view = render(withKit(<IslandSurface environment={MAC_NOTCH} cards={[]} working={1} host={host} reducedMotion />));
    const strip = stripRect(p.shape, true)!;
    const first = regions.at(-1)!;
    expect(first).toHaveLength(1);
    expect(first[0]!.x).toBe(Math.round(p.window.bounds.width / 2 + strip.x - ISLAND.stripGlowMargin));
    expect(first[0]!.width).toBe(Math.round(strip.width + 2 * ISLAND.stripGlowMargin));
    view.rerender(withKit(<IslandSurface environment={MAC_NOTCH} cards={[APPROVAL]} working={1} host={host} reducedMotion />));
    const withCard = regions.at(-1)!;
    expect(withCard).toHaveLength(2);
    // The card hangs below the top band, inside the overlay.
    const card = withCard[1]!;
    expect(card.y).toBeGreaterThanOrEqual(topInset(p.shape));
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(p.window.bounds.width);
  });

  test("open, it takes clicks on the whole open island", () => {
    const { host, regions } = fakeHost();
    const p = islandPlacement(MAC_NOTCH);
    const { container } = render(withKit(<IslandSurface environment={MAC_NOTCH} cards={[]} working={1} host={host} reducedMotion />));
    act(() => {
      fireEvent.click(container.querySelector(".clv-strip [data-part]") ?? container.querySelector(".clv-strip")!);
    });
    const open = regions.at(-1)!;
    const rect = islandRect(p.shape);
    expect(open).toContainEqual({ x: Math.round(p.window.bounds.width / 2 + rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  });

  test("on Wayland: no strip and no floating card; the island stays open on Needs you, and the window takes every click", () => {
    const { host, regions } = fakeHost();
    const { container } = render(withKit(<IslandSurface environment={WAYLAND} cards={[APPROVAL, QUESTION]} host={host} />));
    expect(container.querySelector(".clv-surface")?.getAttribute("data-mode")).toBe("window");
    expect(container.querySelector(".clv-strip")).toBeNull();
    expect(container.querySelector(".clv-island")?.getAttribute("data-open")).toBe("true");
    expect(container.querySelector(".clv-card-shell")).toBeNull();
    expect(regions.at(-1)).toEqual([{ x: 0, y: 0, width: ISLAND_WINDOW.width, height: ISLAND_WINDOW.height }]);
    // Esc closes an overlay's open island; a window has nothing to close to.
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(container.querySelector(".clv-island")?.getAttribute("data-open")).toBe("true");
  });
});

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const DEVICES: DeviceView[] = [
  { id: "phone", name: "Phone", kind: "phone", os: "ios", runsCore: false, online: false, isThis: false, isMain: false, addedAt: 0, lastSeenAt: NOW - 3 * 3_600_000, link: { peer: "phone", up: false, path: "relay", relay: "waifucave relay" } },
  { id: "laptop", name: "Pocket laptop", kind: "desktop", os: "macos", runsCore: true, online: true, isThis: false, isMain: false, addedAt: 0, link: { peer: "laptop", up: true, path: "lan", rttMs: 3.4 } },
  { id: "studio", name: "Studio", kind: "desktop", os: "macos", runsCore: true, online: true, isThis: true, isMain: true, addedAt: 0 },
  { id: "box", name: "Box", kind: "server", os: "linux", runsCore: true, online: true, isThis: false, isMain: false, addedAt: 0, link: { peer: "box", up: true, path: "relay", relay: "waifucave relay", rttMs: 48 } },
  { id: "old", name: "Old tower", kind: "desktop", os: "windows", runsCore: true, online: false, isThis: false, isMain: false, addedAt: 0, lastSeenAt: NOW - 9 * 86_400_000 },
  { id: "chrome", name: "Chrome", kind: "browser", runsCore: false, online: true, isThis: false, isMain: false, addedAt: 0, link: { peer: "chrome", up: true, path: "direct" } },
];

describe("the Devices tab's model", () => {
  test("this device first, then the main, the computers online, the others online, then the offline, latest first", () => {
    expect(orderDevices(DEVICES).map((d) => d.id)).toEqual(["studio", "box", "laptop", "chrome", "phone", "old"]);
    const main = { ...DEVICES[1]!, isMain: true };
    expect(orderDevices([DEVICES[3]!, main, DEVICES[2]!]).map((d) => d.id)).toEqual(["studio", "laptop", "box"]);
  });

  test("seen: now, minutes, hours, yesterday, days, then a date", () => {
    expect(seenAgo(undefined, NOW)).toBe("Never seen");
    expect(seenAgo(NOW - 20_000, NOW)).toBe("Seen just now");
    expect(seenAgo(NOW - 60_000, NOW)).toBe("Seen 1 min ago");
    expect(seenAgo(NOW - 5 * 60_000, NOW)).toBe("Seen 5 min ago");
    expect(seenAgo(NOW - 3 * 3_600_000, NOW)).toBe("Seen 3 h ago");
    expect(seenAgo(NOW - 30 * 3_600_000, NOW)).toBe("Seen yesterday");
    expect(seenAgo(NOW - 4 * 86_400_000, NOW)).toBe("Seen 4 days ago");
    expect(seenAgo(NOW - 9 * 86_400_000, NOW)).toBe("Seen 2026-10-27");
  });

  test("each row: what it is, how it is linked or when it was seen, its round trip under the pointer", () => {
    const rows = deviceRows(DEVICES, NOW);
    expect(rows[0]).toEqual({ id: "studio", title: "Studio", side: "Computer · this device · main", state: "online", status: "Running", detail: null, quiet: false });
    expect(rows.find((r) => r.id === "laptop")).toMatchObject({ side: "Computer", status: "Same network", detail: "3 ms round trip" });
    expect(rows.find((r) => r.id === "box")).toMatchObject({ side: "Server", status: "Through waifucave relay", detail: "48 ms round trip" });
    expect(rows.find((r) => r.id === "chrome")).toMatchObject({ side: "Browser", status: "Direct", detail: null });
    expect(rows.find((r) => r.id === "phone")).toMatchObject({ state: "offline", status: "Seen 3 h ago", detail: "Last linked through waifucave relay", quiet: true });
  });

  test("two groups, each with its count online; an empty group is left out", () => {
    const groups = deviceGroups(DEVICES, NOW);
    expect(groups.map((g) => [g.id, g.title, g.meta, g.rows.map((r) => r.id)])).toEqual([
      ["computers", "Computers", "3 of 4 online", ["studio", "box", "laptop", "old"]],
      ["others", "Phones and browsers", "1 of 2 online", ["chrome", "phone"]],
    ]);
    expect(deviceGroups(DEVICES.filter((d) => d.runsCore), NOW).map((g) => g.id)).toEqual(["computers"]);
    expect(devicesSummary(DEVICES)).toBe("4 of 6 online");
  });
});

describe("the Devices tab", () => {
  test("rows with a dot for online and a ring for away; the round trip shows under the pointer", () => {
    const { container } = render(<DevicesList devices={DEVICES} now={NOW} />);
    expect([...container.querySelectorAll(".clv-group-title > span:first-child")].map((e) => e.textContent)).toEqual(["Computers", "Phones and browsers"]);
    expect(container.querySelectorAll(".clv-row")).toHaveLength(6);
    expect(container.querySelectorAll(".clv-row .clv-row-mark .clv-mark-dot")).toHaveLength(4);
    expect(container.querySelectorAll(".clv-row .clv-row-mark .clv-mark-ring")).toHaveLength(2);
    expect(screen.queryByText("3 ms round trip")).toBeNull();
    fireEvent.mouseEnter(screen.getByText("Pocket laptop").closest(".clv-row")!);
    expect(screen.getByText("3 ms round trip")).toBeTruthy();
  });

  test("none yet: says so", () => {
    render(<DevicesList devices={[]} now={NOW} />);
    expect(screen.getByText("No devices yet")).toBeTruthy();
  });

  test("follows devices.watch: a device that comes online, and a new one", async () => {
    let push: (d: DeviceView) => void = () => {};
    const stop = mock(() => {});
    const source: DevicesSource = { list: async () => DEVICES.slice(0, 3), watch: (l) => ((push = l), stop) };
    const view = render(<DevicesTab source={source} now={() => NOW} />);
    await act(async () => {});
    expect(screen.getByText("Seen 3 h ago")).toBeTruthy();
    act(() => push({ ...DEVICES[0]!, online: true, link: { peer: "phone", up: true, path: "relay", relay: "waifucave relay" } }));
    expect(screen.queryByText("Seen 3 h ago")).toBeNull();
    act(() => push(DEVICES[5]!));
    expect(screen.getByText("Chrome")).toBeTruthy();
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("the entries the manifest names", () => {
  test("every component the manifest names is an export of the client entry", () => {
    for (const entry of manifest.contributes.ui) expect(typeof (client as Record<string, unknown>)[entry.component]).toBe("function");
    expect(manifest.capabilities).toEqual(["approvals", "devices.read"]);
    expect(manifest.contributes.ui.map((e) => e.spot)).toEqual(["app.surface", "island.tab"]);
  });

  test("IslandApp and DevicesTabEntry read the host; without one they draw nothing", async () => {
    const empty = render(<IslandApp props={{ surface: "island" }} />);
    expect(empty.container.innerHTML).toBe("");
    empty.unmount();
    const { host: window, windows } = fakeHost();
    const host: IslandHost = { environment: WINDOWS, window, cards: [], working: 0, devices: { list: async () => DEVICES, watch: () => () => {} }, reducedMotion: true };
    const { container } = render(
      <IslandHostContext.Provider value={host}>
        <IslandApp props={{ surface: "island" }} />
        <DevicesTabEntry props={{ expanded: true }} />
      </IslandHostContext.Provider>,
    );
    await act(async () => {});
    expect(container.querySelector(".clv-surface")?.getAttribute("data-mode")).toBe("top");
    expect(windows).toHaveLength(1);
    expect(screen.getByText("Studio")).toBeTruthy();
  });
});
