// The island's Devices tab (spec §8): an `island.tab` entry of the island's own. The computers, then the phones and
// browsers, one quiet row each, this device first and then the main computer; a dot for a device online, a hollow
// ring for one away; how each link reaches its peer, and the round trip under the pointer. Reads `devices.read` (`DevicesApi.list` and `watch`).
// An at-a-glance status (ruling R3): pairing, revoking and choosing the main computer are Settings → Devices, lane F's
// page, which a row and "Manage devices" open.

import { Fragment, useEffect, useState, type ReactElement } from "react";
import { deviceGroups, type DeviceView } from "../model/devices";
import { t } from "../strings";
import { EmptyTab, TabScroll } from "./OpenIsland";
import { GroupTitle, LiftRow, LinkWords, RowWords, StatusWord, type StatusMark } from "./rows";

/** `devices.read`, as lane B's plugin API gives it. */
export interface DevicesSource {
  list(): Promise<DeviceView[]>;
  watch(listener: (device: DeviceView) => void): () => void;
}

const ONLINE = "var(--clover-island-success, #4CC38A)";
const AWAY = "var(--clover-island-muted, #8B8B8B)";

export interface DevicesListProps {
  devices: readonly DeviceView[];
  now: number;
  /** The gallery's: a row shown as under the pointer. */
  hovered?: string;
  /** Opens Settings → Devices, at this device when one is named. */
  onOpenDevices?: (device?: string) => void;
}

export function DevicesList({ devices, now, hovered: hoveredId, onOpenDevices }: DevicesListProps): ReactElement {
  const [hovered, setHovered] = useState<string | null>(hoveredId ?? null);
  if (devices.length === 0) return <EmptyTab line={t("clover.devices.none")} />;
  return (
    <TabScroll>
      <div className="clv-rows">
        {deviceGroups(devices, now).map((group) => (
          <Fragment key={group.id}>
            <GroupTitle title={group.title} meta={group.meta} />
            {group.rows.map((row) => {
              const mark: StatusMark = row.state === "online" ? { kind: "dot", color: ONLINE } : { kind: "ring", color: AWAY };
              return (
                <LiftRow
                  key={row.id}
                  title={row.title}
                  side={row.side}
                  mark={mark}
                  quiet={row.quiet}
                  hovered={hovered === row.id}
                  onHover={(on) => setHovered(on ? row.id : null)}
                  onClick={onOpenDevices ? () => onOpenDevices(row.id) : undefined}
                  trailing={<StatusWord mark={mark} word={row.status} />}
                  below={hovered === row.id && row.detail ? <RowWords text={row.detail} /> : null}
                />
              );
            })}
          </Fragment>
        ))}
        {onOpenDevices ? (
          <span className="clv-devices-manage">
            <LinkWords text={t("clover.devices.manage")} onClick={() => onOpenDevices()} />
          </span>
        ) : null}
      </div>
    </TabScroll>
  );
}

/** The tab itself: the list, kept current from `devices.watch`. */
export function DevicesTab({ source, now = () => Date.now(), onOpenDevices }: { source: DevicesSource; now?: () => number; onOpenDevices?: (device?: string) => void }): ReactElement {
  const [devices, setDevices] = useState<readonly DeviceView[]>([]);
  useEffect(() => {
    let alive = true;
    void source.list().then((list) => alive && setDevices(list));
    const stop = source.watch((device) =>
      setDevices((current) => {
        const i = current.findIndex((d) => d.id === device.id);
        if (i < 0) return [...current, device];
        const next = [...current];
        next[i] = device;
        return next;
      }),
    );
    return () => {
      alive = false;
      stop();
    };
  }, [source]);
  return <DevicesList devices={devices} now={now()} onOpenDevices={onOpenDevices} />;
}
