// The archive of the previous app's sessions (spec §14.1 "Existing … installs": old sessions stay readable in an
// archive view but never become a bot's history; the app's archive view, §5.5). Owner: lane D.
//
// They are this daemon's own inherited session store (code, chat and dispatch sessions, as the previous app kept them
// in this home): Clover never reads another install's home (other-installs.ts). Read-only here, and the user's alone.
//
// * `archive.list`: the top-level sessions, newest activity first (a dispatch session's children are its own), matched
//   by `query` against the title, the first message and the project folder, paged by a `cursor` naming the last one
//   shown (its `updatedAt` and id: the list's own order, so a tie is never skipped or shown twice). It reads the
//   store's index (the message count included) and one stat per session, never a log.
// * `archive.history`: a session's events as the store keeps them, oldest first, a page at a time (`cursor`: the seq
//   the next page starts after). The store finds the page by bisecting the log (`readRange`), so a page never parses
//   the lines before it, and a page stops at a byte budget well under one request line (NDJSON_MAX_LINE_BYTES).
import { NDJSON_MAX_LINE_BYTES, SESSIONS_METHODS, type ArchivedSessionView } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import type { SessionRow, SessionStore } from "./store";

const ARCHIVE_MODES = new Set(["code", "chat", "dispatch"]);
const LIST_DEFAULT = 50;
const HISTORY_DEFAULT = 200;
/** The longest title an archived session shows (the view's own limit). */
const TITLE_MAX = 500;
/** A history page's lines, at most: a quarter of one request line, so the reply's envelope and any re-encoding fit. */
export const HISTORY_PAGE_BYTES = Math.floor(NDJSON_MAX_LINE_BYTES / 4);
/** One event longer than this is left out of the page (named by its seq), never sent. */
export const HISTORY_EVENT_MAX_BYTES = Math.floor(NDJSON_MAX_LINE_BYTES / 2);
const SEQ_CURSOR = /^\d{1,15}$/;
const LIST_CURSOR = /^(\d{1,15}):(.{1,128})$/s;

export interface ArchiveDeps {
  store: Pick<SessionStore, "list" | "readRange" | "lastEventTs" | "firstMessage" | "messageCount">;
}

export function archiveMethods(deps: ArchiveDeps): Record<string, MethodHandler> {
  const M = SESSIONS_METHODS;
  return {
    [M.archiveList.name]: handler(M.archiveList, async ({ query, cursor, limit }, ctx) => {
      requireUser(ctx, "read the archive");
      const after = cursor === undefined ? undefined : listCursor(cursor);
      const needle = query?.trim().toLowerCase();
      const rows = deps.store.list()
        .filter(archived)
        .filter((r) => needle === undefined || needle === "" || [r.title, deps.store.firstMessage(r.sessionId), r.cwd].some((t) => t?.toLowerCase().includes(needle)))
        .map((r) => ({ r, updatedAt: updatedAtOf(deps.store, r) }))
        // The list's order: newest first, then by id. A cursor's page starts after the session it names.
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.r.sessionId < b.r.sessionId ? -1 : a.r.sessionId > b.r.sessionId ? 1 : 0))
        .filter(({ r, updatedAt }) => after === undefined || updatedAt < after.updatedAt || (updatedAt === after.updatedAt && r.sessionId > after.id));
      const n = limit ?? LIST_DEFAULT;
      const page = rows.slice(0, n);
      const last = page.at(-1);
      const more = rows.length > n;
      return {
        sessions: page.map(({ r, updatedAt }) => viewOf(deps.store, r, updatedAt)),
        more,
        ...(more && last !== undefined ? { cursor: `${last.updatedAt}:${last.r.sessionId}` } : {}),
      };
    }),

    [M.archiveHistory.name]: handler(M.archiveHistory, async ({ id, cursor, limit }, ctx) => {
      requireUser(ctx, "read the archive");
      const row = deps.store.list().find((r) => r.sessionId === id);
      if (row === undefined || !archived(row)) throw new ContractError("not_found", `no archived session ${id}`);
      if (cursor !== undefined && !SEQ_CURSOR.test(cursor)) throw new ContractError("invalid", "archive.history: a bad cursor");
      const after = cursor === undefined ? 0 : Number(cursor);
      const page = deps.store.readRange(id, after, { limit: limit ?? HISTORY_DEFAULT, maxBytes: HISTORY_PAGE_BYTES, maxOne: HISTORY_EVENT_MAX_BYTES });
      // An event too long to send is named, so the view can say something is missing there, and paged past.
      const events: unknown[] = page.oversized === undefined
        ? page.events
        : [{ seq: page.oversized.seq, type: "archive_omitted", reason: "too_large", bytes: page.oversized.bytes }];
      const lastSeq = page.oversized?.seq ?? page.events.at(-1)?.seq;
      return { events, ...(page.more && lastSeq !== undefined ? { cursor: String(lastSeq) } : {}) };
    }),
  };
}

/** A session the archive shows: a top-level one, in a mode the previous app ran. */
function archived(r: SessionRow): boolean {
  return r.parentSessionId === undefined && ARCHIVE_MODES.has(r.mode ?? "code");
}

function listCursor(cursor: string): { updatedAt: number; id: string } {
  const m = LIST_CURSOR.exec(cursor);
  if (m === null) throw new ContractError("invalid", "archive.list: a bad cursor");
  return { updatedAt: Number(m[1]), id: m[2]! };
}

/** When the session last changed: its log's last write, never before it was made. */
function updatedAtOf(store: ArchiveDeps["store"], r: SessionRow): number {
  let at = r.createdAt;
  try {
    at = Math.max(at, store.lastEventTs(r.sessionId));
  } catch {
    // No log: the session's creation.
  }
  return at;
}

function viewOf(store: ArchiveDeps["store"], r: SessionRow, updatedAt: number): ArchivedSessionView {
  // The store's title falls back to the first message's first line already.
  const title = r.title;
  return {
    id: r.sessionId,
    ...(title === undefined || title === "" ? {} : { title: title.slice(0, TITLE_MAX) }),
    mode: (r.mode ?? "code") as ArchivedSessionView["mode"],
    ...(r.cwd === undefined ? {} : { project: r.cwd }),
    ...(r.model === undefined ? {} : { model: r.model }),
    createdAt: r.createdAt,
    updatedAt,
    // The index's own count (kept as messages are appended), never a log read.
    messages: store.messageCount(r.sessionId),
  };
}
