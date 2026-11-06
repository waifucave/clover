// The island's Devices tab (spec §8): every paired device, which one is this, which one is the main computer, and how
// each link reaches its peer. The data is `devices.read`'s `DeviceView`, mirrored here from lane B's protocol
// (`packages/protocol/src/devices.ts` on `lane/b-m0`) until #157 merges and the parts import it. Pure.

import { t } from "../strings";

export type DeviceKind = "desktop" | "server" | "cloud" | "phone" | "browser";
export type LinkPath = "lan" | "direct" | "relay";

export interface LinkView {
  peer: string;
  up: boolean;
  path?: LinkPath;
  /** The relay plugin carrying it, when `path` is `relay`. */
  relay?: string;
  rttMs?: number;
  since?: number;
}

export interface DeviceView {
  id: string;
  name: string;
  kind: DeviceKind;
  os?: "macos" | "windows" | "linux" | "ios" | "android" | "other";
  /** Runs clover-core: a computer in the folder tree, which can take over as the main. */
  runsCore: boolean;
  computer?: string;
  hasDisplay?: boolean;
  online: boolean;
  link?: LinkView;
  isThis: boolean;
  isMain: boolean;
  addedAt: number;
  lastSeenAt?: number;
}

export interface DeviceRow {
  id: string;
  title: string;
  /** Muted words after the name: what it is, and whether it is this device or the main computer. */
  side: string;
  state: "online" | "offline";
  /** How this device reaches it, or when it was last seen. */
  status: string;
  /** Under the title, under the pointer: its round trip, or the relay it last came through. */
  detail: string | null;
  /** An offline device is quieter. */
  quiet: boolean;
}

export interface DeviceGroup {
  id: "computers" | "others";
  title: string;
  /** "2 of 3 online". */
  meta: string;
  rows: DeviceRow[];
}

/** The order the tab lists them in: this device, the main, the other computers online, phones and browsers online,
 *  then whatever is offline, most recently seen first. Ties go by name. */
export function orderDevices(devices: readonly DeviceView[]): DeviceView[] {
  const rank = (d: DeviceView) => (d.isThis ? 0 : d.isMain ? 1 : !d.online ? 4 : d.runsCore ? 2 : 3);
  return [...devices].sort((a, b) => rank(a) - rank(b) || (!a.online && !b.online ? (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) : 0) || a.name.localeCompare(b.name));
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date. */
export function seenAgo(at: number | undefined, now: number): string {
  if (at === undefined) return t("clover.devices.neverSeen");
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t("clover.devices.seenNow");
  if (minutes < 60) return t("clover.devices.seenMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("clover.devices.seenHours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t("clover.devices.seenYesterday");
  if (days < 7) return t("clover.devices.seenDays", { count: days });
  return t("clover.devices.seenOn", { date: new Date(at).toISOString().slice(0, 10) });
}

function kindWords(d: DeviceView): string {
  return t(`clover.devices.kind.${d.kind}`);
}

function linkWords(link: LinkView | undefined): string {
  if (!link || !link.up) return t("clover.devices.notLinked");
  if (link.path === "relay") return link.relay ? t("clover.devices.viaRelayNamed", { relay: link.relay }) : t("clover.devices.viaRelay");
  if (link.path === "lan") return t("clover.devices.sameNetwork");
  return t("clover.devices.direct");
}

/** This device is online by definition: it is drawing the tab. */
function isOnline(d: DeviceView): boolean {
  return d.online || d.isThis;
}

export function deviceRow(d: DeviceView, now: number): DeviceRow {
  const online = isOnline(d);
  const side = [kindWords(d), d.isThis ? t("clover.devices.thisDevice") : null, d.isMain ? t("clover.devices.main") : null].filter(Boolean).join(" · ");
  const status = d.isThis ? t("clover.devices.running") : online ? linkWords(d.link) : seenAgo(d.lastSeenAt, now);
  let detail: string | null = null;
  if (!d.isThis && online && d.link?.up && d.link.rttMs !== undefined) detail = t("clover.devices.roundTrip", { ms: Math.round(d.link.rttMs) });
  if (!online && d.link?.relay) detail = t("clover.devices.lastViaRelay", { relay: d.link.relay });
  return { id: d.id, title: d.name, side, state: online ? "online" : "offline", status, detail, quiet: !online };
}

export function deviceRows(devices: readonly DeviceView[], now: number): DeviceRow[] {
  return orderDevices(devices).map((d) => deviceRow(d, now));
}

/** The tab's two groups: the computers (they run clover-core), then the phones and browsers. An empty group is left
 *  out. */
export function deviceGroups(devices: readonly DeviceView[], now: number): DeviceGroup[] {
  const groups: DeviceGroup[] = [];
  for (const id of ["computers", "others"] as const) {
    const members = devices.filter((d) => (id === "computers") === d.runsCore);
    if (members.length === 0) continue;
    groups.push({
      id,
      title: t(`clover.devices.${id}`),
      meta: t("clover.devices.groupMeta", { online: members.filter(isOnline).length, count: members.length }),
      rows: deviceRows(members, now),
    });
  }
  return groups;
}

/** The whole list's line: how many are online, of how many. */
export function devicesSummary(devices: readonly DeviceView[]): string {
  return t("clover.devices.summary", { online: devices.filter(isOnline).length, count: devices.length });
}
