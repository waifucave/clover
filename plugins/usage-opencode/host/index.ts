// The OpenCode usage source (moss/usage-opencode): the `usage.sources` entry's handler. `ingest` asks `opencode stats`
// through `api.outside` (named in the manifest) for its token counts and cost; OpenCode keeps no plan limits to read.
import type { HandlerContext } from "@waifucave/moss-plugin-sdk";
import type { UsageIngestArgs, UsageSourceHandler } from "@waifucave/moss-plugin-sdk/usage-source";
import { ingest } from "../src/source";

export const source: UsageSourceHandler = {
  ingest: (args: UsageIngestArgs, ctx: HandlerContext) => ingest(args, ctx),
};
