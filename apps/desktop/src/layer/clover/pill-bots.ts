// The pill's bots (`bots.read` through the pill's own plugin API): read once per API object, and kept current from
// `bot_changed` events instead of asked for again. The effect is keyed on `api.bots`, which `usePluginApi()` keeps
// stable. A key that changes on every render, such as a freshly bound `list`, re-runs the effect after each `setBots`,
// and that loops `bot.list` against the daemon without a pause.
import { useEffect, useState } from "react";
import type { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

export interface PillBotRow {
  id: string;
  name: string;
}

const row = (b: { id: unknown; name?: unknown }): PillBotRow => ({ id: String(b.id), name: String(b.name ?? b.id) });

export function usePillBots(api: ReturnType<typeof usePluginApi>): readonly PillBotRow[] {
  const bots = api.bots;
  const [rows, setRows] = useState<readonly PillBotRow[]>([]);
  useEffect(() => {
    if (bots === undefined) return;
    let live = true;
    void bots.list().then((r) => {
      if (live) setRows((r as readonly { id: unknown; name?: unknown }[]).map(row));
    }).catch(() => undefined);
    const stop = bots.watch?.((b) => {
      const next = row(b as { id: unknown; name?: unknown });
      setRows((list) => (list.some((x) => x.id === next.id) ? list.map((x) => (x.id === next.id ? next : x)) : [...list, next]));
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [bots]);
  return rows;
}
