// The island's strip from the pending cards' metas (lane E's wrapper maps them; the island draws them): what the
// core may show a plugin, in the island's own card shape. Elicitation draws as a link, every other sealed kind as an
// approval, with ids, computers and option kinds but never words. Empty options fall back to the island's own
// approve-and-deny pair. Question text stays with the core (a question for B), so only sealed kinds map.
//
// Types only from the protocol: no value imports at all, so the desktop's unit tests load this without the island
// bundle (whose `@clover-child/island` name resolves only for the layer build). Compatibility with the island's own
// `IslandCard` is checked where the wrapper hands the strip over (the layer build).
import type { CardMeta } from "@waifucave/clover-protocol";

/** A pending card as the island draws it: a subset of the island's `IslandCard`, kept in sync by the layer build. */
export type IslandStripCard =
  | { id: string; kind: "approval"; tool?: boolean; computer?: string; issuedAt?: number; options?: readonly { id: string; kind: "approve" | "deny"; remember?: "always" }[] }
  | { id: string; kind: "link"; computer?: string; issuedAt?: number; options?: readonly { id: string; kind: "approve" | "deny"; remember?: "always" }[] };

/** The island's strip from the pending cards' metas. */
export function islandCards(cards: readonly CardMeta[]): IslandStripCard[] {
  return cards.map((c) => {
    const options = c.options.length > 0
      ? { options: c.options.map((o) => ({ id: o.id, kind: o.kind, ...(o.remember !== undefined ? { remember: o.remember } : {}) })) }
      : {};
    const base = {
      id: c.id,
      ...(c.computer !== null ? { computer: c.computer } : {}),
      issuedAt: c.issuedAt,
      ...options,
    };
    if (c.kind === "elicitation") return { ...base, kind: "link" as const };
    return { ...base, kind: "approval" as const, ...(c.kind === "tool" ? { tool: true } : {}) };
  });
}
