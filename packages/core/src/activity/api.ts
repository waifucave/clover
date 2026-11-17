// The plugin API's `activity.list` and `activity.watch` (spec revision 19, §3.6, G4) over the engine's feed. The router has
// gated each by the kind the call names (`activity.read.<kind>`); the feed checks it again against the plugin's own grants.
import type { DataKind } from "@waifucave/moss-protocol";
import type { ActivityView } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import type { FeedReader } from "../contracts/activity-feed";
import { listenerArg, type ApiCallContext, type ApiHandlers } from "../plugin-host/api/router";
import type { EngineActivityFeed } from "./feed";

const readerOf = (ctx: ApiCallContext): FeedReader => ({ kind: "plugin", capabilities: ctx.record.granted });

export function activityApi(feed: EngineActivityFeed): ApiHandlers {
  return {
    "activity.list": (ctx, args) => feed.list(args[0] as DataKind, readerOf(ctx)),
    "activity.watch": (ctx, args) => feed.watch(args[0] as DataKind, readerOf(ctx), listenerArg<ActivityView>(args, 1)),
  };
}

/** `activity.list` on a MOSS connection: the app's, the CLI's, a layer's, a remote client's. A plugin's call was gated by
 *  the kind it names before it got here (`capabilityRefusal`), so the list is the feed of that kind. */
export function activityMossHandlers(feed: EngineActivityFeed): Record<string, (params: unknown) => unknown> {
  return {
    "activity.list": (params) => {
      const kind = (params as { kind?: unknown } | undefined)?.kind;
      if (kind !== "sessions" && kind !== "bots") throw new ContractError("invalid", "activity.list takes a kind");
      return { activity: feed.list(kind, { kind: "user" }) };
    },
  };
}
