import { join } from "node:path";
import type { HandlerContext } from "@waifucave/moss-plugin-sdk";
import {
  fileKey, readFiles, type FileCursor, type UsageIngestArgs, type UsageIngestReply, type UsagePlanArgs, type UsagePlanReading, type UsagePlanReply,
} from "@waifucave/moss-plugin-sdk/usage-source";
import { codexPlanFromAppServer, codexPlanFromRollouts, codexRecordOf, codexRollouts, codexStateOf } from "./codex";

// The Codex source (spec §12 "Usage sources"): its plan windows through its own `codex app-server`, then the newest
// rollout's `rate_limits`, then what MOSS's own Codex sessions reported; and its token counts from its session
// rollouts, `~/.codex/sessions` and `~/.codex/archived_sessions` (the two folders the manifest names).

/** Where Codex keeps its files: the user's home is the host process's `HOME`. */
export const codexHomeOf = (env: Readonly<Record<string, string | undefined>> = process.env): string => join(env.HOME ?? "/nonexistent-home", ".codex");

export interface CodexSourceOptions {
  /** `<codex home>`; the user's `~/.codex` unless a test names another. */
  home?: () => string;
  appServerTimeoutMs?: number;
}

const newer = (a: UsagePlanReading | undefined, b: UsagePlanReading | undefined): UsagePlanReading | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (b.at ?? -Infinity) > (a.at ?? -Infinity) ? b : a;
};

export async function plan(args: UsagePlanArgs, ctx: Pick<HandlerContext, "api">, o: CodexSourceOptions = {}): Promise<UsagePlanReply> {
  const outside = ctx.api.outside;
  if (outside === undefined) return { failure: "no-outside" };
  const log: string[] = [];
  const app = await codexPlanFromAppServer(outside, { now: () => args.now, ...(o.appServerTimeoutMs === undefined ? {} : { timeoutMs: o.appServerTimeoutMs }) });
  if (app.failure === "not-installed") return { notInstalled: true };
  if (app.reading !== undefined) return { reading: app.reading, keep: true };
  if (app.failure !== undefined) log.push(`codex app-server gave no plan reading: ${app.failure}`);
  // The latest probe failed: the last good one (a failed probe, a restart) against the passive rung, the newer of the two.
  let fromRollout: UsagePlanReading | undefined;
  try { fromRollout = await codexPlanFromRollouts(await codexRollouts((o.home ?? codexHomeOf)()), args.now); } catch { /* unreadable: no rung */ }
  const best = newer(args.kept, fromRollout);
  if (best !== undefined) return { reading: best, log };
  const reported = args.reports["codex-oauth"] ?? [];
  if (reported.length > 0) return { reading: { source: "winter-codex-oauth", windows: [], statusOnly: [...reported], at: Math.max(...reported.map((w) => w.at)) }, log };
  return { ...(app.failure === undefined ? {} : { failure: app.failure }), log };
}

// ── the token counts ────────────────────────────────────────────────────────────────────────────────────────────────

interface IngestState {
  v: 1;
  /** Each rollout's read cursor, by the hash of its path. */
  files: Record<string, FileCursor>;
}

/** The state as the core handed it back, or one made from what the core's store held before this state moved here. */
function stateOf(args: UsageIngestArgs): IngestState {
  const s = args.state as Partial<IngestState> | undefined;
  const files: Record<string, FileCursor> = {};
  if (typeof s === "object" && s !== null && typeof s.files === "object" && s.files !== null) {
    for (const [k, c] of Object.entries(s.files)) {
      if (typeof c === "object" && c !== null && typeof c.inode === "number" && typeof c.offset === "number") {
        files[k] = { inode: c.inode, offset: c.offset, ...(c.skipping === true ? { skipping: true } : {}), state: codexStateOf((c.state ?? {}) as Record<string, unknown>) as Record<string, unknown> };
      }
    }
    return { v: 1, files };
  }
  for (const [k, row] of Object.entries(args.legacy ?? {})) {
    if (!k.startsWith("codex:") || row.offset <= 0) continue;
    files[k] = { inode: row.inode, offset: row.offset, ...(row.state.__skipping === true ? { skipping: true } : {}), state: codexStateOf(row.state) as Record<string, unknown> };
  }
  return { v: 1, files };
}

export async function ingest(args: UsageIngestArgs, o: CodexSourceOptions & { fileBudgetBytes?: number; maxLineBytes?: number; maxRecords?: number } = {}): Promise<UsageIngestReply> {
  const state = stateOf(args);
  const found = await codexRollouts((o.home ?? codexHomeOf)());
  const read = await readFiles({
    files: found, cursors: state.files, keyOf: (f) => fileKey("codex", f.path),
    recordOf: (line, st, file) => codexRecordOf(line, st as ReturnType<typeof codexStateOf>, fileKey("codex", file.path).slice(6, 22), file.mtimeMs),
    ...(o.fileBudgetBytes === undefined ? {} : { fileBudgetBytes: o.fileBudgetBytes }), ...(o.maxLineBytes === undefined ? {} : { maxLineBytes: o.maxLineBytes }),
    ...(o.maxRecords === undefined ? {} : { maxRecords: o.maxRecords }),
  });
  // A rollout that is gone is forgotten (its records stay in the store).
  const alive = new Set(found.map((f) => fileKey("codex", f.path)));
  const files = Object.fromEntries(Object.entries(read.cursors).filter(([k]) => alive.has(k)));
  return { records: read.records, more: read.more, state: { v: 1, files } satisfies IngestState };
}
