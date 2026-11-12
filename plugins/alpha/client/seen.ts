// What Alpha has seen of her main conversation, folded one event at a time (no UI, so it is tested alone).

export interface Seen { tool?: { name: string; detail: string; status: string; title?: string }; tools: number; replies: number; waiting: boolean; files: number }

export const GLYPH: Record<string, string> = { write: "✎", edit: "✎", read: "❒", bash: "›_", websearch: "⌕", webfetch: "⤓", agent: "✦" };
export const NOW: Record<string, string> = { write: "Writing", edit: "Editing", read: "Reading", bash: "Running a command", websearch: "Searching the web", webfetch: "Reading a page", agent: "Handing off" };
const kind = (n: string) => (/^mcp__[a-z0-9-]+__(.+)$/.exec(n)?.[1] ?? n).toLowerCase();

/** Folds a conversation's events into what Alpha shows, one at a time (an event costs the same however long the conversation is).
 *  `take` says whether the event changed anything she shows. */
export function seenFolder(): { take(e: Record<string, unknown>): boolean; seen(): Seen } {
  let seen: Seen = { tools: 0, replies: 0, waiting: false, files: 0 };
  const pending = new Set<string>();
  return {
    seen: () => seen,
    take(e) {
      const before = JSON.stringify(seen);
      const next: Seen = { ...seen, ...(seen.tool ? { tool: { ...seen.tool } } : {}) };
      switch (e.type) {
        case "tool_call": {
          next.tools++;
          let detail = "";
          try { const a = JSON.parse(String(e.argsJson ?? "{}")); detail = String(a.file_path ?? a.command ?? a.query ?? a.url ?? "").split("/").slice(-2).join("/"); } catch { /* none */ }
          // A title only from her own plugin's tools (here it is her own widget); another plugin's never stands in for Clover's wording.
          const own = /^mcp__alpha(-[a-z0-9-]+)?__/.test(String(e.name ?? ""));
          const title = own && typeof e.displayTitle === "string" ? e.displayTitle.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 60) : "";
          next.tool = { name: kind(String(e.name ?? "")), detail, status: "running", ...(title ? { title } : {}) };
          break;
        }
        case "tool_result":
          if (next.tool) next.tool.status = e.isError === true ? "failed" : "done";
          if (e.fileDiff) next.files++;
          break;
        case "assistant_message": next.replies++; break;
        case "card_pending": case "card_requested": pending.add(String((e.card as any)?.id ?? "")); break;
        case "card_resolved": pending.delete(String((e.cardId ?? (e.card as any)?.id) ?? "")); break;
        case "turn_completed": if (next.tool?.status === "running") next.tool.status = "done"; break;
      }
      next.waiting = pending.size > 0;
      if (JSON.stringify(next) === before) return false;
      seen = next;
      return true;
    },
  };
}
