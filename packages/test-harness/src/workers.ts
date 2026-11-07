// The local emulator for Clover's Cloudflare Workers (plan §8: outside services stay local until the live gates):
// a service folder's wrangler config, its entry bundled by Bun, run in Miniflare's workerd on 127.0.0.1 with
// in-memory storage. Nothing is deployed, and nothing leaves this machine.
//
// Why Miniflare 4 in this process, not `wrangler dev`: wrangler refuses to forward requests under Bun (Bun's
// fetch ignores the undici dispatcher its proxy needs), and Miniflare 5 is still a beta with a different options
// shape. The wrangler config stays the one source of truth: the keys below are read from it, and any other key
// is refused by name, so a service never runs here differently from how it is configured.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Miniflare } from "miniflare";

/** The wrangler config keys the emulator honours. */
export const SUPPORTED_WRANGLER_KEYS: readonly string[] = [
  "$schema", "name", "main", "compatibility_date", "compatibility_flags", "vars",
  "durable_objects", "migrations", "kv_namespaces", "r2_buckets", "d1_databases",
  // Deploy-only settings, which change nothing locally.
  "account_id", "workers_dev", "routes", "route", "observability", "placement", "logpush", "upload_source_maps", "preview_urls",
];

export interface WranglerConfig {
  name?: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  vars?: Record<string, string | number | boolean | Record<string, unknown>>;
  durable_objects?: { bindings: { name: string; class_name: string; script_name?: string }[] };
  migrations?: { tag: string; new_classes?: string[]; new_sqlite_classes?: string[] }[];
  kv_namespaces?: { binding: string }[];
  r2_buckets?: { binding: string }[];
  d1_databases?: { binding: string }[];
}

/** Reads `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` in `dir`, refusing keys the emulator would ignore. */
export function readWranglerConfig(dir: string): WranglerConfig {
  const found = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].map((f) => join(dir, f)).find((p) => existsSync(p));
  if (found === undefined) throw new Error(`no wrangler.jsonc, wrangler.json or wrangler.toml in ${dir}`);
  const text = readFileSync(found, "utf8");
  const raw = (found.endsWith(".toml") ? Bun.TOML.parse(text) : Bun.JSONC.parse(text)) as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !SUPPORTED_WRANGLER_KEYS.includes(k));
  if (unknown.length > 0) throw new Error(`${found}: the emulator does not support ${unknown.join(", ")} yet (packages/test-harness/src/workers.ts)`);
  if (typeof raw.main !== "string" || typeof raw.compatibility_date !== "string") throw new Error(`${found}: main and compatibility_date are required`);
  const config = raw as unknown as WranglerConfig;
  for (const b of config.durable_objects?.bindings ?? []) {
    if (b.script_name !== undefined) throw new Error(`${found}: Durable Object ${b.name} lives in another Worker (script_name), which the emulator does not run`);
  }
  return config;
}

/** The Miniflare options a wrangler config means, for an already-bundled entry. */
export function miniflareOptions(config: WranglerConfig, script: string, opts: { bindings?: Record<string, unknown> } = {}): ConstructorParameters<typeof Miniflare>[0] {
  const sqlite = new Set((config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []));
  const durableObjects = Object.fromEntries((config.durable_objects?.bindings ?? []).map((b) => [b.name, { className: b.class_name, useSQLite: sqlite.has(b.class_name) }]));
  return {
    name: config.name ?? "worker",
    modules: [{ type: "ESModule", path: "index.js", contents: script }],
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
    bindings: { ...(config.vars ?? {}), ...(opts.bindings ?? {}) },
    durableObjects,
    kvNamespaces: (config.kv_namespaces ?? []).map((k) => k.binding),
    r2Buckets: (config.r2_buckets ?? []).map((r) => r.binding),
    d1Databases: (config.d1_databases ?? []).map((d) => d.binding),
    host: "127.0.0.1",
    port: 0,
  } as ConstructorParameters<typeof Miniflare>[0];
}

/** Bundles a Worker entry for workerd: one ES module, the `cloudflare:` built-ins left to the runtime. */
export async function bundleWorker(entry: string): Promise<string> {
  const result = await Bun.build({
    // Macros off: a `with { type: "macro" }` import would run in this process (bun-types has no field for it).
    ...{ macros: false },
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*"],
  });
  if (!result.success || result.outputs[0] === undefined) {
    throw new Error(`bundling ${entry} failed:\n${result.logs.map((l) => String(l)).join("\n")}`);
  }
  return result.outputs[0].text();
}

export interface RunningWorker {
  /** The Worker's address on 127.0.0.1. */
  url: URL;
  /** A real HTTP request to the Worker; `path` is resolved against `url`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The emulator itself, for what a test needs beyond HTTP (its storage, its bindings). */
  miniflare: Miniflare;
  dispose(): Promise<void>;
}

/** What a start needs of a Miniflare instance: the seam `startWithRetry`'s own test uses. */
export interface StartableRuntime {
  readonly ready: Promise<URL>;
  dispose(): Promise<void>;
}

function deadline(ms: number, message: string): { promise: Promise<never>; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

/**
 * Starts a runtime, and a fresh one once more when the first is not ready within `timeoutMs`. workerd answers in well
 * under a second, but on CI runners (macOS and Windows) one start in a run has failed: workerd exited before reporting
 * its ports, and Miniflare's `ready` neither resolved nor rejected for 30 s, while the starts just before and after
 * it took under a second. A failed attempt is disposed, with a deadline of its own, before the next one starts.
 */
export async function startWithRetry<T extends StartableRuntime>(create: () => T, opts: { attempts?: number; timeoutMs?: number } = {}): Promise<{ runtime: T; url: URL }> {
  const attempts = opts.attempts ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const runtime = create();
    const ready = runtime.ready;
    ready.catch(() => {}); // an abandoned attempt's late rejection is not the caller's error
    const wait = deadline(timeoutMs, `not ready within ${timeoutMs} ms`);
    try {
      return { runtime, url: await Promise.race([ready, wait.promise]) };
    } catch (err) {
      failures.push(`attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
      const stop = deadline(5_000, "dispose timed out");
      await Promise.race([disposeRuntime(runtime), stop.promise]).catch(() => {});
      stop.clear();
    } finally {
      wait.clear();
    }
  }
  throw new Error(`the Worker did not start (${failures.join("; ")})`);
}

/**
 * Disposes a runtime whose process may already be gone. On Windows, Bun's `kill` of an exited child throws EBADF
 * (seen in CI, inside Miniflare's dispose) where Node's returns false; the runtime is gone either way, so that one
 * error is not the caller's. Any other error is.
 */
export async function disposeRuntime(runtime: Pick<StartableRuntime, "dispose">): Promise<void> {
  try {
    await runtime.dispose();
  } catch (err) {
    const e = err as { code?: unknown; syscall?: unknown };
    if (e.syscall === "kill" && (e.code === "EBADF" || e.code === "ESRCH")) return;
    throw err;
  }
}

/** Runs the Worker in `dir` (its wrangler config's `main` and bindings). `bindings` add or override variables. */
export async function startWorker(opts: { dir: string; bindings?: Record<string, unknown> }): Promise<RunningWorker> {
  const dir = resolve(opts.dir);
  const config = readWranglerConfig(dir);
  const entry = isAbsolute(config.main) ? config.main : join(dir, config.main);
  const script = await bundleWorker(entry);
  const { runtime: miniflare, url } = await startWithRetry(() => new Miniflare(miniflareOptions(config, script, opts)));
  return {
    url,
    miniflare,
    fetch: (path, init) => fetch(new URL(path, url), init),
    dispose: () => disposeRuntime(miniflare),
  };
}
