// The bots-as-engine-data row (lane BT, spec §6.1, §13 Split 1): on a daemon with records as the bots' source
// (`MOSS_BOT_SOURCE=records`, packages/core/src/bots/source.ts, the default since lane MC), over the app's methods with no app (its cards answered over RPC): the move made the bundled Alpha a record; a
// bot made with `bot.create` answers a turn in its one conversation and is listed with its last line; it makes another
// bot with `MakeBot` behind the person's card; it is removed (archived) and brought back with its conversation whole.
// Run last in the chain (its own daemon on the chain's home), or alone with --only-bot-records.
export const BOT_RECORDS_STEP = "bots as engine data (records as the source): the move makes MOSS (id alpha) a record; a bot made with bot.create answers in its one conversation and its last line is listed; it makes a bot with MakeBot behind the person's card; removed, it is archived and comes back with its conversation";

export const BOT_RECORDS_ENV: Readonly<Record<string, string>> = { MOSS_BOT_SOURCE: "records" };

interface RecordView { id: string; model?: string; madeBy: { kind: string; id?: string; plugin?: string }; mainSession: string }

/** What is wrong with what the row read, or undefined. */
export function botRecordsWrong(o: {
  journal?: { bots: { outcome: string; id: string }[] };
  records: readonly RecordView[];
  made?: RecordView;
  summary?: { id: string; last?: { from: string }; unread: boolean };
  maker: string;
  child?: RecordView;
  cards: readonly string[];
}): string | undefined {
  if (o.journal === undefined) return "bot.move.status has no journal: the move didn't run";
  if (!o.journal.bots.some((b) => b.id === "alpha" && b.outcome === "moved")) return `the move's journal doesn't say alpha moved: ${JSON.stringify(o.journal.bots).slice(0, 300)}`;
  // MOSS's own default bot (engine data, lane MC): the move writes her record, made by MOSS (`default`); a home whose
  // journal predates that has her as a plain move of her old plugin.
  if (!o.records.some((r) => r.id === "alpha" && (r.madeBy.kind === "default" || r.madeBy.kind === "move"))) return "the default bot (alpha) isn't a record the move made";
  if (o.made === undefined) return "bot.create made no record";
  if (o.summary === undefined || o.summary.last?.from !== "bot") return `bot.summaries doesn't list ${o.maker}'s reply as its last line: ${JSON.stringify(o.summary)}`;
  if (!o.cards.some((c) => c.includes("confirm"))) return `MakeBot raised no card (cards: ${o.cards.join("; ") || "none"})`;
  if (o.child === undefined) return "MakeBot made no bot after the person's yes";
  if (o.child.madeBy.kind !== "bot" || o.child.madeBy.id !== o.maker) return `the new bot's maker is ${JSON.stringify(o.child.madeBy)}, not ${o.maker}`;
  return undefined;
}
