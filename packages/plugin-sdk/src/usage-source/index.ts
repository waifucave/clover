// The kit a `usage.sources` plugin imports (spec §12 "Usage sources"): the types of what the core asks and what a
// source answers, the pure helpers of a plan reading, and the helpers that read a tool's files. Host halves only
// (`@waifucave/moss-plugin-sdk/usage-source`): it reads files with `node:fs`.
export type {
  PlanStatusWindow, PlanWindow, PlanWindowKind, UsageIngestArgs, UsageIngestReply, UsagePlanArgs, UsagePlanReading, UsagePlanReply,
  UsageRecord, UsageSourceHandler, UsageStored,
} from "./types";
export { PLAN_SCOPE_FAMILIES, kindOfMinutes, percentOf, planScopeKey, planWindowKey, resetMs, shortStr, staleness, timeOf, tokenCount } from "./plan";
export { findFiles, fileKey, readFiles, readNewLines, scanLinesBackward } from "./files";
export type { FileCursor, FoundFile, ReadFilesOptions, ReadResult } from "./files";
export { runOutside } from "./outside";
export type { Outside, OutsideOutcome } from "./outside";
