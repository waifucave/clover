// How an in-process session's own hooks join the hooks its base options bring (lane A; the bot driver and the in-process
// subagent backend). Nothing is dropped: for each event the session's own hooks go first (the pause, before anything else
// may run), then the base's, then any trailing check of its own. A base hook may refuse a call or ask about it, never
// allow it: an allow would skip the approval check (`canUseTool`), and with it the credential broker and the pause check
// after an approval, so the base's allows are taken out. Hooks from sources the runtime ranks higher run before these
// lists, so the trailing check holds the call even when such a hook went first.
import type { HookCallbackMatcher, Options } from "@waifucave/clover-agent-sdk";

type Hooks = NonNullable<Options["hooks"]>;
type HookEventName = keyof Hooks;

/** The events where a hook's answer can allow a call. */
const DECIDING_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PermissionRequest"]);

/** A hook's answer with any allow taken out: a refusal, a question and any other field stay. */
export function withoutAllow(out: unknown): unknown {
  if (out === null || typeof out !== "object") return out;
  const o = { ...(out as Record<string, unknown>) };
  if (o.decision === "approve") delete o.decision;
  const spec = o.hookSpecificOutput;
  if (spec !== null && typeof spec === "object") {
    const s = { ...(spec as Record<string, unknown>) };
    if (s.permissionDecision === "allow") {
      delete s.permissionDecision;
      delete s.permissionDecisionReason;
    }
    const d = s.decision;
    if (d !== null && typeof d === "object" && (d as { behavior?: unknown }).behavior === "allow") delete s.decision;
    o.hookSpecificOutput = s;
  }
  return o;
}

function noAllow(event: string, m: HookCallbackMatcher): HookCallbackMatcher {
  if (!DECIDING_EVENTS.has(event)) return m;
  return { ...m, hooks: m.hooks.map((h) => (async (...args: Parameters<typeof h>) => withoutAllow(await h(...args))) as typeof h) };
}

/** The base options' hooks with the session's own: its own first, then the base's (no allows), then `last`. */
export function mergedHooks(base: Options["hooks"], first: Options["hooks"], opts: { last?: Options["hooks"] } = {}): Hooks {
  const out: Hooks = {};
  const events = new Set([...Object.keys(first ?? {}), ...Object.keys(base ?? {}), ...Object.keys(opts.last ?? {})]) as Set<HookEventName>;
  for (const event of events) {
    out[event] = [...(first?.[event] ?? []), ...(base?.[event] ?? []).map((m) => noAllow(event, m)), ...(opts.last?.[event] ?? [])];
  }
  return out;
}
