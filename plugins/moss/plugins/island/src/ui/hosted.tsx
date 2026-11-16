// The island, hosted: what the manifest's `app.surface` entry names. It reads its host (the display, the pending cards, the tabs, the
// lines) from the SDK's own hooks, with the capabilities its manifest holds, so a copy of this plugin installed from a folder under
// another id draws and acts the same. (Before this lived in the app's own layer, beside the app's wiring.)
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Card as SdkCard, CardApprove, CardDeny, CardField, CardReadiness, Spot, useApprovals, useMountContext, usePluginApi, useSurface, useSpotEntries, useSurfaceEnvironment, useT, type EntryProps } from "@waifucave/moss-plugin-sdk/ui";
import { IslandApp as IslandView, IslandHostContext } from "./host";
import type { IslandHost } from "./host";
import type { IslandTabEntry } from "./Island";
import type { LineSource } from "./Lines";
import { SealedKitContext, type SealedCardKit } from "./sealed";
import type { SurfaceHostApi } from "./IslandSurface";
import { useCoalesced } from "./use-coalesced";
import { islandCards } from "../model/strip-cards";

/* The island's host -----------------------------------------------------------------------------------------------
 * `environment` is the surface host's (the OS, the display server and the display's own bounds and housing); until the
 * surface's window reports it, the island draws nothing (a surface is grown only by what it knows). `window` carries
 * what the island asks of the window through the core's surface broker: the spec's own fields are the request's, and
 * regions ride the same call. `cards` are the pending cards' metas (`useApprovals()`, fed by the daemon's
 * `card_pending` on this layer's connection), mapped by `./cards` onto what the island draws. The tab entries
 * (`island.tab`) are placed by the part that declares the spot; the island's own Devices tab carries its devices'
 * list and watch off the plugin API. */

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
      // A bot starting or stopping work is when a plugin's line is likely to change (the island holds `bots.read`).
      ...(api.bots?.watch !== undefined ? { watchWork: (listener: () => void) => api.bots!.watch(() => listener()) } : {}),
    };
  }, [api]);
  const [bots, setBots] = useState<readonly { id: string; name: string }[]>([]);
  useEffect(() => {
    const list = api.bots?.list;
    if (list === undefined) return;
    let live = true;
    void list().then((all) => { if (live) setBots(all.map((b) => ({ id: b.id, name: typeof b.name === "string" ? b.name : b.name.en }))); }, () => undefined);
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
      <IslandHostContext.Provider value={host}><IslandView props={props as never} tokens={tokens} /></IslandHostContext.Provider>
    </SealedKitContext.Provider>
  );
}
