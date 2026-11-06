// The fenced process (C-M2 part 2): a command run under the fence, for bots' Bash and, on macOS, a hook's command
// (spec §9.1; `spawn.ts`'s door). One sandbox per OS, built from the fence's `SandboxPolicy` at each run, so a
// development folder added or a plugin's data folder made since is in it:
//   macOS    Seatbelt (`sandbox-exec -p`, `macos-profile.ts`)
//   Linux    bubblewrap (`linux-bwrap.ts`), from its standard place only; where unprivileged user namespaces are shut
//            (AppArmor's restriction on Ubuntu without bwrap's profile) the door says so and refuses
//   Windows  not yet: the door says so and refuses
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { fenceContextFor } from "../contracts/fence";
import type { CloverFence } from "./fence";
import { bwrapPlan, heldFolderNote, unixSocketFilter } from "./linux-bwrap";
import { macFenceProfile } from "./macos-profile";
import { callerPlaces } from "./per-caller";
import { runCommand, type FencedSpawner } from "./spawn";

export interface FencedProcessOptions {
  readonly fence: CloverFence;
  readonly os?: Os;
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

export function fencedSpawner(o: FencedProcessOptions): FencedSpawner {
  const os = o.os ?? o.fence.os;
  if (os === "macos") {
    if (!existsSync(SANDBOX_EXEC)) return closed("macOS's sandbox (sandbox-exec) isn't on this Mac");
    return {
      available: true,
      run: (r) => {
        const ctx = fenceContextFor(r.who.caller);
        const policy = o.fence.policy(ctx);
        const profile = macFenceProfile({ policy, cloverHome: o.fence.cloverHome, home: o.fence.home, perUserTemp: (o.perUserTemp ?? darwinUserTemp)(), caller: callerPlaces(o.fence.cloverHome, os, ctx) });
        return runCommand(r, { shell: "sh", argv: [SANDBOX_EXEC, "-p", profile, "/bin/sh", "-c", r.command] });
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
          if (repoHooks !== null) { try { mkdirSync(repoHooks, { recursive: true, mode: 0o700 }); } catch { /* stays unbound */ } }
          const plan = bwrapPlan({ policy: o.fence.policy(ctx), cloverHome: o.fence.cloverHome, cwd: r.cwd, uid: process.getuid?.() ?? 0, seccompFd: 3, caller, repoHooks });
          const result = await runCommand(r, { shell: "sh", argv: [bwrap, ...plan.args, "/bin/sh", "-c", r.command], extraFds: [fd] });
          if (result.kind === "refused") return result;
          const note = heldFolderNote(result.stderr, plan.held);
          return note === null ? result : { ...result, stderr: result.stderr + note };
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

/** The session's own repo's `.git/hooks`, when `cwd` sits inside a repo under `home`: the folder a planted hook
 *  would fire from. Climbs without following links — a link on the way up stops the climb — and stays under the
 *  home; null outside a repo, outside the home, or through a link. */
export function ownRepoHooks(cwd: string, home: string): string | null {
  const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
  let at = cwd;
  for (;;) {
    let me: ReturnType<typeof lstatSync> | undefined;
    try { me = lstatSync(at); } catch { me = undefined; }
    if (me === undefined || me.isSymbolicLink()) return null; // never climb through a link
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(join(at, ".git")); } catch { st = undefined; }
    if (st !== undefined && !st.isSymbolicLink()) return join(at, ".git", "hooks");
    if (at === home || !under(at, home) || dirname(at) === at) return null;
    at = dirname(at);
  }
}

function closed(reason: string): FencedSpawner {
  return { available: false, run: async () => ({ kind: "refused", reason: `a fenced process can't be started here: ${reason}` }) };
}
