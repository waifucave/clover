// What Alpha's frames share about her: the bot's own record and what her main conversation has been doing (for "right now" and the day's tally).
import { useEffect, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import { seenFolder, type Seen } from "./seen";

export { GLYPH, NOW, type Seen } from "./seen";

export interface BotRef { id: string; name: string }
export interface BotNow { name: string; portrait?: string; model: string; state: string; mainSession: string; credit?: string }

export function useBot(ref: BotRef): BotNow | undefined {
  const api = usePluginApi();
  const [bot, setBot] = useState<BotNow | undefined>();
  useEffect(() => {
    let live = true;
    const take = (b: any) => { if (!live) return; const next: BotNow = { name: b.name, portrait: b.portrait, model: b.model, state: b.state, mainSession: b.mainSession, ...(typeof b.avatar?.credit === "string" && b.avatar.credit !== "" ? { credit: b.avatar.credit } : {}) }; setBot((was) => (was !== undefined && JSON.stringify(was) === JSON.stringify(next) ? was : next)); };
    void api.bots?.get(ref.id).then(take, () => undefined);
    const stop = api.bots?.watch((b: any) => { if (b.id === ref.id) take(b); });
    return () => { live = false; stop?.(); };
  }, [api, ref.id]);
  return bot;
}


/** What her main conversation has shown so far (the last tool, the replies, a card that waits), followed live. */
export function useSeen(session: string | undefined): Seen {
  const api = usePluginApi();
  const [seen, setSeen] = useState<Seen>({ tools: 0, replies: 0, waiting: false, files: 0 });
  useEffect(() => {
    if (!session) return;
    let live = true;
    const fold = seenFolder();
    // The history is folded once, in order; each followed event after it costs one fold and draws only if it changed what she shows.
    let waiting: Record<string, unknown>[] | undefined = [];
    const apply = (e: Record<string, unknown>) => { if (fold.take(e) && live) setSeen(fold.seen()); };
    void api.conversation.history(session, { limit: 300 }).then((h: any) => {
      const events = (h.events as Record<string, unknown>[]).slice().sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
      const held = waiting ?? [];
      waiting = undefined;
      for (const e of events) fold.take(e);
      for (const e of held) fold.take(e);
      if (live) setSeen(fold.seen());
    }, () => { waiting = undefined; });
    const stop = api.conversation.follow(session, (e: Record<string, unknown>) => { if (waiting !== undefined) waiting.push(e); else apply(e); });
    return () => { live = false; stop(); };
  }, [api, session]);
  return seen;
}

/** Dark when the tab's own surface token is: the window's appearance reaches a frame as tokens. */
export function useDark(): boolean {
  const read = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--clover-color-surface").trim();
    const m = /^#([0-9a-f]{6})/i.exec(v);
    if (m === null) return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
    const n = parseInt(m[1]!, 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.5;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const t = setInterval(() => setDark((d) => { const n = read(); return n === d ? d : n; }), 1000);
    return () => clearInterval(t);
  }, []);
  return dark;
}
