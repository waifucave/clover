// The setup guide's provider list, in both apps (MOSS and MOSS Code): the providers the person added first; then the
// ones people most often have: every provider with a sign-in of its own (a subscription: ChatGPT/Codex, xAI's, an OAuth
// plugin's), then the big API-key providers in FEATURED's order; then the rest by name. A search narrows the whole list by
// name or id. Pure and dependency-free (its own subpath, `@waifucave/moss-protocol/provider-order`), so both apps' pages
// and the tests share it. It only reorders and filters what the guide was given.

export interface Orderable {
  /** The provider's plugin id (`moss/model-<provider>` for a bundled one) or its provider id. */
  id: string;
  name: string;
  auth: readonly { state: string; method?: string }[];
}

/** Searching is offered once the list is long enough to need it. */
export const SEARCH_FROM = 6;

/** The big API-key providers, by provider id, in the order the guide shows them after the sign-in ones. */
export const FEATURED: readonly string[] = ["openai", "anthropic", "google", "openrouter", "xai", "deepseek", "mistral", "groq"];

const ready = (p: Orderable): boolean => p.auth.some((a) => a.state === "signed-in" || a.state === "refreshing");

/** The provider id a guide row stands for: a bundled model plugin's id less its `moss/model-` prefix. */
export function providerIdOf(id: string): string {
  return id.startsWith("moss/model-") ? id.slice("moss/model-".length) : id;
}

/** Where a provider sorts: added (0), its own sign-in (1), featured (2, then its place), the rest (3). */
function rank(p: Orderable): [number, number] {
  if (ready(p)) return [0, 0];
  if (p.auth.some((a) => a.method !== undefined && a.method !== "api-key")) return [1, 0];
  const f = FEATURED.indexOf(providerIdOf(p.id));
  return f >= 0 ? [2, f] : [3, 0];
}

export function orderProviders<T extends Orderable>(providers: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const kept = q === "" ? [...providers] : providers.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  return kept.sort((a, b) => {
    const [ra, fa] = rank(a);
    const [rb, fb] = rank(b);
    return ra - rb || fa - fb || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}
