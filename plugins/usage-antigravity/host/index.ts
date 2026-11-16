// The Antigravity usage source (moss/usage-antigravity): the `usage.sources` entry's handler. The Usage plugin's core
// side calls `plan` on this computer; it runs `agy -p /usage` through `api.outside` (named in the manifest) and reads
// the plan windows out of its answer. Nothing of Antigravity's sign-in is read.
import type { HandlerContext } from "@waifucave/moss-plugin-sdk";
import type { UsagePlanArgs, UsageSourceHandler } from "@waifucave/moss-plugin-sdk/usage-source";
import { plan } from "../src/source";

export const source: UsageSourceHandler = {
  plan: (args: UsagePlanArgs, ctx: HandlerContext) => plan(args, ctx),
};
