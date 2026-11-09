// `plugin.install { from: "folder" }` (spec §5.1): a plugin folder on disk copied into the plugins folder, where it is
// found and waits for the user's OK on its sealed card, like any other install. Nothing in it runs before that yes.
//
// * The copy is what was checked: the files are copied into a staging folder outside the plugins folder (so the
//   watcher never sees a half-copied tree), the staged copy is validated, and only then renamed into
//   `<plugins>/<id>`. A source changed during the copy can't swap in files nobody validated.
// * Only regular files are copied, as bytes. A symlink to a file inside the source counts as that file (the tree
//   hash's rule, `treeEntries`); one that leaves the folder, a link to a folder, and a dangling one refuse the install.
//   Hard links in the source are copied as plain files, so the installed copy has none.
// * Bounded: at most `INSTALL_MAX_FILES` files and `INSTALL_MAX_BYTES` bytes in all; the excluded names (`.git` and
//   the others the tree hash leaves out) aren't copied.
// * The id is the manifest's `id`, else the source folder's name, and the folder is named by it. An id that's already
//   installed here is refused (removing it first is the user's own act), and so is one from Clover's bundled plugins.
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { MANIFEST_FILE } from "@waifucave/clover-plugin-sdk";
import { TopPluginId } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { treeEntries, TreeProblem } from "./tree";
import { validatePluginFolder } from "./validate";

export const INSTALL_MAX_FILES = 20_000;
export const INSTALL_MAX_BYTES = 512 * 1024 * 1024;

/** Reads one file of the source, as it is when opened (#394's review): opened without following a link, checked to be a
 *  regular file through its descriptor, read from that descriptor up to what's left of the byte budget, and its path
 *  checked again afterwards to still be the file that was meant. Gives back the bytes. */
export function readSourceFile(from: string, rel: string, budget: number): Buffer {
  let fd: number;
  try {
    fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    throw new ContractError("invalid", `${rel} can't be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ContractError("invalid", `${rel} isn't a regular file`);
    if (st.size > budget) throw new ContractError("invalid", `a plugin folder holds at most ${INSTALL_MAX_BYTES / (1024 * 1024)} MB`);
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    // Grown since it was opened: refused rather than read past the budget or half read.
    const more = Buffer.alloc(1);
    if (readSync(fd, more, 0, 1, got) > 0) throw new ContractError("invalid", `${rel} changed while it was copied`);
    if (realpathSync(from) !== from) throw new ContractError("invalid", `${rel} changed while it was copied`);
    return got === st.size ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** A rename's failure as the install's: a folder that appeared there meanwhile is the user's to remove first. */
export function renameInto(staged: string, dest: string, id: string, rename: (from: string, to: string) => void = renameSync): void {
  try {
    rename(staged, dest);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") throw new ContractError("conflict", `${id} is already installed; remove it first to install this folder`);
    if (code !== "EXDEV") throw e;
  }
  // The plugins folder is on another volume than the staging folder: copied beside it under a dot-name (which the
  // folder watcher and the registry skip), then renamed in on that volume.
  const beside = join(dirname(dest), `.${id}.installing-${randomBytes(6).toString("hex")}`);
  try {
    cpSync(staged, beside, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    try {
      renameSync(beside, dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") throw new ContractError("conflict", `${id} is already installed; remove it first to install this folder`);
      throw new ContractError("failed", `${id} couldn't be moved into the plugins folder: ${code ?? (e as Error).message}`);
    }
  } finally {
    rmSync(beside, { recursive: true, force: true });
  }
}

/** `<home>/run/plugin-install`: where an install's copy is staged, outside the plugins folder. */
export function installStagingDir(cloverHome: string): string {
  return join(cloverHome, "run", "plugin-install");
}

/** The staging folders a run before left (a crash mid-install): removed when the daemon starts. */
export function sweepInstallStages(stagingDir: string): void {
  rmSync(stagingDir, { recursive: true, force: true });
}

/** Copies the plugin folder at `source` into `pluginsDir`, validated, and gives back its id and folder. Throws
 *  `ContractError` (`invalid`, `conflict`) with the reason. */
export async function installFromFolder(o: {
  source: string;
  pluginsDir: string;
  /** Where staging folders go: on the plugins folder's volume, outside it (`<home>/run/plugin-install`). */
  stagingDir: string;
  os?: "macos" | "windows" | "linux";
  /** Ids that can't be installed over (installed already, bundled, or a development folder's). */
  taken: (id: string) => boolean;
}): Promise<{ id: string; folder: string; treeHash: string }> {
  let root: string;
  try {
    root = realpathSync(o.source);
  } catch {
    throw new ContractError("invalid", `${o.source} doesn't exist`);
  }
  if (!statSync(root).isDirectory() || !existsSync(join(root, MANIFEST_FILE))) throw new ContractError("invalid", `${root} has no ${MANIFEST_FILE}`);
  mkdirSync(o.pluginsDir, { recursive: true });
  const plugins = realpathSync(o.pluginsDir);
  if (root === plugins || root.startsWith(plugins + sep) || plugins.startsWith(root + sep)) {
    throw new ContractError("invalid", "a plugin is installed from a folder outside the plugins folder");
  }

  let entries: ReturnType<typeof treeEntries>;
  try {
    // Capped in the walk itself, before a file past either cap is read.
    entries = treeEntries(root, { allowHardLinks: true, maxFiles: INSTALL_MAX_FILES, maxBytes: INSTALL_MAX_BYTES });
  } catch (e) {
    throw new ContractError("invalid", e instanceof TreeProblem ? e.message : `the folder can't be read: ${(e as Error).message}`);
  }

  mkdirSync(o.stagingDir, { recursive: true, mode: 0o700 });
  const stage = join(o.stagingDir, randomBytes(8).toString("hex"));
  const staged = join(stage, basename(root));
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  try {
    let bytes = 0;
    for (const e of entries) {
      const from = realpathSync(join(root, ...e.path.split("/")));
      // `treeEntries` checked every link stays inside; checked again here, since the folder may change meanwhile.
      if (from !== root && !from.startsWith(root + sep)) throw new ContractError("invalid", `${e.path} now leaves the plugin folder`);
      // The byte cap counts what's actually read.
      const data = readSourceFile(from, e.path, INSTALL_MAX_BYTES - bytes);
      bytes += data.length;
      const to = join(staged, ...e.path.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data, { flag: "wx" });
      chmodSync(to, e.executable ? 0o755 : 0o644);
    }
    chmodSync(staged, 0o755);

    // What's checked is the copy, by the same validation the terminal's `clover plugin validate` runs.
    const v = await validatePluginFolder(staged, ...(o.os ? [{ os: o.os }] : []));
    if (!v.ok || v.plugin === undefined || v.treeHash === undefined) {
      const errors = v.issues.filter((i) => i.severity === "error").slice(0, 5).map((i) => `${i.file ? `${i.file}: ` : ""}${i.message}`);
      throw new ContractError("invalid", `the plugin isn't valid${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`);
    }
    const id = v.plugin.id;
    // A top-level plugin's id, as the protocol takes it (never a child's `a/b`).
    if (!TopPluginId.safeParse(id).success) throw new ContractError("invalid", `${JSON.stringify(id)} isn't a plugin id`);
    const dest = join(plugins, id);
    if (o.taken(id) || existsSync(dest)) throw new ContractError("conflict", `${id} is already installed; remove it first to install this folder`);
    renameInto(staged, dest, id);
    return { id, folder: dest, treeHash: v.treeHash };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
