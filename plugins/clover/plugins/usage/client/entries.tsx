// The usage entries in the app: no host is handed to them there, so theirs is built from the layer's own hooks (the core's
// `usage.*` methods and the app's translator). This file imports `./sdk`, which the layer's build binds to the app's runtime;
// a hook imported from anywhere else would be the stand-in's, with no runtime around it.
import { useMemo, type ReactElement } from "react";
import { UsageTab } from "../src/ui/UsageTab";
import { UsageView } from "../src/ui/UsageView";
import { coreUsageApi, useUsageHost, type UsageEntryProps, type UsageHost } from "../src/ui/host";
import type { Translator } from "../src/strings";
import { useCore, useT } from "./sdk";

function useAppHost(): UsageHost | null {
  const core = useCore();
  const t = useT();
  return useMemo(() => (core === undefined ? null : { usage: coreUsageApi(core), t: t as unknown as Translator }), [core, t]);
}

/** The `island.tab` entry: Usage. */
export function UsageTabEntry(_: UsageEntryProps<{ expanded: boolean }>): ReactElement | null {
  const host = useUsageHost(useAppHost());
  if (!host) return null;
  return <UsageTab api={host.usage} now={host.now} onOpenDetails={host.openDetails} />;
}

/** The `settings.section` entry: Usage. */
export function UsageSection(_: UsageEntryProps<Record<string, never>>): ReactElement | null {
  const host = useUsageHost(useAppHost());
  if (!host) return null;
  return <UsageView api={host.usage} now={host.now} />;
}
