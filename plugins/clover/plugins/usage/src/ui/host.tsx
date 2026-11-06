// What the usage entries read from the app until lane E's runtime gives them `usePluginApi().usage`: one context, so
// the gallery and the tests hand the in-memory fake (`memoryUsage`) and E-M1 hands the plugin API's.

import { createContext, useContext, type ReactElement } from "react";
import type { UsageApi } from "../model/usage";
import { UsageTab } from "./UsageTab";
import { UsageView } from "./UsageView";

export interface UsageHost {
  /** `usage.read` (lane B's `UsageApi`). */
  usage: UsageApi;
  now?: () => number;
  /** Opens the Usage section of Settings (the shell's route; a question for lane E). */
  openDetails?: () => void;
}

export const UsageHostContext = createContext<UsageHost | null>(null);

/** What lane B's `EntryProps` hands every entry. */
export interface UsageEntryProps<P> {
  props: P;
  tokens?: Readonly<Record<string, unknown>>;
  entry?: { pluginId: string; id: string; spot: string; key?: string };
}

/** The `island.tab` entry: Usage. */
export function UsageTabEntry(_: UsageEntryProps<{ expanded: boolean }>): ReactElement | null {
  const host = useContext(UsageHostContext);
  if (!host) return null;
  return <UsageTab api={host.usage} now={host.now} onOpenDetails={host.openDetails} />;
}

/** The `settings.section` entry: Usage. */
export function UsageSection(_: UsageEntryProps<Record<string, never>>): ReactElement | null {
  const host = useContext(UsageHostContext);
  if (!host) return null;
  return <UsageView api={host.usage} now={host.now} />;
}
