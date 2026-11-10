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
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { MANIFEST_FILE } from "@waifucave/clover-plugin-sdk";
import { ContractError } from "../contracts/common";
import { treeEntries, TreeProblem } from "./tree";
import { validatePluginFolder } from "./validate";

export const INSTALL_MAX_FILES = 20_000;
export const INSTALL_MAX_BYTES = 512 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
    entries = treeEntries(root, { allowHardLinks: true });
  } catch (e) {
    throw new ContractError("invalid", e instanceof TreeProblem ? e.message : `the folder can't be read: ${(e as Error).message}`);
  }
  if (entries.length > INSTALL_MAX_FILES) throw new ContractError("invalid", `a plugin folder has at most ${INSTALL_MAX_FILES} files; this one has ${entries.length}`);

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
      const st = lstatSync(from);
      if (!st.isFile()) throw new ContractError("invalid", `${e.path} isn't a regular file`);
      bytes += st.size;
      if (bytes > INSTALL_MAX_BYTES) throw new ContractError("invalid", `a plugin folder holds at most ${INSTALL_MAX_BYTES / (1024 * 1024)} MB`);
      const to = join(staged, ...e.path.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from), { flag: "wx" });
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
    if (!ID_RE.test(id)) throw new ContractError("invalid", `${JSON.stringify(id)} isn't a plugin id`);
    const dest = join(plugins, id);
    if (o.taken(id) || existsSync(dest)) throw new ContractError("conflict", `${id} is already installed; remove it first to install this folder`);
    renameSync(staged, dest);
    return { id, folder: dest, treeHash: v.treeHash };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
