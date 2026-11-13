// What the usage entries read from the app until lane E's runtime gives them `usePluginApi().usage`: one context, so
// the gallery and the tests hand the in-memory fake (`memoryUsage`) and E-M1 hands the plugin API's.

import { createContext, useContext, useMemo, type ReactElement } from "react";
import { useCore, useT } from "../../client/sdk";
import type { CoreClient } from "../../../shell/runtime/types";
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

/** The usage API over the core's own `usage.*` methods (the app's layer for the `clover` tree may call them: `usage.read`).
 *  Nothing emits `usage_changed` yet, so `watch` hears nothing and a view reads again when it mounts. */
export function coreUsageApi(core: Pick<CoreClient, "call">): UsageApi {
  const call = core.call as unknown as (method: string, params?: unknown) => Promise<any>;
  return {
    rows: (query) => call("usage.rows", query),
    plans: async () => (await call("usage.plans", {})).readings,
    summary: async (query) => (await call("usage.summary", query)).groups,
    watch: () => () => undefined,
  };
}

/** The host, with its translator installed for the usage plugin's words: the one a test or the gallery gives, else the app's
 *  own (the core's `usage.*` methods and the app's translator). */
function useUsageHost(): UsageHost | null {
  const given = useContext(UsageHostContext);
  const core = useCore();
  const t = useT();
  const own = useMemo<UsageHost | null>(() => (core === undefined ? null : { usage: coreUsageApi(core), t: t as unknown as Translator }), [core, t]);
  const host = given ?? own;
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
