// The session panels' reads (spec §5.5 "Which panels a tab gets"): what a coding session's or an agent's column and its
// diff panel, and a bot's slim column, draw. Each serves what the core already knows, read only, nothing new kept:
// - `session.diff`: the changes in the session's folder (`diff.ts`), when the folder is on this computer.
// - `session.outputs`: the files the session delivered to its outputs folder (`<home>/outputs/<session>`), names only.
// - `session.context`: its last turn's measured prompt (`turn_completed.contextTokens`) against its model's window.
// - `session.connectors`: how many plugin MCP servers it gets, and how many of their plugins wait for a sign-in.
// The roles and the capability are the other session reads' (`conversation.read`); the server applies them first.
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { SESSIONS_METHODS, type SessionDiff, type SessionView } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { handler, type MethodHandler } from "../rpc/handler";
import { folderDiff } from "./diff";
import { outdirPath } from "./outdir";
import type { SessionRecord } from "../contracts/session-host";
import { projectRecords } from "./wire";

/** How far back `session.context` looks for the last measured turn, in records. */
export const CONTEXT_SCAN_RECORDS = 2_000;
const CONTEXT_SCAN_STEP = 200;

export interface SessionPanelDeps {
  /** The session's view (its kind, folder, computer, model), undefined for one this computer doesn't know. */
  view(id: string): SessionView | undefined;
  /** Its records (`DurableSessionHost.history`/`length`), for the last measured turn. */
  history(id: string, opts: { afterSeq: number; limit: number }): readonly SessionRecord[];
  length(id: string): number;
  /** A tree path as a folder on this computer, or why it isn't one (another computer's, not in the tree). */
  localFolder(root: string): { path: string } | { reason: string };
  /** The Clover home, where the outputs folders are. */
  home: string;
  /** A model tag's context window, when the catalog knows it. */
  contextWindowOf?(model: string): number | undefined;
  /** The plugin MCP servers a session gets, with whether each one's plugin waits for a sign-in. */
  connectorsOf?(view: SessionView): Promise<{ total: number; needSignIn: number }>;
}

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic", ".avif", ".bmp"]);
const PAGE = new Set([".html", ".htm", ".md", ".markdown", ".pdf"]);
const kindOf = (name: string): "page" | "file" | "image" => {
  const ext = extname(name).toLowerCase();
  return IMAGE.has(ext) ? "image" : PAGE.has(ext) ? "page" : "file";
};

export function sessionPanelMethods(deps: SessionPanelDeps): Record<string, MethodHandler> {
  const M = SESSIONS_METHODS;
  const viewOf = (id: string): SessionView => {
    const v = deps.view(id);
    if (v === undefined) throw new ContractError("not_found", `no session ${id}`);
    return v;
  };
  return {
    [M.sessionDiff.name]: handler(M.sessionDiff, async ({ id }): Promise<SessionDiff> => {
      const v = viewOf(id);
      const none = (notice: string): SessionDiff => ({ base: "", target: "working tree", targets: [], files: [], notice });
      if (v.root === undefined) return none("This session has no folder, so it has no changes to show.");
      const at = deps.localFolder(v.root);
      if ("reason" in at) return none(at.reason);
      return folderDiff(at.path);
    }),

    [M.sessionOutputs.name]: handler(M.sessionOutputs, async ({ id, limit }) => {
      viewOf(id);
      let dir: string;
      try { dir = outdirPath(deps.home, id); } catch { return { items: [], more: 0 }; }
      let names: string[];
      try { names = readdirSync(dir); } catch { return { items: [], more: 0 }; }
      const files = names
        .filter((n) => !n.startsWith(".") && n.length <= 255)
        .map((n) => { try { const st = statSync(join(dir, n)); return st.isFile() ? { n, at: st.mtimeMs } : undefined; } catch { return undefined; } })
        .filter((f): f is { n: string; at: number } => f !== undefined)
        .sort((a, b) => b.at - a.at || a.n.localeCompare(b.n));
      const max = limit ?? 20;
      return { items: files.slice(0, max).map((f) => ({ id: f.n, name: f.n, kind: kindOf(f.n) })), more: Math.max(0, files.length - max) };
    }),

    [M.sessionContext.name]: handler(M.sessionContext, async ({ id }) => {
      const v = viewOf(id);
      const window = v.model === undefined ? undefined : deps.contextWindowOf?.(v.model);
      if (window === undefined || window <= 0) return null;
      // Back from the end, a page at a time, for the last turn whose prompt was measured.
      const length = deps.length(id);
      for (let end = length; end > 0 && length - end < CONTEXT_SCAN_RECORDS; end -= CONTEXT_SCAN_STEP) {
        const start = Math.max(0, end - CONTEXT_SCAN_STEP);
        const events = projectRecords(deps.history(id, { afterSeq: start - 1, limit: end - start }), { kind: v.kind, sealed: true });
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i]!;
          if (e.type !== "turn_completed") continue;
          const tokens = e.contextTokens;
          if (typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0) return { used: Math.min(1, tokens / window), tokens, window };
        }
      }
      return null;
    }),

    [M.sessionConnectors.name]: handler(M.sessionConnectors, async ({ id }) => {
      const v = viewOf(id);
      return deps.connectorsOf === undefined ? { total: 0, needSignIn: 0 } : deps.connectorsOf(v);
    }),
  };
}
