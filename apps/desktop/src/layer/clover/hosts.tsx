// The `clover` tree's surfaces' hosts (`app.surface` entries), from the app's runtime: lane G's island and pill read
// their host context (`IslandHostContext`, `PillHostContext`), so a wrapper here sits between each component the
// manifest names and the app's own hooks (`useSurfaceEnvironment`, `useSurface`, `usePluginApi`, `useUserSend`,
// `useT`), instead of a gallery's stand-in. The usage child's host still has no runtime API (`usage.*`'s client half
// is lane B's plugin API, not built here): nothing provides it, its entries draw nothing.
// The avatars (the VRM child, the 2D-model child) have no host context; their entries get a wrapper whose only job is
// to install the plugin's own translator with the app's `useT()` (lane G's ask, G-M3's `setTranslator`), so their
// words come in the user's language with English beneath.
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useApprovals, useMountContext, usePluginApi, useSurface, useSurfaceEnvironment, useT, useUserSend, type EntryProps } from "@waifucave/clover-plugin-sdk/ui";
import { IslandApp, IslandHostContext, type IslandHost, type SurfaceHostApi } from "@clover-child/island";
import { islandCards } from "./cards";
import { PillApp, PillHostContext, type PillHost } from "@clover-child/pill";
import { VrmAvatar, setTranslator as setVrmTranslator } from "@clover-child/vrm";
import { Live2dAvatarEntry, setTranslator as setLive2dTranslator } from "@clover-child/live2d";
import type { Rect } from "@waifucave/clover-plugin-sdk/ui/bridge";

/* The island's host -----------------------------------------------------------------------------------------------
 * `environment` is the surface host's (the OS, the display server and the display's own bounds and housing); until the
 * surface's window reports it, the island draws nothing (a surface is grown only by what it knows). `window` carries
 * what the island asks of the window through the core's surface broker: the spec's own fields are the request's, and
 * regions ride the same call. `cards` are the pending cards' metas (`useApprovals()`, fed by the daemon's
 * `card_pending` on this layer's connection), mapped by `./cards` onto what the island draws. The tab entries
 * (`island.tab`) are placed by the part that declares the spot; the island's own Devices tab carries its devices'
 * list and watch off the plugin API. */

function environNow(os: string | undefined): IslandHost["environment"] | undefined {
  if (os !== "macos" && os !== "windows" && os !== "linux") return undefined;
  return { os, display: { bounds: { x: 0, y: 0, width: 0, height: 0 }, workArea: { x: 0, y: 0, width: 0, height: 0 }, notch: null } };
}

export function IslandHosted({ props, tokens }: EntryProps<Record<string, unknown>>): ReactElement | null {
  const ctx = useMountContext();
  const t = useT();
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
  const approvals = useApprovals();
  const host: IslandHost | undefined = environment === undefined ? undefined : {
    environment,
    window,
    cards: islandCards(approvals.cards),
    t,
  };
  if (host === undefined) return null;
  return <IslandHostContext.Provider value={host}><IslandApp props={props as never} tokens={tokens} /></IslandHostContext.Provider>;
}

/* The pill's host ---------------------------------------------------------------------------------------------------
 * The pill's bots come through its own plugin API (`bots.read`), its words through the app's user-send (the gate
 * counts them inside the window's own transient activation and refuses otherwise, §5.5: a refusal puts the words back
 * in the field). With an environment the pill manages its window like the island's; without one it draws the simple
 * Dispatch pill. What it shows per target's turn is lane D's sessions through the same `usePluginApi()`; nothing is
 * provided for it in this first cut. */

export function PillHosted({ props, tokens }: EntryProps<Record<string, unknown>>): ReactElement | null {
  const api = usePluginApi();
  const send = useUserSend();
  const t = useT();
  const live = useSurfaceEnvironment();
  const surface = useSurface();
  const [environment, setEnvironment] = useState(() => environNow(live === undefined ? undefined : live.os));
  useEffect(() => {
    if (live !== undefined) setEnvironment(live);
  }, [live]);
  const window: SurfaceHostApi = useMemo(() => ({
    setWindow: (spec) => surface({ visible: spec.visible !== false, bounds: spec.bounds }),
    setInteractiveRegions: (regions) => surface({ regions }),
  }), [surface]);
  const boto = api.bots?.list.bind(api.bots);
  const [bots, setBots] = useState<PillHost["bots"]>([]);
  useEffect(() => {
    if (boto === undefined) return;
    let live = true;
    void boto().then((r) => {
      if (!live) return;
      setBots((r as readonly { id: unknown; name?: unknown }[]).map((b) => ({ id: String(b.id), name: String(b.name ?? b.id) })));
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [boto]);
  const host: PillHost = {
    bots,
    send: (to, text) => (send !== undefined ? send(to, text) : Promise.resolve()),
    ...(environment !== undefined ? { environment, window } : {}),
    t,
  };
  return <PillHostContext.Provider value={host}><PillApp props={props as never} tokens={tokens} /></PillHostContext.Provider>;
}

/* The avatars -------------------------------------------------------------------------------------------------------
 * They have no host context and hear nothing of the app; their words come from each child's own fixed table. The
 * wrapper's single job: install the child's translator with the app's `useT()` before the avatar draws, every render,
 * so a language change reaches the next one (G-M3's `setTranslator`, the same hook lane F's parts get). */

export function VrmAvatarHosted({ props }: { props: unknown; tokens?: Readonly<Record<string, unknown>> }): ReactElement | null {
  const t = useT();
  setVrmTranslator(t);
  return <VrmAvatar {...(props as import("@clover-child/vrm").VrmAvatarProps)} />;
}

export function Live2dAvatarHosted({ props, tokens }: { props: unknown; tokens?: Readonly<Record<string, unknown>> }): ReactElement | null {
  const t = useT();
  setLive2dTranslator(t);
  return <Live2dAvatarEntry props={props as never} tokens={tokens} />;
}

