// The Claude Code usage source (moss/usage-claude-code): the `usage.sources` entry's handler. `plan` runs `claude -p
// /usage` and `claude auth status` through `api.outside` (named in the manifest); `ingest` reads the token counts its
// transcripts hold and its own `/stats` cache, in the two paths the manifest names. Nothing of Claude Code's sign-in, and
// not `~/.claude.json`, is read.
import type { HandlerContext } from "@waifucave/moss-plugin-sdk";
import type { UsageIngestArgs, UsagePlanArgs, UsageSourceHandler } from "@waifucave/moss-plugin-sdk/usage-source";
import { ingest, plan } from "../src/source";

export const source: UsageSourceHandler = {
  plan: (args: UsagePlanArgs, ctx: HandlerContext) => plan(args, ctx),
  ingest: (args: UsageIngestArgs) => ingest(args),
};
