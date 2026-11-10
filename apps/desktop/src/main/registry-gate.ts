// What the app does with each answer to `plugin.ui` (index.ts `loadRegistry`). An empty UI list can be true (nothing fills
// the window) or passing (the registry still opening, a plugin host restarting after an upgrade): a working shell is not
// torn down for one empty answer, and the root's fallback is not shown until the emptiness has lasted.

/** Empty answers in a row after which "no UI" is believed, when the daemon's plugin list showed plugins (so it is open). */
export const EMPTY_ANSWERS_WITH_LIST = 4;
/** The same when the plugin list is unavailable (an older daemon): longer, as the list can't say the registry is open. */
export const EMPTY_ANSWERS_NO_LIST = 8;

export interface GateInput {
  /** Plugins with UI in this answer. */
  ui: number;
  /** Plugins in the daemon's list; 0 when it is empty or the call isn't served. */
  listed: number;
  safeMode: boolean;
  /** Plugins with UI in the registry the app holds now. */
  held: number;
  /** Empty answers in a row before this one. */
  emptyBefore: number;
}

export interface GateResult {
  /** Whether this answer replaces the registry the app holds. */
  apply: boolean;
  emptyAnswers: number;
  /** The registry is known open and nothing fills the window: the root may show its fallback. */
  ready: boolean;
}

export function gateAnswer(i: GateInput): GateResult {
  const emptyAnswers = i.ui > 0 ? 0 : i.emptyBefore + 1;
  const need = i.listed > 0 ? EMPTY_ANSWERS_WITH_LIST : EMPTY_ANSWERS_NO_LIST;
  const ready = i.ui > 0 || i.safeMode || emptyAnswers >= need;
  // A held shell stays until the emptiness is believed.
  return { apply: i.ui > 0 || i.held === 0 || ready, emptyAnswers, ready };
}
