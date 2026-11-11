// The welcome guide's provider list: the ones already signed in first, then by name; a search narrows it by name or id.
// Pure, so the page and its test share it. It only reorders and filters what `welcome.providers` already returned.

export interface Orderable {
  id: string;
  name: string;
  auth: readonly { state: string }[];
}

/** Searching is offered once the list is long enough to need it. */
export const SEARCH_FROM = 6;

const ready = (p: Orderable): boolean => p.auth.some((a) => a.state === "signed-in" || a.state === "refreshing");

export function orderProviders<T extends Orderable>(providers: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const kept = q === "" ? [...providers] : providers.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  return kept.sort((a, b) => Number(ready(b)) - Number(ready(a)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
