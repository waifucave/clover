// The archive of the previous app's sessions (spec §14.1 "Existing … installs": old sessions stay readable in an
// archive view but never become a bot's history; the app's archive view, §5.5). Owner: lane D.
//
// They are this daemon's own inherited session store (code, chat and dispatch sessions, as the previous app kept them
// in this home): Clover never reads another install's home (other-installs.ts). Read-only here, and the user's alone.
//
// * `archive.list`: the top-level sessions, newest activity first (a dispatch session's children are its own), matched
//   by `query` against the title, the first message and the project folder, paged by `before` (the last page's oldest
//   `updatedAt`).
// * `archive.history`: a session's events as the store keeps them, oldest first, a page at a time (`cursor`: the seq
//   the next page starts after).
import { SESSIONS_METHODS, type ArchivedSessionView } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import type { SessionRow, SessionStore } from "./store";

const ARCHIVE_MODES = new Set(["code", "chat", "dispatch"]);
const LIST_DEFAULT = 50;
const HISTORY_DEFAULT = 200;
/** The longest title an archived session shows (the view's own limit). */
const TITLE_MAX = 500;

export interface ArchiveDeps {
  store: Pick<SessionStore, "list" | "read" | "lastEventTs" | "firstMessage">;
}

export function archiveMethods(deps: ArchiveDeps): Record<string, MethodHandler> {
  const M = SESSIONS_METHODS;
  return {
    [M.archiveList.name]: handler(M.archiveList, async ({ query, before, limit }, ctx) => {
      requireUser(ctx, "read the archive");
      const needle = query?.trim().toLowerCase();
      const rows = deps.store.list()
        .filter((r) => r.parentSessionId === undefined && ARCHIVE_MODES.has(r.mode ?? "code"))
        .filter((r) => needle === undefined || needle === "" || [r.title, deps.store.firstMessage(r.sessionId), r.cwd].some((t) => t?.toLowerCase().includes(needle)))
        .map((r) => ({ r, updatedAt: updatedAtOf(deps.store, r) }))
        .filter(({ updatedAt }) => before === undefined || updatedAt < before)
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.r.sessionId < b.r.sessionId ? -1 : 1));
      const n = limit ?? LIST_DEFAULT;
      const page = rows.slice(0, n);
      return { sessions: page.map(({ r, updatedAt }) => viewOf(deps.store, r, updatedAt)), more: rows.length > n };
    }),

    [M.archiveHistory.name]: handler(M.archiveHistory, async ({ id, cursor, limit }, ctx) => {
      requireUser(ctx, "read the archive");
      const row = deps.store.list().find((r) => r.sessionId === id);
      if (row === undefined || !ARCHIVE_MODES.has(row.mode ?? "code")) throw new ContractError("not_found", `no archived session ${id}`);
      const after = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      if (!Number.isSafeInteger(after) || after < 0) throw new ContractError("invalid", `archive.history: a bad cursor`);
      const n = limit ?? HISTORY_DEFAULT;
      const events = deps.store.read(id, after);
      const page = events.slice(0, n);
      const last = page.at(-1);
      return { events: page, ...(events.length > n && last !== undefined ? { cursor: String(last.seq) } : {}) };
    }),
  };
}

function updatedAtOf(store: ArchiveDeps["store"], r: SessionRow): number {
  try {
    return store.lastEventTs(r.sessionId);
  } catch {
    return r.createdAt;
  }
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
    updatedAt: Math.max(updatedAt, r.createdAt),
    messages: messagesOf(store, r.sessionId),
  };
}

/** How many messages the session holds: the user's and the assistant's, as its log keeps them. */
function messagesOf(store: ArchiveDeps["store"], id: string): number {
  try {
    return store.read(id).filter((e) => e.type === "user_message" || e.type === "assistant_message").length;
  } catch {
    return 0;
  }
}
