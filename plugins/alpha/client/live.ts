// What Alpha's frames share about her: the bot's own record and what her main conversation has been doing (for "right now" and the day's tally).
import { useEffect, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

export interface BotRef { id: string; name: string }
export interface BotNow { name: string; portrait?: string; model: string; state: string; mainSession: string; credit?: string }

export function useBot(ref: BotRef): BotNow | undefined {
  const api = usePluginApi();
  const [bot, setBot] = useState<BotNow | undefined>();
  useEffect(() => {
    let live = true;
    const take = (b: any) => live && setBot({ name: b.name, portrait: b.portrait, model: b.model, state: b.state, mainSession: b.mainSession, ...(typeof b.avatar?.credit === "string" && b.avatar.credit !== "" ? { credit: b.avatar.credit } : {}) });
    void api.bots?.get(ref.id).then(take, () => undefined);
    const stop = api.bots?.watch((b: any) => { if (b.id === ref.id) take(b); });
    return () => { live = false; stop?.(); };
  }, [api, ref.id]);
  return bot;
}


export interface Seen { tool?: { name: string; detail: string; status: string; title?: string }; tools: number; replies: number; waiting: boolean; files: number }

export const GLYPH: Record<string, string> = { write: "✎", edit: "✎", read: "❒", bash: "›_", websearch: "⌕", webfetch: "⤓", agent: "✦" };
export const NOW: Record<string, string> = { write: "Writing", edit: "Editing", read: "Reading", bash: "Running a command", websearch: "Searching the web", webfetch: "Reading a page", agent: "Handing off" };
const kind = (n: string) => (/^mcp__[a-z0-9-]+__(.+)$/.exec(n)?.[1] ?? n).toLowerCase();

function foldEvents(events: Record<string, unknown>[]): Seen {
  const seen: Seen = { tools: 0, replies: 0, waiting: false, files: 0 };
  const pending = new Set<string>();
  for (const e of events) {
    switch (e.type) {
      case "tool_call": {
        seen.tools++;
        let detail = "";
        try { const a = JSON.parse(String(e.argsJson ?? "{}")); detail = String(a.file_path ?? a.command ?? a.query ?? a.url ?? "").split("/").slice(-2).join("/"); } catch { /* none */ }
        // A title only from her own plugin's tools (here it is her own widget); another plugin's never stands in for Clover's wording.
        const own = /^mcp__alpha(-[a-z0-9-]+)?__/.test(String(e.name ?? ""));
        const title = own && typeof e.displayTitle === "string" ? e.displayTitle.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 60) : "";
        seen.tool = { name: kind(String(e.name ?? "")), detail, status: "running", ...(title ? { title } : {}) };
        break;
      }
      case "tool_result":
        if (seen.tool) seen.tool.status = e.isError === true ? "failed" : "done";
        if (e.fileDiff) seen.files++;
        break;
      case "assistant_message": seen.replies++; break;
      case "card_pending": case "card_requested": pending.add(String((e.card as any)?.id ?? "")); break;
      case "card_resolved": pending.delete(String((e.cardId ?? (e.card as any)?.id) ?? "")); break;
      case "turn_completed": if (seen.tool?.status === "running") seen.tool.status = "done"; break;
    }
  }
  seen.waiting = pending.size > 0;
  return seen;
}


/** What her main conversation has shown so far (the last tool, the replies, a card that waits), followed live. */
export function useSeen(session: string | undefined): Seen {
  const api = usePluginApi();
  const [seen, setSeen] = useState<Seen>({ tools: 0, replies: 0, waiting: false, files: 0 });
  useEffect(() => {
    if (!session) return;
    let live = true;
    const all: Record<string, unknown>[] = [];
    const refresh = () => live && setSeen(foldEvents(all));
    void api.conversation.history(session, { limit: 300 }).then((h: any) => { all.push(...(h.events as Record<string, unknown>[]).slice().sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))); refresh(); }, () => undefined);
    const stop = api.conversation.follow(session, (e: Record<string, unknown>) => { all.push(e); refresh(); });
    return () => { live = false; stop(); };
  }, [api, session]);
  return seen;
}
