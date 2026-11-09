// The fenced process (C-M2 part 2): a command run under the fence, for bots' Bash and, on macOS, a hook's command
// (spec §9.1; `spawn.ts`'s door). One sandbox per OS, built from the fence's `SandboxPolicy` at each run, so a
// development folder added or a plugin's data folder made since is in it:
//   macOS    Seatbelt (`sandbox-exec -p`, `macos-profile.ts`)
//   Linux    bubblewrap (`linux-bwrap.ts`), from its standard place only; where unprivileged user namespaces are shut
//            (AppArmor's restriction on Ubuntu without bwrap's profile) the door says so and refuses
//   Windows  not yet: the door says so and refuses
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  /** Linux: how long a failed bwrap probe stands (`BWRAP_PROBE_RETRY_MS` by default; tests). */
  readonly probeRetryMs?: number;
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

/** How long a failed bwrap probe stands before the next run tries again (a bwrap installed meanwhile). */
export const BWRAP_PROBE_RETRY_MS = 60_000;

/** The macOS holder for `o`: the one named, else the one beside the daemon's executable when it is there. */
function holderFor(o: FencedProcessOptions): string | null {
  if (o.processHolder !== undefined) return o.processHolder !== null && existsSync(o.processHolder) ? o.processHolder : null;
  const beside = join(dirname(process.execPath), PROCESS_HOLDER_FILE);
  return existsSync(beside) ? beside : null;
}

/** Each session's watched git config files as its last run left them (after that run's revert), for `recheck`. */
class SessionConfigs {
  readonly #by = new Map<string, Map<string, string | null>>();
  /** After a run: what each watched file holds now is what the next look compares against. */
  settled(sessionId: string | undefined, paths: Iterable<string>): void {
    if (sessionId === undefined) return;
    const m = this.#by.get(sessionId) ?? new Map<string, string | null>();
    for (const p of paths) m.set(p, readIfFile(p));
    this.#by.set(sessionId, m);
  }
  recheck(sessionId: string, opts: { end?: boolean } = {}): string | null {
    const m = this.#by.get(sessionId);
    if (m === undefined) return null;
    const note = revertPlantedGitKeys(m);
    if (opts.end) this.#by.delete(sessionId);
    else for (const p of m.keys()) m.set(p, readIfFile(p));
    return note;
  }
}

const sessionOf = (r: FencedRun): string | undefined => (r.who.caller.kind === "session" ? r.who.caller.sessionId : undefined);

export function fencedSpawner(o: FencedProcessOptions): FencedSpawner {
  const os = o.os ?? o.fence.os;
  const configs = new SessionConfigs();
  if (os === "macos") {
    if (!existsSync(SANDBOX_EXEC)) return closed("macOS's sandbox (sandbox-exec) isn't on this Mac");
    return {
      available: true,
      recheck: (sessionId, opts) => configs.recheck(sessionId, opts),
      run: async (r) => {
        const template = ensureGitTemplate(o.fence.cloverHome);
        if (typeof template !== "string") return template;
        const ctx = fenceContextFor(r.who.caller);
        const policy = o.fence.policy(ctx);
        const profile = macFenceProfile({ policy, cloverHome: o.fence.cloverHome, home: o.fence.home, perUserTemp: (o.perUserTemp ?? darwinUserTemp)(), caller: callerPlaces(o.fence.cloverHome, os, ctx) });
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
        const note = revertPlantedGitKeys(configBefore);
        configs.settled(sessionOf(r), configBefore.keys());
        return note === null ? result : { ...result, stderr: result.stderr + note };
      },
    };
  }
  if (os === "linux") {
    const bwrap = o.bwrap ?? BWRAP;
    // Whether bwrap can make its namespaces here, probed off the event loop: warmed at the daemon's start (`warm`),
    // never a blocking spawn on a hook's first run (INT, #369's review). A failure is tried again after
    // `BWRAP_PROBE_RETRY_MS`, so a bwrap installed meanwhile works without a restart.
    let probed: string | null | undefined; // null: it works; a string: why it doesn't
    let probedAt = 0;
    let probing: Promise<string | null> | undefined;
    const probe = (): Promise<string | null> => {
      const now = Date.now();
      if (probed === null || (probed !== undefined && now - probedAt < (o.probeRetryMs ?? BWRAP_PROBE_RETRY_MS))) return Promise.resolve(probed);
      probing ??= (async () => {
        let why: string | null;
        if (!existsSync(bwrap)) why = "bubblewrap isn't installed (/usr/bin/bwrap)";
        else {
          try {
            const child = Bun.spawn([bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "/bin/true"], { stdout: "ignore", stderr: "pipe" });
            const timer = setTimeout(() => child.kill(), 10_000);
            const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
            clearTimeout(timer);
            why = code === 0 ? null : `bubblewrap can't make its namespaces here (${(stderr || `exit ${code}`).trim().slice(0, 200)})`;
          } catch (err) {
            why = `bubblewrap can't make its namespaces here (${(err instanceof Error ? err.message : String(err)).slice(0, 200)})`;
          }
        }
        probed = why;
        probedAt = Date.now();
        probing = undefined;
        return why;
      })();
      return probing;
    };
    return {
      // Before the first probe answers: whether bwrap is there at all; after, the probe's answer.
      get available() { return probed === undefined ? existsSync(bwrap) : probed === null; },
      warm: async () => { await probe(); },
      recheck: (sessionId, opts) => configs.recheck(sessionId, opts),
      run: async (r) => {
        const why = await probe();
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

/** Reads a file's bytes without following a link, or null when it isn't a plain file. */
function readIfFile(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return readFileSync(path, "utf8");
  } catch { return null; }
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
    const line = readFileSync(join(repoRoot, ".git"), "utf8").split("\n")[0] ?? "";
    const m = /^gitdir:\s*(.+?)\s*$/.exec(line);
    if (m === null) return out;
    const g = m[1]!.startsWith("/") ? m[1]! : join(repoRoot, m[1]!);
    out.push(join(g, "config"));
    const common = g.replace(/\/worktrees\/[^/]+\/?$/, "");
    if (common !== g) out.push(join(common, "config"));
  } catch { /* unreadable: nothing to watch */ }
  return out;
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
