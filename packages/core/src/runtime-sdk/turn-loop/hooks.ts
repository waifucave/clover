// The turn loop's hook events (spec §5.3 "Hook order", "What each event may return", "Handlers"; the plugin SDK's hook
// catalog), fired by lane A's bot driver and run on the plugins' `hooks` entries through lane B's plugin host.
// Owner: lane A (the events and their order); lane B owns the registry, the host and the catalog.
//
// * **Events:** `tool.before` and `tool.after` around each tool call, `message.in` on each message before the model
//   sees it (the one that starts a turn and each one that folds in), `message.out` on the bot's text before it is
//   stored and shown, `turn.start` and `turn.end`, `compact.before` and `compact.after`.
// * **Order:** the hooks on one event run one after another in the order of their plugins' ids (`hookOrder`), each
//   seeing the last one's output.
// * **What each may return** (`HOOK_RETURNS`): `tool.before` may deny, ask or replace the input, never allow;
//   `tool.after` may replace the result; `message.in` and `message.out` the text; `turn.start` a labelled note; the
//   rest only observe. Anything else a hook returns is ignored. A deny stops the hooks after it.
// * **A hook that throws or runs past its `timeoutMs`** (10 seconds by default, never more than 30 seconds: inline
//   hooks sit on the turn's path) is skipped and reported (`onSkipped`, which Settings shows), except a BLOCKING hook:
//   one on an event whose result can deny (`HOOK_RETURNS` lists "deny": today only `tool.before`) fails CLOSED, so the
//   call is denied with a reason naming the plugin, the hook and why (crashed or timed out). `message.in`,
//   `message.out`, `tool.after`, `turn.start` and the rest can't deny anything, so they fail open.
// * **Scope** (§5.1): an entry whose `scope` (or its plugin's) leaves bots out never runs on a bot's session.
// * **Tool filter:** `tools` takes exact names or patterns with `*` (`hookMatchesTool`).
// * **Who it runs as:** the session that made the call (R7), so the API calls the hook makes act for that session.
// * A `command` hook (Claude Code's hook protocol) needs a process in lane C's sandbox; until that lands it is skipped,
//   reported once per entry.
import type { Caller } from "@waifucave/clover-protocol";
import { claudeEventNameOf, hookMatchesTool, hookOrder, HOOK_DEFAULT_TIMEOUT_MS, HOOK_RETURNS, type HookEvent, type HookInput } from "../../../../plugin-sdk/src/catalogs/hooks";
import type { PluginHost } from "../../contracts/plugin-host";
import type { FencedRunResult, FencedSpawner } from "../../fence/spawn";
import type { Contribution, PluginRegistry } from "../../contracts/plugin-registry";

export type { HookEvent, HookInput };

/** The session a hook event is about. */
export interface HookSession {
  id: string;
  kind: "bot" | "side-thread" | "agent" | "coding";
  caller: Caller;
  bot?: string;
  computer: string;
}

/** What the turn loop asks of the hooks: each event, with what its hooks may change. */
export interface TurnHooks {
  toolBefore(s: HookSession, tool: { name: string; callId: string }, input: unknown, signal?: AbortSignal): Promise<{ deny?: string; ask?: string; input: unknown }>;
  toolAfter(s: HookSession, tool: { name: string; callId: string }, input: unknown, result: unknown, signal?: AbortSignal): Promise<unknown>;
  messageIn(s: HookSession, text: string, signal?: AbortSignal): Promise<string>;
  messageOut(s: HookSession, text: string, signal?: AbortSignal): Promise<string>;
  /** The notes the hooks add to the turn. */
  turnStart(s: HookSession, signal?: AbortSignal): Promise<{ label: string; text: string; pluginId: string; hook: string }[]>;
  turnEnd(s: HookSession, text?: string): Promise<void>;
  compactBefore(s: HookSession): Promise<void>;
  compactAfter(s: HookSession): Promise<void>;
  /** Whether any hook is on for `message.out` (replies show only after it runs, §5.3). */
  rewritesReplies(): boolean;
}

/** No hooks at all. */
export const NO_HOOKS: TurnHooks = {
  toolBefore: async (_s, _t, input) => ({ input }),
  toolAfter: async (_s, _t, _i, result) => result,
  messageIn: async (_s, text) => text,
  messageOut: async (_s, text) => text,
  turnStart: async () => [],
  turnEnd: async () => {},
  compactBefore: async () => {},
  compactAfter: async () => {},
  rewritesReplies: () => false,
};

/** A `hooks` entry as the manifest gives it (`HookSchema`). */
interface HookEntryValue {
  id: string;
  on: readonly HookEvent[];
  tools?: readonly string[];
  handler?: string;
  command?: string;
  timeoutMs?: number;
  scope?: "bots" | "agents" | "both";
}

export interface PluginHooksOptions {
  registry: Pick<PluginRegistry, "entries" | "get">;
  host: Pick<PluginHost, "invoke">;
  /** A hook skipped: it threw, ran past its limit, or can't run here yet. Settings shows it. */
  onSkipped?(skip: { pluginId: string; hook: string; event: HookEvent; reason: string }): void;
  /** The door a `command` hook runs through (lane C's `hookSpawner`: the fenced process, or a refusal where there is
   *  no fence). Left out, a command hook is skipped and reported. */
  commandSpawner?: FencedSpawner;
}

/** The most a hook may run, a `handler` or a `command`: either holds the turn (or the message) up while it runs. */
export const INLINE_HOOK_MAX_TIMEOUT_MS = 30_000;
/** The events whose hooks can deny the action; a crash or timeout there fails closed. */
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set((Object.keys(HOOK_RETURNS) as HookEvent[]).filter((e) => HOOK_RETURNS[e].includes("deny")));
/** Longest reason that reaches a log line, Settings or a denial. */
const REASON_MAX = 300;

/** One line, no control characters, at most `REASON_MAX` characters. */
export function sanitizeReason(reason: string): string {
  // eslint-disable-next-line no-control-regex
  const one = reason.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
  return one.length > REASON_MAX ? `${one.slice(0, REASON_MAX - 1)}…` : one;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function scopeOf(c: Contribution, registry: PluginHooksOptions["registry"]): "bots" | "agents" | "both" {
  const own = (c.value as HookEntryValue).scope;
  if (own !== undefined) return own;
  const plugin = registry.get(c.pluginId)?.manifest as { scope?: "bots" | "agents" | "both" } | undefined;
  return plugin?.scope ?? "both";
}

function servesSession(scope: "bots" | "agents" | "both", kind: HookSession["kind"]): boolean {
  if (scope === "both") return true;
  return scope === "bots" ? kind === "bot" || kind === "side-thread" : kind === "agent" || kind === "coding";
}

/** The turn loop's hooks over the plugins' `hooks` entries. */
export function pluginHooks(o: PluginHooksOptions): TurnHooks {
  const reportedCommand = new Set<string>();

  const hooksFor = (event: HookEvent, s: HookSession, tool?: string): { pluginId: string; entry: HookEntryValue }[] => {
    const active = o.registry.entries("hooks").filter((c) => c.state === "active");
    const matching = active.filter((c) => {
      const v = c.value as HookEntryValue;
      return Array.isArray(v.on) && v.on.includes(event) && servesSession(scopeOf(c, o.registry), s.kind) && (tool === undefined || hookMatchesTool(v.tools, tool));
    });
    return hookOrder(matching.map((c) => ({ pluginId: c.pluginId, entry: c.value as HookEntryValue })));
  };

  /** Runs each hook in order; `step` folds its (allowed) output into the running value. */
  async function run<T>(event: HookEvent, s: HookSession, input: Omit<HookInput, "event" | "session" | "bot" | "computer">, initial: T, step: (acc: T, out: Record<string, unknown>, hook: { pluginId: string; id: string }) => { value: T; stop?: boolean }, signal?: AbortSignal, tool?: string): Promise<T> {
    let acc = initial;
    for (const { pluginId, entry } of hooksFor(event, s, tool)) {
      const failClosed = (why: string): boolean => {
        if (!BLOCKING_EVENTS.has(event)) return false;
        const reason = sanitizeReason(`the hook "${entry.id}" of plugin "${pluginId}" ${why}, so the action was refused`);
        const next = step(acc, { deny: { reason } }, { pluginId, id: entry.id });
        acc = next.value;
        return next.stop === true;
      };
      if (entry.handler === undefined && entry.command === undefined) continue;
      if (entry.handler === undefined && o.commandSpawner === undefined) {
        const key = `${pluginId}/${entry.id}`;
        if (!reportedCommand.has(key)) {
          reportedCommand.add(key);
          o.onSkipped?.({ pluginId, hook: entry.id, event, reason: sanitizeReason("a command hook has no process door on this computer yet") });
        }
        continue;
      }
      const args: HookInput = {
        event,
        session: { id: s.id, kind: s.kind, caller: s.caller },
        ...(s.bot === undefined ? {} : { bot: s.bot }),
        computer: s.computer,
        ...input,
        ...(event === "message.in" || event === "message.out" ? { text: acc as unknown as string } : {}),
        ...(event === "tool.before" ? { input: (acc as unknown as { input: unknown }).input } : {}),
        ...(event === "tool.after" ? { result: acc } : {}),
      };
      let out: unknown;
      if (entry.handler === undefined) {
        // A `command` hook: Claude Code's protocol (the input as JSON on stdin; JSON on stdout; exit 2 denies, with its
        // stderr as the reason), run through the process door as the hooked session (`who`), never as the core or the
        // plugin. Where the door can't run it (no fence: `refused`), a hook that can deny denies: the action is never
        // let through unhooked.
        const folder = o.registry.get(pluginId)?.folder;
        if (folder === undefined || folder === "") {
          // No folder of its own (the plugin went away mid-turn): it never runs in the core's own directory.
          o.onSkipped?.({ pluginId, hook: entry.id, event, reason: "the plugin has no folder on this computer" });
          if (failClosed("couldn't run (the plugin has no folder on this computer)")) break;
          continue;
        }
        // Clover's input with Claude Code's names beside it, so a wrapped Claude Code hook reads what it expects.
        const stdin = JSON.stringify({ ...args, ...claudeHookInput(event, s, folder, args) });
        if (stdin.length > COMMAND_HOOK_STDIN_MAX) {
          o.onSkipped?.({ pluginId, hook: entry.id, event, reason: "its input is too large to hand to a command hook" });
          if (failClosed("couldn't be given its input (too large)")) break;
          continue;
        }
        let r: FencedRunResult;
        try {
          r = await o.commandSpawner!.run({
            command: entry.command!,
            cwd: folder,
            env: commandHookEnv(pluginId, folder, s),
            stdin,
            timeoutMs: Math.min(entry.timeoutMs ?? HOOK_DEFAULT_TIMEOUT_MS, INLINE_HOOK_MAX_TIMEOUT_MS),
            ...(signal === undefined ? {} : { signal }),
            // The plugin's own fence (its door builds it from `pluginId`); the session lends its project folders.
            who: { caller: s.caller, hook: entry.id, pluginId },
          });
        } catch (err) {
          if (signal?.aborted === true) throw err;
          r = { kind: "refused", reason: err instanceof Error ? err.message : String(err) };
        }
        if (signal?.aborted === true) throw signal.reason ?? new Error("aborted");
        if (r.kind === "refused") {
          o.onSkipped?.({ pluginId, hook: entry.id, event, reason: sanitizeReason(r.reason) });
          if (failClosed(`couldn't run (${sanitizeReason(r.reason)})`)) break;
          continue;
        }
        if (r.kind === "timeout") {
          o.onSkipped?.({ pluginId, hook: entry.id, event, reason: "timed out" });
          if (failClosed("timed out")) break;
          continue;
        }
        if (r.code === 2) {
          // Exit 2: a hook that can deny denies, with its stderr; on any other event it's an error, reported.
          const said = sanitizeReason(r.stderr) || "a plugin's hook refused it";
          if (!BLOCKING_EVENTS.has(event)) {
            o.onSkipped?.({ pluginId, hook: entry.id, event, reason: sanitizeReason(`exited 2: ${said}`) });
            continue;
          }
          const next = step(acc, { deny: { reason: said } }, { pluginId, id: entry.id });
          acc = next.value;
          if (next.stop === true) break;
          continue;
        }
        if (r.code !== 0) {
          o.onSkipped?.({ pluginId, hook: entry.id, event, reason: sanitizeReason(`exited ${r.code}`) });
          if (failClosed(`failed (exit ${r.code})`)) break;
          continue;
        }
        const stdout = r.stdout.trim();
        if (stdout === "") continue;
        try {
          out = JSON.parse(stdout) as unknown;
        } catch {
          o.onSkipped?.({ pluginId, hook: entry.id, event, reason: "its output isn't JSON" });
          if (failClosed("answered something that isn't JSON")) break;
          continue;
        }
        if (isObject(out)) {
          const mapped = fromClaudeHookOutput(event, out);
          if (mapped === null) {
            o.onSkipped?.({ pluginId, hook: entry.id, event, reason: "its output names another event" });
            if (failClosed("answered for another event")) break;
            continue;
          }
          out = mapped;
        }
      } else {
        try {
          out = await o.host.invoke({
            pluginId, handler: entry.handler, args, caller: s.caller, session: s.id,
            timeoutMs: Math.min(entry.timeoutMs ?? HOOK_DEFAULT_TIMEOUT_MS, INLINE_HOOK_MAX_TIMEOUT_MS), ownLimit: true,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (err) {
          if (signal?.aborted === true) throw err;
          const timedOut = (err as { code?: unknown } | null)?.code === "timeout";
          const detail = err instanceof Error ? err.message : String(err);
          o.onSkipped?.({ pluginId, hook: entry.id, event, reason: sanitizeReason(detail) });
          // Fail closed: the reason carries no stack and none of the error's text, which might hold a secret.
          if (failClosed(timedOut ? "timed out" : "crashed")) break;
          continue;
        }
      }
      if (!isObject(out)) continue;
      // Only what the event allows (§5.3); `event` in the output, when given, must be this one.
      if (out.event !== undefined && out.event !== event) continue;
      const allowed = HOOK_RETURNS[event];
      const filtered: Record<string, unknown> = {};
      for (const k of allowed) if (k in out) filtered[k] = out[k];
      const next = step(acc, filtered, { pluginId, id: entry.id });
      acc = next.value;
      if (next.stop === true) break;
    }
    return acc;
  }

  const text = (event: "message.in" | "message.out") => (s: HookSession, t: string, signal?: AbortSignal) =>
    run<string>(event, s, {}, t, (acc, out) => ({ value: typeof out.text === "string" ? out.text : acc }), signal);

  return {
    async toolBefore(s, tool, input, signal) {
      let reason: { deny?: string; ask?: string } = {};
      const r = await run<{ input: unknown }>("tool.before", s, { tool }, { input }, (acc, out) => {
        if (isObject(out.deny)) {
          reason = { deny: typeof out.deny.reason === "string" ? out.deny.reason : "a plugin's hook refused it" };
          return { value: acc, stop: true };
        }
        if (isObject(out.ask) && reason.ask === undefined) reason = { ...reason, ask: typeof out.ask.reason === "string" ? out.ask.reason : "a plugin's hook asks" };
        return { value: "input" in out ? { input: out.input } : acc };
      }, signal, tool.name);
      return { ...reason, input: r.input };
    },
    toolAfter: (s, tool, input, result, signal) =>
      run<unknown>("tool.after", s, { tool, input }, result, (acc, out) => ({ value: "result" in out ? out.result : acc }), signal, tool.name),
    messageIn: text("message.in"),
    messageOut: text("message.out"),
    async turnStart(s, signal) {
      const notes: { label: string; text: string; pluginId: string; hook: string }[] = [];
      await run<null>("turn.start", s, {}, null, (acc, out, hook) => {
        const n = out.note;
        if (isObject(n) && typeof n.label === "string" && typeof n.text === "string") notes.push({ label: n.label.slice(0, 200), text: n.text.slice(0, 20_000), pluginId: hook.pluginId, hook: hook.id });
        return { value: acc };
      }, signal);
      return notes;
    },
    async turnEnd(s, t) {
      await run<null>("turn.end", s, t === undefined ? {} : { text: t }, null, (acc) => ({ value: acc }));
    },
    async compactBefore(s) {
      await run<null>("compact.before", s, {}, null, (acc) => ({ value: acc }));
    },
    async compactAfter(s) {
      await run<null>("compact.after", s, {}, null, (acc) => ({ value: acc }));
    },
    rewritesReplies: () => o.registry.entries("hooks").some((c) => c.state === "active" && (c.value as HookEntryValue).on?.includes("message.out")),
  };
}

/** The most a command hook's stdin may hold; past it a blocking hook denies, as it couldn't judge the input. */
export const COMMAND_HOOK_STDIN_MAX = 8 * 1024 * 1024;

/** Claude Code's hook input names (its hooks reference): `hook_event_name`, `session_id`, `cwd`, and by event
 *  `tool_name`/`tool_input`, `tool_response`, `prompt`. An event Claude Code has no name for gets none. */
function claudeHookInput(event: HookEvent, s: HookSession, cwd: string, args: HookInput): Record<string, unknown> {
  const name = claudeEventNameOf(event);
  const out: Record<string, unknown> = { session_id: s.id, cwd };
  if (name !== undefined) out.hook_event_name = name;
  if (args.tool !== undefined) { out.tool_name = args.tool.name; out.tool_use_id = args.tool.callId; }
  if (event === "tool.before" || event === "tool.after") out.tool_input = args.input;
  if (event === "tool.after") out.tool_response = args.result;
  if (event === "message.in") out.prompt = args.text;
  return out;
}

/** A command hook's output in Clover's shape: Clover's own fields as they are, and Claude Code's mapped onto them
 *  (its hooks reference). On `tool.before`: `decision: "block"` and `continue: false` deny (with `reason` /
 *  `stopReason`); `hookSpecificOutput.permissionDecision` `deny` denies and `ask` asks, with its
 *  `permissionDecisionReason`, while `allow` is ignored (a hook never allows, §5.3); `hookSpecificOutput.updatedInput`
 *  replaces the input. A deny from either side wins. Null when `hookSpecificOutput.hookEventName` names another event:
 *  that output isn't this event's. */
export function fromClaudeHookOutput(event: HookEvent, out: Record<string, unknown>): Record<string, unknown> | null {
  const specific = isObject(out.hookSpecificOutput) ? out.hookSpecificOutput : undefined;
  if (specific !== undefined && specific.hookEventName !== undefined && specific.hookEventName !== claudeEventNameOf(event)) return null;
  if (event !== "tool.before") return out;
  const mapped: Record<string, unknown> = { ...out };
  const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() !== "" ? v : fallback);
  if (!isObject(mapped.deny)) {
    if (out.decision === "block") mapped.deny = { reason: text(out.reason, "a plugin's hook blocked it") };
    else if (out.continue === false) mapped.deny = { reason: text(out.stopReason, "a plugin's hook stopped it") };
    else if (specific?.permissionDecision === "deny") mapped.deny = { reason: text(specific.permissionDecisionReason, "a plugin's hook refused it") };
  }
  if (!isObject(mapped.ask) && specific?.permissionDecision === "ask") mapped.ask = { reason: text(specific.permissionDecisionReason, "a plugin's hook asks") };
  if (!("input" in mapped) && specific !== undefined && isObject(specific.updatedInput)) mapped.input = specific.updatedInput;
  return mapped;
}

/** A command hook's whole environment: nothing of the core's is inherited (no key, no token), only what a hook
 *  written for Claude Code expects to find, under Clover's names and Claude Code's. */
function commandHookEnv(pluginId: string, folder: string, s: HookSession): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CLOVER_PLUGIN_ID: pluginId,
    CLOVER_SESSION_ID: s.id,
    CLOVER_PLUGIN_ROOT: folder,
    CLAUDE_PLUGIN_ROOT: folder,
  };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return env;
}
