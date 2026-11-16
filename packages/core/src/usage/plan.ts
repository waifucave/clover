import type { PlanStatusWindow, PlanWindow, UsagePlanReading } from "@waifucave/moss-plugin-sdk/usage-source";

// Plan readings for the Usage tab (spec §12 "Usage sources"): how full the user's own apps' plan windows are, as a
// `usage.sources` entry's handler read them, with its age and a staleness verdict. The windows' own rules (the key, the
// staleness) are the source kit's, so a source and the core judge a window alike.

export { planScopeKey, planWindowKey, staleness } from "@waifucave/moss-plugin-sdk/usage-source";
export type { PlanStatusWindow, PlanWindow, PlanWindowKind } from "@waifucave/moss-plugin-sdk/usage-source";

/** What a reading's `source` says when no source answered. */
export type PlanNoSource = "none" | "disabled" | "not-installed";

/** A plan reading as the core answers it: the source's, with the entry it came from. */
export interface PlanReading extends Omit<UsagePlanReading, "source" | "windows" | "statusOnly"> {
  /** The `usage.sources` entry's id. */
  provider: string;
  /** The rung that answered (the source's own word), or `none` / `disabled` / `not-installed`. */
  source: string;
  windows: PlanWindow[];
  statusOnly?: PlanStatusWindow[];
}
