// The `streams` area of the plugin API (spec §5.4 "Streams"), served to both halves of a plugin: `open` and `accept` (the
// two ends' watches) and `write`, `end`, `cancel` and `ack` over the daemon's one hub (`./hub.ts`). No capability: a
// stream connects only one plugin's own two halves, so the caller's own plugin is all it names. The SDK makes the Web
// streams a plugin sees from these (`@waifucave/moss-plugin-sdk/streams`).
import { ContractError } from "../contracts/common";
import { listenerArg, stringArg, type ApiCallContext, type ApiHandlers } from "../plugin-host/api/router";
import type { StreamEvent, StreamHub } from "./hub";

export interface StreamsApiOptions {
  hub: StreamHub;
}

const who = (ctx: ApiCallContext) => ({ pluginId: ctx.pluginId, side: ctx.process });

export function streamsApi(o: StreamsApiOptions): ApiHandlers {
  return {
    "streams.accept": (ctx, args) => o.hub.accept(who(ctx), stringArg(args, 0, "a stream's name", 128), listenerArg<StreamEvent>(args, 1)),
    "streams.open": (ctx, args) => {
      const name = stringArg(args, 0, "a stream's name", 128);
      const opts = args[1];
      if (opts !== undefined && opts !== null && (typeof opts !== "object" || Array.isArray(opts))) throw new ContractError("invalid", "a stream's options are an object: { meta? }");
      return o.hub.open(who(ctx), name, (opts as { meta?: unknown } | null | undefined)?.meta, listenerArg<StreamEvent>(args, 2));
    },
    "streams.write": (ctx, args) => o.hub.write(stringArg(args, 0, "a stream's id", 128), who(ctx), args[1]),
    "streams.end": (ctx, args) => {
      o.hub.end(stringArg(args, 0, "a stream's id", 128), who(ctx));
    },
    "streams.cancel": (ctx, args) => {
      const reason = args[1];
      if (reason !== undefined && reason !== null && typeof reason !== "string") throw new ContractError("invalid", "a cancel's reason is a string");
      o.hub.cancel(stringArg(args, 0, "a stream's id", 128), who(ctx), reason ?? undefined);
    },
    "streams.ack": (ctx, args) => {
      o.hub.ack(stringArg(args, 0, "a stream's id", 128), who(ctx), args[1]);
    },
  };
}
