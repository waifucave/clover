// The usage tests' door to the bundled source plugins (`plugins/usage-*`): the REAL handlers (their `plan` and `ingest`),
// called in-process through the core's own `outside.run` door (`plugin-host/api/outside.ts`) over FAKE executables on a
// private PATH. Nothing here reaches the user's own Codex, Claude Code, Antigravity or OpenCode, nor their `~/.codex` or
// `~/.claude`: a home nobody named is a folder that does not exist.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { outsideApi } from "../../src/plugin-host/api/outside";
import type { PlanStatusWindow } from "../../src/usage/plan";
import { UsageService as RealUsageService, type UsageServiceDeps } from "../../src/usage/service";
import type { UsageSourceEntry, UsageSourcePort } from "../../src/usage/sources";
import { ingest as codexIngest, plan as codexPlan } from "../../../../plugins/usage-codex/src/source";
import { ingest as claudeIngest, plan as claudePlan } from "../../../../plugins/usage-claude-code/src/source";
import { plan as agyPlan } from "../../../../plugins/usage-antigravity/src/source";
import { ingest as opencodeIngest } from "../../../../plugins/usage-opencode/src/source";

const PLUGINS = join(import.meta.dir, "../../../../plugins");

/** The entry a bundled plugin's manifest declares (what the registry would hand the core). */
export function bundledEntry(folder: string, over: Partial<UsageSourceEntry> = {}): UsageSourceEntry {
  const m = JSON.parse(readFileSync(join(PLUGINS, folder, "moss.json"), "utf8")) as { contributes: Record<string, Array<{ id: string; name?: string; handler: string; provides: Array<"plan" | "usage">; planEveryMs?: number }>> };
  const e = m.contributes["usage.sources"]![0]!;
  return { pluginId: folder, id: e.id, name: e.name ?? e.id, handler: e.handler, provides: e.provides, ...(e.planEveryMs === undefined ? {} : { planEveryMs: e.planEveryMs }), ...over };
}

export function programsOf(folder: string): string[] {
  const m = JSON.parse(readFileSync(join(PLUGINS, folder, "moss.json"), "utf8")) as { host: { outside?: { programs?: string[] } } };
  return m.host.outside?.programs ?? [];
}

type Exe = "codex" | "claude" | "agy" | "opencode";

export interface LegacyServiceDeps extends Partial<UsageServiceDeps> {
  db: UsageServiceDeps["db"];
  pricer: UsageServiceDeps["pricer"];
  tracking: UsageServiceDeps["tracking"];
  /** Where the apps keep their files (a folder nobody named is one that does not exist). */
  codexHome?: string;
  claudeHome?: string;
  /** The fake programs on the private PATH (absent = not installed). Read at every call, so a test may change them. */
  codexExecutable?: () => string | undefined;
  claudeExecutable?: () => string | undefined;
  agyExecutable?: () => string | undefined;
  opencodeExecutable?: () => string | undefined;
  mossCodexWindows?: () => PlanStatusWindow[];
  codexAppServerEveryMs?: number;
  claudeCliEveryMs?: number;
  agyCliEveryMs?: number;
  appServerTimeoutMs?: number;
  claudeCliTimeoutMs?: number;
  agyCliTimeoutMs?: number;
  agyTimeoutBackoffMs?: number;
  opencodeEveryMs?: number;
  opencodeSpawnBudget?: number;
  opencodeTimeoutMs?: number;
  fileBudgetBytes?: number;
  maxLineBytes?: number;
  claudeStatsMaxBytes?: number;
  /** The Codex plan's ladder is called at most this often (its rollout rung used to be re-read on its own: 0 = every ask). */
  fallbackEveryMs?: number;
  /** The sources present (default: all four). */
  present?: Array<"codex" | "claude-code" | "antigravity" | "opencode">;
}

const none = (): string => join(mkdtempSync(join(tmpdir(), "moss-usage-nowhere-")), "absent");

/** The port over the real source handlers. `calls` records every call (source, method). */
export function sourcePort(o: LegacyServiceDeps): UsageSourcePort & { calls: Array<{ id: string; method: string }> } {
  const calls: Array<{ id: string; method: string }> = [];
  const cache = new Map<string, string>();
  const bins = mkdtempSync(join(tmpdir(), "moss-usage-path-"));
  const exes: Record<Exe, (() => string | undefined) | undefined> = {
    codex: o.codexExecutable, claude: o.claudeExecutable, agy: o.agyExecutable, opencode: o.opencodeExecutable,
  };
  /** A PATH directory holding `name` -> the fake (a symlink when its own name differs). */
  const pathDir = (name: Exe): string | undefined => {
    const exe = exes[name]?.();
    if (exe === undefined) return undefined;
    if (basename(exe) === name) return dirname(exe);
    const key = `${name}:${exe}`;
    let dir = cache.get(key);
    if (dir === undefined) {
      dir = join(bins, String(cache.size));
      mkdirSync(dir, { recursive: true });
      symlinkSync(exe, join(dir, name));
      cache.set(key, dir);
    }
    return dir;
  };
  const mossHome = mkdtempSync(join(tmpdir(), "moss-usage-moss-"));
  const userHome = mkdtempSync(join(tmpdir(), "moss-usage-user-"));
  const entries: Record<string, UsageSourceEntry> = {
    codex: bundledEntry("usage-codex", { planEveryMs: o.codexAppServerEveryMs ?? o.fallbackEveryMs ?? 60_000 }),
    "claude-code": bundledEntry("usage-claude-code", { planEveryMs: o.claudeCliEveryMs ?? 300_000 }),
    antigravity: bundledEntry("usage-antigravity", { planEveryMs: o.agyCliEveryMs ?? 300_000 }),
    opencode: bundledEntry("usage-opencode"),
  };
  const folderOf: Record<string, string> = { codex: "usage-codex", "claude-code": "usage-claude-code", antigravity: "usage-antigravity", opencode: "usage-opencode" };
  const ctxFor = (id: string) => {
    const run = outsideApi({
      mossHome, userHome,
      path: () => (["codex", "claude", "agy", "opencode"] as const).map(pathDir).filter((d): d is string => d !== undefined).join(":"),
    })["outside.run"]!;
    const ctx = { pluginId: folderOf[id]!, record: { folder: join(PLUGINS, folderOf[id]!), manifest: { host: { outside: { programs: programsOf(folderOf[id]!) } } } } };
    return { api: { outside: { run: (program: string, args?: readonly string[], opts?: unknown) => run(ctx as never, [program, args, opts] as never) } } } as never;
  };
  const codexHome = o.codexHome ?? none();
  const claudeHome = o.claudeHome ?? none();
  return {
    calls,
    entries: () => (o.present ?? ["codex", "claude-code", "antigravity", "opencode"]).map((id) => entries[id]!),
    async call(entry, method, args) {
      calls.push({ id: entry.id, method });
      const a = args as never;
      const ctx = ctxFor(entry.id);
      switch (entry.id) {
        case "codex":
          return method === "plan"
            ? codexPlan(a, ctx, { home: () => codexHome, ...(o.appServerTimeoutMs === undefined ? {} : { appServerTimeoutMs: o.appServerTimeoutMs }) })
            : codexIngest(a, { home: () => codexHome, ...(o.fileBudgetBytes === undefined ? {} : { fileBudgetBytes: o.fileBudgetBytes }), ...(o.maxLineBytes === undefined ? {} : { maxLineBytes: o.maxLineBytes }) });
        case "claude-code":
          return method === "plan"
            ? claudePlan(a, ctx, { home: () => claudeHome, ...(o.claudeCliTimeoutMs === undefined ? {} : { cliTimeoutMs: o.claudeCliTimeoutMs }) })
            : claudeIngest(a, {
              home: () => claudeHome, ...(o.fileBudgetBytes === undefined ? {} : { fileBudgetBytes: o.fileBudgetBytes }),
              ...(o.maxLineBytes === undefined ? {} : { maxLineBytes: o.maxLineBytes }), ...(o.claudeStatsMaxBytes === undefined ? {} : { statsMaxBytes: o.claudeStatsMaxBytes }),
            });
        case "antigravity":
          return agyPlan(a, ctx, { ...(o.agyCliTimeoutMs === undefined ? {} : { timeoutMs: o.agyCliTimeoutMs }), ...(o.agyTimeoutBackoffMs === undefined ? {} : { backoffMs: o.agyTimeoutBackoffMs }) });
        default:
          return opencodeIngest(a, ctx, {
            ...(o.opencodeEveryMs === undefined ? {} : { everyMs: o.opencodeEveryMs }), ...(o.opencodeSpawnBudget === undefined ? {} : { spawnBudget: o.opencodeSpawnBudget }),
            ...(o.opencodeTimeoutMs === undefined ? {} : { timeoutMs: o.opencodeTimeoutMs }),
          });
      }
    },
  };
}

/** The deps of a usage service whose sources are the bundled plugins' handlers. */
export function legacyDeps(o: LegacyServiceDeps): UsageServiceDeps & { port: ReturnType<typeof sourcePort> } {
  const port = sourcePort(o);
  const {
    codexHome: _a, claudeHome: _b, codexExecutable: _c, claudeExecutable: _d, agyExecutable: _e, opencodeExecutable: _f, mossCodexWindows, codexAppServerEveryMs: _g,
    claudeCliEveryMs: _h, agyCliEveryMs: _i, appServerTimeoutMs: _j, claudeCliTimeoutMs: _k, agyCliTimeoutMs: _l, agyTimeoutBackoffMs: _m, opencodeEveryMs: _n,
    opencodeSpawnBudget: _o, opencodeTimeoutMs: _p, fileBudgetBytes: _q, maxLineBytes: _r, claudeStatsMaxBytes: _s, fallbackEveryMs: _u, present: _t, ...deps
  } = o;
  return { ...deps, sources: port, reports: () => ({ "codex-oauth": mossCodexWindows?.() ?? [] }), port };
}

/** The real service, built from the OLD option names (`codexExecutable`, `claudeHome`, …) over the source plugins. */
export class UsageService extends RealUsageService {
  readonly port: ReturnType<typeof sourcePort>;
  constructor(o: LegacyServiceDeps) {
    const deps = legacyDeps(o);
    super(deps);
    this.port = deps.port;
  }
}

export function newService(o: LegacyServiceDeps): { svc: UsageService; port: ReturnType<typeof sourcePort> } {
  const svc = new UsageService(o);
  return { svc, port: svc.port };
}
