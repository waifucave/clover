// The seam every in-process session of the embedded runtime shares (lane A): a bot's conversation (driver.ts), an
// in-process subagent (subagent-backend.ts), and lane K's in-process coding agent (clover-code). Each one is a `query()`
// over the embedded host's spawn hook, with the core's brand on the Clover home, an environment from an allow-list,
// and, for a real model, the daemon's provider fill (the provider, the credential broker, the model plugins' adapters).
// Owner: lane A; lane K builds on it.
import type { Options, SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { buildCoreBrand } from "../brand";
import { testProviderNameFor } from "../provider-selection";

/** What the daemon hands every in-process session. */
export interface EmbeddedSessionDeps {
  /** The Clover home: the runtime's own home (`CLOVER_HOME`), its transcripts. */
  home: string;
  profile?: string;
  /** The embedded runtime's spawn hook (`createEmbeddedSessionHost().spawn`). */
  spawn: SpawnClaudeCodeProcess;
  /** Fills what a real model needs into a session's options (the daemon's); a `winter-test/*` model needs nothing. */
  provider?(model: string, options: Options): void | Promise<void>;
  /** Extra environment for the runtime (never secrets). */
  env?: Record<string, string>;
}

/** The environment variables a session's runtime inherits from the daemon; nothing else does. */
export const EMBEDDED_ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "LANG"] as const;

/** The options every in-process session starts from: brand, model, folder, environment and spawn hook. The caller
 *  adds its prompt, tools, servers, permissions and transcript (`resume` or `sessionId`). */
export function embeddedSessionOptions(deps: Pick<EmbeddedSessionDeps, "home" | "profile" | "spawn" | "env">, s: { model: string; effort?: string; cwd: string }): Options {
  const env: Record<string, string> = {};
  for (const key of EMBEDDED_ENV_ALLOW) {
    const v = process.env[key];
    if (typeof v === "string" && v !== "") env[key] = v;
  }
  Object.assign(env, deps.env);
  // Pinned last, so nothing a caller passes moves the home or the profile.
  env.CLOVER_HOME = deps.home;
  env.CLOVER_PROFILE = deps.profile ?? "";
  const testProvider = testProviderNameFor(s.model);
  if (testProvider !== undefined) env.WINTER_TEST_PROVIDER = testProvider;
  return {
    brand: buildCoreBrand(undefined, deps.home),
    model: s.model,
    ...(s.effort === undefined ? {} : { effort: s.effort as Options["effort"] }),
    cwd: s.cwd,
    env,
    spawnClaudeCodeProcess: deps.spawn,
    settingSources: [],
  };
}

/** The daemon's provider fill, after the caller's options are complete; a `winter-test/*` model skips it. The fill gives
 *  a model what it needs and nothing that widens the session: a fill that sets `hostMessaging` (the runtime's own
 *  `SendMessage` and `TaskStop` would reach the host's other sessions), `allowedTools`, `permissions.allow` or a settings
 *  source is refused, and the session doesn't start. */
export async function fillProvider(deps: Pick<EmbeddedSessionDeps, "provider">, options: Options): Promise<void> {
  const model = options.model;
  if (model === undefined || testProviderNameFor(model) !== undefined) return;
  const before = widening(options);
  await deps.provider?.(model, options);
  const after = widening(options);
  if (after !== before) throw new Error(`the provider fill for ${model} widened the session (${after}); it may only give the model what it needs`);
}

/** What in a session's options would widen what it may do, as one comparable string ("" for nothing). */
export function widening(options: Options): string {
  const o = options as Options & { hostMessaging?: unknown; allowedTools?: unknown; permissions?: { allow?: unknown } };
  return [
    o.hostMessaging !== undefined ? "hostMessaging" : "",
    o.allowedTools !== undefined && (!Array.isArray(o.allowedTools) || o.allowedTools.length > 0) ? "allowedTools" : "",
    o.permissions?.allow !== undefined && (!Array.isArray(o.permissions.allow) || o.permissions.allow.length > 0) ? "permissions.allow" : "",
    Array.isArray(o.settingSources) && o.settingSources.length > 0 ? "settingSources" : "",
  ].filter((x) => x !== "").join(", ");
}
