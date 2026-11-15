// The catch-up look's fingerprint of a folder (`PluginFolders#catchUp`): each file's path, size and time, and each
// folder's name. `node_modules` and `.git` aren't walked, links aren't followed, and it stops at `FINGERPRINT_ENTRIES`.
import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** The most entries a fingerprint looks at in one folder. */
export const FINGERPRINT_ENTRIES = 5_000;

/** What the walks did, for the tests: `readdirs` is how many directory listings were read. */
export const fingerprintStats = { readdirs: 0 };

/** A folder's files as they are now: a full walk, one directory listing per directory and a stat per file. Empty when
 *  the folder isn't there. */
export function fingerprint(folder: string): string {
  return walkFolder(folder).print;
}

interface Walk {
  print: string;
  /** Each directory the walk listed, with the stat key it had just before it was listed. */
  dirs: { path: string; key: string }[];
  /** Each file it stat'ed, with the name its line is under. */
  files: { path: string; name: string }[];
  /** The lines of the directories (their names), which don't change while no directory does. */
  dirLines: string[];
}

const dirKey = (path: string): string | undefined => {
  try { const st = lstatSync(path); return `${st.mtimeMs}:${st.ctimeMs}:${st.ino}`; } catch { return undefined; }
};

function walkFolder(folder: string): Walk {
  const lines: string[] = [];
  const dirs: Walk["dirs"] = [];
  const files: Walk["files"] = [];
  const dirLines: string[] = [];
  const walk = (dir: string, rel: string): void => {
    // The stat first: a change after it shows in the next look as a different key, never as a missed one.
    const key = dirKey(dir);
    let entries: Dirent[];
    try { fingerprintStats.readdirs++; entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    dirs.push({ path: dir, key: key ?? "" });
    for (const e of entries) {
      if (lines.length >= FINGERPRINT_ENTRIES) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) { const line = `${rel}${e.name}/`; lines.push(line); dirLines.push(line); walk(path, `${rel}${e.name}/`); continue; }
      try { const st = lstatSync(path); lines.push(`${rel}${e.name}:${st.size}:${st.mtimeMs}`); files.push({ path, name: `${rel}${e.name}` }); } catch { /* gone meanwhile */ }
    }
  };
  walk(folder, "");
  return { print: lines.sort().join("\n"), dirs, files, dirLines };
}

/**
 * The fingerprints of folders looked at again and again. A directory's listing is the costliest part of a walk (about
 * six times a stat), and it only changes when the directory itself does: so a look stats each directory it listed last
 * time (its mtime and ctime, which no tool can set back) and each file, and lists again, with a full walk, only when a
 * directory's stat differs, a file's stat fails or the last walk hit the cap. A file edited in place changes its own
 * stat; a file or folder that comes, goes or is renamed changes its directory's. The print it returns is the one a full
 * walk gives at that moment.
 */
export class FingerprintCache {
  readonly #walks = new Map<string, Walk & { capped: boolean }>();

  print(folder: string): string {
    const last = this.#walks.get(folder);
    // A folder that wasn't there (no directory listed) has nothing to compare: it is walked until it is.
    if (last !== undefined && !last.capped && last.dirs.length > 0) {
      const again = this.#again(last);
      if (again !== undefined) return again;
    }
    const walk = walkFolder(folder);
    this.#walks.set(folder, { ...walk, capped: walk.dirLines.length + walk.files.length >= FINGERPRINT_ENTRIES });
    return walk.print;
  }

  forget(folder: string): void {
    this.#walks.delete(folder);
  }

  /** Every folder it holds a walk of. */
  folders(): string[] {
    return [...this.#walks.keys()];
  }

  clear(): void {
    this.#walks.clear();
  }

  /** The print from the last walk's directories and files by their stats alone; undefined when it can't be (a full walk is due). */
  #again(w: Walk): string | undefined {
    for (const d of w.dirs) if (dirKey(d.path) !== d.key) return undefined;
    const lines = [...w.dirLines];
    for (const f of w.files) {
      try { const st = lstatSync(f.path); lines.push(`${f.name}:${st.size}:${st.mtimeMs}`); } catch { return undefined; }
    }
    return lines.sort().join("\n");
  }
}
