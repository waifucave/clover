// What the usage entries read from the app until lane E's runtime gives them `usePluginApi().usage`: one context, so
// the gallery and the tests hand the in-memory fake (`memoryUsage`) and E-M1 hands the plugin API's.

import { createContext, useContext, type ReactElement } from "react";
import type { UsageApi } from "../model/usage";
import { UsageTab } from "./UsageTab";
import { UsageView } from "./UsageView";
import { setLanguage, setTranslator, type Translator } from "../strings";

export interface UsageHost {
  /** `usage.read` (lane B's `UsageApi`). */
  usage: UsageApi;
  now?: () => number;
  /** Opens the Usage section of Settings (the shell's route; a question for lane E). */
  openDetails?: () => void;
  /** The app's translator for this plugin's keys (lane E's `useT()`): the words in the user's language, English for a
   *  key it lacks. Absent, English. */
  t?: Translator;
  /** The user's language (a BCP 47 tag), for numbers and dates. Absent, English. */
  lang?: string;
}

/** The host, with its translator installed for the usage plugin's words. */
function useUsageHost(): UsageHost | null {
  const host = useContext(UsageHostContext);
  setTranslator(host?.t ?? null);
  setLanguage(host?.lang);
  return host;
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
  const host = useUsageHost();
  if (!host) return null;
  return <UsageTab api={host.usage} now={host.now} onOpenDetails={host.openDetails} />;
}

/** The `settings.section` entry: Usage. */
export function UsageSection(_: UsageEntryProps<Record<string, never>>): ReactElement | null {
  const host = useUsageHost();
  if (!host) return null;
  return <UsageView api={host.usage} now={host.now} />;
}
