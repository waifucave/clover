// P5 (the reviewer's read 44): a folder a plugin names to read outside its sandbox (`host.outside.read`) that holds the
// user's home, or is MOSS's own home, in it or holding it, is refused with why, on this computer, where both homes are
// known: the plugin doesn't validate, so its card never promises a read the fence wouldn't give (`outsideReadFolders`
// drops such a folder too, the fence's own hold). The SDK's validator refuses the shapes it can judge anywhere (`/`,
// the disk's top folders, `/System`); this judges the rest by real paths.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ValidationIssue } from "@waifucave/moss-protocol";

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** The homes a folder plugin's names are judged against: the user's (`HOME`) and MOSS's, the parent of its plugins
 *  folder. */
export function homesOf(pluginsDir: string, userHome: string = homedir()): { userHome: string; mossHome: string } {
  return { userHome, mossHome: dirname(pluginsDir) };
}

/** The refusals for a manifest's `host.outside.read` on this computer: each folder that holds the user's home or
 *  MOSS's, or lies in MOSS's. */
export function outsideHomeIssues(manifest: unknown, o: { userHome: string; mossHome: string }): ValidationIssue[] {
  const read = (manifest as { host?: { outside?: { read?: unknown } } } | undefined)?.host?.outside?.read;
  if (!Array.isArray(read)) return [];
  const home = real(o.userHome);
  const moss = real(o.mossHome);
  const issues: ValidationIssue[] = [];
  read.forEach((p, i) => {
    if (typeof p !== "string") return;
    const at = real(p === "~" ? o.userHome : p.startsWith("~/") ? join(o.userHome, p.slice(2)) : resolve(p));
    const why = inside(home, at) ? "holds your whole home folder" : inside(moss, at) ? "holds MOSS's own folder" : inside(at, moss) ? "is inside MOSS's own folder" : undefined;
    if (why === undefined) return;
    issues.push({
      severity: "error", refuses: "plugin", code: "outside_folder_home", file: "moss.json", path: `/host/outside/read/${i}`,
      message: `"${p}" ${why}, so it isn't a folder it may read outside its sandbox: name the folder inside your home that it needs`,
    });
  });
  return issues;
}
