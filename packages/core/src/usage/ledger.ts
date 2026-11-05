// Clover's own usage rows (spec §12 "Usage tracking", §5.8 "the usage counting of Clover's own turns"): one row per
// model per turn, append-only, tagged with the bot and the session, so usage counts per bot and per session. Owner:
// lane D.
//
// `<home>/usage/clover.db`, beside the inherited `usage.db` (whose readers of Codex, Claude Code, OpenCode and
// Antigravity carry over, §12), with a schema of its own (`PRAGMA user_version`). A row's wire id is
// `<computer>:<database>:<n>`, where `<database>` is minted when the file is made, so rows synced from several
// computers never clash, nor do a computer's rows from before and after its ledger was made again (protocol
// `UsageRow`). Each row has a dedupe key (`<session>:<seq>…`), so counting the same turn twice, after a crash or a
// catch-up, adds nothing. `cursors` holds how far the counter has read each session's log. Days are the user's: a
// `day` summary groups by the date in the ledger's time zone (this computer's, unless given).
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UsageRow, UsageSource } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";

export const LEDGER_SCHEMA_VERSION = 1;
export const ROWS_PAGE_DEFAULT = 1_000;
export const ROWS_PAGE_MAX = 10_000;

export function cloverUsageDbPath(home: string): string {
  return join(home, "usage", "clover.db");
}

export interface LedgerRowInput {
  /** Never counted twice: the session and the log record (and the model's place in the turn). */
  dedupe: string;
  source: UsageSource;
  at: number;
  provider?: string;
  model?: string;
  bot?: string;
  session?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** The last record the counter read in a session's log: a turn's end, by its seq and its time. */
export interface LedgerCursor {
  seq: number;
  ts: number;
}

export type UsageGroupBy = "source" | "model" | "bot" | "computer" | "day" | "session";

export interface UsageTotals {
  rows: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The sum of the rows that carry a price; absent when none does. */
  costUsd?: number;
}

export interface RowsQuery {
  since: number;
  until?: number;
  computer?: string;
  source?: UsageSource;
  bot?: string;
  session?: string;
  cursor?: string;
  limit?: number;
}

interface DbRow {
  n: number;
  id: string;
  computer: string;
  source: string;
  at: number;
  provider: string | null;
  model: string | null;
  bot: string | null;
  session: string | null;
  input: number;
  output: number;
  cache_read: number | null;
  cache_write: number | null;
  cost_usd: number | null;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function encodeCursor(at: number, n: number): string {
  return Buffer.from(JSON.stringify([at, n])).toString("base64url");
}

function decodeCursor(cursor: string): { at: number; n: number } {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && v.length === 2 && isCount(v[0]) && isCount(v[1])) return { at: v[0], n: v[1] };
  } catch {
    // falls through
  }
  throw new ContractError("invalid", "not a usage cursor");
}

export class UsageLedger {
  readonly computer: string;
  /** This file's own id, part of every row's id. */
  readonly database: string;
  readonly #db: Database;
  readonly #day: Intl.DateTimeFormat;

  constructor(opts: { path: string; computer: string; timeZone?: string }) {
    this.computer = opts.computer;
    this.#day = new Intl.DateTimeFormat("en-CA", { timeZone: opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    mkdirSync(dirname(opts.path), { recursive: true });
    this.#db = new Database(opts.path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    const version = (this.#db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > LEDGER_SCHEMA_VERSION) throw new Error(`the usage ledger at ${opts.path} is from a newer Clover (schema ${version})`);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS rows (
        n INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        dedupe TEXT NOT NULL UNIQUE,
        computer TEXT NOT NULL,
        source TEXT NOT NULL,
        at INTEGER NOT NULL,
        provider TEXT, model TEXT, bot TEXT, session TEXT,
        input INTEGER NOT NULL, output INTEGER NOT NULL,
        cache_read INTEGER, cache_write INTEGER,
        cost_usd REAL
      );
      CREATE INDEX IF NOT EXISTS rows_at ON rows(at, n);
      CREATE INDEX IF NOT EXISTS rows_bot ON rows(bot, at);
      CREATE INDEX IF NOT EXISTS rows_session ON rows(session, at);
      CREATE TABLE IF NOT EXISTS cursors (session TEXT PRIMARY KEY, seq INTEGER NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = ${LEDGER_SCHEMA_VERSION};
    `);
    this.#db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('database', $v)").run({ $v: randomBytes(6).toString("hex") });
    this.database = (this.#db.query("SELECT value FROM meta WHERE key = 'database'").get() as { value: string }).value;
  }

  close(): void {
    this.#db.close();
  }

  /** Adds rows, skipping any already counted, and moves a session's cursor, in one transaction. Returns the rows it
   *  added. */
  add(rows: readonly LedgerRowInput[], cursor?: LedgerCursor & { session: string }): UsageRow[] {
    const insert = this.#db.query(`INSERT OR IGNORE INTO rows (id, dedupe, computer, source, at, provider, model, bot, session, input, output, cache_read, cache_write, cost_usd)
      VALUES ($id, $dedupe, $computer, $source, $at, $provider, $model, $bot, $session, $input, $output, $cacheRead, $cacheWrite, $cost)`);
    const rename = this.#db.query("UPDATE rows SET id = $id WHERE n = $n");
    const added: UsageRow[] = [];
    this.#db.transaction(() => {
      for (const r of rows) {
        if (![r.inputTokens, r.outputTokens, r.cacheReadTokens ?? 0, r.cacheWriteTokens ?? 0].every(isCount)) throw new ContractError("invalid", `usage row ${r.dedupe}: token counts are whole numbers`);
        if (r.costUsd !== undefined && !(Number.isFinite(r.costUsd) && r.costUsd >= 0)) throw new ContractError("invalid", `usage row ${r.dedupe}: a cost is a non-negative number`);
        const res = insert.run({
          $id: `pending:${r.dedupe}`, $dedupe: r.dedupe, $computer: this.computer, $source: r.source, $at: r.at,
          $provider: r.provider ?? null, $model: r.model ?? null, $bot: r.bot ?? null, $session: r.session ?? null,
          $input: r.inputTokens, $output: r.outputTokens, $cacheRead: r.cacheReadTokens ?? null, $cacheWrite: r.cacheWriteTokens ?? null,
          $cost: r.costUsd ?? null,
        });
        if (res.changes === 0) continue;
        const n = Number(res.lastInsertRowid);
        const id = `${this.computer}:${this.database}:${n}`;
        rename.run({ $id: id, $n: n });
        added.push(toWire({
          n, id, computer: this.computer, source: r.source, at: r.at, provider: r.provider ?? null, model: r.model ?? null,
          bot: r.bot ?? null, session: r.session ?? null, input: r.inputTokens, output: r.outputTokens,
          cache_read: r.cacheReadTokens ?? null, cache_write: r.cacheWriteTokens ?? null, cost_usd: r.costUsd ?? null,
        }));
      }
      if (cursor !== undefined) {
        this.#db.query("INSERT INTO cursors (session, seq, ts) VALUES ($s, $q, $t) ON CONFLICT(session) DO UPDATE SET seq = excluded.seq, ts = excluded.ts").run({ $s: cursor.session, $q: cursor.seq, $t: cursor.ts });
      }
    })();
    return added;
  }

  /** How far the counter has read a session's log: the turn's end it counted last (its seq and time), if any. */
  cursor(session: string): LedgerCursor | undefined {
    const row = this.#db.query("SELECT seq, ts FROM cursors WHERE session = $s").get({ $s: session }) as LedgerCursor | null;
    return row ?? undefined;
  }

  /** Rows from `since`, oldest first, a page at a time (`usage.rows`). */
  rows(q: RowsQuery): { rows: UsageRow[]; next?: string } {
    const limit = Math.min(Math.max(1, q.limit ?? ROWS_PAGE_DEFAULT), ROWS_PAGE_MAX);
    const where = ["at >= $since"];
    const params: Record<string, string | number> = { $since: q.since, $limit: limit + 1 };
    if (q.until !== undefined) (where.push("at < $until"), (params.$until = q.until));
    if (q.computer !== undefined) (where.push("computer = $computer"), (params.$computer = q.computer));
    if (q.source !== undefined) (where.push("source = $source"), (params.$source = q.source));
    if (q.bot !== undefined) (where.push("bot = $bot"), (params.$bot = q.bot));
    if (q.session !== undefined) (where.push("session = $session"), (params.$session = q.session));
    if (q.cursor !== undefined) {
      const c = decodeCursor(q.cursor);
      where.push("(at > $cAt OR (at = $cAt AND n > $cN))");
      params.$cAt = c.at;
      params.$cN = c.n;
    }
    const found = this.#db.query(`SELECT * FROM rows WHERE ${where.join(" AND ")} ORDER BY at, n LIMIT $limit`).all(params) as DbRow[];
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return { rows: page.map(toWire), ...(found.length > limit && last ? { next: encodeCursor(last.at, last.n) } : {}) };
  }

  /** Totals over `[from, to)`, grouped (`usage.summary`); `day` is the date in the ledger's time zone. */
  summary(q: { from: number; to: number; groupBy: UsageGroupBy; bot?: string; session?: string }): { key: string; inputTokens: number; outputTokens: number; costUsd?: number }[] {
    const where = ["at >= $from", "at < $to"];
    const params: Record<string, string | number> = { $from: q.from, $to: q.to };
    if (q.bot !== undefined) (where.push("bot = $bot"), (params.$bot = q.bot));
    if (q.session !== undefined) (where.push("session = $session"), (params.$session = q.session));
    const out = (rows: { k: string; i: number; o: number; c: number | null }[]) =>
      rows.map((r) => ({ key: r.k, inputTokens: r.i, outputTokens: r.o, ...(r.c === null ? {} : { costUsd: r.c }) }));
    if (q.groupBy === "day") {
      // A day's bounds move with daylight saving, so dates are worked out here, per quarter hour of rows (every time
      // zone's offset is a whole number of quarter hours).
      const quarters = this.#db.query(`SELECT (at / 900000) AS h, SUM(input) AS i, SUM(output) AS o, SUM(cost_usd) AS c FROM rows WHERE ${where.join(" AND ")} GROUP BY h`).all(params) as { h: number; i: number; o: number; c: number | null }[];
      const days = new Map<string, { k: string; i: number; o: number; c: number | null }>();
      for (const h of quarters) {
        const k = this.#day.format(new Date(h.h * 900_000));
        const d = days.get(k) ?? { k, i: 0, o: 0, c: null };
        d.i += h.i;
        d.o += h.o;
        if (h.c !== null) d.c = (d.c ?? 0) + h.c;
        days.set(k, d);
      }
      return out([...days.values()].sort((a, b) => (a.k < b.k ? -1 : 1)));
    }
    const key = {
      source: "source",
      model: "COALESCE(model, 'unknown')",
      bot: "COALESCE(bot, '-')",
      computer: "computer",
      session: "COALESCE(session, '-')",
    }[q.groupBy];
    return out(this.#db.query(`SELECT ${key} AS k, SUM(input) AS i, SUM(output) AS o, SUM(cost_usd) AS c FROM rows WHERE ${where.join(" AND ")} GROUP BY k ORDER BY k`).all(params) as { k: string; i: number; o: number; c: number | null }[]);
  }

  /** Everything a bot or a session has used, over all time or a period. */
  totals(q: { bot?: string; session?: string; from?: number; to?: number } = {}): UsageTotals {
    const where = ["1 = 1"];
    const params: Record<string, string | number> = {};
    if (q.bot !== undefined) (where.push("bot = $bot"), (params.$bot = q.bot));
    if (q.session !== undefined) (where.push("session = $session"), (params.$session = q.session));
    if (q.from !== undefined) (where.push("at >= $from"), (params.$from = q.from));
    if (q.to !== undefined) (where.push("at < $to"), (params.$to = q.to));
    const r = this.#db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(input), 0) AS i, COALESCE(SUM(output), 0) AS o, COALESCE(SUM(cache_read), 0) AS cr,
      COALESCE(SUM(cache_write), 0) AS cw, SUM(cost_usd) AS c FROM rows WHERE ${where.join(" AND ")}`).get(params) as { n: number; i: number; o: number; cr: number; cw: number; c: number | null };
    return { rows: r.n, inputTokens: r.i, outputTokens: r.o, cacheReadTokens: r.cr, cacheWriteTokens: r.cw, ...(r.c === null ? {} : { costUsd: r.c }) };
  }
}

function toWire(r: DbRow): UsageRow {
  return {
    id: r.id,
    computer: r.computer,
    source: r.source as UsageSource,
    at: r.at,
    ...(r.provider === null ? {} : { provider: r.provider }),
    ...(r.model === null ? {} : { model: r.model }),
    ...(r.bot === null ? {} : { bot: r.bot }),
    ...(r.session === null ? {} : { session: r.session }),
    inputTokens: r.input,
    outputTokens: r.output,
    ...(r.cache_read === null ? {} : { cacheReadTokens: r.cache_read }),
    ...(r.cache_write === null ? {} : { cacheWriteTokens: r.cache_write }),
    ...(r.cost_usd === null ? {} : { costUsd: r.cost_usd }),
  };
}
