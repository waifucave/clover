import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { IslandUsageRegistry } from "../island/usage";
import { usageTrackingFrom, type Settings } from "../settings";
import { UsageDb } from "./db";
import { UsagePricer } from "./pricing";
import { UsageService } from "./service";
import { probeEnv, resolveExecutable } from "./spawn-lines";

// Boot wiring for usage tracking (`docs/claude/usage.md`). Whose apps: the daemon's `userHome` — the user's home folder
// for the daemon on its default home (`isDefaultCloverHome`), NONE for any other (a temp-home or test daemon): then
// nothing below falls back to a home folder, `$CODEX_HOME`, `$CLAUDE_CONFIG_DIR`, the install places or `$PATH`, and
// only an explicit `CLOVER_USAGE_*` or an injection names a root or an executable. Where the user's apps keep their
// files, for a daemon that has a `userHome`:
//  - Codex: `$CLOVER_USAGE_CODEX_HOME` (tests) → `$CODEX_HOME` → `<userHome>/.codex`;
//  - Claude Code: `$CLOVER_USAGE_CLAUDE_HOME` (tests) → `$CLAUDE_CONFIG_DIR` → `<userHome>/.claude`, and its
//    `.claude.json` (`$CLOVER_USAGE_CLAUDE_JSON` → `$CLAUDE_CONFIG_DIR/.claude.json` → `<userHome>/.claude.json`);
//  - the executables: `$CLOVER_USAGE_CODEX_EXECUTABLE` / `$CLOVER_USAGE_CLAUDE_EXECUTABLE` /
//    `$CLOVER_USAGE_AGY_EXECUTABLE` / `$CLOVER_USAGE_OPENCODE_EXECUTABLE` (authoritative: a missing path or "off" means none) → the usual install places
//    → `$PATH`.
// Both test preloads point every `CLOVER_USAGE_*` at nothing, so no test daemon ever reads or spawns the real ones, and
// switch the background plan checks off (`CLOVER_USAGE_BACKGROUND=off`).

/** What a usage service reads (diagnostics and tests): its roots, and the executables it would run now. */
export interface UsageSources {
  codexHome?: string;
  claudeHome?: string;
  claudeJsonPath?: string;
  executables(): { codex?: string | undefined; claude?: string | undefined; agy?: string | undefined; opencode?: string | undefined };
}

export interface UsageInjection {
  codexHome?: string | null;
  claudeHome?: string | null;
  claudeJsonPath?: string | null;
  codexExecutable?: string | null;
  claudeExecutable?: string | null;
  agyExecutable?: string | null;
  opencodeExecutable?: string | null;
  now?: () => number;
  /** The background catch-up: false = off (tests); its timings. */
  catchUp?: boolean;
  catchUpFirstMs?: number;
  catchUpEveryMs?: number;
  /** The background plan checks and the alarms' fast beats (`UsageService.startBackground`): false = off; its timings. */
  background?: boolean;
  backgroundEveryMs?: number;
  alarmBeatMs?: { codex?: number; "claude-code"?: number; antigravity?: number };
}

// The usual absolute install places, tried before `$PATH` (Homebrew, /usr/local, ~/.local, npm-global, the app bundle).
// Functions, never module constants: every process of the `clover-core` binary loads this module — the sandboxed
// automation worker too, whose environment has no HOME and whose seatbelt refuses the user lookup, so a `homedir()`
// at load throws there and the worker never starts.
export const codexInstalls = (home: string): string[] => [
  "/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(home, ".local/bin/codex"), join(home, ".npm-global/bin/codex"),
  "/Applications/Codex.app/Contents/Resources/codex",
];
export const claudeInstalls = (home: string): string[] => [
  "/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(home, ".local/bin/claude"), join(home, ".claude/local/claude"),
  join(home, ".npm-global/bin/claude"),
];
/** Antigravity's CLI (Homebrew installs it as `agy`). */
export const agyInstalls = (home: string): string[] => [
  "/opt/homebrew/bin/agy", "/usr/local/bin/agy", join(home, ".local/bin/agy"), join(home, ".npm-global/bin/agy"),
];
/** OpenCode (Homebrew, its own install script's `~/.opencode/bin`, npm). */
export const opencodeInstalls = (home: string): string[] => [
  "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode", join(home, ".opencode/bin/opencode"), join(home, ".local/bin/opencode"),
  join(home, ".npm-global/bin/opencode"),
];

/** The JS package managers' global bins (bun, volta, pnpm, every nvm node): a CLI installed through one of them is
 *  still "on this Mac" when the app's `$PATH` is the bare launchd one. */
export function packageManagerBins(name: string, home: string): string[] {
  const out = [join(home, ".bun/bin", name), join(home, ".volta/bin", name), join(home, "Library/pnpm", name)];
  try {
    for (const v of readdirSync(join(home, ".nvm/versions/node"))) out.push(join(home, ".nvm/versions/node", v, "bin", name));
  } catch { /* no nvm */ }
  return out;
}

/**
 * A daemon that must never read or spawn the user's own apps — every one booted OUTSIDE the tests and the real
 * daemon (the probes, the verify gates, the live and e2e suites, `check:idle-wakeups`): every root and executable is
 * none, the background plan beat and the catch-up off. `test/usage/script-daemons.test.ts` pins every such entry.
 */
export const USAGE_INERT: UsageInjection = Object.freeze({
  codexHome: null, claudeHome: null, claudeJsonPath: null, codexExecutable: null, claudeExecutable: null, agyExecutable: null,
  opencodeExecutable: null, catchUp: false, background: false,
});

/** The same for a daemon spawned as a process (`clover daemon run`, a compiled `clover-core`): its environment. */
export const USAGE_INERT_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLOVER_USAGE_CODEX_HOME: "off", CLOVER_USAGE_CLAUDE_HOME: "off", CLOVER_USAGE_CLAUDE_JSON: "off",
  CLOVER_USAGE_CODEX_EXECUTABLE: "off", CLOVER_USAGE_CLAUDE_EXECUTABLE: "off", CLOVER_USAGE_AGY_EXECUTABLE: "off",
  CLOVER_USAGE_OPENCODE_EXECUTABLE: "off", CLOVER_USAGE_BACKGROUND: "off", CLOVER_USAGE_CATCH_UP: "off",
});

function pick(injected: string | null | undefined, env: string | undefined, fallback: () => string | undefined): string | undefined {
  if (injected !== undefined) return injected ?? undefined;
  // "off" names no directory (as for the executables): authoritative, never a fall-through.
  if (env === "off") return undefined;
  if (env !== undefined && env.length > 0) return env;
  return fallback();
}

export function createUsageService(opts: {
  home: string;
  /** Whose apps it reads (`<userHome>/.codex`, `/.claude`, their install places): the user's home folder for the daemon
   *  on its default home, undefined for any other, which then reads no app at all unless one is named explicitly. */
  userHome: string | undefined;
  settings: () => Settings | null | undefined;
  islandUsage?: IslandUsageRegistry;
  version?: string;
  injection?: UsageInjection;
  /** The fired alarms waiting for an acknowledgement changed (the island's notifications). */
  onAlarmNotices?: () => void;
  log?: { warn?: (msg: string, meta?: Record<string, unknown>) => void; info?: (msg: string, meta?: Record<string, unknown>) => void };
}): { service: UsageService; sources: UsageSources; close(): void } | undefined {
  const env = process.env;
  const inj = opts.injection ?? {};
  let db: UsageDb;
  try {
    db = new UsageDb(join(opts.home, "usage", "usage.db"));
  } catch (err) {
    console.error(`[usage] usage.db unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  // No user home (a temp-home or test daemon): no fallback at all, the env's pointers into a home included.
  const user = opts.userHome;
  const claudeConfigDir = user !== undefined && env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;
  const codexHome = pick(inj.codexHome, env.CLOVER_USAGE_CODEX_HOME, () => user === undefined ? undefined : env.CODEX_HOME || join(user, ".codex"));
  const claudeHome = pick(inj.claudeHome, env.CLOVER_USAGE_CLAUDE_HOME, () => user === undefined ? undefined : claudeConfigDir ?? join(user, ".claude"));
  const claudeJsonPath = pick(inj.claudeJsonPath, env.CLOVER_USAGE_CLAUDE_JSON, () => user === undefined ? undefined : claudeConfigDir !== undefined ? join(claudeConfigDir, ".claude.json") : join(user, ".claude.json"));
  // An executable named explicitly is used (or "off"); otherwise it is looked for only with a user home: its install
  // places and `$PATH`. Without one, none is looked for.
  const explicit = (injected: string | null | undefined, envValue: string | undefined): string | undefined =>
    injected !== undefined ? (injected ?? "off") : envValue ?? (user === undefined ? "off" : undefined);
  const installs = (own: (home: string) => string[], name: string): string[] => (user === undefined ? [] : [...own(user), ...packageManagerBins(name, user)]);
  const executables = {
    codex: () => resolveExecutable("codex", explicit(inj.codexExecutable, env.CLOVER_USAGE_CODEX_EXECUTABLE), installs(codexInstalls, "codex")),
    claude: () => resolveExecutable("claude", explicit(inj.claudeExecutable, env.CLOVER_USAGE_CLAUDE_EXECUTABLE), installs(claudeInstalls, "claude")),
    agy: () => resolveExecutable("agy", explicit(inj.agyExecutable, env.CLOVER_USAGE_AGY_EXECUTABLE), installs(agyInstalls, "agy")),
    opencode: () => resolveExecutable("opencode", explicit(inj.opencodeExecutable, env.CLOVER_USAGE_OPENCODE_EXECUTABLE), installs(opencodeInstalls, "opencode")),
  };
  const probeRoot = join(opts.home, "usage");
  const pricer = new UsagePricer();
  const service = new UsageService({
    db, pricer,
    tracking: () => usageTrackingFrom(opts.settings()),
    ...(codexHome === undefined ? {} : { codexHome }),
    ...(claudeHome === undefined ? {} : { claudeHome }),
    ...(claudeJsonPath === undefined ? {} : { claudeJsonPath }),
    codexExecutable: executables.codex,
    claudeExecutable: executables.claude,
    agyExecutable: executables.agy,
    opencodeExecutable: executables.opencode,
    cloverCodexWindows: () => (opts.islandUsage?.windowsFor("codex-oauth") ?? []).map((w) => ({
      ...(w.rateLimitType === undefined ? {} : { rateLimitType: w.rateLimitType }), status: w.status,
      ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }), at: w.at,
    })),
    probeRoot: () => probeRoot,
    // A probe's environment: with a user home, the allowlist and the tool's own home variables, HOME being that home;
    // without one (a temp-home or test daemon running an explicitly named executable), HOME is the daemon's own home
    // and no tool-home variable (CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_*) crosses (#386's review).
    probeEnv: (extra) => (user === undefined ? { ...probeEnv([]), HOME: opts.home } : { ...probeEnv(extra), HOME: user }),
    ...(opts.version === undefined ? {} : { version: opts.version }),
    ...(inj.now === undefined ? {} : { now: inj.now }),
    ...(opts.onAlarmNotices === undefined ? {} : { onAlarmNotices: opts.onAlarmNotices }),
    ...(inj.backgroundEveryMs === undefined ? {} : { backgroundEveryMs: inj.backgroundEveryMs }),
    ...(inj.alarmBeatMs === undefined ? {} : { alarmBeatMs: inj.alarmBeatMs }),
    log: opts.log ?? {
      warn: (msg, meta) => console.error(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`),
      info: (msg, meta) => console.error(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`),
    },
  });
  // The background catch-up (`UsageService.catchUp`): once a few minutes after boot, then every few hours — so Claude
  // Code's transcripts are read before its own cleanup deletes them, Usage screen open or not. Unref'd timers (never
  // hold the daemon), a handful of wakeups a day; off with the env switch (tests, the idle-wakeups gate).
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (inj.catchUp !== false && env.CLOVER_USAGE_CATCH_UP !== "off") {
    const run = (): void => { void service.catchUp().catch(() => { /* logged per pass; the next catch-up retries */ }); };
    const first = setTimeout(run, inj.catchUpFirstMs ?? USAGE_CATCH_UP_FIRST_MS);
    const every = setInterval(run, inj.catchUpEveryMs ?? USAGE_CATCH_UP_EVERY_MS);
    first.unref?.();
    every.unref?.();
    timers.push(first, every);
  }
  // The background plan checks (user 2026-10-18): every installed and tracked plan every 30 min, and a plan with an
  // alarm on its own throttle. Unref'd; off with the env switch (both test preloads) or the injection.
  if (inj.background !== false && env.CLOVER_USAGE_BACKGROUND !== "off") service.startBackground();
  return {
    service,
    sources: {
      ...(codexHome === undefined ? {} : { codexHome }),
      ...(claudeHome === undefined ? {} : { claudeHome }),
      ...(claudeJsonPath === undefined ? {} : { claudeJsonPath }),
      executables: () => ({ codex: executables.codex(), claude: executables.claude(), agy: executables.agy(), opencode: executables.opencode() }),
    },
    close: () => {
      service.stopBackground();
      for (const t of timers) clearTimeout(t);
      db.close();
    },
  };
}

/** The background catch-up's first run after boot, and its period. */
export const USAGE_CATCH_UP_FIRST_MS = 3 * 60_000;
export const USAGE_CATCH_UP_EVERY_MS = 6 * 3_600_000;
