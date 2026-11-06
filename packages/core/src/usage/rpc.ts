// Lane D's methods of the protocol's usage area (packages/protocol/src/usage.ts): Clover's own rows, per bot and per
// session. `usage.plans` waits for the inherited plan readers to be mounted on Clover's server, so it isn't here yet.
// Owner: lane D.
import { USAGE_METHODS } from "@waifucave/clover-protocol";
import { handler, type MethodHandler } from "../bots/rpc";
import type { UsageLedger } from "./ledger";

export function usageMethods(deps: { ledger: UsageLedger }): Record<string, MethodHandler> {
  const M = USAGE_METHODS;
  return {
    [M.usageRows.name]: handler(M.usageRows, async (q) => deps.ledger.rows({
      since: q.since,
      ...(q.until === undefined ? {} : { until: q.until }),
      ...(q.computer === undefined ? {} : { computer: q.computer }),
      ...(q.source === undefined ? {} : { source: q.source }),
      ...(q.bot === undefined ? {} : { bot: q.bot }),
      ...(q.session === undefined ? {} : { session: q.session }),
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
      ...(q.limit === undefined ? {} : { limit: q.limit }),
    })),
    [M.usageSummary.name]: handler(M.usageSummary, async (q) => ({
      groups: deps.ledger.summary({
        from: q.from, to: q.to, groupBy: q.groupBy,
        ...(q.bot === undefined ? {} : { bot: q.bot }),
        ...(q.session === undefined ? {} : { session: q.session }),
      }),
    })),
  };
}
