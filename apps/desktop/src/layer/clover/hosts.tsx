// The `clover` tree's surfaces' hosts (`app.surface` entries), from the app's runtime: lane G's island and pill read
// their host context (`IslandHostContext`, `PillHostContext`), so a wrapper here sits between each component the
// manifest names and the app's own hooks (`useSurfaceEnvironment`, `useSurface`, `usePluginApi`, `useUserSend`,
// `useT`), instead of a gallery's stand-in. The usage child's host still has no runtime API (`usage.*`'s client half
// is lane B's plugin API, not built here): nothing provides it, its entries draw nothing.
// The avatars (the VRM child, the 2D-model child) have no host context; their entries get a wrapper whose only job is
// to install the plugin's own translator with the app's `useT()` (lane G's ask, G-M3's `setTranslator`), so their
// words come in the user's language with English beneath.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Card as SdkCard, CardApprove, CardDeny, CardField, CardReadiness, Spot, useApprovals, useAvatarControl, useAvatarSpeech, useMountContext, usePluginApi, useSurface, useSpotEntries, useSurfaceEnvironment, useT, useUserSend, type EntryProps } from "@waifucave/clover-plugin-sdk/ui";
import { IslandApp, IslandHostContext, SealedKitContext, type IslandHost, type IslandTabEntry, type LineSource, type SealedCardKit, type SurfaceHostApi } from "@clover-child/island";
import { coalesced } from "./coalesce";
import { islandCards } from "./cards";
import { usePillBots } from "./pill-bots";
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

/** One coalescing host for a surface part, cleared when the part unmounts. */
function useCoalesced(surface: unknown): SurfaceHostApi {
  const host = useMemo(() => coalesced(surface as never), [surface]);
  useEffect(() => () => host.dispose(), [host]);
  return host;
}

/* The sealed kit: the island places a card's frames with the app's own runtime (`<Card>`, `<Card.Field>`, `<Card.Approve>`,
 * `<Card.Deny>` from the SDK's UI API), the same ones every part with the `approvals` capability gets. Each frame is a page
 * of the app's sealed scheme; the island positions it and never reads it. A card whose frames are still arriving reports
 * that it is not whole, and the island holds it back (`holdsUntilWhole`) instead of drawing it empty. */

function WholeCard({ id, tokens, className, onReady, children }: { id: string; tokens?: Readonly<Record<string, string>>; className?: string; onReady?: (ready: boolean) => void; children?: ReactNode }): ReactElement {
  const states = useRef(new Map<string, boolean>());
  const told = useRef(onReady);
  told.current = onReady;
  const last = useRef<boolean | null>(null);
  const settle = useCallback(() => {
    const all = [...states.current.values()];
    const ready = all.length > 0 && all.every(Boolean);
    if (last.current !== ready) {
      last.current = ready;
      told.current?.(ready);
    }
  }, []);
  const readiness = useMemo(() => ({
    report: (key: string, ready: boolean) => {
      states.current.set(key, ready);
      queueMicrotask(settle);
    },
  }), [settle]);
  return (
    <CardReadiness.Provider value={readiness}>
      <SdkCard id={id} tokens={tokens as never} className={className}>{children}</SdkCard>
    </CardReadiness.Provider>
  );
}

const APP_KIT: SealedCardKit = {
  holdsUntilWhole: true,
  Card: (props) => <WholeCard {...props} />,
  Field: ({ name, lines, className }) => (
    <span className={className} data-sealed-slot={name} style={{ display: "block" }}>
      <CardField name={name as never} lines={lines} />
    </span>
  ),
  Approve: ({ option, look, size }) => <CardApprove option={option} look={look} size={size} />,
  Deny: ({ option, look, size }) => <CardDeny option={option} look={look} size={size} />,
};

export function IslandHosted({ props, tokens }: EntryProps<Record<string, unknown>>): ReactElement | null {
  const ctx = useMountContext();
  const t = useT();
  // Only the window's own report: a placeholder display (zero bounds) placed the window at 40x24 and then 214x46 at start.
  const environment = useSurfaceEnvironment();
  const surface = useSurface();
  const window: SurfaceHostApi = useCoalesced(surface);
  const approvals = useApprovals();
  // The `island.tab` entries (Usage, the island's own Devices, a plugin's): each tab draws its one entry by its ref.
  const tabEntries = useSpotEntries("island.tab").entries;
  const tabs = useMemo(() => tabEntries.map((e): IslandTabEntry => ({
    id: e.id,
    title: typeof e.fields["title"] === "string" ? e.fields["title"] : e.id,
    pluginId: e.pluginId,
    pluginName: e.pluginName,
    ...(e.fields["attention"] === "never" || e.fields["attention"] === "badge" || e.fields["attention"] === "expand" ? { attention: e.fields["attention"] } : {}),
    render: () => <Spot name="island.tab" only={e.ref} />,
  })), [tabEntries]);
  // The plugins' lines (`island.line`, the island's own point): its entries and a call of an entry's handler, off the plugin
  // API the island's frame holds; the island asks only while its Needs you tab is open, and decides everything it draws.
  const api = usePluginApi();
  const lines = useMemo((): LineSource | undefined => {
    const points = api.points;
    if (points === undefined) return undefined;
    return {
      entries: async () => (await points.entries("island.line")).map((e) => ({ pluginId: e.pluginId, entryId: e.entryId })),
      call: (entry) => points.call("island.line", entry, "handler", undefined, { timeoutMs: 2000 }),
      watch: (listener) => points.watch("island.line", () => listener()),
    };
  }, [api]);
  const [bots, setBots] = useState<readonly { id: string; name: string }[]>([]);
  useEffect(() => {
    const list = api.bots?.list;
    if (list === undefined) return;
    let live = true;
    void list().then((all) => { if (live) setBots(all.map((b) => ({ id: b.id, name: b.name }))); }, () => undefined);
    return () => { live = false; };
  }, [api]);
  const host: IslandHost | undefined = environment === undefined ? undefined : {
    environment,
    window,
    cards: islandCards(approvals.cards),
    tabs,
    ...(lines !== undefined ? { lines } : {}),
    botName: (id) => bots.find((b) => b.id === id)?.name,
    t,
  };
  if (host === undefined) return null;
  return (
    <SealedKitContext.Provider value={APP_KIT}>
      <IslandHostContext.Provider value={host}><IslandApp props={props as never} tokens={tokens} /></IslandHostContext.Provider>
    </SealedKitContext.Provider>
  );
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
  const environment = live;
  const window: SurfaceHostApi = useCoalesced(surface);
  // Once per API object, then from `bot_changed` (a list bound afresh each render looped `bot.list`: ./pill-bots).
  const bots: PillHost["bots"] = usePillBots(api);
  // The plugins' `pill.target` entries (title and handler data; the daemon runs the handler when the pill sends to one).
  const listed = useSpotEntries("pill.target").entries;
  const targets = useMemo<NonNullable<PillHost["targets"]>>(
    () => listed.filter((e) => typeof e.fields.title === "string").map((e) => ({ ref: e.ref, pluginId: e.pluginId, pluginName: e.pluginName, id: e.id, title: e.fields.title as string })),
    [listed],
  );
  const host: PillHost = {
    bots,
    ...(targets.length > 0 ? { targets } : {}),
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
  // The speech the stage plays (the character stage's provider): the mouth follows it.
  const { feed } = useAvatarSpeech();
  const control = useAvatarControl();
  const p = props as import("@clover-child/vrm").VrmAvatarProps;
  return <VrmAvatar {...p} speech={p.speech ?? feed ?? null} control={control} />;
}

export function Live2dAvatarHosted({ props, tokens }: { props: unknown; tokens?: Readonly<Record<string, unknown>> }): ReactElement | null {
  const t = useT();
  setLive2dTranslator(t);
  const { feed, speaking } = useAvatarSpeech();
  const control = useAvatarControl();
  const p = props as { speech?: unknown; speaking?: boolean };
  return <Live2dAvatarEntry props={{ ...p, speech: p.speech ?? feed, speaking: p.speaking ?? speaking, control } as never} tokens={tokens} />;
}

