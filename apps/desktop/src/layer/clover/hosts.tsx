// The `clover` tree's surfaces' hosts (`app.surface` entries), from the app's runtime: lane G's island and pill read
// their host context (`IslandHostContext`, `PillHostContext`), so a wrapper here sits between each component the
// manifest names and the app's own hooks (`useSurfaceEnvironment`, `useSurface`, `usePluginApi`, `useUserSend`),
// instead of a gallery's stand-in. The usage child's host has no runtime API yet (`usage.*` runs on the plugin API
// lane B builds): nothing provides it, its entries draw nothing until G-M3 names theirs.
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useMountContext, usePluginApi, useSurface, useSurfaceEnvironment, useUserSend, type EntryProps } from "@waifucave/clover-plugin-sdk/ui";
import { IslandApp, IslandHostContext, type IslandHost, type SurfaceHostApi } from "@clover-child/island";
import { PillApp, PillHostContext, type PillHost } from "@clover-child/pill";
import type { Rect } from "@waifucave/clover-plugin-sdk/ui/bridge";

/* The island's host -----------------------------------------------------------------------------------------------
 * `environment` is the surface host's (the OS, the display server and the display's own bounds and housing); until the
 * surface's window reports it, the island draws nothing (a surface is grown only by what it knows). `window` carries
 * what the island asks of the window through the core's surface broker: the spec's own fields are the request's, and
 * regions ride the same call. `cards` is E-M3's sealed path (`useApprovals()` is a stub there until then), so the
 * strip waits for a card without one. The tab entries (`island.tab`) are placed by the part that declares the spot;
 * the island's own Devices tab carries its devices' list and watch off the plugin API. */

function environNow(os: string | undefined): IslandHost["environment"] | undefined {
  if (os !== "macos" && os !== "windows" && os !== "linux") return undefined;
  return { os, display: { bounds: { x: 0, y: 0, width: 0, height: 0 }, workArea: { x: 0, y: 0, width: 0, height: 0 }, notch: null } };
}

export function IslandHosted({ props, tokens }: EntryProps<Record<string, unknown>>): ReactElement | null {
  const ctx = useMountContext();
  const [environment, setEnvironment] = useState(() => environNow(ctx.os));
  const live = useSurfaceEnvironment();
  useEffect(() => {
    if (live !== undefined) setEnvironment(live);
  }, [live]);
  const surface = useSurface();
  const window: SurfaceHostApi = useMemo(() => ({
    setWindow: (spec) => surface({ visible: spec.visible !== false, bounds: spec.bounds }),
    setInteractiveRegions: (regions) => surface({ regions }),
  }), [surface]);
  const host: IslandHost | undefined = environment === undefined ? undefined : {
    environment,
    window,
    cards: [],
  };
  if (host === undefined) return null;
  return <IslandHostContext.Provider value={host}><IslandApp props={props as never} tokens={tokens} /></IslandHostContext.Provider>;
}

/* The pill's host ---------------------------------------------------------------------------------------------------
 * The pill's bots come through its own plugin API (`bots.read`), its words through the app's user-send (the gate
 * counts them inside the window's own transient activation and refuses otherwise, §5.5: a refusal puts the words back
 * in the field). What it shows per target's turn is lane D's sessions through the same `usePluginApi()`; nothing is
 * provided for it in this first cut. */

export function PillHosted({ props, tokens }: EntryProps<Record<string, unknown>>): ReactElement | null {
  const api = usePluginApi();
  const send = useUserSend();
  const [bots, setBots] = useState<PillHost["bots"]>([]);
  const botGet = api.bots?.list.bind(api.bots);
  useEffect(() => {
    if (botGet === undefined) return;
    let live = true;
    void botGet().then((r) => {
      if (!live) return;
      setBots((r as readonly { id: unknown; name?: unknown }[]).map((b) => ({ id: String(b.id), name: String(b.name ?? b.id) })));
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [botGet]);
  const host: PillHost = {
    bots,
    send: (to, text) => (send !== undefined ? send(to, text) : Promise.resolve()),
  };
  return <PillHostContext.Provider value={host}><PillApp props={props as never} tokens={tokens} /></PillHostContext.Provider>;
}
