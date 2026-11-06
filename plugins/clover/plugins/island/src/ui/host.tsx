// What the island's entries read from the app, until lane E's runtime gives them `usePluginApi()`, `useApprovals()`,
// `<Spot>` and the surface host. One context, so the gallery and the tests hand a stand-in and E-M1 hands the real
// thing, and the components the manifest names (`IslandApp`, `DevicesTabEntry`) take only their `EntryProps`.
//
// Each field says what it stands for in lane B's contracts (`packages/plugin-sdk/src/api/*.ts` on `lane/b-m0`).

import { createContext, useContext, useMemo, type ReactElement } from "react";
import type { IslandCard, QuestionCard } from "../model/cards";
import type { SurfaceEnvironment } from "../model/placement";
import { DevicesTab, type DevicesSource } from "./DevicesTab";
import type { IslandTabEntry } from "./Island";
import { IslandSurface, type SurfaceHostApi } from "./IslandSurface";

export interface IslandHost {
  /** The display the island hangs on, and the OS and session: the surface host's (lane E, and its add-on for the
   *  camera housing). */
  environment: SurfaceEnvironment;
  /** Opens and moves the island's window, and passes clicks outside its regions through (lane E). */
  window?: SurfaceHostApi;
  /** Every pending card, oldest first: `useApprovals()` for the sealed ones (ids, computers, options), and the
   *  questions, whose text is the island's to show (§5.5; the source of question cards is a question for B). */
  cards: readonly IslandCard[];
  /** How many bots are working: `bots.watch`'s states. */
  working?: number;
  /** The `island.tab` entries after Needs you, in their order: `<Spot name="island.tab">`, one entry at a time. */
  tabs?: readonly IslandTabEntry[];
  /** `bots.read`: the bots, so another plugin named as one gets no tab. */
  bots?: readonly { id: string; name: string }[];
  /** `devices.read` (`DevicesApi.list` and `watch`). */
  devices?: DevicesSource;
  /** Opens Settings → Devices (lane F's page, ruling R3), at a device when one is named: lane E's route. */
  openDevices?: (device?: string) => void;
  onAnswerQuestion?: (card: QuestionCard, answers: Record<string, string>) => Promise<boolean> | boolean | void;
  reducedMotion?: boolean;
}

export const IslandHostContext = createContext<IslandHost | null>(null);

export function useIslandHost(): IslandHost | null {
  return useContext(IslandHostContext);
}

/** What lane B's `EntryProps` hands every entry: its spot's props, the part's tokens, and which entry it is. */
export interface IslandEntryProps<P> {
  props: P;
  tokens?: Readonly<Record<string, unknown>>;
  entry?: { pluginId: string; id: string; spot: string; key?: string };
}

/** The `app.surface` entry: the island, placed for this display and OS. */
export function IslandApp(_: IslandEntryProps<{ surface: string }>): ReactElement | null {
  const host = useIslandHost();
  const bots = host?.bots;
  const botNames = useMemo(() => bots?.flatMap((b) => [b.name, b.id]), [bots]);
  if (!host) return null;
  return (
    <IslandSurface
      environment={host.environment}
      cards={host.cards}
      working={host.working}
      tabs={host.tabs}
      botNames={botNames}
      host={host.window}
      onAnswerQuestion={host.onAnswerQuestion}
      reducedMotion={host.reducedMotion}
    />
  );
}

/** The island's own `island.tab` entry: Devices. */
export function DevicesTabEntry(_: IslandEntryProps<{ expanded: boolean }>): ReactElement | null {
  const host = useIslandHost();
  if (!host?.devices) return null;
  return <DevicesTab source={host.devices} onOpenDevices={host.openDevices} />;
}
