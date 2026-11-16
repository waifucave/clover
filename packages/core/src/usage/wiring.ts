import { join } from "node:path";
import type { PlanWindowReports } from "./codex-windows";
import { usageTrackingFrom, type Settings } from "../settings";
import { UsageDb } from "./db";
import { UsagePricer } from "./pricing";
import { UsageService } from "./service";
import { SOURCE_ID, type UsageSourceEntry, type UsageSourcePort } from "./sources";

// Boot wiring for usage tracking (spec §12 "Usage sources"). The core reads no app: a tool's usage is a `usage.sources`
// entry's, a plugin's, called through the plugin host once it is up (`attach`; the host starts after this service does).
// Whose apps: the daemon's `userHome` — the user's home folder for the daemon on its default home (`isDefaultMossHome`),
// NONE for any other (a temp-home or test daemon): such a daemon calls NO entry unless one is named, because a plugin
// runs the user's own programs with the user's own access (`api.outside`). Named by `injection.sources` (a list of source
// names; `null` = none) or `$MOSS_USAGE_SOURCES` (a comma list; `off` = none).
// Both test preloads set `MOSS_USAGE_SOURCES=off`, so no test daemon ever reads or runs the real ones, and switch the
// background plan checks off (`MOSS_USAGE_BACKGROUND=off`).

/** What a usage service may call (diagnostics and tests): the entries it would ask now. */
export interface UsageSources {
  entries(): Array<{ id: string; pluginId: string }>;
}

export interface UsageInjection {
  /** The source names this daemon may call (a test or a fixture); `null` = none; absent = by the user home. */
  sources?: readonly string[] | null;
  /** TEST SEAM: the port to call instead of the plugin host's (a test's own entries). Every entry it gives may be called. */
  port?: UsageSourcePort;
  now?: () => number;
  /** The background catch-up: false = off (tests); its timings. */
  catchUp?: boolean;
  catchUpFirstMs?: number;
  catchUpEveryMs?: number;
  /** The background plan checks and the alarms' fast beats (`UsageService.startBackground`): false = off; its timings. */
  background?: boolean;
  backgroundEveryMs?: number;
  alarmBeatMs?: Record<string, number>;
}

/**
 * A daemon that must never read or run the user's own apps — every one booted OUTSIDE the tests and the real daemon (the
 * probes, the verify gates, the live and e2e suites, `check:idle-wakeups`): no source is called, the background plan beat
 * and the catch-up off. `test/usage/script-daemons.test.ts` pins every such entry.
 */
export const USAGE_INERT: UsageInjection = Object.freeze({ sources: null, catchUp: false, background: false });

/** The same for a daemon spawned as a process (`moss daemon run`, a compiled `moss-core`): its environment. */
export const USAGE_INERT_ENV: Readonly<Record<string, string>> = Object.freeze({
  MOSS_USAGE_SOURCES: "off", MOSS_USAGE_BACKGROUND: "off", MOSS_USAGE_CATCH_UP: "off",
});

/** Which source names a daemon may call: undefined = every one (the user's own computer), a set = only those. */
export function allowedSources(opts: { userHome: string | undefined; injection?: UsageInjection; env?: Readonly<Record<string, string | undefined>> }): Set<string> | "all" | "none" {
  const inj = opts.injection?.sources;
  if (inj === null) return "none";
  if (inj === undefined && opts.injection?.port !== undefined) return "all";
  if (inj !== undefined) return new Set(inj.filter((s) => SOURCE_ID.test(s)));
  const env = (opts.env ?? process.env).MOSS_USAGE_SOURCES;
  if (env === "off") return "none";
  if (env !== undefined && env.length > 0) return new Set(env.split(",").map((s) => s.trim()).filter((s) => SOURCE_ID.test(s)));
  return opts.userHome === undefined ? "none" : "all";
}

/** The port the usage service calls through. The plugin host starts after the service, so it is bound late (`attach`);
 *  until then, and for a daemon that may call no source, it has no entries. */
export class LateUsagePort implements UsageSourcePort {
  private real: UsageSourcePort | undefined;
  constructor(private readonly allowed: () => Set<string> | "all" | "none") {}
  attach(real: UsageSourcePort | undefined): void { this.real = real; }
  entries(): UsageSourceEntry[] {
    const allowed = this.allowed();
    if (this.real === undefined || allowed === "none") return [];
    const all = this.real.entries();
    return allowed === "all" ? all : all.filter((e) => allowed.has(e.id));
  }
  async call(entry: UsageSourceEntry, method: "plan" | "ingest", args: unknown, timeoutMs: number): Promise<unknown> {
    if (this.real === undefined || !this.entries().some((e) => e.pluginId === entry.pluginId && e.id === entry.id)) throw new Error("usage source is not available");
    return this.real.call(entry, method, args, timeoutMs);
  }
}

export function createUsageService(opts: {
  home: string;
  /** Whose apps it reads: the user's home folder for the daemon on its default home, undefined for any other, which then
   *  calls no source unless one is named explicitly. */
  userHome: string | undefined;
  settings: () => Settings | null | undefined;
  /** The plan windows Codex sessions reported while they ran: handed to every source as data (`reports["codex-oauth"]`). */
  codexWindows?: PlanWindowReports;
  injection?: UsageInjection;
  log?: { warn?: (msg: string, meta?: Record<string, unknown>) => void; info?: (msg: string, meta?: Record<string, unknown>) => void };
}): { service: UsageService; sources: UsageSources; attach(host: { port?: UsageSourcePort; notify?: (notice: { title: string; body: string }) => void }): void; close(): void } | undefined {
  const env = process.env;
  const inj = opts.injection ?? {};
  let db: UsageDb;
  try {
    db = new UsageDb(join(opts.home, "usage", "usage.db"));
  } catch (err) {
    console.error(`[usage] usage.db unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  const port = new LateUsagePort(() => allowedSources({ userHome: opts.userHome, injection: inj }));
  if (inj.port !== undefined) port.attach(inj.port);
  let notify: ((notice: { title: string; body: string }) => void) | undefined;
  const pricer = new UsagePricer();
  const service = new UsageService({
    db, pricer, sources: port,
    tracking: () => usageTrackingFrom(opts.settings()),
    reports: () => ({
      "codex-oauth": (opts.codexWindows?.windowsFor("codex-oauth") ?? []).map((w) => ({
        ...(w.rateLimitType === undefined ? {} : { rateLimitType: w.rateLimitType }), status: w.status,
        ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }), at: w.at,
      })),
    }),
    notify: (n) => notify?.(n),
    ...(inj.now === undefined ? {} : { now: inj.now }),
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
  if (inj.catchUp !== false && env.MOSS_USAGE_CATCH_UP !== "off") {
    const run = (): void => { void service.catchUp().catch(() => { /* logged per pass; the next catch-up retries */ }); };
    const first = setTimeout(run, inj.catchUpFirstMs ?? USAGE_CATCH_UP_FIRST_MS);
    const every = setInterval(run, inj.catchUpEveryMs ?? USAGE_CATCH_UP_EVERY_MS);
    first.unref?.();
    every.unref?.();
    timers.push(first, every);
  }
  // The background plan checks (user 2026-10-18): every plan every 30 min, and a plan with an alarm on its own throttle.
  // Unref'd; off with the env switch (both test preloads) or the injection.
  if (inj.background !== false && env.MOSS_USAGE_BACKGROUND !== "off") service.startBackground();
  return {
    service,
    sources: { entries: () => port.entries().map((e) => ({ id: e.id, pluginId: e.pluginId })) },
    attach: (host) => { if (host.port !== undefined && inj.port === undefined) port.attach(host.port); if (host.notify !== undefined) notify = host.notify; },
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
