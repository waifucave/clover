// What Alpha has seen of her main conversation, folded one event at a time (no UI, so it is tested alone).

export interface Seen { tool?: { name: string; detail: string; status: string; title?: string }; tools: number; replies: number; waiting: boolean; files: number;
  /** The same counts for today alone (the local day, by each event's own time): the day's tally. `files` counts the distinct files a write or an edit named. */
  today: { replies: number; tools: number; files: number } }

export const GLYPH: Record<string, string> = { write: "✎", edit: "✎", read: "❒", bash: "›_", websearch: "⌕", webfetch: "⤓", agent: "✦" };
export const NOW: Record<string, string> = { write: "Writing", edit: "Editing", read: "Reading", bash: "Running a command", websearch: "Searching the web", webfetch: "Reading a page", agent: "Handing off" };
/** The local date as `YYYY-MM-DD`: the day the stage's tally counts (the server writes the same form). */
export function localDay(at: number = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const WRITES = new Set(["write", "edit", "multiedit", "notebookedit"]);
const kind = (n: string) => (/^mcp__[a-z0-9-]+__(.+)$/.exec(n)?.[1] ?? n).toLowerCase();

/** Folds a conversation's events into what Alpha shows, one at a time (an event costs the same however long the conversation is).
 *  `take` says whether the event changed anything she shows. */
export function seenFolder(now: () => number = Date.now): { take(e: Record<string, unknown>): boolean; seen(): Seen } {
  let seen: Seen = { tools: 0, replies: 0, waiting: false, files: 0, today: { replies: 0, tools: 0, files: 0 } };
  const pending = new Set<string>();
  const touched = new Set<string>();
  return {
    seen: () => seen,
    take(e) {
      const before = JSON.stringify(seen);
      const next: Seen = { ...seen, today: { ...seen.today }, ...(seen.tool ? { tool: { ...seen.tool } } : {}) };
      const mid = new Date(now()); mid.setHours(0, 0, 0, 0);
      const isToday = typeof e.ts !== "number" || e.ts >= mid.getTime();
      switch (e.type) {
        case "tool_call": {
          next.tools++;
          if (isToday) next.today.tools++;
          let detail = "";
          try { const a = JSON.parse(String(e.argsJson ?? "{}")); const path = String(a.file_path ?? a.path ?? ""); if (isToday && path !== "" && WRITES.has(kind(String(e.name ?? "")))) { const key = `${mid.getTime()}:${path}`; if (!touched.has(key)) { touched.add(key); next.today.files++; } } detail = String(a.file_path ?? a.command ?? a.query ?? a.url ?? "").split("/").slice(-2).join("/"); } catch { /* none */ }
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
        case "assistant_message": next.replies++; if (isToday) next.today.replies++; break;
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
