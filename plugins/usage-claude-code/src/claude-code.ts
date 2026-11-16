import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  findFiles, percentOf, resetMs, runOutside, shortStr, staleness, timeOf, tokenCount,
  type FoundFile, type Outside, type PlanWindow, type PlanWindowKind, type UsagePlanReading, type UsageRecord,
} from "@waifucave/moss-plugin-sdk/usage-source";

// The user's own Claude Code (spec §12 "Usage sources") — READ ONLY, and only what is needed:
//
//  - TOKENS: its local transcripts, `<claude config dir>/projects/**/*.jsonl`. Only `assistant` records with a
//    `message.usage` are parsed, and only `message.usage`'s four counts (+ the one-hour cache-write subset),
//    `message.model`, `message.id`, `requestId`, `sessionId` and `timestamp` are kept. Never a message's content,
//    never the cwd, never the project directory's name (the read state is keyed by a hash of the path).
//  - HISTORY: its `/stats` cache, `<claude config dir>/stats-cache.json`, for the days the transcripts no longer hold.
//  - PLAN: Claude Code's own `/usage` report (`claude -p "/usage" …`, which asks with Claude Code's own login), and the
//    plan's name from its own `auth status`.
//  - NEVER Claude Code's Keychain item or token, `.credentials.json`, or `~/.claude.json` (which can hold API keys and
//    MCP servers' secrets): the manifest names only `~/.claude/projects` and `~/.claude/stats-cache.json`, and the fence
//    keeps the sign-in file unreadable inside a folder a plugin names. The plan's size ("20x") that `~/.claude.json`
//    gave is no longer read.
//    (https://code.claude.com/docs/en/legal-and-compliance) — the CLI makes its own call, MOSS reads its output.

/** One transcript line → at most one record (PURE). Streamed messages repeat across lines: `dedupe` is the message id
 *  plus the request id, so the first copy wins. */
export function claudeCodeRecordOf(line: string, fallbackAt: number): UsageRecord | undefined {
  if (!line.includes("\"assistant\"") || !line.includes("\"usage\"")) return undefined;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  if (obj.type !== "assistant") return undefined;
  const message = obj.message as Record<string, unknown> | undefined;
  if (typeof message !== "object" || message === null) return undefined;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const model = shortStr(message.model, 80);
  if (model === undefined || model === "<synthetic>") return undefined;
  const messageId = shortStr(message.id, 80);
  const requestId = shortStr(obj.requestId, 80);
  const uuid = shortStr(obj.uuid, 80);
  if (messageId === undefined && uuid === undefined) return undefined;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  if (input + output + cacheRead + cacheWrite === 0) return undefined;
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  const cacheWrite1h = typeof creation === "object" && creation !== null ? Math.min(tokenCount(creation.ephemeral_1h_input_tokens), cacheWrite) : 0;
  const sessionId = shortStr(obj.sessionId, 80);
  return {
    dedupe: messageId !== undefined ? `cc:${messageId}:${requestId ?? ""}` : `cc:u:${uuid}`,
    at: timeOf(obj.timestamp) ?? fallbackAt, ...(sessionId === undefined ? {} : { sessionId }),
    provider: "anthropic", model, input, output, cacheRead, cacheWrite, ...(cacheWrite1h > 0 ? { cacheWrite1h } : {}),
  };
}

export async function claudeCodeTranscripts(claudeHome: string): Promise<FoundFile[]> {
  return findFiles(join(claudeHome, "projects"), (name) => name.endsWith(".jsonl"), 5);
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────────────

function claudeKind(kind: string | undefined, group: string | undefined): { kind: PlanWindowKind; minutes?: number } {
  if (kind === "session" || group === "session" || kind === "five_hour") return { kind: "five_hour", minutes: 300 };
  if (kind === "weekly_all" || kind === "seven_day") return { kind: "weekly", minutes: 10_080 };
  if (kind === "weekly_scoped" || (kind ?? "").startsWith("seven_day_")) return { kind: "weekly_scoped", minutes: 10_080 };
  if (group === "weekly") return { kind: "weekly", minutes: 10_080 };
  return { kind: "other" };
}

/** A limit's model scope. Claude Code's `/usage` (2.1.293, seen live 2026-10-18) nests it:
 *  `scope: {model: {display_name: "Fable"}, surface: null}`; a bare string or `{model: "…"}` is read too. */
function scopeOf(v: unknown): string | undefined {
  if (typeof v === "string") return shortStr(v, 60);
  if (typeof v !== "object" || v === null) return undefined;
  const model = (v as Record<string, unknown>).model;
  if (typeof model === "string") return shortStr(model, 60);
  if (typeof model === "object" && model !== null) {
    const m = model as Record<string, unknown>;
    return shortStr(m.display_name, 60) ?? shortStr(m.name, 60) ?? shortStr(m.id, 60);
  }
  return undefined;
}

/** PURE: a stream-json `usage_report`'s limits as plan windows. */
export function windowsFromUsageReport(report: unknown, at: number, now: number): PlanWindow[] {
  if (typeof report !== "object" || report === null) return [];
  const rl = (report as Record<string, unknown>).rate_limits;
  const limits = Array.isArray(rl) ? rl : typeof rl === "object" && rl !== null ? (rl as Record<string, unknown>).limits : undefined;
  if (!Array.isArray(limits)) return [];
  const out: PlanWindow[] = [];
  for (const [i, raw] of limits.entries()) {
    if (typeof raw !== "object" || raw === null) continue;
    const l = raw as Record<string, unknown>;
    const usedPercent = percentOf(l.percent);
    if (usedPercent === undefined) continue;
    const k = claudeKind(shortStr(l.kind), shortStr(l.group));
    const resetsAt = resetMs(l.resets_at);
    const scope = scopeOf(l.scope);
    const severity = shortStr(l.severity, 24);
    out.push({
      id: `${shortStr(l.kind) ?? "limit"}${scope === undefined ? "" : `:${scope}`}:${i}`, kind: k.kind,
      ...(k.minutes === undefined ? {} : { windowMinutes: k.minutes }), usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt }), ...(scope === undefined ? {} : { scope }), ...(severity === undefined ? {} : { severity }),
      ...staleness(at, k.minutes, resetsAt, now),
    });
  }
  return out;
}

export const CLAUDE_USAGE_TIMEOUT_MS = 15_000;
/**
 * The invocation verified on a real install (no hooks, no MCP servers, no session file, stdin closed) plus two HARD
 * bounds in case `/usage` ever reaches the model loop: `--max-turns 1` and `--tools ""` (every built-in tool off; with
 * `--strict-mcp-config` and no `--mcp-config` there are no MCP tools either). Both are documented CLI flags
 * (https://code.claude.com/docs/en/cli-reference); a local command runs no turn and uses no tool, so neither applies to it.
 */
export const CLAUDE_USAGE_ARGS = [
  "-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config",
  "--max-turns", "1", "--tools", "",
] as const;

/** Why a `/usage` run was refused. `guard` (and `guard-model-turn`) mean `/usage` reached the model loop: the caller
 *  switches the rung off for this exact binary. Everything else is an ordinary failure, retried after the throttle. */
export type ClaudeCliFailure = "guard" | "guard-model-turn" | "no-local-command" | "error" | "no-report" | "no-result" | "timeout" | "spawn-failed" | "too-large" | "not-installed";

/** PURE: does a stream frame show a MODEL turn (an assistant message that used tokens, or any tool use)? */
export function isModelTurnSignal(msg: Record<string, unknown>): boolean {
  if (msg.type !== "assistant") return false;
  const m = msg.message as Record<string, unknown> | undefined;
  if (typeof m !== "object" || m === null) return false;
  const u = m.usage as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && (tokenCount(u.input_tokens) > 0 || tokenCount(u.output_tokens) > 0)) return true;
  return Array.isArray(m.content) && m.content.some((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_use");
}

/**
 * PURE: judge the stream `claude -p "/usage"` printed, a line each. Accepted ONLY when the turn's `result` says it was
 * the local `/usage` command (`local_command: "usage"`), cost nothing and ran no model turn. The `guard` failures (the
 * caller latches the binary) need POSITIVE evidence of the model loop: turns or cost above 0, another `local_command`, or
 * a model-turn signal in the stream (then also when the run ends without a result). A `result` naming no command
 * (an early startup error) and one with `is_error` but the local command (logged out, offline) are ordinary failures.
 */
export function judgeClaudeUsage(lines: readonly string[], now: number): { reading?: UsagePlanReading; failure?: ClaudeCliFailure } {
  let report: unknown;
  let sawModelTurn = false;
  for (const line of lines) {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (isModelTurnSignal(msg)) sawModelTurn = true;
    if (msg.type === "assistant" && msg.usage_report !== undefined) { report = msg.usage_report; continue; }
    if (msg.type !== "result") continue;
    const cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
    const turns = typeof msg.num_turns === "number" ? msg.num_turns : 0;
    // Latch only on POSITIVE evidence of the model loop: a turn, a cost, another local command — or a model-turn
    // signal earlier in the stream. A result naming no command at all (an early startup error) is ordinary.
    const other = typeof msg.local_command === "string" && msg.local_command !== "usage";
    if (other || cost > 0 || turns > 0) return { failure: "guard" };
    if (sawModelTurn) return { failure: "guard-model-turn" };
    if (msg.local_command !== "usage") return { failure: "no-local-command" };
    if (msg.is_error === true) return { failure: "error" };
    if (report === undefined) return { failure: "no-report" };
    const windows = windowsFromUsageReport(report, now, now);
    if (windows.length === 0) return { failure: "no-report" };
    return { reading: { source: "claude-cli", at: now, windows } };
  }
  return { failure: sawModelTurn ? "guard-model-turn" : "no-result" };
}

/** Run the user's `claude` for its `/usage` report through the program the manifest names (`api.outside.run`). The
 *  stream is read once the program ends, so an early stop on a model turn is the flags' (`--max-turns 1`, no tools). */
export async function claudePlanFromCli(outside: Outside, opts: { timeoutMs?: number; now: () => number }):
  Promise<{ reading?: UsagePlanReading; failure?: ClaudeCliFailure }> {
  const ran = await runOutside(outside, "claude", [...CLAUDE_USAGE_ARGS], { timeoutMs: opts.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS });
  if (ran.kind === "not-installed" || ran.kind === "spawn-failed" || ran.kind === "too-large") return { failure: ran.kind };
  const judged = judgeClaudeUsage(ran.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0), opts.now());
  if (judged.reading !== undefined || judged.failure === "guard" || judged.failure === "guard-model-turn") return judged;
  if (ran.kind === "timeout") return { failure: "timeout" };
  return judged;
}

/** `claude auth status --json`: Claude Code reporting its OWN sign-in, offline (user 2026-10-18: show the plan beside
 *  "Claude Code", like Codex's). Seen live: `{loggedIn, authMethod, …, subscriptionType: "max"}`. */
export const CLAUDE_AUTH_STATUS_ARGS = ["auth", "status", "--json"] as const;

/**
 * The user's Claude plan name ("max", "pro", …) from Claude Code's own `auth status`. ONLY `subscriptionType` is read;
 * the rest of the answer (email, organisation, ids) is parsed in memory and dropped — never kept, logged or sent.
 * Undefined when not signed in with claude.ai, or on any failure.
 */
export async function claudeSubscriptionType(outside: Outside, opts: { timeoutMs?: number } = {}): Promise<string | undefined> {
  const ran = await runOutside(outside, "claude", [...CLAUDE_AUTH_STATUS_ARGS], { timeoutMs: opts.timeoutMs ?? 8_000 });
  if (ran.kind !== "exited" && ran.kind !== "timeout") return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(ran.stdout.slice(0, 64 * 1024)); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const t = (parsed as Record<string, unknown>).subscriptionType;
  return typeof t === "string" && /^[A-Za-z0-9 _-]{1,24}$/.test(t) ? t : undefined;
}

/** A whole small file as text — the cap enforced on the bytes actually READ (at most cap + 1), whatever a stat said a
 *  moment before. `undefined` = missing or unreadable. */
export async function readCapped(path: string, maxBytes: number): Promise<string | "over-cap" | undefined> {
  try {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(maxBytes + 1);
      let read = 0;
      while (read < buf.length) {
        const { bytesRead } = await fh.read(buf, read, buf.length - read, read);
        if (bytesRead <= 0) break;
        read += bytesRead;
      }
      if (read > maxBytes) return "over-cap";
      return buf.subarray(0, read).toString("utf8");
    } finally {
      await fh.close().catch(() => undefined);
    }
  } catch { return undefined; }
}
