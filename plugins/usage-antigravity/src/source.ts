import type { HandlerContext } from "@waifucave/moss-plugin-sdk";
import { runOutside, type Outside, type UsagePlanArgs, type UsagePlanReply } from "@waifucave/moss-plugin-sdk/usage-source";
import { AGY_TIMEOUT_BACKOFF_MS, antigravityPlanFromCli } from "./antigravity";

// The Antigravity source's `plan` (spec §12 "Usage sources"): `agy`'s own `/usage`, no other rung. What it remembers
// between calls, kept by the core: the binary latch (a `/usage` that once reached the model loop is not asked again
// until `agy` changes) and the timeout back-off (a run that outlived even its own `--print-timeout` waits hours).

interface PlanState {
  /** `agy`'s version when its `/usage` once reached the model loop; asked again only when it changes. */
  latched?: { version: string; reason: string };
  /** When a run last outlived its own timeout. */
  timedOutAt?: number;
}

const stateOf = (v: unknown): PlanState => {
  const s: PlanState = {};
  if (typeof v !== "object" || v === null) return s;
  const o = v as Record<string, unknown>;
  const l = o.latched as Record<string, unknown> | undefined;
  if (typeof l === "object" && l !== null && typeof l.version === "string" && typeof l.reason === "string") s.latched = { version: l.version, reason: l.reason };
  if (typeof o.timedOutAt === "number") s.timedOutAt = o.timedOutAt;
  return s;
};

/** `agy --version`'s first line: what tells a changed binary from the one that was latched. "" when it says nothing. */
async function versionOf(outside: Outside): Promise<string> {
  const r = await runOutside(outside, "agy", ["--version"], { timeoutMs: 8_000 });
  return r.kind === "exited" ? (r.stdout.split("\n")[0] ?? "").trim().slice(0, 80) : "";
}

export async function plan(args: UsagePlanArgs, ctx: Pick<HandlerContext, "api">, o: { timeoutMs?: number; backoffMs?: number } = {}): Promise<UsagePlanReply> {
  const outside = ctx.api.outside;
  if (outside === undefined) return { failure: "no-outside" };
  const state = stateOf(args.state);
  const log: string[] = [];
  const backoffMs = o.backoffMs ?? AGY_TIMEOUT_BACKOFF_MS;
  if (state.timedOutAt !== undefined && args.now - state.timedOutAt < backoffMs) {
    return { failure: "backoff", retryAfterMs: backoffMs - (args.now - state.timedOutAt) };
  }
  if (state.latched !== undefined) {
    if (state.latched.version === (await versionOf(outside))) return { failure: "latched" };
    delete state.latched;
  }
  const r = await antigravityPlanFromCli(outside, { now: () => args.now, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) });
  if (r.failure === "not-installed") return { notInstalled: true };
  let retryAfterMs: number | undefined;
  if (r.failure === "guard") {
    state.latched = { version: await versionOf(outside), reason: r.failure };
    log.push("agy /usage did not come back as the read-only command; not asked again until Antigravity changes");
  } else if (r.failure === "timeout") {
    state.timedOutAt = args.now;
    retryAfterMs = backoffMs;
    log.push("agy /usage outlived its own --print-timeout; not asked again for hours");
  } else if (r.failure !== undefined) {
    log.push(`agy /usage gave no plan reading: ${r.failure}`);
  }
  return {
    ...(r.reading === undefined ? {} : { reading: r.reading, keep: true }),
    ...(r.failure === undefined ? {} : { failure: r.failure }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    state: state.latched === undefined && state.timedOutAt === undefined ? null : state,
    log,
  };
}
