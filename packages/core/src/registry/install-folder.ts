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
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    // Non-blocking, so a file swapped for a FIFO can't hold the daemon in open(); fstat then refuses it.
    fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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

/** The staging folders a run before left (a crash mid-install): removed when the daemon starts, and with them a copy
 *  an EXDEV install left beside the plugins folder (`.<id>.installing-<hex>`). */
export function sweepInstallStages(stagingDir: string, pluginsDir?: string): void {
  rmSync(stagingDir, { recursive: true, force: true });
  if (pluginsDir === undefined || !existsSync(pluginsDir)) return;
  for (const name of readdirSync(pluginsDir)) {
    if (/^\.[a-z0-9-]+\.installing-[0-9a-f]+$/.test(name)) rmSync(join(pluginsDir, name), { recursive: true, force: true });
  }
}

/** Where an install puts its plugin and checks it: the plugins folder, the staging folder beside it, the OS the
 *  validation reads for, and the ids it can't install over. */
export interface InstallTarget {
  pluginsDir: string;
  /** Where staging folders go: on the plugins folder's volume, outside it (`<home>/run/plugin-install`). */
  stagingDir: string;
  os?: "macos" | "windows" | "linux";
  /** Ids that can't be installed over (installed already, bundled, or a development folder's). */
  taken: (id: string) => boolean;
}

/** A folder from outside the plugins folder, as it is now: its real path, refused when it is or holds the plugins
 *  folder. */
export function sourceFolder(source: string, pluginsDir: string): string {
  let root: string;
  try {
    root = realpathSync(source);
  } catch {
    throw new ContractError("invalid", `${source} doesn't exist`);
  }
  if (!statSync(root).isDirectory()) throw new ContractError("invalid", `${root} isn't a folder`);
  mkdirSync(pluginsDir, { recursive: true });
  const plugins = realpathSync(pluginsDir);
  if (root === plugins || root.startsWith(plugins + sep) || plugins.startsWith(root + sep)) {
    throw new ContractError("invalid", "a plugin is installed from a folder outside the plugins folder");
  }
  return root;
}

/** Copies the tree at `root` (a real path) into `dest`, the way an install copies: only regular files, as bytes; a link
 *  to a file inside the tree counts as that file, one that leaves it refuses the copy; capped in files and bytes before
 *  a file past either cap is read; the tree hash's excluded names (`.git`, …) left out. `budget` is the bytes the copy
 *  may still use (an install's whole budget by default). Gives back the bytes copied. */
export function copyTreeInto(root: string, dest: string, budget = INSTALL_MAX_BYTES): number {
  let entries: ReturnType<typeof treeEntries>;
  try {
    entries = treeEntries(root, { allowHardLinks: true, maxFiles: INSTALL_MAX_FILES, maxBytes: budget });
  } catch (e) {
    throw new ContractError("invalid", e instanceof TreeProblem ? e.message : `the folder can't be read: ${(e as Error).message}`);
  }
  let bytes = 0;
  for (const e of entries) {
    const from = realpathSync(join(root, ...e.path.split("/")));
    // `treeEntries` checked every link stays inside; checked again here, since the folder may change meanwhile.
    if (from !== root && !from.startsWith(root + sep)) throw new ContractError("invalid", `${e.path} now leaves the folder`);
    // The byte cap counts what's actually read.
    const data = readSourceFile(from, e.path, budget - bytes);
    bytes += data.length;
    const to = join(dest, ...e.path.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, data, { flag: "wx" });
    chmodSync(to, e.executable ? 0o755 : 0o644);
  }
  return bytes;
}

/** A new staging folder for one install, removed by `done` whatever happens. */
export function newStage(stagingDir: string): { dir: string; done(): void } {
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const dir = join(stagingDir, randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Validates a staged plugin folder, the copy that will be installed, by the same validation the terminal's
 *  `clover plugin validate` runs, and renames it into the plugins folder under its id. */
export async function installStaged(staged: string, o: InstallTarget): Promise<{ id: string; folder: string; treeHash: string }> {
  chmodSync(staged, 0o755);
  const v = await validatePluginFolder(staged, ...(o.os ? [{ os: o.os }] : []));
  if (!v.ok || v.plugin === undefined || v.treeHash === undefined) {
    const errors = v.issues.filter((i) => i.severity === "error").slice(0, 5).map((i) => `${i.file ? `${i.file}: ` : ""}${i.message}`);
    throw new ContractError("invalid", `the plugin isn't valid${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`);
  }
  const id = v.plugin.id;
  // A top-level plugin's id, as the protocol takes it (never a child's `a/b`).
  if (!TopPluginId.safeParse(id).success) throw new ContractError("invalid", `${JSON.stringify(id)} isn't a plugin id`);
  const plugins = realpathSync(o.pluginsDir);
  const dest = join(plugins, id);
  if (o.taken(id) || existsSync(dest)) throw new ContractError("conflict", `${id} is already installed; remove it first to install this folder`);
  renameInto(staged, dest, id);
  return { id, folder: dest, treeHash: v.treeHash };
}

/** Copies the plugin folder at `source` into `pluginsDir`, validated, and gives back its id and folder. Throws
 *  `ContractError` (`invalid`, `conflict`) with the reason. */
export async function installFromFolder(o: InstallTarget & { source: string }): Promise<{ id: string; folder: string; treeHash: string }> {
  const root = sourceFolder(o.source, o.pluginsDir);
  if (!existsSync(join(root, MANIFEST_FILE))) throw new ContractError("invalid", `${root} has no ${MANIFEST_FILE}`);
  const stage = newStage(o.stagingDir);
  const staged = join(stage.dir, basename(root));
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  try {
    copyTreeInto(root, staged);
    return await installStaged(staged, o);
  } finally {
    stage.done();
  }
}
