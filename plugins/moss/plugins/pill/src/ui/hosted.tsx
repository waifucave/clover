// The Dispatch pill, hosted: what the manifest's `app.surface` entry names. Its bots come through its own plugin API (`bots.read`), its
// words through the SDK's user-send (`useUserSend`, under the `user.send` capability), its window through `useSurface`.
import { useMemo, type ReactElement } from "react";
import { useSpotEntries, useSurface, useSurfaceEnvironment, usePluginApi, useT, useUserSend, type EntryProps } from "@waifucave/moss-plugin-sdk/ui";
import { PillApp as PillView, PillHostContext, type PillHost } from "./host";
import { useCoalesced, type SurfaceHostApi } from "../surface/window";
import { displayText } from "@waifucave/moss-plugin-sdk/plain";
import { usePillBots } from "./pill-bots";

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
    () => listed.flatMap((e) => { const title = fieldText(e.fields.title); return title === undefined ? [] : [{ ref: e.ref, pluginId: e.pluginId, pluginName: e.pluginName, id: e.id, title }]; }),
    [listed],
  );
  const host: PillHost = {
    bots,
    ...(targets.length > 0 ? { targets } : {}),
    send: (to, text) => (send !== undefined ? send(to, text) : Promise.resolve()),
    ...(environment !== undefined ? { environment, window } : {}),
    t,
  };
  return <PillHostContext.Provider value={host}><PillView props={props as never} tokens={tokens} /></PillHostContext.Provider>;
}

/** A spot entry's title as the manifest wrote it (a string, or words by language), cleaned to one plain line by the SDK's own
 *  cleaner; undefined when it is neither. (The pill reads nothing of another plugin: this is its own copy of the shell's.) */
function fieldText(v: unknown, lang = "en"): string | undefined {
  if (typeof v === "string") return displayText(v, 80);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  if (typeof t.en !== "string") return undefined;
  return displayText([t[lang], t[lang.split("-")[0]!], t.en].find((x): x is string => typeof x === "string"), 80);
}
