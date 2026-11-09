// The fenced process (C-M2 part 2): a command run under the fence, for bots' Bash and, on macOS, a hook's command
// (spec §9.1; `spawn.ts`'s door). One sandbox per OS, built from the fence's `SandboxPolicy` at each run, so a
// development folder added or a plugin's data folder made since is in it:
//   macOS    Seatbelt (`sandbox-exec -p`, `macos-profile.ts`)
//   Linux    bubblewrap (`linux-bwrap.ts`), from its standard place only; where unprivileged user namespaces are shut
//            (AppArmor's restriction on Ubuntu without bwrap's profile) the door says so and refuses
//   Windows  not yet: the door says so and refuses
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { fenceContextFor } from "../contracts/fence";
import type { CloverFence } from "./fence";
import { bwrapPlan, heldFolderNote } from "./linux-bwrap";
import { unixSocketFilter } from "./seccomp";
import { PROCESS_HOLDER_FILE } from "../build-kind";
import { agentConfigDirs, agentConfigFiles, gitTemplateDir, globalHooksPathDirs, loginStartDirs, loginStartSafeFiles, loginStartUnsafeFiles, selfUpdateFiles } from "./layout";
import { supervisorArch } from "./linux-supervisor";
import { parseGitConfigWatched, revertWatchedGitChanges, watchedGitChanges } from "./git-config";
import { macFenceProfile } from "./macos-profile";
import { callerPlaces } from "./per-caller";
import { runCommand, type FencedRun, type FencedRunResult, type FencedSpawner } from "./spawn";

export interface FencedProcessOptions {
  readonly fence: CloverFence;
  readonly os?: Os;
  /** macOS: the process holder every command runs under (`DescendantEnd`), so all it starts ends with the run.
   *  Default: `clover-process-holder` beside the daemon's executable when it is there (lane M ships it); `null`, or
   *  none there, records the process tree while the run lasts instead. */
  readonly processHolder?: string | null;
  /** macOS's per-user temp folder; default from `getconf DARWIN_USER_TEMP_DIR`. */
  readonly perUserTemp?: () => string | null;
  /** Linux: bubblewrap's path (default `/usr/bin/bwrap`, never a PATH search). */
  readonly bwrap?: string;
}

let tempCache: string | null | undefined;
function darwinUserTemp(): string | null {
  if (tempCache !== undefined) return tempCache;
  tempCache = null;
  try {
    const raw = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout?.trim();
    if (raw) tempCache = require("node:fs").realpathSync(raw.replace(/\/+$/, "")) as string;
  } catch { /* none */ }
  return tempCache;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The macOS holder for `o`: the one named, else the one beside the daemon's executable when it is there. */
function holderFor(o: FencedProcessOptions): string | null {
  if (o.processHolder !== undefined) return o.processHolder !== null && existsSync(o.processHolder) ? o.processHolder : null;
  const beside = join(dirname(process.execPath), PROCESS_HOLDER_FILE);
  return existsSync(beside) ? beside : null;
}

/** Each session's watched git config files as its last run left them (after that run's revert), for `recheck`. */
class SessionConfigs {
  readonly #by = new Map<string, Map<string, string | null>>();
  /** A watched session's places, looked over again at each `recheck` for repos made since. */
  readonly #places = new Map<string, { home: string; cwd: string; writable: readonly string[] }>();
  /** A watched path that is a link: what it led to when last looked at (a dotfile manager's `~/.gitconfig`). */
  readonly #through = new Map<string, Map<string, string | null>>();
  /** Sessions already told the repo walk stopped at its budget (once each). */
  readonly #told = new Set<string>();
  constructor(private readonly scan: (home: string, cwd: string, writable: readonly string[]) => { files: string[]; stopped: boolean } = sessionConfigFiles) {}
  /** After a run: what each watched file holds now is what the next look compares against. */
  settled(sessionId: string | undefined, paths: Iterable<string>): void {
    if (sessionId === undefined) return;
    const m = this.#by.get(sessionId) ?? new Map<string, string | null>();
    for (const p of paths) m.set(p, readIfFile(p));
    this.#by.set(sessionId, m);
  }
  /** A session whose commands run elsewhere (a bot's Bash in the runtime's own sandbox): its repo's configs and the
   *  global ones are watched from now, each as it is now; a file already watched keeps its baseline. */
  watch(sessionId: string, home: string, cwd: string, writable: readonly string[]): void {
    const m = this.#by.get(sessionId) ?? new Map<string, string | null>();
    const t = this.#through.get(sessionId) ?? new Map<string, string | null>();
    for (const p of this.scan(home, cwd, writable).files) if (!m.has(p)) { m.set(p, readIfFile(p)); t.set(p, readThroughLink(p)); }
    this.#by.set(sessionId, m);
    this.#through.set(sessionId, t);
    const was = this.#places.get(sessionId);
    this.#places.set(sessionId, { home, cwd, writable: [...new Set([...(was?.writable ?? []), ...writable])] });
  }
  recheck(sessionId: string, opts: { end?: boolean } = {}): string | null {
    const m = this.#by.get(sessionId);
    if (m === undefined) return null;
    // A watched session's places looked over again: a repo made since (a `git init` or a clone in a scratch folder)
    // is watched as newly appeared, so a risky key it carries is reverted now.
    const at = this.#places.get(sessionId);
    let stopped = false;
    if (at !== undefined) {
      const found = this.scan(at.home, at.cwd, at.writable);
      for (const p of found.files) if (!m.has(p)) m.set(p, null);
      stopped = found.stopped;
    }
    // A link planted at a watched config (`.git/config` → a file it wrote) is never written through: inside the
    // session's writable folders, where nothing but a runner made it, the link is removed when what it leads to sets
    // a risky key it didn't; elsewhere it is reported.
    const t = this.#through.get(sessionId) ?? new Map<string, string | null>();
    const links: string[] = [];
    for (const p of m.keys()) {
      const now = readThroughLink(p);
      if (now === null) { t.delete(p); continue; }
      const before = t.get(p) ?? null;
      const changed = isTooBig(now) && now !== before ? [{ dotted: "a file too big to check" }] : watchedGitChanges(before, now);
      if (changed.length === 0) { t.set(p, now); continue; }
      const keys = changed.map((c) => c.dotted).join(", ");
      const mine = at !== undefined && at.writable.some((w) => p.startsWith(w.endsWith("/") ? w : `${w}/`));
      if (mine) {
        try { unlinkSync(p); links.push(`${p}: removed a link planted as a git config (risky git keys: ${keys})`); t.delete(p); }
        catch { links.push(`${p}: kept a link planted as a git config (risky git keys: ${keys}): could not remove it`); }
      } else links.push(`${p}: kept a link at a git config that now sets risky git keys (${keys})`);
    }
    this.#through.set(sessionId, t);
    const reverted = revertPlantedGitKeys(m);
    const linked = links.length === 0 ? null : `clover: a git config was a link to risky git keys; ${links.join("; ")}\n`;
    // The walk's stop is said once a session: a repo past it isn't watched.
    const budget = stopped && !this.#told.has(sessionId)
      ? `clover: the repo watch stopped after ${WATCH_REPO_BUDGET} folders in this session's writable folders; a repo past them isn't checked for risky git keys\n`
      : null;
    if (budget !== null) this.#told.add(sessionId);
    const note = reverted === null && linked === null && budget === null ? null : `${reverted ?? ""}${linked ?? ""}${budget ?? ""}`;
    if (opts.end) { this.#by.delete(sessionId); this.#places.delete(sessionId); this.#through.delete(sessionId); this.#told.delete(sessionId); }
    else for (const p of m.keys()) m.set(p, readIfFile(p));
    return note;
  }
}

const sessionOf = (r: FencedRun): string | undefined => (r.who.caller.kind === "session" ? r.who.caller.sessionId : undefined);

/** At a run's start: the session's watched configs looked at again against what its last run left, before this run
 *  takes its own snapshot. */
function recheckBefore(configs: SessionConfigs, r: FencedRun): string | null {
  const id = sessionOf(r);
  return id === undefined ? null : configs.recheck(id);
}

export function fencedSpawner(o: FencedProcessOptions): FencedSpawner {
  const os = o.os ?? o.fence.os;
  const configs = new SessionConfigs();
  if (os === "macos") {
    if (!existsSync(SANDBOX_EXEC)) return closed("macOS's sandbox (sandbox-exec) isn't on this Mac");
    return {
      available: true,
      recheck: (sessionId, opts) => configs.recheck(sessionId, opts),
      watch: (sessionId, cwd, writable = []) => configs.watch(sessionId, o.fence.home, cwd, writable),
      run: async (r) => {
        const template = ensureGitTemplate(o.fence.cloverHome);
        if (typeof template !== "string") return template;
        const ctx = fenceContextFor(r.who.caller);
        const policy = o.fence.policy(ctx);
        const profile = macFenceProfile({ policy, cloverHome: o.fence.cloverHome, home: o.fence.home, perUserTemp: (o.perUserTemp ?? darwinUserTemp)(), caller: callerPlaces(o.fence.cloverHome, os, ctx) });
        // A key set since the session's last run ended is reverted first, so it never becomes this run's baseline
        // (#321's check 2).
        const between = recheckBefore(configs, r);
        const configBefore = snapshotFiles(watchedConfigFiles(o.fence.home, r.cwd));
        // Everything the command starts ends with the run (#321's review): under the holder, or by its recorded tree,
        // a `set -m` job and a double fork included. Only then are the git keys looked at, so nothing is left to set
        // one after the revert.
        const holder = holderFor(o);
        const result = await runCommand(withGitTemplate(r, template), {
          shell: "sh", argv: [SANDBOX_EXEC, "-p", profile, "/bin/sh", "-c", r.command],
          descendants: holder !== null ? { kind: "holder", holder } : { kind: "tree" },
        });
        if (result.kind === "refused") return result;
        // Repos made during the run weren't on disk at snapshot time: watch their configs as newly appeared.
        for (const p of watchedConfigFiles(o.fence.home, r.cwd)) if (!configBefore.has(p)) configBefore.set(p, null);
        const notes = [between, revertPlantedGitKeys(configBefore)].filter((n): n is string => n !== null);
        configs.settled(sessionOf(r), configBefore.keys());
        return notes.length === 0 ? result : { ...result, stderr: result.stderr + notes.join("") };
      },
    };
  }
  if (os === "linux") {
    const bwrap = o.bwrap ?? BWRAP;
    let probed: string | null | undefined; // null: it works; a string: why it doesn't
    const probe = (): string | null => {
      if (probed !== undefined) return probed;
      if (!existsSync(bwrap)) return (probed = "bubblewrap isn't installed (/usr/bin/bwrap)");
      const r = spawnSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "/bin/true"], { encoding: "utf8", timeout: 10_000 });
      return (probed = r.status === 0 ? null : `bubblewrap can't make its namespaces here (${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 200)})`);
    };
    return {
      get available() { return probe() === null; },
      recheck: (sessionId, opts) => configs.recheck(sessionId, opts),
      watch: (sessionId, cwd, writable = []) => configs.watch(sessionId, o.fence.home, cwd, writable),
      run: async (r) => {
        const why = probe();
        if (why !== null) return { kind: "refused", reason: `a fenced process can't be started here: ${why}` };
        // The home the view is built from is a plain folder: nothing else gets a tmpfs view.
        try {
          if (!lstatSync(o.fence.cloverHome).isDirectory()) {
            return { kind: "refused", reason: `a fenced process can't be started here: ${o.fence.cloverHome} isn't a plain folder` };
          }
        } catch {
          return { kind: "refused", reason: `a fenced process can't be started here: no Clover home at ${o.fence.cloverHome}` };
        }
        const filter = unixSocketFilter();
        if (filter === null) return { kind: "refused", reason: `a fenced process can't be started here: no seccomp filter for ${process.arch}` };
        // The filter reaches bwrap as the child's fd 3, read from a file only this run uses.
        const dir = mkdtempSync(join(tmpdir(), "clover-seccomp-"));
        const file = join(dir, "filter.bpf");
        writeFileSync(file, filter, { mode: 0o600 });
        const fd = openSync(file, "r");
        try {
          const ctx = fenceContextFor(r.who.caller);
          const template = ensureGitTemplate(o.fence.cloverHome);
          if (typeof template !== "string") return template;
          const caller = callerPlaces(o.fence.cloverHome, os, ctx);
          // The runner's own folders exist before the sandbox hides everything else: a first write lands on the
          // disk, the way the macOS profile's allows do. Parents included, each 0700, as `makeBotFolders` makes
          // them; a folder that can't be made refuses the run rather than silently staying unbound.
          for (const p of [caller.ownOutputs, caller.ownScratch, caller.ownRoutines, caller.ownPluginData, caller.ownMemory, caller.ownBot]) {
            if (p === null) continue;
            try { mkdirSync(p, { recursive: true, mode: 0o700 }); }
            catch (e) { return { kind: "refused", reason: `a fenced process can't be started here: its own folder ${p} can't be made (${e instanceof Error ? e.message : String(e)})` }; }
          }
          // The session's own repo's hooks, when the run starts inside a repo under the home: made when missing
          // (best effort: a read-only checkout stays as it is) and bound read-only, so no run plants a hook that
          // fires later outside the sandbox. Other repos under the home are the known limit (bwrap can't match
          // patterns); the fence judges every tool call that reaches them.
          const repoHooks = ownRepoHooks(r.cwd, o.fence.home);
          if (repoHooks !== null) { try { mkdirNoLinks(repoHooks); } catch { /* stays unbound: the belt still watches it */ } }
          // Missing fenced login-start folders and safe files are made now, empty and link-free (ruling 1 and 2):
          // the sandbox then binds them read-only instead of holding their parents, so ordinary new names stay
          // writable. Clover's own browser partitions count too. A folder or file that can't be made refuses the
          // run rather than silently staying unbound (an existing link is the user's own: left alone).
          const loginDirs = loginStartDirs(o.fence.home, o.fence.cloverHome, "linux");
          const loginSafe = loginStartSafeFiles(o.fence.home, "linux");
          const browserProfiles = o.fence.fencedSet().filter((i) => i.kind === "browser-profiles").map((i) => i.path);
          // The user's configured global hooks folder, when under the home and missing: made empty and read-only
          // like the login-start folders, so it never holds its parent (outside the home it is fenced without a
          // mount, and the fence still judges it).
          const hooksDirs = globalHooksPathDirs(o.fence.home).filter((p) => p === o.fence.home || p.startsWith(`${o.fence.home}/`));
          // Lane M's self-update files live under the Clover home, which the default-deny view already hides:
          // nothing is created for them, and they never hold anything. The supervisor still refuses plants by
          // identity, with the post-command belt behind it.
          // …and B's #234 plugin-load denies (`node_modules` above every folder plugin code loads from, `~/node_modules`
          // first): one that isn't there is supervised, never made and never held, so a missing `~/node_modules`
          // doesn't hold the home and ordinary new top-level names stay writable (the controller's ruling).
          const loadDenies = o.fence.policy(ctx).denyWrite.filter((d) => basename(d) === "node_modules" && d !== o.fence.cloverHome && !d.startsWith(`${o.fence.cloverHome}/`));
          // The coding agents' settings (#308): folders made empty like the login-start ones, files supervised, so a
          // missing `~/.claude.json` never holds the home either.
          const supervisedFiles = [...loginStartUnsafeFiles(o.fence.home, "linux"), ...selfUpdateFiles(o.fence.cloverHome, "linux"), ...loadDenies,
            ...agentConfigFiles(o.fence.home, "linux")];
          try {
            for (const d of [...loginDirs, ...browserProfiles, ...hooksDirs, ...agentConfigDirs(o.fence.home, "linux")]) mkdirNoLinks(d);
            for (const f of loginSafe) ensureEmptyFile(f);
          } catch (e) {
            return { kind: "refused", reason: `a fenced process can't be started here: a login-start place can't be made (${e instanceof Error ? e.message : String(e)})` };
          }
          const beltBefore = new Map(supervisedFiles.map((p) => [p, existsNoFollow(p)]));
          const between = recheckBefore(configs, r); // as on macOS: never a key set between two runs as a baseline
          const configBefore = snapshotFiles(watchedConfigFiles(o.fence.home, r.cwd));
          // Fail closed: no supervisor, no run. The shim exits 127 with a `(closed)` marker when it can't start
          // one; a command that prints the marker and exits 127 only refuses itself.
          if (supervisorArch() === null) {
            return { kind: "refused", reason: `a fenced process can't be started here: no user-notification supervisor on ${process.arch} (fail closed)` };
          }
          const plan = bwrapPlan({ policy: o.fence.policy(ctx), cloverHome: o.fence.cloverHome, cwd: r.cwd, uid: process.getuid?.() ?? 0, seccompFd: 3, caller, repoHooks, supervised: supervisedFiles });
          // The supervisor watches the fenced files that don't exist yet (spec item 1116, #198 B1): it refuses
          // plants with EACCES. Its file list reaches the shim as JSON; the template dir rides GIT_TEMPLATE_DIR.
          const shimEnv = { ...r.env, GIT_TEMPLATE_DIR: template, CLOVER_SUPERVISED_FILES: JSON.stringify(supervisedFiles) };
          const result = await runCommand({ ...r, env: shimEnv }, { shell: "sh", argv: [process.execPath, join(import.meta.dir, "linux-sandbox-shim.ts"), bwrap, ...plan.args, "/bin/sh", "-c", r.command], extraFds: [fd] });
          if (result.kind === "refused") return result;
          if (result.kind === "exited" && result.code === 127 && result.stderr.includes("(closed)")) {
            return { kind: "refused", reason: `a fenced process can't be started here: ${result.stderr.trim().slice(0, 200)}` };
          }
          // Repos made during the run weren't on disk at snapshot time: watch their configs as newly appeared.
          for (const p of watchedConfigFiles(o.fence.home, r.cwd)) if (!configBefore.has(p)) configBefore.set(p, null);
          const notes = [
            between,
            heldFolderNote(result.stderr, plan.held),
            quarantinePlanted(beltBefore, o.fence.cloverHome),
            revertPlantedGitKeys(configBefore),
          ].filter((n): n is string => n !== null);
          configs.settled(sessionOf(r), configBefore.keys());
          return notes.length === 0 ? result : { ...result, stderr: result.stderr + notes.join("") };
        } finally {
          closeSync(fd);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  }
  return closed("the Windows sandbox isn't built yet");
}

const BWRAP = "/usr/bin/bwrap";

/** Clover's empty git template for the sandbox: made here if missing, read-only to runners, so `git init` and
 *  `git clone` install no hooks. A user's own `init.templateDir` in their git config is overridden by the env var
 *  inside the sandbox only. */
function ensureGitTemplate(cloverHome: string): string | FencedRunResult {
  const template = gitTemplateDir(cloverHome);
  try {
    mkdirSync(template, { recursive: true, mode: 0o700 });
    return template;
  } catch (e) {
    return { kind: "refused", reason: `a fenced process can't be started here: Clover's git template ${template} can't be made (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** The run with `GIT_TEMPLATE_DIR` pointed at Clover's empty template. */
function withGitTemplate(r: FencedRun, template: string): FencedRun {
  return { ...r, env: { ...r.env, GIT_TEMPLATE_DIR: template } };
}

/** The most of a git config (or a `.git` file) read: past it the file is "too big" (#366's review). */
export const CONFIG_READ_CAP = 1024 * 1024;
const TOO_BIG = "\u0000clover:too-big:";
/** A file past `CONFIG_READ_CAP`, as a stamp that changes when it does (never a config's text: it starts with NUL). */
export const isTooBig = (text: string | null): boolean => text !== null && text.startsWith(TOO_BIG);

/** A regular file's text, read without blocking: opened non-blocking (a FIFO never waits for a writer), the opened
 *  file required to be a regular one (`fstat` on the descriptor, so nothing is swapped in between), and read up to
 *  `CONFIG_READ_CAP` (`/dev/zero` never stalls it); past it, a too-big stamp. Without `follow`, a link is refused
 *  (`O_NOFOLLOW`). Null when missing, not a regular file or unreadable. */
function readCapped(path: string, follow: boolean): string | null {
  let fd = -1;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (follow ? 0 : fsConstants.O_NOFOLLOW));
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const stamp = `${TOO_BIG}${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (st.size > CONFIG_READ_CAP) return stamp;
    const buf = Buffer.alloc(CONFIG_READ_CAP + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > CONFIG_READ_CAP) return stamp;
    }
    return buf.toString("utf8", 0, n);
  } catch { return null; } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

/** What a watched path that is a link leads to, read through the link (`readCapped`); null when it isn't a link. */
function readThroughLink(path: string): string | null {
  try { if (!lstatSync(path).isSymbolicLink()) return null; } catch { return null; }
  return readCapped(path, true);
}

/** A file's text without following a link (`readCapped`), or null when it isn't a regular file. */
function readIfFile(path: string): string | null {
  return readCapped(path, false);
}

/** Snapshots file contents (null where missing) for the post-command checks, without following links. */
export function snapshotFiles(paths: readonly string[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const p of paths) m.set(p, readIfFile(p));
  return m;
}

/** Makes a link-free empty file, 0600: parents first, then O_CREAT|O_EXCL|O_NOFOLLOW. An existing file or link
 *  is the user's own: left alone. Anything else fails the run, so nothing plants through a half-made path. */
function ensureEmptyFile(path: string): void {
  mkdirNoLinks(dirname(path));
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return; // already there: leave it
    throw e; // ELOOP (a link) and the rest: fail closed
  }
  try { closeSync(fd); } catch { /* created: good enough */ }
}

/** Whether a path exists at all, without following a final link. */
function existsNoFollow(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** Quarantines files that appeared since the snapshot (spec item 1116's belt while the supervisor is new): moves
 *  each aside under the Clover home (outside every runner view) and locks it down, without following links.
 *  Returns the report line, or null when nothing appeared. */
export function quarantinePlanted(before: Map<string, boolean>, cloverHome: string): string | null {
  const planted: string[] = [];
  for (const [p, wasThere] of before) {
    if (wasThere) continue;
    try { lstatSync(p); } catch { continue; } // still missing
    try {
      const qdir = join(cloverHome, "quarantine");
      mkdirSync(qdir, { recursive: true, mode: 0o700 });
      const q = join(qdir, `${basename(p)}.quarantined-${randomBytes(4).toString("hex")}`);
      renameSync(p, q);
      try { chmodSync(q, 0); } catch { /* moved aside is enough */ }
      planted.push(p);
    } catch { /* stays: the fence still judges every tool call that reaches it */ }
  }
  return planted.length === 0 ? null : `clover: the run planted ${planted.join(", ")}; quarantined\n`;
}

/** Whether every folder holding `path` is a plain folder, without following links. */
function chainIsClean(path: string): boolean {
  let at = dirname(path);
  for (;;) {
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(at); } catch { return false; }
    if (st === undefined || !st.isDirectory() || st.isSymbolicLink()) return false;
    if (at === dirname(at)) return true;
    at = dirname(at);
  }
}

/** Reverts risky git keys a sandboxed command added or changed (spec item 1116): only the watched keys are
 *  touched, other edits stay, and nothing is written through a planted link or into a planted folder. A file that
 *  appeared with watched keys set has those lines dropped (an empty file left behind sets nothing). The fixed
 *  file is re-parsed through git's own parser before it lands: if any watched change survives (a layout git
 *  accepts that the line parser misses), the file's pre-run bytes are written back instead — or the appeared
 *  file removed — and the report says "not reverted". The write uses git's lockfile protocol (`config.lock`,
 *  created exclusively, re-read, written, renamed over) with a retry; on final failure the same fallback
 *  applies. A file that changed since it was read is never clobbered. Returns the report line, or null. */
export function revertPlantedGitKeys(before: Map<string, string | null>): string | null {
  const notes: string[] = [];
  for (const [p, prev] of before) {
    const cur = readIfFile(p);
    if (cur === prev) continue;
    if (isTooBig(cur)) {
      // Past the cap it can't be checked: its earlier state comes back (a file that appeared goes), or it is reported.
      if (isTooBig(prev)) { notes.push(`${p}: kept a git config too big to check (over ${CONFIG_READ_CAP} bytes)`); continue; }
      restorePreRun(p, prev);
      notes.push(`${p}: a git config too big to check (over ${CONFIG_READ_CAP} bytes): ${prev === null ? "removed" : "restored as it was"}`);
      continue;
    }
    const changed = watchedGitChanges(prev, cur);
    if (changed.length === 0) continue; // an unwatched change (or unreadable now): leave it
    if (!chainIsClean(p)) {
      notes.push(`${p}: kept risky git keys (${changed.map((c) => c.dotted).join(", ")}): planted link above`);
      continue;
    }
    try {
      const fixed = revertWatchedGitChanges(cur ?? "", changed);
      // Re-verify through git's own parser: the built-in line parser can miss layouts git itself accepts
      // (case tricks, continuations, subsection spellings). Anything surviving means the revert lied.
      const remaining = watchedGitChanges(prev, fixed);
      if (remaining.length > 0) {
        restorePreRun(p, prev);
        notes.push(`${p}: could not revert risky git keys (${remaining.map((c) => c.dotted).join(", ")}): not reverted`);
        continue;
      }
      // Compare-and-swap: only replace a file that hasn't changed since it was read.
      if (readIfFile(p) !== cur) {
        notes.push(`${p}: kept risky git keys (${changed.map((c) => c.dotted).join(", ")}): changed under us, not clobbered`);
        continue;
      }
      const written = writeLocked(p, fixed, cur);
      if (written === "changed") {
        notes.push(`${p}: kept risky git keys (${changed.map((c) => c.dotted).join(", ")}): changed under us, not clobbered`);
        continue;
      }
      if (written !== "ok") {
        restorePreRun(p, prev);
        notes.push(`${p}: could not revert risky git keys (${changed.map((c) => c.dotted).join(", ")}): not reverted`);
        continue;
      }
      notes.push(`${p}: reverted risky git keys (${changed.map((c) => c.dotted).join(", ")})`);
    } catch {
      notes.push(`${p}: kept risky git keys (${changed.map((c) => c.dotted).join(", ")}): could not revert`);
    }
  }
  return notes.length === 0 ? null : `clover: the run set risky git keys; ${notes.join("; ")}\n`;
}

/** Writes `content` over `p` with git's lockfile protocol: `p.lock` is created exclusively (git's own
 *  lockfile name, so a concurrent git respects it too), the live file is re-read against `expect` (a
 *  concurrent writer's bytes are never clobbered), the content is written to the lock with the live file's
 *  mode copied over (a 0644 config stays 0644), and the lock is renamed over. Retries a contested lock.
 *  One `finally` unlinks the lock whenever this call created it and didn't rename it over, so no outcome —
 *  landed, changed-under-us, or failed — can leave a `config.lock` behind to block the user's git. */
export function writeLocked(p: string, content: string, expect: string | null): "ok" | "changed" | "locked" | "error" {
  const lock = `${p}.lock`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd = -1;
    let created = false;
    let renamed = false;
    try {
      try {
        fd = openSync(lock, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        created = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "EEXIST") continue; // contested: retry
        return "error";
      }
      if (readIfFile(p) !== expect) return "changed";
      writeFileSync(fd, content, { encoding: "utf8" });
      try { fchmodSync(fd, lstatSync(p).mode & 0o7777); } catch { /* 0600 stands */ }
      if (fd !== -1) { try { closeSync(fd); } catch { /* written */ } fd = -1; }
      renameSync(lock, p);
      renamed = true;
      return "ok";
    } catch {
      return "error";
    } finally {
      if (fd !== -1) { try { closeSync(fd); } catch { /* best effort */ } }
      if (created && !renamed) { try { unlinkSync(lock); } catch { /* best effort */ } }
    }
  }
  return "locked";
}

/** The Addendum 10 fallback: put the file's pre-run bytes back (or remove a file that appeared), best
 *  effort, without clobber checks — leaving a half-reverted risky key is worse than restoring. The lock is
 *  owned the same single way: created here, unlinked here unless renamed over. */
function restorePreRun(p: string, prev: string | null): void {
  try {
    if (prev === null) {
      // A file that appeared: remove it (missing counts as reverted — nothing for git to read).
      try {
        const st = lstatSync(p);
        if (!st.isSymbolicLink() && st.isFile()) unlinkSync(p);
      } catch { /* gone or a link: leave it */ }
      return;
    }
    const lock = `${p}.lock`;
    let fd = -1;
    let created = false;
    let renamed = false;
    try {
      fd = openSync(lock, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      created = true;
      writeFileSync(fd, prev, { encoding: "utf8" });
      try { fchmodSync(fd, lstatSync(p).mode & 0o7777); } catch { /* 0600 stands */ }
      if (fd !== -1) { try { closeSync(fd); } catch { /* written */ } fd = -1; }
      renameSync(lock, p);
      renamed = true;
    } finally {
      if (fd !== -1) { try { closeSync(fd); } catch { /* best effort */ } }
      if (created && !renamed) { try { unlinkSync(lock); } catch { /* best effort */ } }
    }
  } catch { /* best effort */ }
}

/** Every git config a repo root could plant risky keys in: its own config, its per-worktree config, its
 *  submodules' configs, and — for a linked worktree (a `.git` file naming its gitdir) — the worktree's config
 *  plus the shared config all its worktrees read. Links are never followed: a planted link resolves null. */
export function repoConfigFiles(repoRoot: string): string[] {
  const out: string[] = [];
  let git: ReturnType<typeof lstatSync> | undefined;
  try { git = lstatSync(join(repoRoot, ".git")); } catch { return out; }
  if (git === undefined || git.isSymbolicLink()) return out;
  if (git.isDirectory()) {
    const dir = join(repoRoot, ".git");
    out.push(join(dir, "config"), join(dir, "config.worktree"));
    try {
      for (const n of readdirSync(join(dir, "modules"))) {
        const c = join(dir, "modules", n);
        let st: ReturnType<typeof lstatSync> | undefined;
        try { st = lstatSync(c); } catch { continue; }
        if (st !== undefined && st.isDirectory() && !st.isSymbolicLink()) out.push(join(c, "config"));
      }
    } catch { /* no submodules */ }
    return out;
  }
  // A linked worktree: `.git` names its gitdir, `<common>/worktrees/<name>`.
  try {
    const line = (readIfFile(join(repoRoot, ".git")) ?? "").split("\n")[0] ?? "";
    const m = /^gitdir:\s*(.+?)\s*$/.exec(line);
    if (m === null) return out;
    const g = m[1]!.startsWith("/") ? m[1]! : join(repoRoot, m[1]!);
    out.push(join(g, "config"));
    const common = g.replace(/\/worktrees\/[^/]+\/?$/, "");
    if (common !== g) out.push(join(common, "config"));
  } catch { /* unreadable: nothing to watch */ }
  return out;
}

/** How many folders a watched session's writable folders are looked over for repos at each `recheck`, at any depth.
 *  Past it the walk stops and says so (`stopped`); a repo it didn't reach is the documented miss (the fence judges
 *  every tool call, and a planted hook is the supervisor's and the belt's). */
export const WATCH_REPO_BUDGET = 20_000;

/** A bare repo's own folder: `config` and `HEAD` files and an `objects` folder (`git init --bare`, `clone --bare`). */
function isBareRepo(dir: string): boolean {
  try {
    return lstatSync(join(dir, "config")).isFile() && lstatSync(join(dir, "HEAD")).isFile() && lstatSync(join(dir, "objects")).isDirectory();
  } catch { return false; }
}

/** Every repo's git config files under `roots`: each folder holding `.git`, and each bare repo's own `config`, at any
 *  depth, level by level (a big tree spends the budget on its deeper levels last), never through a link, never into
 *  a `.git`; only folders count toward `budget`. No folder name is skipped: a `node_modules` would be a place to hide a
 *  repo in. `stopped`: the budget ran out before the walk did. */
export function reposUnder(roots: readonly string[], budget = WATCH_REPO_BUDGET): { files: string[]; stopped: boolean } {
  const out = new Set<string>();
  let left = budget;
  let level = [...roots];
  let stopped = false;
  while (level.length > 0) {
    // Every folder reached is looked at for a repo; only then are the next level's folders counted.
    for (const dir of level) {
      for (const c of repoConfigFiles(dir)) out.add(c);
      if (isBareRepo(dir)) out.add(join(dir, "config"));
    }
    if (stopped) break;
    const next: string[] = [];
    for (const dir of level) {
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (n === ".git") continue;
        const c = join(dir, n);
        let isDir = false;
        try { const st = lstatSync(c); isDir = st.isDirectory() && !st.isSymbolicLink(); } catch { /* gone */ }
        if (!isDir) continue;
        if (left <= 0) { stopped = true; break; }
        left--;
        next.push(c);
      }
      if (stopped) break;
    }
    level = next;
  }
  return { files: [...out], stopped };
}

/** A watched session's git configs: its cwd's (`watchedConfigFiles`) and every repo's in its writable folders. */
function sessionConfigFiles(home: string, cwd: string, writable: readonly string[]): { files: string[]; stopped: boolean } {
  const r = reposUnder(writable);
  return { files: [...new Set([...watchedConfigFiles(home, cwd), ...r.files])], stopped: r.stopped };
}

/** The git configs a sandboxed command could plant risky keys in: the global ones, the session repo's, any
 *  repo made during the run one level under the cwd, and the files those configs' pre-existing `include.path`
 *  and `includeIf.*.path` entries point at (a planted key in an included file reads the same). Deeper nesting
 *  is a documented miss: the supervisor and the belt still cover planted hooks, and the fence judges every
 *  tool call. Missing files are watched too: a file that appears is reverted when it carries a watched key. */
function watchedConfigFiles(home: string, cwd: string): string[] {
  const out = new Set([join(home, ".gitconfig"), join(home, ".config", "git", "config")]);
  const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
  let at: string | null = cwd;
  const seen = new Set<string>();
  while (at !== null && !seen.has(at) && (at === home || under(at, home))) {
    seen.add(at);
    for (const c of repoConfigFiles(at)) out.add(c);
    try {
      for (const n of readdirSync(at)) {
        const c = join(at, n);
        let st: ReturnType<typeof lstatSync> | undefined;
        try { st = lstatSync(c); } catch { continue; }
        if (st !== undefined && st.isDirectory() && !st.isSymbolicLink()) {
          for (const f of repoConfigFiles(c)) out.add(f);
        }
      }
    } catch { /* unreadable */ }
    if (at === home) break;
    at = dirname(at);
  }
  // One level of pre-existing includes: each watched file that exists contributes the files its own
  // include.path / includeIf entries name. Planted entries added during the run are reverted, not followed —
  // only the pre-run bytes are read here.
  for (const p of [...out]) {
    for (const t of includeTargets(readIfFile(p), dirname(p), home)) {
      if (!out.has(t)) out.add(t);
    }
  }
  return [...out];
}

/** The files a config's own `include.path` and `includeIf.*.path` entries name, resolved the way git reads
 *  them: a leading `~/` grows from the home, an absolute path stands, a relative path grows from the config's
 *  own folder. Glob patterns are expanded where the platform can; an unresolvable entry resolves null. */
export function includeTargets(text: string | null, baseDir: string, home: string): string[] {
  if (text === null) return [];
  const out: string[] = [];
  for (const k of parseGitConfigWatched(text)) {
    const dot = k.dotted.toLowerCase();
    const isInclude = dot === "include.path" || (dot.startsWith("includeif.") && dot.endsWith(".path"));
    if (!isInclude) continue;
    const raw = k.value.trim();
    if (raw === "") continue;
    const abs = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw.startsWith("/") ? raw : join(baseDir, raw);
    if (/[*?\[\]{}]/.test(abs)) {
      // A glob: expand it where the platform can, otherwise skip (never guess).
      try {
        const slash = abs.lastIndexOf("/");
        const dir = slash < 0 ? "." : abs.slice(0, slash) || "/";
        const pat = slash < 0 ? abs : abs.slice(slash + 1);
        const g = new Bun.Glob(pat);
        for (const m of g.scanSync({ cwd: dir, absolute: true })) out.push(m);
      } catch { /* unexpandable: skip */ }
      continue;
    }
    out.push(abs);
  }
  return [...new Set(out)];
}
/** Makes `target` and any missing parents, refusing a link anywhere on the way down (like `makeBotFolders`):
 *  a planted link never redirects the creation. An existing non-folder is left alone (the read-only bind still
 *  covers it). Throws naming the offending link. */
export function mkdirNoLinks(target: string): void {
  const missing: string[] = [];
  let at = target;
  for (;;) {
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(at); } catch { st = undefined; }
    if (st === undefined) {
      missing.unshift(at);
      const parent = dirname(at);
      if (parent === at) throw new Error(`${target} has no plain folder above it`);
      at = parent;
      continue;
    }
    if (st.isSymbolicLink()) throw new Error(`${at} is a link: folders are never made through a link`);
    if (!st.isDirectory()) return; // something else is already there: leave it for the read-only bind
    break;
  }
  for (const p of missing) mkdirSync(p, { mode: 0o700 });
}

/** The session's own repo's `.git/hooks`, when `cwd` sits inside a repo under `home`: the folder a planted hook
 *  would fire from. Climbs without following links — a link on the way up stops the climb — and stays under the
 *  home. A `.git` file (a linked worktree) is resolved through its `gitdir:` line; anything else resolves null. */
export function ownRepoHooks(cwd: string, home: string): string | null {
  const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
  let at = cwd;
  for (;;) {
    let me: ReturnType<typeof lstatSync> | undefined;
    try { me = lstatSync(at); } catch { me = undefined; }
    if (me === undefined || me.isSymbolicLink()) return null; // never climb through a link
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(join(at, ".git")); } catch { st = undefined; }
    if (st !== undefined && !st.isSymbolicLink()) {
      if (st.isDirectory()) return join(at, ".git", "hooks");
      // A linked worktree names its real git dir: `gitdir: <path>`.
      try {
        const line = readFileSync(join(at, ".git"), "utf8").split("\n")[0] ?? "";
        const m = /^gitdir:\s*(.+?)\s*$/.exec(line);
        if (m !== null) return join(at, m[1]!, "hooks");
      } catch { /* unreadable: no hooks to bind */ }
      return null;
    }
    if (at === home || !under(at, home) || dirname(at) === at) return null;
    at = dirname(at);
  }
}

function closed(reason: string): FencedSpawner {
  return { available: false, run: async () => ({ kind: "refused", reason: `a fenced process can't be started here: ${reason}` }) };
}
