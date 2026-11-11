// A pasted MCP config's own files (the controller's ruling on acceptance step 31's finding B): a stdio server the user
// brought very often runs a script in their home (`node /Users/me/tools/server.js`), which the plugin fence denies
// (the user's home is closed but for the package managers' installs, `TOOL_READ_DIRS`). At wrap time the config's
// file arguments that exist and sit in a closed place are found, and each one's folder is opened to that plugin's
// servers, READ-ONLY, on its install record (`wrapped.reads`, never the manifest's), which its OK card lists.
//
// * The folder: the nearest one above the file that holds a project's marker (`package.json`, `pyproject.toml`, a
//   virtual environment's `pyvenv.cfg`, `.git`…), so a built script finds its `node_modules`; else the file's own
//   folder. Never the user's home or a folder above it, never one of its big folders whole (Documents, Desktop,
//   Downloads, Library…), never a folder that is or holds a secret place (`SECRET_READ_PLACES`, `CREDENTIAL_FILES`) or
//   the Clover home, and never one inside a secret place. A walk up stops below the first folder it may not open.
// * A file it may not open is named on the card as unreadable (`wrapped.unreadable`), with how to fix it.
// * The fence re-checks each recorded folder at every start (`wrapperReads`), so a record can't open more than this.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import { CREDENTIAL_FILES, secretReadPlaces } from "../contracts/fence";
import type { PluginRecord } from "../contracts/plugin-registry";
import { TOOL_READ_DIRS } from "./plugin-fence";

/** The most folders one wrapped server is given. */
export const WRAP_READS_MAX = 8;

/** The home's folders never opened whole to a plugin (each is many things of the user's). Relative to the home. */
export const WRAP_READS_NEVER_WHOLE: readonly string[] = ["Library", "Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music", "Public", "Applications", "Library/Mobile Documents", "Library/CloudStorage"];

/** What marks a project's own folder: a walk up from a script stops at the first one holding one of these. */
const PROJECT_MARKERS = ["package.json", "pyproject.toml", "pyvenv.cfg", "Cargo.toml", "go.mod", "deno.json", "bun.lock", "bun.lockb", "requirements.txt", ".git"];

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

/** The folder to open for one file: its project's (the nearest marker above it), or its own; the walk stops below the
 *  first folder it may not open. Undefined, with why, when not even its own may be opened. */
function folderFor(file: string, isDir: boolean, h: WrapHomes): { folder: string } | { why: string } {
  const start = isDir ? file : dirname(file);
  const why = wrapReadRefused(start, h);
  if (why !== undefined) return { why };
  let best = start;
  for (let d = start; ; d = dirname(d)) {
    if (wrapReadRefused(d, h) !== undefined) break;
    if (PROJECT_MARKERS.some((m) => existsSync(join(d, m)))) {
      best = d;
      break;
    }
    if (dirname(d) === d) break;
  }
  return { folder: best };
}

/** A stdio server's closed files: the folders to open (read-only) and the files that can't be, each with why. */
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
    const got = folderFor(p, st.isDirectory(), h);
    if ("why" in got) {
      if (!unreadable.some((u) => u.path === named)) unreadable.push({ path: named, why: got.why });
      continue;
    }
    if (!reads.some((r) => within(got.folder, r))) {
      for (let i = reads.length - 1; i >= 0; i--) if (within(reads[i]!, got.folder)) reads.splice(i, 1);
      reads.push(got.folder);
    }
  }
  return { reads: reads.slice(0, WRAP_READS_MAX), unreadable: unreadable.slice(0, WRAP_READS_MAX) };
}

/** A running plugin's opened folders: only a generated top plugin's own (its install record's `wrapped.reads`), each
 *  checked again now (a folder that became a place it may not open, or is gone, is left out). */
export function wrapperReads(registry: { get(id: string): PluginRecord | undefined }, pluginId: string, h: WrapHomes): string[] {
  if (topPluginIdOf(pluginId) !== pluginId) return [];
  const reads = registry.get(pluginId)?.provenance.wrapped?.reads ?? [];
  return reads.slice(0, WRAP_READS_MAX).filter((f) => {
    try {
      return statSync(f).isDirectory() && wrapReadRefused(f, h) === undefined;
    } catch {
      return false;
    }
  });
}
