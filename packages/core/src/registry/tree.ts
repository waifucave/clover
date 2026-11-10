// A plugin folder on disk (spec §5.1): the reader `validateTree` reads it through, and its tree hash.
//
// Symlinks (settled here, B-M1; the SDK's tree-hash notes leave it to this lane): a symlink to a file inside the
// plugin folder counts as that file's bytes and executable bit, under the link's own path. A symlink that leaves the
// folder, one to a folder, and one that doesn't resolve make the plugin invalid, so a tree never reaches outside
// itself and a walk never loops. Assets are never served through a symlink either way (§5.1).
//
// Hard links (#197's review): a regular file with more than one name could be written through a name outside the
// folder, which the watcher doesn't see and the OK never covered, so one makes an installed plugin invalid. A
// development folder may hold them (a package manager's links), since it reloads on every change anyway.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isTreeHashExcluded, treeHash, treePathProblem, type PluginFolderReader, type TreeEntry } from "@waifucave/clover-plugin-sdk";
import { createHash } from "node:crypto";

/** Why a folder's files can't be hashed: a symlink out of it, a bad path. */
export class TreeProblem extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
  }
}

const isInside = (root: string, real: string) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);

/** Every file of the folder, as the tree hash lists it (left-out names skipped). Throws `TreeProblem`. With `maxFiles` or
 *  `maxBytes`, the walk stops at the first file past either, before that file is read (#394's review: a home folder or
 *  a large `node_modules` picked by mistake mustn't be read whole). */
export function treeEntries(folder: string, opts: { allowHardLinks?: boolean; maxFiles?: number; maxBytes?: number } = {}): TreeEntry[] {
  const root = realpathSync(folder);
  const out: TreeEntry[] = [];
  let bytes = 0;
  const count = (rel: string, size: number) => {
    if (opts.maxFiles !== undefined && out.length + 1 > opts.maxFiles) throw new TreeProblem(rel, `a plugin folder has at most ${opts.maxFiles} files`);
    bytes += size;
    if (opts.maxBytes !== undefined && bytes > opts.maxBytes) throw new TreeProblem(rel, `a plugin folder holds at most ${Math.round(opts.maxBytes / (1024 * 1024))} MB`);
  };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      if (isTreeHashExcluded(rel)) continue;
      const problem = treePathProblem(rel);
      if (problem) throw new TreeProblem(rel, `${JSON.stringify(rel)} has ${problem}`);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          throw new TreeProblem(rel, `the symlink ${rel} doesn't resolve`);
        }
        if (!isInside(root, real)) throw new TreeProblem(rel, `the symlink ${rel} leaves the plugin folder`);
        const target = statSync(real);
        if (!target.isFile()) throw new TreeProblem(rel, `the symlink ${rel} is to a folder; only a file may be linked`);
        if (target.nlink > 1 && !opts.allowHardLinks) throw new TreeProblem(rel, `${rel} links to a hard link, with another name outside the plugin's control`);
        count(rel, target.size);
        out.push(entry(rel, real, target.mode));
      } else if (st.isDirectory()) walk(abs);
      else if (st.isFile()) {
        if (st.nlink > 1 && !opts.allowHardLinks) throw new TreeProblem(rel, `${rel} is a hard link, with another name outside the plugin's control`);
        count(rel, st.size);
        out.push(entry(rel, abs, st.mode));
      }
    }
  };
  walk(root);
  return out;
}

function entry(path: string, file: string, mode: number): TreeEntry {
  return { path, executable: (mode & 0o111) !== 0, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

/** The folder's tree hash (`sha256:<hex>`). Throws `TreeProblem`. */
export async function folderTreeHash(folder: string, opts: { allowHardLinks?: boolean } = {}): Promise<string> {
  return treeHash(treeEntries(folder, opts));
}

/** The real file system under a plugin folder, for `validateTree`. */
export function folderReader(folder: string): PluginFolderReader {
  const root = (() => {
    try {
      return realpathSync(folder);
    } catch {
      return folder;
    }
  })();
  const at = (path: string) => join(root, ...path.split("/").filter((p) => p !== "" && p !== "."));
  return {
    readText(path) {
      try {
        const abs = at(path);
        if (!statSync(abs).isFile()) return undefined;
        return readFileSync(abs, "utf8");
      } catch {
        return undefined;
      }
    },
    exists(path) {
      try {
        lstatSync(at(path));
        return true;
      } catch {
        return false;
      }
    },
    listDirs(path) {
      try {
        return readdirSync(at(path), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
      } catch {
        return [];
      }
    },
    insideFolder(path) {
      try {
        return isInside(root, realpathSync(at(path)));
      } catch {
        return true; // a missing path is the caller's `file_missing`, not an escape
      }
    },
  };
}
