// Contract: Fence (spec §3.1, §4, §9.1 "Bots cannot raise their own access" and "The fence, precisely", §9.3).
// Owner: lane C.
//
// A core fence keeps bots' tools, and agents' commands through their own sandboxes, away from the files that hold
// settings, levels, credentials and bots' user layers, on every OS. The installed plugins folder is fenced too (#197):
// bots get plugins in through `plugin.install`'s OK card and develop them in development folders. The rest of the
// Clover home is default-deny for every tool and runner, with per-caller ways in: a bot writes its own routines as
// files (`routines/<bot>/`), and the app asks before running a routine at a raised level. The fence judges only what
// models drive (a bot's tools, an agent's requests, a plugin's `files` calls); the user's own actions never ask it.
//
// One Fence per computer: each computer fences its own home, and the folder tree asks the fence of the computer that
// holds the files (§9.1 "Approvals follow the files"). Paths are absolute and canonical on that computer; the real
// implementation canonicalizes per OS (case, symlinks, junctions, 8.3 names, hard-link aliases), the fake is POSIX.
import { isAnyPluginId, type Caller, type Os } from "@waifucave/clover-protocol";
import { isInside, type Unsubscribe } from "./common";

/** The fenced set (§9.1), plus the files that hold secrets on Windows and Linux (§8.5). */
export const FENCED_KINDS = [
  "settings",
  "levels",
  "saved-rules",
  "connector-permissions",
  "trust",
  "device-list",
  "user-layers",
  "credential-store",
  /** The registry's own records (review S8): a bot that could write them would approve its own plugin. The OKs (each
   *  plugin's approved tree hash, child switches and card styling last OK'd), */
  "plugin-oks",
  /** the installed-plugins list that syncs (§8.5: ids, versions, hashes, on/off states, opt-outs), */
  "installed-plugins",
  /** and the user's confirmation that they are 18 or older (§5.7). */
  "adult-confirmation",
  /** Development folders themselves (§5.6): they reload on every change without asking. */
  "dev-folders",
  /** The bot driver's state per session, `<home>/sessions-runtime/` (A-M3), which a turn resumes from. Write-denied, and
   *  read-denied too (#197's check 4): a session reads only its own state, `sessions-runtime/<sessionId>…`, through
   *  `forCaller`; the user's surfaces and the core, which the fence doesn't judge, read all of it. */
  "sessions-runtime",
  /** Each bot's memory, `<home>/bots/<bot>/memory/` (the owner's decision). The rule is by pattern, not by the list of
   *  bots (#197's check 4): any `bots/<x>/memory/…`, for a bot not made yet, one synced from elsewhere before the list
   *  catches up, or a removed bot's leftover folder, is reachable only by the bot whose id folds equal to `<x>` (a
   *  child's `/` written `--`), through its main conversation or side threads (`forCaller`); every other caller is
   *  refused both, a check with no caller included. `bots/<x>` and `bots/` themselves are never deleted, moved or
   *  written over, as they hold memory. `fencedSet` lists the known bots' items (`deny: "caller"`); the pattern rules. */
  "bot-memory",
  /** The installed plugins folder, `<home>/plugins/` (#197's check 2): bots, agents and plugin code get a plugin in only
   *  through `plugin.install`'s OK card, and develop plugins in development folders, so nothing they write there loads
   *  or changes a plugin the user OK'd. Read-only to them. */
  "plugins",
  /** `<home>/plugin-data/<id>/` (§5.4), where add-ons live. */
  "plugin-data",
  /** The daemon's run folder: denied for reading too, as it is today. */
  "run-folder",
  /** Sessions' records (`<home>/sessions/`): a bot rewriting its transcript could rewrite what the user said (lane C). */
  "transcripts",
  /** The usage ledger (`<home>/usage/`, lane C). */
  "usage",
  /** The Clover Browser's partitions, cookies and logins included (`<userData>/Partitions/`, lanes C and L): denied for
   *  reading too. */
  "browser-profiles",
  /** The login item that starts the daemon at login (lane C): macOS's LaunchAgents plist and its parked copy, Linux's
   *  systemd user unit; Windows keeps it in Task Scheduler, a closed door. And every place a file written now runs
   *  later outside any sandbox (`autoRunPaths`: shell start files, login items, autostart, SSH's rc and keys). */
  "login-start",
  /** The install folders of the coding agents the user has OK'd to run (lane K, keyed to each program's real path and
   *  hash): the resolved program's folder, and npm's global package folder for its package. Write-denied to sessions
   *  and agents, so none can swap in a new copy of itself or of another agent. They change as the user OKs agents. And
   *  the coding agents' own sandbox settings (`agentConfigPaths`). */
  "agent-installs",
  /** Windows and Linux: the encrypted secrets file, hidden from reads too (§8.5, §9.1). */
  "secrets-file",
  /** Windows and Linux: any file holding the secrets file's key, hidden from reads too. */
  "key-file",
] as const;
export type FencedKind = (typeof FENCED_KINDS)[number];

/** The items whose contents the fence hides from reads as well as writes. */
/** The items whose reach is the caller's (`deny: "caller"`, `forCaller`). */
export const CALLER_KINDS: readonly FencedKind[] = ["bot-memory"];
export const READ_DENIED_KINDS: readonly FencedKind[] = ["run-folder", "browser-profiles", "secrets-file", "key-file"];
/** The items a write to which runs later outside any sandbox: a bot's or an agent's write there is refused without a
 *  card (the approval broker's rule 3), where any other fenced item gets one. */
export const RUN_LATER_KINDS: readonly FencedKind[] = ["login-start", "agent-installs"];

export interface FencedPath {
  kind: FencedKind;
  /** Absolute and canonical; a folder covers everything inside it. */
  path: string;
  /** `caller`: read- and write-denied but to the caller the item is for (`bot`), as `forCaller` binds it. */
  deny: "write" | "read-write" | "caller";
  /** For a `bot-memory` item, the bot whose memory it is. */
  bot?: string;
}

export type FenceOp =
  | { op: "read" | "list" | "stat"; path: string }
  | { op: "write" | "delete"; path: string }
  | { op: "move"; path: string; to: string };

export type FenceVerdict =
  | { allowed: true }
  /** `alias`: a Windows name the disk reads as another file, a stream (`settings.json::$DATA`) or an 8.3 short name
   *  (`CLOVER~1`), refused wherever it is. */
  | { allowed: false; reason: FencedKind | "clover-home" | "alias"; path: string };

/** What a sandbox needs to hold the fence for one command runner: Bash (PowerShell on Windows), and each agent's own
 *  sandbox, whose format lane K writes from these arrays (Claude Code's deny rules, Codex's settings, §9.3). */
export interface SandboxPolicy {
  /** Commands may write here: the home and temp folders (§9.1), less `denyWrite`. */
  allowWrite: string[];
  /** Paths, and globs whose `*` segment is any one name. The whole Clover home is in both lists for every runner
   *  (the home default-deny, the controller's ruling on #197's follow-up); the `own…` folders below are the only ways
   *  back in. */
  denyWrite: string[];
  denyRead: string[];
  /** The runner's own session's outputs, `<home>/outputs/<session>`: read and write inside. */
  ownOutputs?: string;
  /** The runner's own bot's scratch folder, `<home>/scratch/<bot>`, for that bot's main conversation and side threads:
   *  read and write inside. */
  ownScratch?: string;
  /** The runner's own bot's folder, `<home>/bots/<x>`, for the same runners: read only. */
  ownBot?: string;
  /** The runner's own bot's routines, `<home>/routines/<x>`, for the same runners (the controller's ruling: bots write
   *  routines as files, and any edit or move drops a raised level's OK): read and write inside. */
  ownRoutines?: string;
  /** A plugin's own data folder, `<home>/plugin-data/<id>` (its `/` written `--`), for that plugin's own code alone,
   *  keyed on its own id, acting for a session too; never for a bot or a session (the controller's ruling): read and
   *  write inside. */
  ownPluginData?: string;
  /** The runner's own bot's memory (`<home>/bots/<x>/memory`), for the same runners (J's ruling on #197), its id a valid
   *  bot id: read and write inside. Absent for every other runner (coding sessions, agents, the bot's own included,
   *  plugins).
   *
   *  The order a sandbox applies these in is fixed (#197's check 5), and `policyAllows` is its reference:
   *  1. paths compare as resolved real paths, folded, a subpath only at a `/` boundary (never a bare prefix:
   *     `memory-x` is not inside `memory`), a glob's `*` one whole name;
   *  2. unlinking or renaming an `own…` folder itself, or any folder that holds one, is denied;
   *  3. inside `ownMemory`, `ownOutputs`, `ownScratch`, `ownRoutines` and `ownPluginData`, reading and writing pass; `ownBot` and the `own…` folders
   *     themselves, reading;
   *  4. otherwise `denyWrite` and `denyRead` deny, the Clover home included.
   *  Linux's Landlock can't put an allow inside a deny, so lane C's Linux sandbox needs its own way to meet this order
   *  (for example: leave the Clover home out of its grants and grant the `own…` folders alone). */
  ownMemory?: string;
  /** Programs that would hand work to an unfenced process: `open`, `launchctl` and `osascript` on macOS,
   *  `systemd-run --user` on Linux, the Task Scheduler on Windows (§3.1). */
  closedDoors: string[];
  /** Never reachable from a command, approved escapes included: the cloud metadata address first (§9.2). */
  blockedAddresses: string[];
  /** Today's sandboxed Bash has no network (spike S8 read it from source); lane C settles Clover's (S8 item 1). */
  network: "none" | "filtered";
}

/** Who an operation is for, for `bot-memory`: `memoryOf`, a bot's own session (its main conversation or a side
 *  thread), which reaches that bot's memory alone; `user`, the user's own reach and the core's (the fence doesn't
 *  judge them, `check` included); neither, any other caller, which reaches no bot's memory. */
export interface FenceContext {
  memoryOf?: string;
  user?: boolean;
  /** The calling session, whose own `outputs/<session>/` it reaches: a bot's session, a side thread, or a coding
   *  session the user started; never a delegated agent's. */
  sessionId?: string;
  /** The calling plugin's own id, whose own `plugin-data/<id>/` it reaches (a valid plugin id). */
  pluginId?: string;
}

/** The `bot-memory` reach of a caller (`Fence.forCaller`), the owner's decision: a bot's main conversation and side
 *  threads reach their bot's memory; the user and the core reach all; every other caller none, the user's coding
 *  sessions, ACP and delegated agents (the bot's own included), plugins and peers. */
export function fenceContextFor(caller: Caller): FenceContext {
  if (caller.kind === "user" || caller.kind === "core") return { user: true };
  if (caller.kind === "plugin") return isAnyPluginId(caller.pluginId) ? { pluginId: caller.pluginId } : {};
  if (caller.kind !== "session") return {};
  // A delegated agent (an ACP agent a bot started, the bridge's caller) gets no way into the Clover home, its own
  // outputs included (the controller's ruling on #234's review, F4): its work comes back through its report.
  if (caller.sessionKind === "agent") return {};
  const own = { sessionId: caller.sessionId };
  // Only a valid bot id (#197's check 5): `..` would climb out of `bots/`, and `LUNA` would land on Luna's folder on a
  // folding disk.
  if ((caller.sessionKind === "bot" || caller.sessionKind === "side-thread") && caller.bot !== undefined && isAnyPluginId(caller.bot)) {
    return { ...own, memoryOf: caller.bot };
  }
  return own;
}

/** The memory folder a context's bot owns, or undefined without a valid bot id. */
export function ownMemoryOf(ctx: FenceContext | undefined, cloverHome: string): string | undefined {
  if (ctx?.memoryOf === undefined || !isAnyPluginId(ctx.memoryOf)) return undefined;
  return `${cloverHome.replace(/[\\/]+$/, "")}/bots/${ctx.memoryOf.replace("/", "--")}/memory`;
}

type OwnFolder = "ownOutputs" | "ownScratch" | "ownBot" | "ownRoutines" | "ownPluginData" | "ownMemory";

/** The `own…` folders of a runner's policy for a context (the home default-deny's allows). */
export function ownFoldersOf(ctx: FenceContext | undefined, cloverHome: string): Pick<SandboxPolicy, OwnFolder> {
  const home = cloverHome.replace(/[\\/]+$/, "");
  const out: Pick<SandboxPolicy, OwnFolder> = {};
  if (folderName(ctx?.sessionId)) out.ownOutputs = `${home}/outputs/${ctx!.sessionId}`;
  if (ctx?.pluginId !== undefined && isAnyPluginId(ctx.pluginId)) out.ownPluginData = `${home}/plugin-data/${ctx.pluginId.replace("/", "--")}`;
  const memory = ownMemoryOf(ctx, cloverHome);
  if (memory !== undefined) {
    const bot = ctx!.memoryOf!.replace("/", "--");
    out.ownScratch = `${home}/scratch/${bot}`;
    out.ownBot = `${home}/bots/${bot}`;
    out.ownRoutines = `${home}/routines/${bot}`;
    out.ownMemory = memory;
  }
  return out;
}

/** Where a plugin's code could load a dependency it doesn't ship from (#234's check 4, H1): `node_modules` in each
 *  folder plugin code loads from and in every folder above it, to the root, by the real paths given. A bare import a
 *  plugin doesn't ship walks those folders, and a file without an extension there skips Clover's load guard (measured
 *  on Bun 1.4.4), so no runner may write them: they are in every policy's `denyWrite` and `check` refuses writes there,
 *  on every OS. `folders` are the plugins folder, the development folders and any other folder plugin code loads
 *  from; `~/node_modules` is the one that matters today. */
export function pluginLoadDenies(folders: readonly string[]): string[] {
  const out = new Set<string>();
  for (const folder of folders) {
    for (const { root, names, sep } of windowsAwareSpellings(folder)) {
      const stack: string[] = [];
      for (const n of names) {
        if (n === "..") stack.pop();
        else if (n !== "" && n !== ".") stack.push(n);
      }
      for (let i = stack.length; i >= 0; i--) out.add(`${root}${sep}${[...stack.slice(0, i), "node_modules"].join(sep)}`);
    }
  }
  return [...out];
}

/** A folder's root and names, in each spelling a sandbox may match it by: POSIX (`/a/b`); a drive (`C:\a`, `C:/a`); a
 *  UNC share (`\\server\share\a`, whose root is the share, never above it); and a `\\?\` path, both as written and as
 *  its plain form (`\\?\C:\a` and `C:\a`; `\\?\UNC\server\share\a` and `\\server\share\a`), since the Windows sandbox
 *  compares the plain one. Backslashes stay backslashes. */
function windowsAwareSpellings(folder: string): { root: string; names: string[]; sep: string }[] {
  const sep = folder.includes("\\") ? "\\" : "/";
  const parts = (rest: string) => rest.split(/[\\/]/);
  const long = /^[\\/]{2}\?[\\/](.*)$/.exec(folder);
  if (long !== null) {
    const inner = long[1]!;
    const unc = /^UNC[\\/]([^\\/]+)[\\/]([^\\/]+)(.*)$/i.exec(inner);
    if (unc !== null) {
      return [
        { root: `\\\\?\\UNC\\${unc[1]}\\${unc[2]}`, names: parts(unc[3]!), sep: "\\" },
        { root: `\\\\${unc[1]}\\${unc[2]}`, names: parts(unc[3]!), sep: "\\" },
      ];
    }
    const drive = /^([A-Za-z]:)(.*)$/.exec(inner);
    if (drive !== null) return [{ root: `\\\\?\\${drive[1]}`, names: parts(drive[2]!), sep: "\\" }, { root: drive[1]!, names: parts(drive[2]!), sep: "\\" }];
  }
  const unc = /^[\\/]{2}([^\\/?]+)[\\/]([^\\/]+)(.*)$/.exec(folder);
  if (unc !== null) return [{ root: `${sep}${sep}${unc[1]}${sep}${unc[2]}`, names: parts(unc[3]!), sep }];
  const drive = /^([A-Za-z]:)(.*)$/.exec(folder);
  if (drive !== null) return [{ root: drive[1]!, names: parts(drive[2]!), sep }];
  return [{ root: "", names: parts(folder), sep: "/" }];
}

/** Whether `op` writes inside one of `denies` (`pluginLoadDenies`). */
export function writesPluginLoadDeny(op: FenceOp, denies: readonly string[], os?: Os): string | undefined {
  if (op.op !== "write" && op.op !== "delete" && op.op !== "move") return undefined;
  for (const path of op.op === "move" ? [op.path, op.to] : [op.path]) {
    const hit = denies.find((d) => isInsideFolded(path, d, os));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The reference for how a runner's sandbox applies a policy (`SandboxPolicy.ownMemory`'s order, #197's check 5), over
 *  a resolved real path: whether `op` on `realPath` passes. A real sandbox must agree with it. */
export function policyAllows(policy: SandboxPolicy, op: "read" | "write" | "unlink" | "rename", realPath: string, os?: Os): boolean {
  const names = (p: string) => segmentsOf(p).map((n) => foldName(n, os));
  const under = (path: string, root: string, strict = false) => {
    const a = names(path);
    const b = names(root);
    if (a.length < b.length || (strict && a.length === b.length)) return false;
    return b.every((n, i) => n === "*" || n === a[i]);
  };
  const rw = [policy.ownMemory, policy.ownOutputs, policy.ownScratch, policy.ownRoutines, policy.ownPluginData].filter((p): p is string => p !== undefined);
  const ro = [...rw, ...(policy.ownBot === undefined ? [] : [policy.ownBot])];
  // 2. An `own…` folder itself, and every folder that holds one, is never unlinked or renamed.
  if ((op === "unlink" || op === "rename") && rw.some((own) => under(own, realPath))) return false;
  // 3. Inside the read-and-write folders, anything; inside `ownBot` and on the folders themselves, reading.
  if (rw.some((own) => under(realPath, own, true))) return true;
  if (op === "read" && ro.some((own) => under(realPath, own))) return true;
  // 4. The denies, the Clover home included.
  if (op === "read") return !policy.denyRead.some((d) => under(realPath, d));
  if (policy.denyWrite.some((d) => under(realPath, d))) return false;
  return policy.allowWrite.some((a) => under(realPath, a));
}

/** A path's segments with `.` and `..` resolved (the fence judges canonical paths; this keeps a pattern rule from
 *  being walked around). */
function segmentsOf(path: string): string[] {
  const out: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out;
}

/** Where a path sits against the `bot-memory` and `sessions-runtime` patterns under the Clover home. */
export function patternItemAt(path: string, cloverHome: string, os?: Os):
  | { kind: "bot-memory"; folder: string; root: string; inside: boolean }
  | { kind: "sessions-runtime"; name: string | undefined; root: string }
  | undefined {
  const home = segmentsOf(cloverHome);
  const segs = segmentsOf(path);
  const same = (a: string, b: string) => foldName(a, os) === foldName(b, os);
  if (segs.length < home.length + 1 || !home.every((h, i) => same(h, segs[i]!))) return undefined;
  const [area, x, sub] = segs.slice(home.length);
  const base = `/${home.join("/")}`;
  if (same(area!, "sessions-runtime")) return { kind: "sessions-runtime", name: x, root: `${base}/sessions-runtime` };
  if (!same(area!, "bots")) return undefined;
  if (x === undefined) return { kind: "bot-memory", folder: "", root: `${base}/bots`, inside: false };
  if (sub === undefined) return { kind: "bot-memory", folder: x, root: `${base}/bots/${x}`, inside: false };
  return same(sub, "memory") ? { kind: "bot-memory", folder: x, root: `${base}/bots/${x}/memory`, inside: true } : undefined;
}

/** Whether a caller reaches the memory in `bots/<folder>/`: the user, or the bot whose id (`/` as `--`) folds equal. */
export function reachesMemoryFolder(folder: string, ctx: FenceContext | undefined, os?: Os): boolean {
  if (ctx?.user) return true;
  return ctx?.memoryOf !== undefined && isAnyPluginId(ctx.memoryOf) && foldName(ctx.memoryOf.replace("/", "--"), os) === foldName(folder, os);
}

/** Whether a caller reaches a `caller` item. */
export function callerReaches(item: Pick<FencedPath, "deny" | "bot">, ctx: FenceContext | undefined, os?: Os): boolean {
  if (item.deny !== "caller") return true;
  if (ctx?.user) return true;
  return item.bot !== undefined && reachesMemoryFolder(item.bot.replace("/", "--"), ctx, os);
}

/** A name that can name one folder: no `.` or `..`, no separator (for a session id or a bot id as a folder). Exported for the OS sandboxes, which enforce the same rule when granting `own…` folders. */
export const folderName = (s: string | undefined) => s !== undefined && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s) && !/^\.+$/.test(s);

/** Whether a tool or runner may reach a path inside the Clover home (the home default-deny): only the per-caller
 *  allows, by pattern. A path outside the home is the other rules' to judge. */
export function homeAllows(path: string, writes: boolean, ctx: FenceContext | undefined, cloverHome: string, os?: Os): boolean {
  const home = segmentsOf(cloverHome);
  const segs = segmentsOf(path);
  const same = (a: string, b: string) => foldName(a, os) === foldName(b, os);
  if (segs.length < home.length || !home.every((h, i) => same(h, segs[i]!))) return true; // not in the home
  const [area, x, sub, ...deeper] = segs.slice(home.length);
  if (area === undefined || x === undefined) return false; // the home itself, or a top folder in it
  const inside = sub !== undefined; // strictly inside `<area>/<x>`
  // 1. A session's own outputs.
  if (same(area, "outputs") && folderName(ctx?.sessionId) && same(x, ctx!.sessionId!)) return inside || !writes;
  // A plugin's own data folder, for its own code alone.
  if (same(area, "plugin-data")) return ownsPluginData(x, ctx, os) && (inside || !writes);
  const bot = ctx?.memoryOf !== undefined && isAnyPluginId(ctx.memoryOf) ? ctx.memoryOf.replace("/", "--") : undefined;
  if (bot === undefined || !same(x, bot)) return false;
  // 2. A bot's own scratch and its routines, for its main conversation and side threads.
  if (same(area, "scratch") || same(area, "routines")) return inside || !writes;
  if (!same(area, "bots")) return false;
  // 3. Its own folder, read only; its memory, read and write inside, never the memory folder itself written over.
  if (sub !== undefined && same(sub, "memory")) return deeper.length > 0 || !writes;
  return !writes;
}

/** Whether a caller is the plugin whose data folder is `plugin-data/<folder>`: by its own id, `/` as `--`. */
function ownsPluginData(folder: string, ctx: FenceContext | undefined, os?: Os): boolean {
  return ctx?.pluginId !== undefined && isAnyPluginId(ctx.pluginId) && foldName(ctx.pluginId.replace("/", "--"), os) === foldName(folder, os);
}

/** Whether a path is strictly inside its caller's own `plugin-data/<id>/` (the `plugin-data` kind lets it in there). */
function insideOwnPluginData(path: string, ctx: FenceContext | undefined, cloverHome: string | undefined, os?: Os): boolean {
  if (cloverHome === undefined || ctx?.pluginId === undefined) return false;
  const home = segmentsOf(cloverHome);
  const segs = segmentsOf(path);
  if (segs.length < home.length + 3 || !home.every((h, i) => foldName(h, os) === foldName(segs[i]!, os))) return false;
  return foldName(segs[home.length]!, os) === foldName("plugin-data", os) && ownsPluginData(segs[home.length + 1]!, ctx, os);
}

/** A fence bound to one caller: the same rules, with its `bot-memory` reach. */
export type CallerFence = Pick<Fence, "os" | "fencedSet" | "touches" | "checkAgentRoot"> & {
  readonly context: FenceContext;
  check(op: FenceOp): FenceVerdict;
  policy(): SandboxPolicy;
};

export interface Fence {
  readonly os: Os;
  fencedSet(): readonly FencedPath[];
  /** One file operation by a bot, an agent or a plugin. A write, delete or move is refused inside a fenced item and
   *  on any folder that holds one (renaming an ancestor moves the item); a read only inside a read-denied item. Names
   *  compare folded on every OS (`foldName`), whether or not the item exists yet, and a name that isn't ASCII where
   *  Clover names things under its home is refused (`nonAsciiAlias`). */
  /** `ctx` is the caller's reach for `caller` items (`forCaller` passes it); without it they are refused. A write,
   *  delete or move inside `pluginLoadDenies` (a `node_modules` above a folder plugin code loads from) is refused as
   *  `plugins` for every caller but the user. */
  check(op: FenceOp, ctx?: FenceContext): FenceVerdict;
  /** The first fenced item any of `paths` reaches, for any access: an agent's request touching one is always a card,
   *  at every level (§9.3). */
  touches(paths: readonly string[]): FencedPath | null;
  /** `Agent` refuses a root folder inside the Clover home or holding it, inside or holding any fenced item, or inside or
   *  holding a development folder (§5.6, §9.3; #197's check 3): coding agents run unsandboxed, so a root there would let
   *  one edit an OK'd plugin, settings or a plugin's data. */
  checkAgentRoot(root: string): FenceVerdict;
  /** The fence as one caller meets it (#197's check 3, and the owner's decision on `bot-memory`). */
  forCaller(caller: Caller): CallerFence;
  /** The arrays for one command runner. The pattern items (`bot-memory`, `sessions-runtime`) are denied whoever the
   *  runner is for, except a bot's own memory for its main conversation's and side threads' runners (`ownMemory`).
   *  `denyWrite` holds `pluginLoadDenies` too. */
  policy(ctx?: FenceContext): SandboxPolicy;
  /** The set changed: a development folder was added or removed, or a plugin's data folder appeared. */
  watch(fn: () => void): Unsubscribe;
}

/** The programs each OS's fence closes (§3.1). */
export const CLOSED_DOORS: Record<Os, readonly string[]> = {
  macos: ["open", "launchctl", "osascript"],
  linux: ["systemd-run"],
  windows: ["schtasks", "Register-ScheduledTask"],
};

/** Cloud metadata endpoints (§9.2): the bash fence blocks them, so a bot can't lift a VM's credentials. */
export const CLOUD_METADATA_ADDRESSES: readonly string[] = ["169.254.169.254", "fd00:ec2::254", "fd20:ce::254", "metadata.google.internal"];

/** One name as a case-folding file system could compare it: Unicode NFC, then upper case and back to lower, then NFC
 *  again. The round trip folds what lower case alone leaves: the long s (`ſettings` opens `settings` on APFS and NTFS),
 *  the dotless i, the Kelvin sign, and ß to ss. On Windows the trailing dots and spaces Win32 drops go too (`.clover.`
 *  opens `.clover`). Folding more than a disk does only refuses more. The fence folds on every OS: Linux has
 *  case-folding ext4 folders and mounted APFS, NTFS and exFAT homes (#179's review, F1). One function for every lane
 *  that compares names against the fenced set: the fence, the tree's holders, the core's own checks. */
export function foldName(name: string, os?: Os): string {
  const s = name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
  return os === "windows" ? s.replace(/[. ]+$/, "") : s;
}

/** A whole path folded name by name, with `/` between; a `\` is read as `/` first, so `C:\Users\me` meets the fence's
 *  `C:/Users/me`. */
export function foldPath(path: string, os?: Os): string {
  return path.replace(/\\/g, "/").split("/").map((seg) => (seg === "" ? seg : foldName(seg, os))).join("/");
}

/** `isInside`, with both sides folded (`foldPath`). */
export function isInsideFolded(path: string, root: string, os?: Os): boolean {
  return isInside(foldPath(path, os), foldPath(root, os));
}

const NON_ASCII = /[^\x00-\x7f]/;
const namesOf = (path: string): string[] => path.replace(/\\/g, "/").split("/").filter((s) => s !== "");
const sameFolded = (a: readonly string[], b: readonly string[], os?: Os): boolean =>
  a.length === b.length && a.every((n, i) => foldName(n, os) === foldName(b[i]!, os));

/** The second wall (#179's review, F1): a name that isn't ASCII, where Clover names things itself, is refused, whatever
 *  a file system might fold it to. That is the Clover home's own top level and any folder under it that holds a fenced
 *  item (`plugins-state/` for `plugins-state/oks`). Clover never names one of those in another script, so a name there
 *  could only be an attempt at an alias by a rule this fold doesn't know. A bot's memory note or a plugin's asset may
 *  still have any name: those folders hold no fenced item. */
export function nonAsciiAlias(path: string, set: readonly FencedPath[], cloverHome: string, os?: Os): boolean {
  const names = namesOf(path);
  const home = namesOf(cloverHome);
  if (names.length <= home.length || !sameFolded(names.slice(0, home.length), home, os)) return false;
  const holders = set.map((item) => namesOf(item.path));
  for (let depth = home.length; depth < names.length; depth++) {
    if (!NON_ASCII.test(names[depth]!)) continue;
    const folder = names.slice(0, depth);
    if (depth === home.length || holders.some((item) => item.length > depth && sameFolded(item.slice(0, depth), folder, os))) return true;
  }
  return false;
}

/** A Windows name that may be another file's (lane J's rules, shared here by #179's review, check 2): an alternate data
 *  stream (`a.json:x`, `a.json::$DATA`), which opens the file itself, or an 8.3 short name (`CLOVER~1`), which the disk
 *  answers to without listing it. A drive (`C:`) as the first name is neither.
 *
 *  This judges a path as written. The real Windows fence (lane C) first canonicalises the paths it is handed, as the OS
 *  would open them, before it judges them here and before `judge`: device and long-path prefixes (`\\?\`, `\\.\`,
 *  `\\?\GLOBALROOT\…`), UNC paths (`\\server\share\…`, including `\\localhost\C$\…` and `\\127.0.0.1\…`
 *  back to this disk), `/` and `\` alike, and junctions, symlinks and mount points resolved to their real paths
 *  (#187's review). */
export function windowsAlias(path: string): string | undefined {
  const names = namesOf(path);
  return names.find((n, i) => (n.includes(":") && !(i === 0 && /^[A-Za-z]:$/.test(n))) || /~\d/.test(n));
}

/** The hooks folder of the repo a plant targets (`<repo>/.git/hooks`, bare repos `<name>.git/hooks`), when the
 *  path sits at or under it and the repo under `home` — any repo there. Compared folded, so another case can't
 *  dodge it. `login-start`: a hook runs later, outside the sandbox (spec item 1116). */
export function gitHooksRoot(path: string, home: string, os?: Os): string | null {
  const parts = path.split(/[\\/]/).filter((s) => s !== "");
  const hp = home.split(/[\\/]/).filter((s) => s !== "");
  if (parts.length <= hp.length) return null;
  const same = (a: string, b: string) => foldName(a, os) === foldName(b, os);
  const endsGit = (s: string) => foldName(s.length >= 4 ? s.slice(-4) : s, os) === foldName(".git", os);
  if (!hp.every((h, i) => same(h, parts[i]!))) return null; // not under the home
  for (let i = hp.length; i + 1 < parts.length; i++) {
    if (endsGit(parts[i]!) && same(parts[i + 1]!, "hooks")) {
      const sep = path.includes("\\") ? "\\" : "/";
      return (/^[\\/]/.test(path) ? sep : "") + parts.slice(0, i + 2).join(sep);
    }
  }
  return null;
}

/** The `python*` folder names inside a `lib` folder (a user site lives in each one's `site-packages`), from the
 *  folder names on the disk; `[]` where the disk has none or can't be read (the fake's fictional paths). */
export function pythonSiteDirNames(listLib: () => string[]): string[] {
  try {
    return listLib().filter((n) => n.toLowerCase().startsWith("python"));
  } catch { return []; }
}

export interface JudgeOptions {
  /** The computer's OS, for its folding rules (`foldName`). */
  os?: Os;
  /** The Clover home, for the second wall (`nonAsciiAlias`). */
  cloverHome?: string;
  /** Who the operation is for, for `caller` items (`forCaller`); none reaches none of them. */
  caller?: FenceContext;
}

/** The verdict for `op` against a fenced set; the fake and any implementation share it. Names compare folded
 *  (`foldName`) on every OS, and with `cloverHome` a name that isn't ASCII where Clover names things is refused as
 *  `clover-home` (`nonAsciiAlias`). */
export function judge(set: readonly FencedPath[], op: FenceOp, o: JudgeOptions = {}): FenceVerdict {
  const writes = op.op === "write" || op.op === "delete" || op.op === "move";
  const paths = op.op === "move" ? [op.path, op.to] : [op.path];
  const inside = (p: string, r: string) => isInsideFolded(p, r, o.os);
  if (o.os === "windows") for (const path of paths) if (windowsAlias(path) !== undefined) return { allowed: false, reason: "alias", path };
  for (const path of paths) {
    // The pattern items first (#197's check 4): by where the path is, whatever list of bots or sessions is known.
    const pattern = o.cloverHome === undefined ? undefined : patternItemAt(path, o.cloverHome, o.os);
    if (pattern?.kind === "bot-memory") {
      // `bots/` and `bots/<x>` hold memory: never deleted, moved or written over. Inside `bots/<x>/memory`, only its bot.
      if (!pattern.inside && writes) return { allowed: false, reason: "bot-memory", path: pattern.root };
      if (pattern.inside) {
        if (!reachesMemoryFolder(pattern.folder, o.caller, o.os)) return { allowed: false, reason: "bot-memory", path: pattern.root };
        if (writes && foldPath(path, o.os) === foldPath(pattern.root, o.os)) return { allowed: false, reason: "bot-memory", path: pattern.root };
      }
    } else if (pattern?.kind === "sessions-runtime" && (writes || !o.caller?.user)) {
      return { allowed: false, reason: "sessions-runtime", path: pattern.root };
    }
    for (const item of set) {
      if (item.deny === "caller") continue; // judged by its pattern above
      // A plugin's own data folder is its own (the controller's ruling): inside it, `plugin-data` lets that plugin in.
      if (item.kind === "plugin-data" && insideOwnPluginData(path, o.caller, o.cloverHome, o.os)) continue;
      if (writes) {
        if (inside(path, item.path) || inside(item.path, path)) return { allowed: false, reason: item.kind, path: item.path };
      } else if (item.deny === "read-write" && inside(path, item.path)) {
        return { allowed: false, reason: item.kind, path: item.path };
      }
    }
  }
  // Last, above what's fenced by kind: the Clover home is default-deny for every tool and runner (the controller's
  // ruling on #197's follow-up): only its own session's outputs, its bot's scratch and routines, its bot's own folder
  // (read) and memory (read and write), and a plugin's own data folder let it in.
  if (o.cloverHome !== undefined && !o.caller?.user) {
    for (const path of paths) {
      if (!homeAllows(path, writes, o.caller, o.cloverHome, o.os)) {
        const at = patternItemAt(path, o.cloverHome, o.os);
        if (at !== undefined) return { allowed: false, reason: at.kind, path: at.root };
        return { allowed: false, reason: "clover-home", path: o.cloverHome };
      }
    }
  }
  if (o.cloverHome !== undefined) {
    for (const path of paths) {
      if (nonAsciiAlias(path, set, o.cloverHome, o.os)) return { allowed: false, reason: "clover-home", path: o.cloverHome };
    }
  }
  return { allowed: true };
}

// -------------------------------------------------------------------------------------------------
// Persistence and auto-run (the #301 review, the controller's ruling of November 8, and its review on #308): the places
// where a file written now runs OUTSIDE any sandbox later (at the user's next shell, login, SSH session, editor, git
// command, package install or Python start) or changes how a coding agent sandboxes itself or which servers it runs.
// The fence's `login-start` and `agent-installs` items carry them (fence/layout.ts), so every runner's sandbox and file
// tools refuse writes there; a code session the user drives asks instead (no "always"), through the protected-path card
// (runtime-sdk/protected-paths.ts). One list, here; what only the user's own settings can say (where git's templates
// and hooks are, a ZDOTDIR, PYTHONSTARTUP, a Documents folder OneDrive moved) comes in as `RunLaterExtras`
// (fence/run-later.ts reads them).
// -------------------------------------------------------------------------------------------------

/** What the user's own settings add to the list (`fence/run-later.ts`), each an absolute path in `os`'s form. */
export interface RunLaterExtras {
  /** git's `init.templateDir` and `core.hooksPath` from the user's global config files. */
  readonly gitDirs?: readonly string[];
  /** `$ZDOTDIR` when it isn't the home, and `$PYTHONSTARTUP`. */
  readonly envPaths?: readonly string[];
  /** Windows: the Documents known folder, when OneDrive (or the user) moved it from `<home>\Documents`. */
  readonly documents?: string;
}

/** A path under `home` in `os`'s own form. */
function underHome(os: Os, home: string, parts: readonly string[]): string {
  const sep = os === "windows" ? "\\" : "/";
  return [home.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/** The shells' start and end files, on every OS (Git Bash and WSL-style shells read them on Windows too), and
 *  readline's `.inputrc` (its macros type commands). */
export const SHELL_FILES = [
  ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".profile", ".bash_login",
  ".bash_logout", ".cshrc", ".tcshrc", ".login", ".kshrc", ".inputrc",
] as const;

/** Folders and files under `.config` that a shell, an editor or a tool runs from, on every OS. */
const CONFIG_RUN_LATER = [
  ["fish"], ["zsh"], ["nushell"], ["nvim"], ["tmux"], ["git"], ["pip"],
] as const;

/** One entry of the list: a folder (everything inside it) or a single file. */
export interface RunLaterEntry { readonly path: string; readonly file: boolean }

/** The list with each entry's shape (a test fixture plants a file at a file entry, and inside a folder entry). */
export function autoRunEntries(os: Os, home: string, extras: RunLaterExtras = {}): RunLaterEntry[] {
  const out: RunLaterEntry[] = [];
  const f = (...parts: string[]) => { out.push({ path: underHome(os, home, parts), file: true }); };
  const d = (...parts: string[]) => { out.push({ path: underHome(os, home, parts), file: false }); };
  // Shells, readline, editors, tmux.
  for (const name of SHELL_FILES) f(name);
  f(".vimrc"); d(".vim"); f(".emacs"); d(".emacs.d"); f(".tmux.conf");
  for (const parts of CONFIG_RUN_LATER) d(".config", ...parts);
  // SSH's files that run or admit something: `rc` runs at each login, `config` holds `ProxyCommand`/`LocalCommand`,
  // `environment` is read by sshd, the keys admit whoever holds them. `known_hosts` stays writable (ssh writes it).
  for (const name of ["rc", "config", "environment", "authorized_keys", "authorized_keys2"]) f(".ssh", name);
  // git: hooks, fsmonitor, the pager and `!` aliases in the global config; the templates every `git init` copies.
  f(".gitconfig"); d(".git-templates");
  // The folders on the PATH a user's shell finds commands in first.
  d(".local", "bin"); d("bin"); d(".cargo", "bin");
  // Package managers' configs (scripts, registries, init scripts) and Python's: a `.pth` or `usercustomize.py` in the
  // user site-packages runs at every Python start, so the whole user tree is held (`pip install --user` asks).
  f(".npmrc"); f(".yarnrc"); f(".yarnrc.yml"); f(".bunfig.toml"); f(".cargo", "config.toml"); f(".cargo", "config");
  d(".gradle", "init.d"); f(".gradle", "init.gradle"); d(".pip");
  if (os === "macos") {
    d("Library", "LaunchAgents"); d("Library", "LaunchDaemons");
    d("Library", "Application Support", "com.apple.backgroundtaskmanagementagent");
    d("Library", "Application Support", "com.apple.backgroundtaskmanagementd");
    f("Library", "Preferences", "com.apple.loginwindow.plist");
    d("Library", "Application Support", "iTerm2", "Scripts", "AutoLaunch");
    d("Library", "Workflows", "Applications", "Folder Actions");
    d("Library", "Python");
  } else if (os === "linux") {
    d(".config", "autostart"); d(".config", "systemd", "user"); d(".local", "share", "systemd", "user");
    d(".config", "environment.d"); f(".pam_environment"); f(".xprofile"); f(".xinitrc"); f(".xsession"); f(".xsessionrc");
    d(".config", "plasma-workspace", "env"); d(".config", "plasma-workspace", "shutdown");
    d(".config", "i3"); d(".i3"); d(".config", "sway"); d(".config", "hypr"); d(".config", "openbox");
    d(".local", "lib");
  } else {
    const docs = [underHome(os, home, ["Documents"])];
    if (extras.documents !== undefined && extras.documents.toLowerCase() !== docs[0]!.toLowerCase()) docs.push(extras.documents);
    d("AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    for (const doc of docs) out.push({ path: `${doc}\\PowerShell`, file: false }, { path: `${doc}\\WindowsPowerShell`, file: false });
    d("AppData", "Roaming", "Python"); d("AppData", "Roaming", "pip");
  }
  for (const p of extras.gitDirs ?? []) out.push({ path: p, file: false });
  for (const p of extras.envPaths ?? []) out.push({ path: p, file: false });
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)));
}

/** Where a file starts something later, outside any sandbox, under `home`. HKCU's `Run` and `RunOnce` keys aren't
 *  paths: the Windows sandbox (#207) has to deny them, a gap until it lands (the Windows release blocker). */
export function autoRunPaths(os: Os, home: string, extras: RunLaterExtras = {}): string[] {
  return autoRunEntries(os, home, extras).map((e) => e.path);
}

/** The coding agents' own settings, which change how they sandbox themselves or which commands they run (MCP servers,
 *  hooks): Claude Code's whole folder and its `.claude.json` (user-scope MCP servers), Codex's config, Gemini's
 *  settings, Cursor's folder and OpenCode's. Lane K's writers deny these per backend; the fence holds them for every
 *  runner. */
export function agentConfigPaths(os: Os, home: string): string[] {
  return agentConfigEntries(os, home).map((e) => e.path);
}

/** `agentConfigPaths` with each entry's shape. */
export function agentConfigEntries(os: Os, home: string): RunLaterEntry[] {
  const u = (...parts: string[]) => underHome(os, home, parts);
  return [
    { path: u(".claude"), file: false }, { path: u(".claude.json"), file: true },
    { path: u(".codex", "config.toml"), file: true },
    { path: u(".gemini", "settings.json"), file: true },
    { path: u(".cursor"), file: false },
    { path: u(".config", "opencode"), file: false },
  ];
}
