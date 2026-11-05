// The tree on each computer's own disk (spec §9.1 "Same-computer paths are native"; the J-M0 report's §9.1 text): a
// folder outside every home folder whose `home/<this computer>` is a link to the home folder (a junction on Windows),
// so any program here resolves this computer's own tree paths at full speed, and whose `bots/` is a link to the
// folder of the bots this computer runs. Other computers aren't on disk: nothing is mounted (the owner's item 88), so
// a program that names one gets "no such file", and `home/` is read-only, so nothing a program writes there lands on
// the wrong computer. A search of the home folder never walks into the tree, since the tree sits outside it.
import { constants as FS, promises as fsp } from "node:fs";
import { join, posix } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { hostOs } from "./names";

/** Where this computer's tree folder lives: `$XDG_RUNTIME_DIR/clover` on Linux, `/Users/Shared/clover-<uid>` on macOS
 *  (a user can't make folders in `/` or `/Volumes`, and `$TMPDIR` is cleaned), and `%ProgramData%\Clover\tree-<user>`
 *  on Windows, outside the user's profile. */
export function defaultTreeRoot(env: NodeJS.ProcessEnv = process.env, os: Os = hostOs()): string {
  if (os === "linux") {
    const run = env.XDG_RUNTIME_DIR;
    if (!run) throw new ContractError("invalid", "XDG_RUNTIME_DIR isn't set, so there's nowhere outside the home folder for the tree");
    return posix.join(run, "clover");
  }
  if (os === "macos") return `/Users/Shared/clover-${process.getuid?.() ?? 0}`;
  const data = env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData";
  const user = (env.USERNAME ?? "user").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${data}\\Clover\\tree-${user}`;
}

export interface TreeRootOptions {
  /** The tree folder (`defaultTreeRoot()`). */
  root: string;
  /** This computer's name in the tree. */
  self: string;
  /** The home folder `home/<self>` links to. */
  home: string;
  /** The folder of the bots this computer runs, which `bots/` links to. */
  botsRoot: string;
  os?: Os;
}

/** Makes or repairs the tree folder: the user's own and 0700, `home/` read-only and holding only this computer's link
 *  (a rename moves it), and `bots/`. A tree folder another user made first is refused (`refused`); the caller then
 *  picks a random name and remembers it. */
export async function ensureTreeRoot(o: TreeRootOptions): Promise<void> {
  const os = o.os ?? hostOs();
  await fsp.mkdir(o.root, { recursive: true, mode: 0o700 });
  const st = await fsp.lstat(o.root);
  if (!st.isDirectory()) throw new ContractError("refused", `${o.root} isn't a folder`);
  if (os !== "windows") {
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new ContractError("refused", `${o.root} belongs to another user`);
    if ((st.mode & 0o077) !== 0) await fsp.chmod(o.root, 0o700);
  }
  const homeDir = join(o.root, "home");
  await fsp.mkdir(homeDir, { recursive: true });
  if (os !== "windows") await fsp.chmod(homeDir, 0o700);
  try {
    for (const name of await fsp.readdir(homeDir)) {
      if (name === o.self) continue;
      await fsp.rm(join(homeDir, name), { force: true, recursive: false }).catch(() => fsp.unlink(join(homeDir, name)));
    }
    await link(join(homeDir, o.self), o.home, os);
  } finally {
    if (os !== "windows") await fsp.chmod(homeDir, 0o500);
  }
  await fsp.mkdir(o.botsRoot, { recursive: true, mode: 0o700 });
  await link(join(o.root, "bots"), o.botsRoot, os);
}

/** `at` → `target`, made or repaired; anything else at `at` is replaced. */
async function link(at: string, target: string, os: Os): Promise<void> {
  const st = await fsp.lstat(at).catch(() => null);
  if (st?.isSymbolicLink() && (await fsp.readlink(at)).replace(/[\\/]+$/, "") === target.replace(/[\\/]+$/, "")) return;
  if (st) await fsp.rm(at, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: true });
  await fsp.symlink(target, at, os === "windows" ? "junction" : "dir");
}

/** Whether a program here can write in `home/` of the tree (it must not). */
export async function treeHomeWritable(root: string): Promise<boolean> {
  try {
    await fsp.access(join(root, "home"), FS.W_OK);
    return true;
  } catch {
    return false;
  }
}
