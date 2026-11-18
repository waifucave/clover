// The upgrade's new half, for the bots (lane BT, round 4): on the engine a copied plugin-era home started, every bot the
// OLD home holds a conversation of is in MOSS exactly once, listed or archived, with that conversation; and a copied
// plugin that brings one of them and waits for its OK again: after its OK, its bot is listed with its old conversation.
// The copy's upgrade runs it as the row after the old conversation's (scripts/acceptance/run.ts, `BOT_MOVE_UPGRADE_STEP`).
//
// What it reads of the OLD home (read only, the copy's source `MOSS_OLD_HOME`), on its own, not through the engine's
// reader: each `transcripts/<seg>/b_<seg>.meta.json` of `kind: "bot"` (the bot's one conversation; its id is the meta's
// `bot`, `example-notes/bot` in `example-notes--bot`), and the first thing the person said in its log.
// What it asks the engine: `bot.move.status`, `bot.records`, `bot.archived`, `bot.conversation`; `plugin.get` for each
// bot's plugin; and, for the one restore it makes to read an archived bot's conversation, `bot.restore` then
// `bot.remove` (the bot goes back into the archive as it was).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BOT_MOVE_UPGRADE_STEP = "every bot the old home recorded is named once in the move's journal and is listed or archived with its conversation; an archived one is brought back and reads its old turns; MOSS's Settings list the archived ones under Archived bots";

interface Rpc { request<T>(method: string, params?: unknown): Promise<T> }

/** A bot the old home holds a conversation of. */
export interface OldBot {
  id: string;
  session: string;
  title?: string;
  /** The first thing the person said to it, when its log holds one. */
  said?: string;
}

/** The bots the old home holds a conversation of. */
export function oldHomeBots(oldHome: string): OldBot[] {
  const root = join(oldHome, "transcripts");
  if (!existsSync(root)) return [];
  const out: OldBot[] = [];
  for (const seg of readdirSync(root).sort()) {
    const metaFile = join(root, seg, `b_${seg}.meta.json`);
    if (!existsSync(metaFile)) continue;
    let meta: { kind?: unknown; bot?: unknown; id?: unknown; title?: unknown };
    try { meta = JSON.parse(readFileSync(metaFile, "utf8")); } catch { continue; }
    if (meta.kind !== "bot" || typeof meta.bot !== "string" || meta.bot.replace("/", "--") !== seg) continue;
    const bot: OldBot = { id: meta.bot, session: `b_${seg}`, ...(typeof meta.title === "string" ? { title: meta.title } : {}) };
    const log = join(root, seg, `b_${seg}.ndjson`);
    if (existsSync(log)) {
      for (const line of readFileSync(log, "utf8").split("\n").slice(0, 2000)) {
        try {
          const e = JSON.parse(line) as { type?: string; input?: { from?: string; text?: unknown } };
          if (e.type === "input" && e.input?.from === "user" && typeof e.input.text === "string" && e.input.text.trim() !== "") { bot.said = e.input.text; break; }
        } catch { /* a torn line */ }
      }
    }
    out.push(bot);
  }
  return out;
}

/** Whether the bot's one conversation holds `text`, paging back from the newest. */
async function conversationHolds(rpc: Rpc, id: string, text: string): Promise<boolean> {
  let before: number | undefined;
  for (let page = 0; page < 40; page++) {
    const r = await rpc.request<{ events: Record<string, unknown>[]; hasMore: boolean }>("bot.conversation", { id, limit: 500, ...(before === undefined ? {} : { before }) });
    if (JSON.stringify(r.events).includes(JSON.stringify(text).slice(1, -1))) return true;
    const first = r.events[0]?.["seq"];
    if (!r.hasMore || typeof first !== "number") return false;
    before = first;
  }
  return false;
}

interface Journal { at: number; bots: { outcome: string; id: string; why?: string }[] }

/** The check: what it found, or a thrown Error saying what is wrong. `okPlugin` presses a plugin's OK card in the window
 *  (the caller's: run.ts's `pressCard` over `card.list`), for a copied bot plugin waiting for its OK again. */
export async function botMoveUpgradeCheck(o: { rpc: Rpc; oldHome: string; okPlugin?: (pluginId: string) => Promise<void> }): Promise<string> {
  const wrong = (m: string): never => { throw new Error(m); };
  const old = oldHomeBots(o.oldHome);
  if (old.length === 0) wrong(`the old home ${o.oldHome} holds no bot's conversation to check`);
  const status = await o.rpc.request<{ journal?: Journal; pending: string[]; held?: { reason: string } }>("bot.move.status", {});
  if (status.held !== undefined) wrong(`the move is held: ${status.held.reason}`);
  const journal = status.journal ?? wrong("bot.move.status has no journal: the move didn't run");
  const records = async () => (await o.rpc.request<{ bots: { id: string }[] }>("bot.records", {})).bots.map((b) => b.id);
  const archived = async () => (await o.rpc.request<{ bots: { id: string }[] }>("bot.archived", {})).bots.map((b) => b.id);
  let listed = await records();
  let kept = await archived();
  for (const b of old) {
    const entries = journal.bots.filter((e) => e.id === b.id);
    if (entries.length !== 1) wrong(`the move's journal names ${b.id} ${entries.length} times (${JSON.stringify(journal.bots).slice(0, 400)})`);
    if (entries[0]!.outcome === "failed") wrong(`${b.id} wasn't moved: ${entries[0]!.why ?? "no reason"} (pending: ${status.pending.join(", ") || "none"})`);
    const places = [listed.includes(b.id) ? "listed" : "", kept.includes(b.id) ? "archived" : ""].filter(Boolean);
    if (places.length !== 1) wrong(`${b.id} is ${places.length === 0 ? "neither listed nor archived" : "both listed and archived"}`);
  }

  // A copied plugin that brings one of these bots and waits for its OK again (`found`): OK'd, its bot is listed with its
  // old conversation.
  const okd: string[] = [];
  for (const b of old) {
    const plugin = (await o.rpc.request<{ plugin: { state: string; manifest?: { contributes?: { bot?: unknown } } } }>("plugin.get", { id: b.id }).catch(() => undefined))?.plugin;
    if (plugin === undefined || plugin.manifest?.contributes?.bot === undefined || plugin.state !== "found") continue;
    if (o.okPlugin === undefined) wrong(`${b.id}'s plugin waits for its OK and the check was given no way to press it`);
    await o.okPlugin!(b.id);
    okd.push(b.id);
    listed = await records();
    if (!listed.includes(b.id)) wrong(`after its plugin's OK, ${b.id} isn't listed (records: ${listed.join(", ")})`);
    if (b.said !== undefined && !(await conversationHolds(o.rpc, b.id, b.said))) wrong(`after its plugin's OK, ${b.id}'s conversation doesn't hold what the person said to it before ("${b.said.slice(0, 60)}")`);
  }

  // Each listed one: its old conversation.
  for (const b of old) {
    if (!listed.includes(b.id) || b.said === undefined) continue;
    if (!(await conversationHolds(o.rpc, b.id, b.said))) wrong(`${b.id} is listed but its conversation doesn't hold what the person said to it before ("${b.said.slice(0, 60)}")`);
  }
  // One archived one, brought back to read its conversation, then archived again as it was.
  const sample = old.find((b) => kept.includes(b.id) && b.said !== undefined);
  if (sample !== undefined) {
    await o.rpc.request("bot.restore", { id: sample.id });
    try {
      if (!(await conversationHolds(o.rpc, sample.id, sample.said!))) wrong(`${sample.id}, brought back from the archive, has lost its conversation ("${sample.said!.slice(0, 60)}")`);
    } finally {
      await o.rpc.request("bot.remove", { id: sample.id });
    }
    kept = await archived();
    if (!kept.includes(sample.id)) wrong(`${sample.id} didn't go back into the archive`);
  }
  const inList = old.filter((b) => listed.includes(b.id)).map((b) => b.id);
  const inArchive = old.filter((b) => kept.includes(b.id)).map((b) => b.id);
  return `${old.length} bots of the old home, each named once by the move's journal: listed ${inList.join(", ") || "none"}; archived ${inArchive.join(", ") || "none"}`
    + (sample === undefined ? "" : `; ${sample.id}'s conversation whole after a restore (archived again)`)
    + (okd.length === 0 ? "; no copied plugin brings one of them and waits for its OK (nothing to OK)" : `; after their OK ${okd.join(", ")} listed with their old conversations`);
}
