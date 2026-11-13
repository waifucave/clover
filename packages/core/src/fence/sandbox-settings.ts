// The fence's policy for one runner as the agent runtime's sandbox settings (`SandboxSettingsConfig.filesystem`), for
// a sandbox the runtime builds itself (a bot's Bash in the turn-loop driver's `sandbox(ctx)`). The ruling: this is the
// single bot Bash sandbox builder.
//
// The controller's ruling: inside any sandbox config a DENY always wins over an ALLOW, whatever the order or how
// specific each is; the runtime renders it so (its denies come after its allows in the Seatbelt profile, and it has no
// `allowRead` at all). So nothing here is an allow meant to re-open part of a deny:
//
// - Writes. The runtime's writes are an allow list (its write roots and `allowWrite`); nothing else is writable. So
//   the Clover home is taken OUT of the allow list instead of denied and re-opened: a root that holds the home is
//   written out as its entries minus the way to the home (the user's home: one level, its own entries), and the folders
//   the runner keeps are added by name. The other sessions' `outputs/<id>` folders are never listed, so the settings
//   stay the same size however many sessions there are (#356's review: one deny per session would pass sandbox-exec's
//   1 MB argv limit at about 10k sessions). The home's deny is still written out entry by entry minus the way to each
//   kept folder, as a net under any root the runtime adds itself, except `outputs/`, which the allow list alone
//   covers (its other folders are a known gap only under such a root).
// - Reads. The runtime's reads are a deny list. A bot reads the whole home but what escalates (by name, and globs for
//   the provider-state sidecars); any other runner's home deny is written out minus the way to its kept folders, with
//   `outputs/` denied whole (this builder serves bots; another runner's own outputs aren't readable through it).
//
// Always, whether on the disk or not when the settings are built: the named fenced items (credentials, runtimes, the
// SDK's config copy and settings, cache/runs, the secrets files, the browser profiles, plugin-data, run/) denied for
// reads and writes, so one made mid-run is denied too; a write-deny on a name inside each kept folder, so the
// runtime's ancestor fence denies creating, removing or renaming the kept folder itself (its entry, not its insides:
// #356's review); and no `.git/hooks` (nor `<name>.git/hooks`) anywhere under a write root, as the macOS profile has.
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { Level, Os } from "@waifucave/clover-protocol";
import { BOT_READ_DENIED, secretReadPlaces, segmentMatches, type SandboxPolicy } from "../contracts/fence";
import { gitRunLaterPlaces, pathClass } from "../approvals/ordinary-paths";
import { PROJECT_DENIES, PROJECT_WHOLE_DENIES } from "../registry/plugin-fence";
import { gitTemplateDir } from "./layout";

export interface SandboxSettingsOptions {
  /** A folder's entry names, or [] when it isn't a folder (tests pass a fake). */
  list?: (dir: string) => readonly string[];
  /** Windows-form paths (backslashes). */
  windows?: boolean;
  /** Whether a path is plain: no link, and its real path is itself (tests pass a fake). The runtime real-paths every
   *  write root, so a root that is a link, or sits under one, would open its target. */
  plain?: (path: string) => boolean;
  /** Whether a path is there and isn't a folder (tests pass a fake). */
  file?: (path: string) => boolean;
}

const realPlain = (path: string): boolean => {
  try { return !lstatSync(path).isSymbolicLink() && realpathSync(path) === path; } catch { return false; }
};

/** Whether `path` is there and isn't a folder, through links (a file, a socket; macOS's `/tmp` is a link to a folder,
 *  so a folder). Nothing is kept or held under one: a name under a file can't resolve (ENOTDIR), and the runtime's
 *  file-tool check refuses every path when a deny entry doesn't resolve (the owner's try 14). */
export const realNonFolder = (path: string): boolean => {
  try { return !statSync(path).isDirectory(); } catch { return false; }
};

/** The environment a bot's Bash runs with beside these settings: `GIT_TEMPLATE_DIR` at Clover's empty template, so
 *  `git init` and `git clone` in a scratch folder work with every `.git/hooks` write-denied (they copy no hooks). */
export function sandboxEnvOf(cloverHome: string): Record<string, string> {
  const template = gitTemplateDir(cloverHome);
  try { mkdirSync(template, { recursive: true, mode: 0o700 }); } catch { /* git then finds no template: it copies nothing either */ }
  return { GIT_TEMPLATE_DIR: template };
}

/** The name written-denied inside each kept folder: the runtime's ancestor fence then holds the folder's own entry. */
export const KEPT_FOLDER_PIN = ".clover-kept-folder";

const realList = (dir: string): readonly string[] => {
  try { return readdirSync(dir); } catch { return []; }
};

/** The policy as the runtime's sandbox settings: literal paths and the policy's globs, no allow inside any deny. */
export function sandboxSettingsOf(policy: SandboxPolicy, home: string, o: SandboxSettingsOptions = {}): SandboxSettingsConfig {
  const p = o.windows ? win32 : posix;
  const list = o.list ?? realList;
  const plain = o.plain ?? realPlain;
  const file = o.file ?? realNonFolder;
  const fold = (s: string) => (o.windows ? s.toLowerCase() : s);
  const same = (a: string, b: string) => fold(a) === fold(b);
  const inside = (a: string, root: string) => same(a, root) || fold(a).startsWith(fold(root.endsWith(p.sep) ? root : `${root}${p.sep}`));
  const isPattern = (d: string) => d.includes("*");
  const open = policy.botAccess;
  const outputs = p.join(home, "outputs");

  // The folders kept for writing and for reading.
  // A bot's workshop (`ownPlugins`, the plugins it built) is kept like its scratch: written inside, the folder itself held
  // by its pin, and every `.git` in it held by the run-later denies under each root.
  const ownRw = [policy.ownOutputs, policy.ownScratch, policy.ownRoutines, policy.ownPluginData, policy.ownMemory, ...(policy.ownPlugins ?? [])].filter((x): x is string => x !== undefined);
  // The drop: the plugins folder itself kept for writing (a new folder made there; its own entry held by its pin),
  // and every entry already there that isn't one of this bot's own plugins denied by name.
  if (policy.pluginDrop !== undefined) ownRw.push(policy.pluginDrop);
  const dropDenies = policy.pluginDrop === undefined ? [] : list(policy.pluginDrop)
    .map((name) => p.join(policy.pluginDrop!, name))
    .filter((e) => !(policy.ownPlugins ?? []).some((own) => same(own, e)));
  const writeKeep = [...ownRw];
  if (open !== undefined) {
    // Each one plain: a link (an old one, or one a run made) would be real-pathed to its target by the runtime. And a
    // folder: a file among them (a Finder `.DS_Store` in `scratch/`) is no bot's scratch, and a pin under it would
    // never resolve.
    for (const x of list(open.scratch)) { const k = p.join(open.scratch, x); if (plain(k) && !file(k)) writeKeep.push(k); }
    for (const x of list(open.bots)) { const k = p.join(open.bots, x, "memory"); if (plain(k) && !file(k)) writeKeep.push(k); }
  }
  const readKeep = open !== undefined ? [home] : [...ownRw, ...(policy.ownBot === undefined ? [] : [policy.ownBot])];

  /** `root`'s entries minus the way to each kept folder, walked level by level; `outputs/` as `whole` says. */
  const except = (root: string, keep: readonly string[], outputsWhole: boolean | null): string[] => {
    if (keep.some((k) => inside(root, k))) return []; // the root itself is kept
    const toward = keep.filter((k) => inside(k, root));
    if (toward.length === 0) return [root];
    // The other sessions' outputs folders are never listed: denied whole (reads), or left to the allow list (writes).
    if (outputsWhole !== null && same(root, outputs)) return outputsWhole ? [root] : [];
    const out: string[] = [];
    for (const name of list(root)) {
      const e = p.join(root, name);
      if (toward.some((k) => inside(k, e))) out.push(...except(e, toward, outputsWhole));
      else out.push(e);
    }
    return out;
  };

  /** Whether a policy glob would cover a kept folder (`bots/*\/memory` for a runner that keeps a memory). */
  const globCovers = (glob: string, keep: string): boolean => {
    const g = glob.split(p.sep).filter((s) => s !== "");
    const k = keep.split(p.sep).filter((s) => s !== "");
    return g.length <= k.length && g.every((seg, i) => segmentMatches(k[i]!, seg, o.windows ? "windows" : "macos"));
  };

  // The named fenced items, by name whether they are there or not.
  const named = [...BOT_READ_DENIED.filter((segs) => !segs.some(isPattern)).map((segs) => p.join(home, ...segs)), p.join(home, "run")];

  /** The policy's denies plus the named items; the home's own deny written out; a deny holding a kept folder written
   *  out the same way; one strictly inside a kept folder kept as it is (a deny wins). */
  const denies = (list0: readonly string[], keep: readonly string[], outputsWhole: boolean): string[] => {
    const out: string[] = [];
    for (const d of [...list0, ...named]) {
      if (same(d, home)) { out.push(...except(home, keep, outputsWhole)); continue; }
      if (isPattern(d)) { if (!keep.some((k) => globCovers(d, k))) out.push(d); continue; }
      if (keep.some((k) => inside(k, d) && !same(k, d))) { out.push(...except(d, keep, outputsWhole)); continue; }
      if (keep.some((k) => same(k, d))) continue;
      out.push(d);
    }
    return out;
  };

  // Writes: the allow list with the home taken out of every root that holds it; the kept folders by name.
  // A root written out entry by entry (the user's home): only plain entries, never a link or one whose real path is
  // elsewhere (the runtime real-paths each root: a link to `/` would open the disk, one to the Clover home the home),
  // and each held like a kept folder, so a run can't swap it for a link that the next run's root would follow.
  const allowWrite: string[] = [];
  const listedRoots: string[] = [];
  for (const a of policy.allowWrite) {
    if (inside(home, a)) {
      for (const e of except(a, [home], null)) if (!inside(e, home) && plain(e)) { allowWrite.push(e); listedRoots.push(e); }
    } else if (!inside(a, home) || writeKeep.some((k) => inside(a, k))) allowWrite.push(a);
  }
  allowWrite.push(...writeKeep);
  const hookRoots = [...policy.allowWrite, ...writeKeep.filter((k) => !policy.allowWrite.some((a) => inside(k, a)))];
  // The runtime renders a glob deny recursively (the folder and all under it). Under folders only: a root that is a file
  // (one the home's entries listed) holds nothing, and a name under it would never resolve.
  const hooks = [...new Set(hookRoots)].filter((r) => !file(r)).map((r) => `${r}${p.sep}**${p.sep}*.git${p.sep}hooks`);
  const pins = [...writeKeep.filter((k) => !same(k, home)), ...listedRoots].filter((k) => !file(k)).map((k) => p.join(k, KEPT_FOLDER_PIN));

  return {
    enabled: true,
    filesystem: {
      allowWrite: [...new Set(allowWrite)],
      denyWrite: [...new Set([...denies(policy.denyWrite, writeKeep, false), ...pins, ...hooks, ...dropDenies])],
      denyRead: [...new Set(denies(policy.denyRead, readKeep, true))],
    },
  };
}

/** A bot's Bash sandbox at its level (§9.1, the owner's ruling of November 10): at ask for risky actions (and below)
 *  its commands write only to its own folders and the temp folder, so one runs without asking; the user's home is a
 *  write root only at accept edits and fully automatic. What `RequestAccess` granted the conversation joins it (stage
 *  2): `grantedWrite` as more write roots. Under every root, whatever the level, the shell writes nothing that runs
 *  later outside the sandbox (`shellRunLaterDenies`), and reads none of the user's secret places (`SECRET_READ_PLACES`,
 *  the same list Read is refused by). It never carries a `network` key: the runtime then denies the whole network,
 *  unix sockets included (macOS `(deny network*)` under `(deny default)`; Linux `--unshare-net` and seccomp's refused
 *  `socket(AF_UNIX)`), so `core.sock`, the plugin host's sockets, the SSH agent, Docker and any launchd socket are out
 *  of reach at every level and whatever folder is granted.
 *
 *  The level is read when the sandbox is drawn, at each turn's start: a turn already running keeps the roots it
 *  started with until it ends (the runtime takes its sandbox only when it opens), so a lowered level reaches the shell
 *  at the next turn (accepted by the coordinator's ruling of November 11; backlog: reopen mid-turn on a level drop). */
export function botSandboxSettings(policy: SandboxPolicy, o: {
  cloverHome: string; userHome: string; level: Level | undefined; windows?: boolean;
  grantedWrite?: readonly string[];
  /** The session's own folders the runtime writes to whatever the settings say (its working folder, its bot's
   *  folder): they are roots like every other, and held the same. */
  ownFolders?: readonly string[];
  /** The folders on the user's PATH, read when the sandbox is drawn (`pathFolders`). */
  pathFolders?: readonly string[];
  /** A folder's entries, as `readdirSync` with types gives them (tests pass a fake; `ordinaryTopFolders`). */
  list?: (dir: string) => readonly { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
}): SandboxSettingsConfig {
  const wide = o.level === "accept-edits" || o.level === "automatic";
  const fold = (s: string) => (o.windows ? s.toLowerCase() : s).replace(/[\\/]+$/, "");
  const os: Os = o.windows ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  // A root whose path has a control character is never drawn (a newline would be written raw into the profile).
  const drawable = (r: string) => !CONTROL.test(r);
  // At accept edits the home is written out as its ordinary top-level folders (the coordinator's ruling on stage 2):
  // never `~/Library`, a dot-folder, the home's own files or the folder holding the Clover home's way. Fully automatic
  // keeps the whole home.
  const homeAt = (a: string) => fold(a) === fold(o.userHome);
  const levelWrite = (o.level === "automatic" ? policy.allowWrite
    : wide ? policy.allowWrite.flatMap((a) => (homeAt(a) ? ordinaryTopFolders(o.userHome, { os, cloverHome: o.cloverHome, pathFolders: o.pathFolders ?? [], list: o.list }) : [a]))
    : policy.allowWrite.filter((a) => !homeAt(a))).filter(drawable);
  const granted = (o.grantedWrite ?? []).filter(drawable);
  const allowWrite = [...levelWrite, ...granted.filter((g) => !levelWrite.some((a) => fold(a) === fold(g)))];
  const { network: _never, ...out } = sandboxSettingsOf({ ...policy, allowWrite }, o.cloverHome, o.windows ? { windows: true } : {});
  const own = (o.ownFolders ?? []).filter(drawable);
  const roots = [...new Set([...(out.filesystem?.allowWrite ?? []), ...granted, ...own])];
  // The secret places are never changed either (a Write or an Edit there is refused the same way), nor read.
  const secrets = secretReadPlaces(os, o.userHome).map((p) => p.path);
  // What's held under each root, under the folders only (a root that is a file holds nothing: `realNonFolder`).
  const runLater = [...shellRunLaterDenies(roots.filter((r) => !realNonFolder(r)), { userHome: o.userHome, cloverHome: o.cloverHome, os, pathFolders: o.pathFolders ?? [] }), ...secrets];
  // Fail closed: a root a deny would cover is left out (a deny wins inside the runtime, so it would write nothing
  // there anyway; leaving it out says so). None is, for the folders Clover draws (sandbox-settings.test's invariant).
  const keptWrite = (out.filesystem?.allowWrite ?? []).filter((r) => !rootCovered(r, runLater, os) && !holdsFolded(r, o.cloverHome, os));
  return {
    ...out,
    filesystem: {
      ...out.filesystem,
      allowWrite: keptWrite,
      denyWrite: [...new Set([...(out.filesystem?.denyWrite ?? []), ...runLater])],
      denyRead: [...new Set([...(out.filesystem?.denyRead ?? []), ...secrets])],
    },
  };
}

/** Control characters: never in a drawn root or a granted folder. */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A name as a glob segment that matches it in any letter case (`[gG][iI][tT]`), on the file systems that open a name
 *  in any case (APFS, NTFS): a `.GIT` folder is git's `.git` there. The runtime passes a closed `[…]` through to its
 *  regex as a class. Elsewhere, the name as it is. A `*` stays a wildcard. */
export function anyCase(name: string, os: Os): string {
  if (os === "linux") return name;
  return name.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

/** The run-later names held under every root, from the fence's shared project lists (`PROJECT_WHOLE_DENIES`,
 *  `PROJECT_DENIES`, the plugin fence's for a project folder): denied whole wherever they sit, so none is made,
 *  written, renamed or removed. `.git` goes as `*.git` (a working tree's `.git` folder or file, and a bare repository
 *  by its name); `.clover` per root (`shellRunLaterDenies`), since the Clover home is one. */
function heldNames(): string[] {
  const whole = PROJECT_WHOLE_DENIES.filter((n) => n !== ".git" && n !== ".clover");
  return [...new Set(["*.git", ...whole, ...PROJECT_DENIES, "*.app"])];
}

/** The fixed folders a shell finds commands in besides the user's PATH (the fence's own list of where a planted
 *  program runs: Homebrew's, `/usr/local`, and the user's `bin` folders). Under the user's home, relative. */
const FIXED_PATH_FOLDERS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];
const FIXED_HOME_PATH_FOLDERS = [".local/bin", "bin", ".cargo/bin", ".bun/bin", ".deno/bin", "go/bin", ".npm-global/bin", ".volta/bin"];

/** The user's ordinary top-level folders: the shell's write roots at accept edits in place of the home (the
 *  coordinator's ruling on stage 2: Desktop, Documents, Downloads, Movies, Music, Pictures, Public, and any other plain
 *  top-level folder such as a Projects folder). Never a dot-folder, `~/Library`, `~/Applications`, Windows' `AppData`,
 *  a link, a file, a folder that holds the Clover home, or one the path classes don't call ordinary (a folder on the
 *  PATH, such as `~/bin`). */
export function ordinaryTopFolders(userHome: string, o: {
  os: Os; cloverHome: string; pathFolders: readonly string[];
  list?: (dir: string) => readonly { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
}): string[] {
  const p = o.os === "windows" ? win32 : posix;
  let entries: readonly { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
  try { entries = (o.list ?? ((d: string) => readdirSync(d, { withFileTypes: true })))(userHome); } catch { return []; }
  const never = new Set(["library", "applications", "appdata"]);
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith(".") || never.has(e.name.toLowerCase())) continue;
    const at = p.join(userHome, e.name);
    if (CONTROL.test(at) || isInsideOrSame(o.cloverHome, at, o.os)) continue;
    if (pathClass(p.join(at, "x"), { home: userHome, os: o.os, cloverHome: o.cloverHome, pathFolders: o.pathFolders }) !== "ordinary") continue;
    out.push(at);
  }
  return out.sort();
}

/** Whether `path` (absolute) is one of the run-later places `shellRunLaterDenies` holds BY NAME, wherever it sits and
 *  whatever the session's roots are: a held name (`.git`, `*.git`, `.vscode`, `.mcp.json`, a shell's start file, a
 *  credential file, `*.app`…), or a `.clover` outside the Clover home, as a path segment (or run of segments) at any
 *  depth and in any letter case; or inside a fixed PATH folder. A bot's file write there is refused before
 *  any card (bot-check's `runsLater`): at the narrow levels a project outside the roots has none of these in the
 *  sandbox's `denyWrite` (on Linux none of the names; `.clover` nowhere), yet a card's yes would write a run-later file.
 *  Inside the Clover home it is false: the fence holds that. The home is matched in the spelling it is given in and
 *  in its real one (a home reached through a link: macOS's /var → /private/var, a linked volume), so a bot's write to
 *  its scratch named either way isn't read as a project's `.clover`; the path itself is only ever taken as given (a
 *  `.clover` that is a link into the home is still held). */
export function runLaterByName(path: string, o: { userHome: string; cloverHome: string; os: Os }): boolean {
  const p = o.os === "windows" ? win32 : posix;
  if (isInsideOrSame(path, o.cloverHome, o.os)) return false;
  const realHome = (() => { try { return realpathSync.native(o.cloverHome); } catch { return undefined; } })();
  if (realHome !== undefined && isInsideOrSame(path, realHome, o.os)) return false;
  const segs = path.split(/[\\/]+/).filter((s) => s.length > 0);
  const runAt = (name: string) => {
    const want = name.split("/").filter((s) => s.length > 0);
    for (let i = 0; i + want.length <= segs.length; i++) if (want.every((w, j) => segmentMatches(segs[i + j]!, w, o.os))) return true;
    return false;
  };
  if ([...heldNames(), ".clover"].some(runAt)) return true;
  const fixed = [...FIXED_PATH_FOLDERS, ...FIXED_HOME_PATH_FOLDERS.map((f) => p.join(o.userHome, ...f.split("/")))];
  return fixed.some((f) => isInsideOrSame(path, f, o.os));
}

/** What the sandboxed shell never writes under any root (the adversarial review's blocker on 408d1c844 and the
 *  coordinator's ruling of November 11), so nothing it writes runs later outside the sandbox, when the user runs git,
 *  opens the folder in an editor, `cd`s into it or runs a command by name:
 *    * every `.git` (folder or file) and `*.git` folder, whole, at any depth and in any letter case: a commit, or
 *      anything else that writes `.git`, is for the outside-the-sandbox card (stage 3);
 *    * the fence's project run-later names (`.vscode`, `.idea`, `.claude`, `.mcp.json`, `.envrc`, `.gitmodules`, the
 *      shells' start files, the credential files, `.ripgreprc`…), whole, at any depth; a project's `.clover` under
 *      each root but the Clover home itself;
 *    * every `*.app` bundle, whole (its entry too, so it can't be renamed away and back);
 *    * the folders on the user's PATH and the fixed ones, by path;
 *    * what the repositories' configs under the roots name for hooks or include (`gitRunLaterPlaces`: `core.hooksPath`
 *      such as `.husky`), found when the sandbox is drawn.
 *  The names are globs from `/` (`/**\/<name>`): they hold under every root, the runtime's own (its temp folder, the
 *  working folder) included, and a rename of a parent changes nothing, as the glob matches wherever the name lands.
 *  On Linux the runtime holds a glob's matches that exist when a command starts, and puts away after it what a command
 *  made at a held place: a `.git` made fresh there is only taken away after the run (a known residual; Linux grants
 *  are refused, so it can arise only under the home at the wider levels). */
export function shellRunLaterDenies(roots: readonly string[], o: { userHome: string; cloverHome: string; os: Os; pathFolders: readonly string[] }): string[] {
  const p = o.os === "windows" ? win32 : posix;
  const sep = p.sep;
  // From `/` on macOS (Seatbelt matches a regex as each path is opened). Linux's sandbox expands a glob against the disk
  // at each command's start, so there they are written under each root, which keeps that walk to the roots.
  const top = o.os === "macos" ? "/" : undefined;
  const out: string[] = [];
  const names = heldNames();
  if (top !== undefined) {
    for (const n of names) out.push(`${sep}**${sep}${n.split("/").map((seg) => anyCase(seg, o.os)).join(sep)}`);
  }
  for (const root of roots) {
    if (top === undefined) for (const n of names) out.push(`${root}${sep}**${sep}${n.split("/").map((seg) => anyCase(seg, o.os)).join(sep)}`);
    // A project's `.clover`, whole under each root. No root holds the Clover home (the home is written out around it,
    // and RequestAccess never grants a folder that holds it); one that did would be left out (`botSandboxSettings`).
    if (!isInsideOrSame(o.cloverHome, root, o.os)) out.push(`${root}${sep}**${sep}${anyCase(".clover", o.os)}`);
  }
  const pathFolders = [...o.pathFolders, ...FIXED_PATH_FOLDERS, ...FIXED_HOME_PATH_FOLDERS.map((f) => p.join(o.userHome, ...f.split("/")))];
  for (const f of pathFolders) if (!CONTROL.test(f) && roots.some((r) => isInsideOrSame(f, r, o.os) || isInsideOrSame(r, f, o.os))) out.push(f);
  out.push(...configNamed(roots, o).filter((x) => !CONTROL.test(x)));
  return [...new Set(out)];
}

/** How many folders the look for repositories' configs walks under all the roots together, each time it runs. */
const SCAN_BUDGET = 6_000;
/** How long a look is kept: the sandbox is drawn at each turn's start, and a file tool's call during a background
 *  command reads the roots again. */
const SCAN_TTL_MS = 10_000;
let scanCache: { key: string; at: number; places: string[]; complete: boolean } | undefined;

/** What the repositories under the roots name for hooks and includes (`gitRunLaterPlaces`), with one budget for all
 *  of them (`SCAN_BUDGET` folders, 6 deep, package installs and `~/Library` skipped). Past the budget, what was found
 *  is held and the rest isn't looked for (`scanComplete` says so): a hooks folder by another name deeper than that is
 *  the stated gap; `.husky` and `.githooks`, where `core.hooksPath` most often points, are held by name anyway. */
function configNamed(roots: readonly string[], o: { userHome: string; os: Os }): string[] {
  const key = `${o.os}\0${o.userHome}\0${[...roots].sort().join("\0")}`;
  const now = Date.now();
  if (scanCache !== undefined && scanCache.key === key && now - scanCache.at < SCAN_TTL_MS) return scanCache.places;
  const budget = { left: SCAN_BUDGET };
  const places: string[] = [];
  let complete = true;
  for (const root of roots) {
    const r = gitRunLaterPlaces(root, { home: o.userHome, os: o.os }, budget);
    places.push(...r.places);
    if (!r.complete) complete = false;
  }
  scanCache = { key, at: now, places: [...new Set(places)], complete };
  return scanCache.places;
}

/** Whether the last look for repositories' configs went through everything under the roots (tests, the report). */
export function scanComplete(): boolean | undefined { return scanCache?.complete; }

const foldOf = (s: string, os: Os) => (os === "linux" ? s : s.toLowerCase());
/** Whether `root` holds `path` (strictly, or is it). */
function holdsFolded(root: string, path: string, os: Os): boolean { return isInsideOrSame(path, root, os); }
function isInsideOrSame(path: string, root: string, os: Os): boolean {
  const sep = os === "windows" ? "\\" : "/";
  const a = foldOf(path, os).replace(/[\\/]+$/, "");
  const r = foldOf(root, os).replace(/[\\/]+$/, "");
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** A deny glob as the runtime renders it (`**\/` any folders or none, `*` within one name, a closed `[…]` a class,
 *  the match recursive), for the invariant that no deny covers a root. */
export function denyRegex(glob: string, os: Os): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") { re += "(.*/)?"; i += 2; continue; }
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i += 1; continue; }
    if (c === "*") { re += "[^/]*"; continue; }
    if (c === "?") { re += "[^/]"; continue; }
    if (c === "[") { const end = glob.indexOf("]", i); re += glob.slice(i, end + 1); i = end; continue; }
    re += /[.^$+{}()|\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}(/.*)?$`, os === "linux" ? "" : "i");
}

/** Whether a deny covers `root` (the root itself, or a folder that holds it). */
export function rootCovered(root: string, denies: readonly string[], os: Os): boolean {
  return denies.some((d) => (d.includes("*") ? denyRegex(d, os).test(root) : isInsideOrSame(root, d, os)));
}
