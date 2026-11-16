// A tab's back and forward, from DevTools' own list: `Page.getNavigationHistory` answers with the entries and the
// index of the current one; `Page.navigateToHistoryEntry` goes to an entry by its id.

/** The part of `Page.getNavigationHistory`'s result the view reads. */
interface NavigationHistory {
  currentIndex?: unknown;
  entries?: unknown;
}

/** The entries one step back and one step forward, by their ids; absent when there is no such step. */
export interface Steps {
  back?: number;
  forward?: number;
}

export function readSteps(result: unknown): Steps {
  const h = (result ?? {}) as NavigationHistory;
  if (!Array.isArray(h.entries) || typeof h.currentIndex !== "number") return {};
  const idAt = (i: number): number | undefined => {
    const entry = h.entries && (h.entries as unknown[])[i];
    const id = entry !== null && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
    return typeof id === "number" ? id : undefined;
  };
  const back = idAt(h.currentIndex - 1);
  const forward = idAt(h.currentIndex + 1);
  return { ...(back !== undefined ? { back } : {}), ...(forward !== undefined ? { forward } : {}) };
}
