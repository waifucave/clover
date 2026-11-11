// The registry's load-time build of a TypeScript client entry (the registry contract's client entries; spec §5.5): a
// plugin whose `client.entry` is `.ts`, `.tsx`, `.jsx`, `.mts` or `.cts` gets its client built into one ES module here,
// and the app's view of it (`UiPluginView.clientBuild`) names that module. Until it lands the plugin's parts don't
// mount; a build that fails leaves the plugin `invalid` with the bundler's message.
//
// * When: only for a plugin that holds the user's OK for this very tree (`okHash` is its `treeHash`; a development
//   folder's yes is that), is on, and is running or waiting (the states whose UI shows). Never for a plugin found,
//   refused or invalid, never at scan time. Built when it turns so; a development folder, whose tree changes with each
//   edit, rebuilds each time its tree hash changes. A tree that moves on while a build runs: that build is killed and
//   its result dropped.
// * The child: the plugin Bun (`pluginBun`) running Clover's builder bundle, with Clover's bunfig, `--no-env-file`,
//   `--no-macros`, an empty staging folder as its working folder, an environment of its own (no variable of the
//   daemon's), and on macOS the plugin fence: reads the plugin's real folder, the bundle, its Bun and the bunfig;
//   writes the staging folder only; no network, no other program, no native code but Bun's. Elsewhere there is no
//   fence: the child is still a separate, killable process with the limits below.
// * Bounds (`CLIENT_BUILD_LIMITS`): 60 s, 1.5 GiB resident (a watchdog reads the child's RSS every 500 ms and kills it
//   above that; macOS enforces no address-space limit on a child), 4,000 input files and 64 MiB of them, 16 MiB out;
//   one build at a time per plugin, two at a time in all. A failure serves nothing: the staging folder goes.
// * The cache: `<home>/cache/plugin-builds/<id>/<tree hash>/index.js` (a child's id with `/` written `--`), renamed
//   into place whole. Plugins can't reach it (the plugin fence denies the Clover home), and bots neither read nor write
//   it. It is never trusted across runs: the folder is emptied when the daemon starts, and a plugin's builds go when it
//   is removed or its tree changes. What was built is held here, with the module's SHA-256, which the app checks before
//   it serves the file, so a file changed on disk after the build is never served.
// * The OK covers it: the tree hash the user OK'd is the source's; the module is derived, keyed by that tree hash and
//   this builder's version (`CLIENT_BUILDER_VERSION`), and never changes what was OK'd.
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Unsubscribe } from "../contracts/common";
import type { PluginRecord, PluginRegistry } from "../contracts/plugin-registry";
import { plainNote } from "../plugin-host/card-yes";
import { sha256Hex, writeRunFile } from "../plugin-host/run-file";
import { isCompiledBinary } from "../build-kind";
import { fencedCommand, type PluginFenceInput } from "./plugin-fence";
import { ensurePluginRunFiles, pluginBun } from "./plugin-run";
import { BUILT_CLIENT_FILE, CLIENT_BUILD_LIMITS, type ClientBuildJob, type ClientBuildResult } from "./client-build-run";

/** Bumped when the builder's output for the same source would differ: every build is made again. */
export const CLIENT_BUILDER_VERSION = 1;

/** A client entry the registry builds at load. */
export const BUILT_AT_LOAD = /\.(?:tsx?|jsx|[mc]ts)$/i;

/** What the app is told about a built client: the folder, the module's name in it, and its SHA-256 (hex). */
export interface ClientBuildRecord { base: string; file: string; sha256: string }

/** The builder bundle's source entry, and its embedded file's name in a compiled core. */
export const CLIENT_BUILDER_ENTRY = fileURLToPath(new URL("./client-build-main.ts", import.meta.url));
export const CLIENT_BUILDER_BUNDLE_FILE = "clover-plugin-builder.bundle";
const EMBEDDED_BUILDER = /^clover-plugin-builder(?:-[a-z0-9]+)?\.bundle$/;

/** The builder bundle's text: a compiled core's embedded one, or built from source. A compiled core without it can't
 *  build clients (its sources aren't there). */
export async function builderBundleText(o: { compiled?: boolean } = {}): Promise<string> {
  const files = (typeof Bun !== "undefined" ? (Bun.embeddedFiles as unknown as readonly { name?: string; bytes(): Promise<Uint8Array> }[]) : []).filter((f) => EMBEDDED_BUILDER.test(f.name ?? ""));
  if (files.length > 1) throw new Error(`the core embeds ${files.length} ${CLIENT_BUILDER_BUNDLE_FILE} files, not one`);
  if (files.length === 1) return new TextDecoder("utf-8", { fatal: true }).decode(await files[0]!.bytes());
  if (o.compiled ?? isCompiledBinary()) throw new Error(`this core was built without ${CLIENT_BUILDER_BUNDLE_FILE}, so it can't build a plugin's client: rebuild it with compile:core`);
  const result = await Bun.build({ entrypoints: [CLIENT_BUILDER_ENTRY], target: "bun", format: "esm", splitting: false, minify: false, sourcemap: "none", throw: false, ...{ macros: false } });
  if (!result.success || result.outputs.length !== 1) throw new Error(`the client builder didn't build: ${result.logs.map(String).join("; ")}`);
  return result.outputs[0]!.text();
}

/** Runs one job; the default starts the child (`childRunner`). */
export type ClientBuildRunner = (job: ClientBuildJob, signal: AbortSignal) => Promise<ClientBuildResult>;

/** The child: the plugin Bun running the builder bundle, fenced where there is a fence, killed past the bounds. */
export function childRunner(o: { cloverHome: string; userHome?: string; bun?: string; timeoutMs?: number; maxRssBytes?: number; watchEveryMs?: number; fence?: boolean; log?: (line: string) => void }): ClientBuildRunner {
  let bundle: Promise<{ path: string; sha256: string }> | undefined;
  const runDir = join(o.cloverHome, "run");
  const ready = () => (bundle ??= (async () => {
    const text = await builderBundleText();
    const dir = join(runDir, "plugin-builder");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "builder.js");
    writeRunFile(path, text);
    return { path, sha256: sha256Hex(text) };
  })());
  return async (job, signal) => {
    const { path } = await ready();
    const stoppedEarly: ClientBuildResult = { ok: false, message: "the build was stopped: the plugin changed" };
    if (signal.aborted) return stoppedEarly;
    const files = ensurePluginRunFiles(runDir, { cloverHome: o.cloverHome });
    const bun = o.bun ?? pluginBun(o.cloverHome);
    const cmd = [bun, `--config=${files.bunfig}`, "--no-env-file", "--no-macros", path];
    const fence: PluginFenceInput = {
      cloverHome: o.cloverHome, userHome: o.userHome ?? homedir(),
      // The bundle's own folder (it holds only the bundle; Bun reads the folder of what it runs).
      read: [job.root, dirname(path), files.bunfig, bun, dirname(bun)], write: [job.outDir], exec: "plugin", execs: [bun], fork: false, network: "none", noNativeCode: true,
    };
    const argv = o.fence === false ? cmd : fencedCommand(cmd, fence);
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: job.outDir, TMPDIR: job.outDir, LANG: "C.UTF-8", NODE_ENV: "production" };
    return await new Promise<ClientBuildResult>((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: job.outDir, env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let settled = false;
      const done = (r: ClientBuildResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(watch);
        signal.removeEventListener("abort", onAbort);
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve(r);
      };
      const timeoutMs = o.timeoutMs ?? CLIENT_BUILD_LIMITS.timeoutMs;
      const timer = setTimeout(() => done({ ok: false, message: `the build took longer than ${Math.round(timeoutMs / 1000)} s and was stopped` }), timeoutMs);
      const maxRss = o.maxRssBytes ?? CLIENT_BUILD_LIMITS.maxRssBytes;
      const watch = setInterval(() => {
        if (child.pid === undefined) return;
        const ps = Bun.spawnSync(["/bin/ps", "-o", "rss=", "-p", String(child.pid)], { stdout: "pipe", stderr: "ignore" });
        const kb = Number(new TextDecoder().decode(ps.stdout).trim());
        if (Number.isFinite(kb) && kb * 1024 > maxRss) done({ ok: false, message: `the build used more than ${Math.round(maxRss / 1024 / 1024)} MiB of memory and was stopped` });
      }, o.watchEveryMs ?? 500);
      const onAbort = () => done(stoppedEarly);
      signal.addEventListener("abort", onAbort);
      child.stdout.on("data", (b: Buffer) => {
        if (out.length < 64 * 1024) out += b.toString("utf8");
      });
      child.stderr.on("data", (b: Buffer) => {
        if (err.length < 8 * 1024) err += b.toString("utf8");
      });
      child.on("error", (e) => done({ ok: false, message: `the build couldn't start: ${e.message}` }));
      child.on("close", (code) => {
        const line = out.split("\n").find((l) => l.startsWith("{"));
        try {
          const r = line === undefined ? undefined : (JSON.parse(line) as ClientBuildResult);
          if (r !== undefined && typeof r.ok === "boolean") return done(r);
        } catch { /* below */ }
        if (err.trim() !== "") o.log?.(`plugins: the client builder said: ${plainNote(err).slice(0, 300)}`);
        done({ ok: false, message: `the build stopped (exit ${code ?? "by a signal"})` });
      });
      child.stdin.end(JSON.stringify(job));
    });
  };
}

/** The folder of one plugin's builds (a child's id with `/` written `--`). */
export function pluginBuildsDir(cloverHome: string, id: string): string {
  return join(clientBuildsRoot(cloverHome), id.replace("/", "--"));
}
export function clientBuildsRoot(cloverHome: string): string {
  return join(cloverHome, "cache", "plugin-builds");
}

/** The tree hash as a folder name (`sha256:<hex>` → `<hex>`), and the builder's version with it. */
const hashDir = (treeHash: string) => `${treeHash.replace(/^sha256:/, "").replace(/[^a-zA-Z0-9]/g, "")}-v${CLIENT_BUILDER_VERSION}`;

export interface ClientBuildsOptions {
  cloverHome: string;
  registry: Pick<PluginRegistry, "list" | "get" | "watch"> & { setBuildFailure(id: string, treeHash: string, reason: string | null): void };
  run?: ClientBuildRunner;
  /** Builds at a time, in all. */
  concurrency?: number;
  log?: (line: string) => void;
  userHome?: string;
}

/** Whether a plugin's client is built at load now: an OK for this very tree, on, running or waiting, a TS entry. */
export function wantsClientBuild(r: PluginRecord): boolean {
  const entry = (r.manifest as { client?: { entry?: unknown } } | undefined)?.client?.entry;
  return typeof entry === "string" && BUILT_AT_LOAD.test(entry) && r.enabled && (r.state === "running" || r.state === "waiting")
    && r.treeHash !== undefined && r.okHash === r.treeHash;
}

interface Job { treeHash: string; abort: AbortController }

export class ClientBuilds {
  readonly #o: ClientBuildsOptions;
  readonly #run: ClientBuildRunner;
  readonly #built = new Map<string, { treeHash: string; record: ClientBuildRecord }>();
  readonly #jobs = new Map<string, Job>();
  readonly #queue: { id: string; treeHash: string }[] = [];
  readonly #listeners = new Set<(id: string) => void>();
  #running = 0;
  #closed = false;
  readonly #stop: Unsubscribe;

  constructor(o: ClientBuildsOptions) {
    this.#o = o;
    this.#run = o.run ?? childRunner({ cloverHome: o.cloverHome, ...(o.userHome !== undefined ? { userHome: o.userHome } : {}), ...(o.log !== undefined ? { log: o.log } : {}) });
    // Never trusted across runs: what an earlier run left goes.
    rmSync(clientBuildsRoot(o.cloverHome), { recursive: true, force: true });
    this.#stop = o.registry.watch(() => this.#sync());
    this.#sync();
  }

  /** The built client of this plugin's tree, once it has landed. */
  get(id: string, treeHash: string): ClientBuildRecord | undefined {
    const b = this.#built.get(id);
    return b !== undefined && b.treeHash === treeHash ? b.record : undefined;
  }

  /** Hears each plugin whose build landed (its view changes). */
  watch(fn: (id: string) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  /** Every build in flight and queued, for a test's wait. */
  async settled(): Promise<void> {
    while (this.#running > 0 || this.#queue.length > 0) await new Promise((r) => setTimeout(r, 20));
  }

  close(): void {
    this.#closed = true;
    this.#stop();
    for (const j of this.#jobs.values()) j.abort.abort();
    this.#queue.length = 0;
  }

  #sync(): void {
    if (this.#closed) return;
    const want = new Map<string, string>();
    for (const r of this.#o.registry.list()) if (wantsClientBuild(r)) want.set(r.id, r.treeHash!);
    // What no longer wants this build: its job stopped, its result and its folder gone.
    for (const [id, job] of this.#jobs) if (want.get(id) !== job.treeHash) job.abort.abort();
    for (let i = this.#queue.length - 1; i >= 0; i--) if (want.get(this.#queue[i]!.id) !== this.#queue[i]!.treeHash) this.#queue.splice(i, 1);
    for (const [id, b] of this.#built) {
      if (want.get(id) === b.treeHash) continue;
      this.#built.delete(id);
      rmSync(b.record.base, { recursive: true, force: true });
    }
    for (const [id, treeHash] of want) {
      if (this.#built.get(id)?.treeHash === treeHash || this.#jobs.get(id)?.treeHash === treeHash || this.#queue.some((q) => q.id === id && q.treeHash === treeHash)) continue;
      this.#queue.push({ id, treeHash });
    }
    this.#next();
  }

  #next(): void {
    const max = this.#o.concurrency ?? 2;
    while (!this.#closed && this.#running < max && this.#queue.length > 0) {
      const i = this.#queue.findIndex((q) => !this.#jobs.has(q.id));
      if (i < 0) return;
      const { id, treeHash } = this.#queue.splice(i, 1)[0]!;
      void this.#build(id, treeHash);
    }
  }

  async #build(id: string, treeHash: string): Promise<void> {
    const r = this.#o.registry.get(id);
    if (r === undefined || !wantsClientBuild(r) || r.treeHash !== treeHash) return;
    const entry = (r.manifest as { client: { entry: string } }).client.entry;
    const abort = new AbortController();
    this.#jobs.set(id, { treeHash, abort });
    this.#running++;
    const dir = pluginBuildsDir(this.#o.cloverHome, id);
    const staging = join(dir, `.staging-${crypto.randomUUID()}`);
    let result: ClientBuildResult;
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      result = await this.#run({ root: r.folder, entry, outDir: staging, home: this.#o.userHome ?? homedir(), user: userInfo().username }, abort.signal);
    } catch (e) {
      result = { ok: false, message: `the build couldn't run: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      this.#running--;
      this.#jobs.delete(id);
    }
    try {
      // The tree moved on, or the plugin went: nothing of this build is kept or said.
      const now = this.#o.registry.get(id);
      if (abort.signal.aborted || this.#closed || now === undefined || now.treeHash !== treeHash || !wantsClientBuild(now)) return;
      if (!result.ok) {
        this.#o.log?.(`plugins: ${id}'s client didn't build: ${plainNote(result.message).slice(0, 300)}`);
        this.#o.registry.setBuildFailure(id, treeHash, `its client didn't build: ${plainNote(result.message)}`);
        return;
      }
      const final = join(dir, hashDir(treeHash));
      rmSync(final, { recursive: true, force: true });
      renameSync(staging, final);
      const before = this.#built.get(id);
      if (before !== undefined && before.record.base !== final) rmSync(before.record.base, { recursive: true, force: true });
      this.#built.set(id, { treeHash, record: { base: final, file: BUILT_CLIENT_FILE, sha256: result.sha256 } });
      this.#o.log?.(`plugins: ${id}'s client built (${result.bytes} bytes)`);
      for (const fn of this.#listeners) fn(id);
    } finally {
      rmSync(staging, { recursive: true, force: true });
      this.#next();
    }
  }
}
