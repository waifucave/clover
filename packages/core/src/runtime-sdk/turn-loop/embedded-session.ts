// The seam every in-process session of the embedded runtime shares (lane A): a bot's conversation (driver.ts), an
// in-process subagent (subagent-backend.ts), and lane K's in-process coding agent (clover-code). Each one is a `query()`
// over the embedded host's spawn hook, with the core's brand on the Clover home, an environment from an allow-list,
// and, for a real model, the daemon's provider fill (the provider, the credential broker, the model plugins' adapters).
// Owner: lane A; lane K builds on it.
import type { Options, SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildCoreBrand } from "../brand";
import { testProviderNameFor } from "../provider-selection";

/** What the daemon hands every in-process session. */
export interface EmbeddedSessionDeps {
  /** The Clover home: the runtime's own home (`CLOVER_HOME`), its transcripts. */
  home: string;
  profile?: string;
  /** The embedded runtime's spawn hook (`createEmbeddedSessionHost().spawn`). */
  spawn: SpawnClaudeCodeProcess;
  /** Fills what a real model needs (the daemon's); a `winter-test/*` model needs nothing. It is handed a view, not the
   *  session's options: only the model's keys come back (`fillProvider`, `PROVIDER_FILL_KEYS`). */
  provider?(model: string, options: Options): void | Promise<void>;
  /** Extra environment for the runtime (never secrets). */
  env?: Record<string, string>;
  /** macOS: the process holder (agent SDK 0.0.70's `native/process-holder.c`, built and signed by lane M's packaging
   *  under its own identity). Every command of the session runs as its child, so what a command leaves running,
   *  setsid'd and double-forked processes included, is adopted as a background task the pause stops. Default: the
   *  `clover-process-holder` beside the daemon's executable, when it is there; without one, the command's process group
   *  stands for what it leaves. */
  processHolder?: string;
}

/** The file name of the process holder beside the daemon (lane M's layout). */
export const PROCESS_HOLDER_FILE = "clover-process-holder";

/** The process holder the session's commands run under: the one named, else the one beside the daemon (macOS). */
export function processHolderFor(deps: Pick<EmbeddedSessionDeps, "processHolder">): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const path = deps.processHolder ?? join(dirname(process.execPath), PROCESS_HOLDER_FILE);
  return existsSync(path) ? path : undefined;
}

/** The environment variables a session's runtime inherits from the daemon; nothing else does. */
export const EMBEDDED_ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "LANG"] as const;

/** The options every in-process session starts from: brand, model, folder, environment and spawn hook. The caller
 *  adds its prompt, tools, servers, permissions and transcript (`resume` or `sessionId`). */
export function embeddedSessionOptions(deps: Pick<EmbeddedSessionDeps, "home" | "profile" | "spawn" | "env" | "processHolder">, s: { model: string; effort?: string; cwd: string }): Options {
  const env: Record<string, string> = {};
  for (const key of EMBEDDED_ENV_ALLOW) {
    const v = process.env[key];
    if (typeof v === "string" && v !== "") env[key] = v;
  }
  Object.assign(env, deps.env);
  // Pinned last, so nothing a caller passes moves the home or the profile.
  env.CLOVER_HOME = deps.home;
  env.CLOVER_PROFILE = deps.profile ?? "";
  // The runtime reads `<PREFIX>PROCESS_HOLDER` at each command (F8); set here, after the caller's, so only the seam names it.
  const holder = processHolderFor(deps);
  if (holder !== undefined) env.CLOVER_PROCESS_HOLDER = holder;
  else delete env.CLOVER_PROCESS_HOLDER;
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

/** The keys a provider fill may set: the model's own (which model, where it's served and how it's signed in), nothing
 *  that changes what the session may do. */
export const PROVIDER_FILL_KEYS = [
  "model", "fallbackModel", "provider", "modelProviders", "onCredentialResolve",
  "contextWindowTokens", "maxOutputTokens", "thinking", "maxThinkingTokens", "providerStallTimeoutMs",
] as const satisfies readonly (keyof Options)[];

type FillKey = (typeof PROVIDER_FILL_KEYS)[number];

/** What a provider fill is handed: the model's keys (`PROVIDER_FILL_KEYS`) to set, and the session's folder and
 *  environment to read (frozen). */
export type ProviderFillView = Pick<Options, FillKey> & { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> };

/** The daemon's provider fill, after the caller's options are complete; a `winter-test/*` model skips it. The fill never
 *  sees the rest of the options: it gets a view with the model's keys (`PROVIDER_FILL_KEYS`) and a frozen copy of the
 *  folder and environment, and only those keys come back. A fill that sets anything else on the view (the hooks, the
 *  approval check, the permission mode, the sandbox, tools, MCP servers, plugins, folders, host messaging), or changes
 *  the environment, is refused, and the session doesn't start. */
export async function fillProvider(deps: Pick<EmbeddedSessionDeps, "provider">, options: Options): Promise<void> {
  const model = options.model;
  if (model === undefined || testProviderNameFor(model) !== undefined || deps.provider === undefined) return;
  const view: Record<string, unknown> = {};
  for (const k of PROVIDER_FILL_KEYS) if (options[k] !== undefined) view[k] = options[k];
  const env = Object.freeze({ ...(options.env ?? {}) });
  if (options.cwd !== undefined) view.cwd = options.cwd;
  view.env = env;
  await deps.provider(model, view as Options);
  const allowed = new Set<string>(PROVIDER_FILL_KEYS);
  const refused = Object.keys(view).filter((k) => !allowed.has(k) && !(k === "cwd" && view.cwd === options.cwd) && !(k === "env" && view.env === env));
  if (refused.length > 0) throw new Error(`the provider fill for ${model} tried to set ${refused.join(", ")}; it may only set the model's own keys (${PROVIDER_FILL_KEYS.join(", ")})`);
  const o = options as Record<string, unknown>;
  for (const k of PROVIDER_FILL_KEYS) {
    if (view[k] === undefined) delete o[k];
    else o[k] = view[k];
  }
}
