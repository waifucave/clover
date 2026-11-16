// The Codex usage source (moss/usage-codex): the `usage.sources` entry's handler. `plan` asks `codex app-server`
// through `api.outside` (named in the manifest) and falls back to the newest rollout's `rate_limits`; `ingest` reads the
// token counts the rollouts hold, in the two folders the manifest names. Nothing of Codex's sign-in is read.
import type { HandlerContext } from "@waifucave/moss-plugin-sdk";
import type { UsageIngestArgs, UsagePlanArgs, UsageSourceHandler } from "@waifucave/moss-plugin-sdk/usage-source";
import { ingest, plan } from "../src/source";

export const source: UsageSourceHandler = {
  plan: (args: UsagePlanArgs, ctx: HandlerContext) => plan(args, ctx),
  ingest: (args: UsageIngestArgs) => ingest(args),
};
