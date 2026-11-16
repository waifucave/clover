// Other plugins' tabs inside the open island: the usage plugin's Usage and the devices plugin's Devices, drawn in the
// island's own frame. A composite of several plugins' parts, so it is the look gallery's (whole-app, dev-only), never a
// plugin's (F2b: no plugin imports another's folder).
import type { ReactNode } from "react";
import { IslandDesktop, ISLAND_TABS } from "../../../island/src/gallery";
import { NOTCH, NO_NOTCH } from "../../../island/src/fixtures";
import { OpenIsland, Strip, tabState } from "../../../island/client/index";
import { DevicesList, type DeviceView } from "../../../devices/client/index";
import { memoryUsage } from "../../../usage/src/fake";
import { NOW as USAGE_NOW, SAMPLE_PLANS, sampleRows } from "../../../usage/src/fixtures";
import { UsageTab } from "../../../usage/src/ui/UsageTab";

interface TabStory { id: string; title: string; width: number; height: number; render: () => ReactNode; ready?: () => Promise<void> }

const W = 640;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
/** Sample devices for the Devices tab (sample data). */
const SAMPLE_DEVICES: DeviceView[] = [
  { id: "studio", name: "Studio", kind: "desktop", os: "macos", runsCore: true, online: true, isThis: true, isMain: true, addedAt: 0 },
  { id: "laptop", name: "Pocket laptop", kind: "desktop", os: "windows", runsCore: true, online: true, isThis: false, isMain: false, addedAt: 0, link: { peer: "laptop", up: true, path: "lan", rttMs: 3.4 } },
  { id: "box", name: "Box", kind: "server", os: "linux", runsCore: true, online: true, isThis: false, isMain: false, addedAt: 0, link: { peer: "box", up: true, path: "relay", relay: "waifucave relay", rttMs: 48 } },
  { id: "phone", name: "Phone", kind: "phone", os: "ios", runsCore: false, online: false, isThis: false, isMain: false, addedAt: 0, lastSeenAt: NOW - 3 * 3_600_000, link: { peer: "phone", up: false, path: "relay", relay: "waifucave relay" } },
];
const DEVICES_INDEX = ISLAND_TABS.findIndex((tab) => tab.id === "devices");
const USAGE_INDEX = ISLAND_TABS.findIndex((tab) => tab.id === "usage");
const ROWS = sampleRows();
const now = () => USAGE_NOW;
/** The reads are promises: a few frames for them to answer and the view to draw. */
const loaded = () => new Promise<void>((resolve) => setTimeout(resolve, 150));

export const ISLAND_TAB_STORIES: TabStory[] = [
  {
    id: "island/open-devices",
    title: "Open island: Devices, the computers then the phones, one row under the pointer",
    width: W,
    height: 220,
    render: () => (
      <IslandDesktop shape={NOTCH} width={W} height={220}>
        <Strip shape={NOTCH} counts={{ waiting: 0, working: 2 }} />
        <OpenIsland shape={NOTCH} tabs={tabState(ISLAND_TABS, DEVICES_INDEX)}>
          <DevicesList devices={SAMPLE_DEVICES} now={NOW} hovered="laptop" onOpenDevices={() => {}} />
        </OpenIsland>
      </IslandDesktop>
    ),
  },
  {
    id: "island/open-devices-no-housing",
    title: "Open island: Devices on a screen with no housing, an offline phone under the pointer",
    width: W,
    height: 220,
    render: () => (
      <IslandDesktop shape={NO_NOTCH} width={W} height={220}>
        <OpenIsland shape={NO_NOTCH} tabs={tabState(ISLAND_TABS, DEVICES_INDEX)}>
          <DevicesList devices={SAMPLE_DEVICES} now={NOW} hovered="phone" />
        </OpenIsland>
      </IslandDesktop>
    ),
  },
  {
    id: "usage/island-tab",
    title: "Island: Usage, the plans the fullest first, then today by source; one plan under the pointer",
    width: 640,
    height: 220,
    ready: loaded,
    render: () => (
      <IslandDesktop shape={NOTCH} width={640} height={220}>
        <Strip shape={NOTCH} counts={{ waiting: 0, working: 1 }} />
        <OpenIsland shape={NOTCH} tabs={tabState(ISLAND_TABS, USAGE_INDEX)}>
          <UsageTab api={memoryUsage(ROWS, SAMPLE_PLANS)} now={now} hovered="Studio:codex:Pro:5h" />
        </OpenIsland>
      </IslandDesktop>
    ),
  },
  {
    id: "usage/island-tab-no-plans",
    title: "Island: Usage with no plan read yet, on a screen with no housing",
    width: 640,
    height: 220,
    ready: loaded,
    render: () => (
      <IslandDesktop shape={NO_NOTCH} width={640} height={220}>
        <OpenIsland shape={NO_NOTCH} tabs={tabState(ISLAND_TABS, USAGE_INDEX)}>
          <UsageTab api={memoryUsage(ROWS, [])} now={now} />
        </OpenIsland>
      </IslandDesktop>
    ),
  },
  {
    id: "usage/island-tab-empty",
    title: "Island: Usage before anything was used",
    width: 640,
    height: 220,
    ready: loaded,
    render: () => (
      <IslandDesktop shape={NOTCH} width={640} height={220}>
        <OpenIsland shape={NOTCH} tabs={tabState(ISLAND_TABS, USAGE_INDEX)}>
          <UsageTab api={memoryUsage()} now={now} />
        </OpenIsland>
      </IslandDesktop>
    ),
  },
];
