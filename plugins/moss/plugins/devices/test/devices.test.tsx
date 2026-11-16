// The Devices tab as another plugin's entry of the island's `island.tab` slot: its manifest, and its rows from `devices.read`.
import { settle, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mock } from "bun:test";
import { deviceGroups, deviceRows, devicesSummary, orderDevices, seenAgo, type DeviceView } from "../client/model";
import { DevicesList, DevicesTab, type DevicesSource } from "../client/DevicesTab";
import manifest from "../moss.json" with { type: "json" };
import { DevicesTabEntry } from "../client/entries";
import * as client from "../client";

afterEach(cleanup);

const DEVICE = { id: "d1", name: "Studio", kind: "computer", runsCore: true, online: true, isThis: true, isMain: true, addedAt: 1 };

describe("the Devices plugin", () => {
  test("is a plugin of its own that fills the island's tab slot and holds devices.read; the island holds neither", () => {
    // shell.control: its "open in Settings" (useOpen) brings the main window up, which is that capability's (F2), never its id's.
    expect(manifest.capabilities).toEqual(["devices.read", "shell.control"]);
    expect(manifest.contributes.ui).toEqual([{ spot: "island.tab", id: "devices", component: "DevicesTabEntry", title: "Devices", order: 900, attention: "never" }]);
    expect(typeof (client as Record<string, unknown>).DevicesTabEntry).toBe("function");
  });

  test("draws the devices it reads, and nothing without devices.read", async () => {
    const withApi = runtimeWith({ api: () => ({ devices: { list: async () => [DEVICE], watch: () => () => {} } }) as never, t: (_id, key) => key });
    const view = render(<TestLayer runtime={withApi}><DevicesTabEntry props={{ expanded: true }} /></TestLayer>);
    await act(() => settle());
    expect(view.container.textContent ?? "").toContain("Studio");
    cleanup();
    const without = runtimeWith({ api: () => ({}) as never, t: (_id, key) => key });
    const empty = render(<TestLayer runtime={without}><DevicesTabEntry props={{ expanded: true }} /></TestLayer>);
    await act(() => settle());
    expect(empty.container.innerHTML).toBe("");
  });
});

// The tab's model and rows (they were the island's; F2b moved them here).
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

  test("a row and Manage devices open Settings → Devices (R3: the tab is status, the page manages)", () => {
    const opened: (string | undefined)[] = [];
    const { container } = render(<DevicesList devices={DEVICES} now={NOW} onOpenDevices={(d) => opened.push(d)} />);
    fireEvent.click(screen.getByText("Box").closest(".clv-row")!);
    fireEvent.click(screen.getByText("Manage devices"));
    expect(opened).toEqual(["box", undefined]);
    // Pinned above the list, never scrolled away with it.
    const manage = screen.getByText("Manage devices").closest(".clv-devices-manage")!;
    expect(manage.closest(".clv-tab-scroll")).toBeNull();
    expect(manage.nextElementSibling?.classList.contains("clv-tab-scroll")).toBe(true);
    // Without the route, no link to follow.
    container.remove();
    render(<DevicesList devices={DEVICES} now={NOW} />);
    expect(screen.queryByText("Manage devices")).toBeNull();
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

