// A pasted MCP config's own files (the controller's ruling on acceptance step 31's finding B, and its conditions): a
// stdio server the user brought very often runs a script in their home (`node /Users/me/tools/server.js`), which the
// plugin fence denies (the user's home is closed but for the package managers' installs, `TOOL_READ_DIRS`). At wrap
// time the config's file arguments that exist and sit in a closed place are found, and what each needs is opened to
// that plugin's servers, READ-ONLY, on its install record (`wrapped.reads`, never the manifest's), which its OK lists.
//
// * What is opened (the ruling: the script's own folder, never the project): the file's own folder; and, walking up to
//   the nearest folder that marks a project (`package.json`, `pyproject.toml`, `.git`…), only each level's
//   `node_modules` folder and `package.json` file, so a built script finds its packages. A program that IS a Python
//   virtual environment's interpreter (`<venv>/bin/python…`, a `pyvenv.cfg` beside its `bin`) opens that environment
//   (its `lib` holds the packages). Never a `.git` folder or an `.env` file: the fence denies them inside everything
//   opened (`readDenies`), and a named file that is one is refused.
// * Never the user's home or a folder above it, never one of its big folders whole (Documents, Desktop, Downloads,
//   Library…), never a folder that is or holds a secret place (`SECRET_READ_PLACES`, `CREDENTIAL_FILES`) or the Clover
//   home, and never one inside a secret place. A walk up stops below the first folder it may not open.
// * A file it may not open is named on the card as unreadable (`wrapped.unreadable`), with how to fix it.
// * The fence re-checks each recorded path at every start (`wrapperReads`): one that is now refused, gone, or a link
//   (its real path isn't the recorded one) is dropped, so a record can't open what its card didn't name.
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import { CREDENTIAL_FILES, secretReadPlaces } from "../contracts/fence";
import type { PluginRecord } from "../contracts/plugin-registry";
import { TOOL_READ_DIRS } from "./plugin-fence";

/** The most paths one wrapped plugin is given (folders and `package.json` files). */
export const WRAP_READS_MAX = 32;

/** The home's folders never opened whole to a plugin (each is many things of the user's). Relative to the home. */
export const WRAP_READS_NEVER_WHOLE: readonly string[] = ["Library", "Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music", "Public", "Applications", "Library/Mobile Documents", "Library/CloudStorage"];

/** What marks a project's own folder: the walk up from a script for `node_modules` and `package.json` stops there. */
const PROJECT_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "deno.json", "bun.lock", "bun.lockb", "requirements.txt", ".git"];

/** A `.git` folder or an `.env` file (`.env`, `.env.local`…): never read inside anything opened. */
export const isGitOrEnv = (name: string): boolean => name === ".git" || /^\.env(\..*)?$/.test(name);

export interface WrapHomes {
  /** The user's home (tests pass a temp one). */
  user: string;
  /** The Clover home: never opened. */
  clover: string;
  os: "macos" | "windows" | "linux";
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** The places a plugin never reads, as real paths: the secret places and credential files under the home. */
function secretPlaces(h: WrapHomes): string[] {
  return [...secretReadPlaces(h.os, h.user).map((p) => p.path), ...CREDENTIAL_FILES.map((f) => join(h.user, f))].flatMap((p) => {
    const r = real(p);
    return r === p ? [p] : [p, r];
  });
}

/** Why a folder may not be opened to a wrapped server, or undefined when it may. */
export function wrapReadRefused(folder: string, h: WrapHomes): string | undefined {
  const f = real(folder);
  const user = real(h.user);
  const clover = real(h.clover);
  if (within(user, f)) return "it is your home folder or holds it";
  if (within(f, clover) || within(clover, f)) return "it is Clover's own folder or holds it";
  // Outside the home the fence doesn't close it: nothing to open, and nothing refused.
  if (!within(f, user)) return undefined;
  for (const w of WRAP_READS_NEVER_WHOLE) if (f === join(user, w)) return `it is your whole ${w} folder`;
  for (const s of secretPlaces(h)) {
    if (within(f, s)) return "it is inside a place that keeps keys or sign-ins";
    if (within(s, f)) return "it holds a place that keeps keys or sign-ins";
  }
  return undefined;
}

/** Whether a path is in a place the fence closes (the user's home, the Clover home), outside the installs it reads. */
function closed(p: string, h: WrapHomes): boolean {
  const user = real(h.user);
  if (!within(p, user) && !within(p, real(h.clover))) return false;
  return !TOOL_READ_DIRS.some((d) => within(p, join(user, d)));
}

/** The absolute paths a server's command and arguments name (`/x/y`, and `--flag=/x/y`). */
function namedPaths(command: string, args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of [command, ...args]) {
    const v = a.includes("=") && !isAbsolute(a) ? a.slice(a.indexOf("=") + 1) : a;
    if (isAbsolute(v)) out.push(v);
  }
  return out;
}

/** What one file needs opened: its own folder (or itself, a folder), and on the walk up to its project, each level's
 *  `node_modules` and `package.json`; a venv's interpreter, its environment. Undefined, with why, when not even its own
 *  folder may be opened. */
function opensFor(file: string, isDir: boolean, h: WrapHomes): { paths: string[] } | { why: string } {
  if (file.split(sep).some(isGitOrEnv)) return { why: "it is a .git folder or an .env file, which no plugin reads" };
  const own = isDir ? file : dirname(file);
  // The program is a Python virtual environment's interpreter: the environment, whose `lib` holds its packages.
  const venv = !isDir && basename(own) === "bin" && /^python[0-9.]*$/.test(basename(file)) && existsSync(join(dirname(own), "pyvenv.cfg")) ? dirname(own) : undefined;
  const first = venv ?? own;
  const why = wrapReadRefused(first, h);
  if (why !== undefined) return { why };
  const paths = [first];
  for (let d = first; ; d = dirname(d)) {
    if (d !== first && wrapReadRefused(d, h) !== undefined) break;
    for (const name of ["node_modules", "package.json"]) {
      const p = join(d, name);
      if (d !== first && existsSync(p)) paths.push(p);
    }
    if (PROJECT_MARKERS.some((m) => existsSync(join(d, m))) || dirname(d) === d) break;
  }
  return { paths };
}

/** A stdio server's closed files: the paths to open (read-only) and the files that can't be, each with why. */
export function wrapReads(server: { command: string; args?: readonly string[] }, h: WrapHomes = { user: homedir(), clover: join(homedir(), ".clover"), os: "macos" }): { reads: string[]; unreadable: { path: string; why: string }[] } {
  const reads: string[] = [];
  const unreadable: { path: string; why: string }[] = [];
  for (const named of namedPaths(server.command, server.args ?? [])) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(named);
    } catch {
      continue; // Not a file on this computer (a flag's value, a path inside a container): nothing to open.
    }
    const p = real(named);
    if (!closed(p, h)) continue;
    const got = opensFor(p, st.isDirectory(), h);
    if ("why" in got) {
      if (!unreadable.some((u) => u.path === named)) unreadable.push({ path: named, why: got.why });
      continue;
    }
    for (const path of got.paths) {
      if (reads.some((r) => within(path, r))) continue;
      for (let i = reads.length - 1; i >= 0; i--) if (within(reads[i]!, path)) reads.splice(i, 1);
      reads.push(path);
    }
  }
  return { reads: reads.slice(0, WRAP_READS_MAX), unreadable: unreadable.slice(0, 8) };
}

/** A running plugin's opened folders: only a generated top plugin's own (its install record's `wrapped.reads`), each
 *  checked again now (a folder that became a place it may not open, or is gone, is left out). */
export function wrapperReads(registry: { get(id: string): PluginRecord | undefined }, pluginId: string, h: WrapHomes): string[] {
  if (topPluginIdOf(pluginId) !== pluginId) return [];
  const reads = registry.get(pluginId)?.provenance.wrapped?.reads ?? [];
  return reads.slice(0, WRAP_READS_MAX).filter((f) => {
    try {
      // Never a link (the recorded path swapped for one would open where it leads, which no card named), only a
      // folder or a `package.json`, and still not a place it may not open.
      if (lstatSync(f).isSymbolicLink() || realpathSync(f) !== f) return false;
      const st = statSync(f);
      return (st.isDirectory() || (st.isFile() && basename(f) === "package.json")) && wrapReadRefused(st.isDirectory() ? f : dirname(f), h) === undefined && !f.split(sep).some(isGitOrEnv);
    } catch {
      return false;
    }
  });
}
