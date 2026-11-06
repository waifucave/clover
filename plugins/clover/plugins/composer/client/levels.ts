// Clover's approval levels (spec §9.1, "The levels are read only, ask, ask for risky actions (the
// default), accept edits, and fully automatic"), in order from the most careful.
import { S } from "./strings";
import type { ComposerLevelOption } from "./types";

export const LEVEL_IDS = ["read-only", "ask", "risky", "accept-edits", "automatic"] as const;
export type LevelId = (typeof LEVEL_IDS)[number];

/** The default: ask for risky actions, with the safety reviewer. */
export const DEFAULT_LEVEL: LevelId = "risky";

export const CLOVER_LEVELS: ComposerLevelOption[] = LEVEL_IDS.map((id) => ({ id, label: S.levels[id].label, detail: S.levels[id].detail }));
