// The Dispatch pill, hosted: what the manifest's `app.surface` entry names. Its bots come through its own plugin API (`bots.read`), its
// words through the SDK's user-send (`useUserSend`, under the `user.send` capability), its window through `useSurface`.
import { useMemo, type ReactElement } from "react";
import { useSpotEntries, useSurface, useSurfaceEnvironment, usePluginApi, useT, useUserSend, type EntryProps } from "@waifucave/clover-plugin-sdk/ui";
import { PillApp as PillView, PillHostContext, type PillHost } from "./host";
import { useCoalesced, type SurfaceHostApi } from "@waifucave/clover-plugin-island";
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
  return <PillHostContext.Provider value={host}><PillView props={props as never} tokens={tokens} /></PillHostContext.Provider>;
}
