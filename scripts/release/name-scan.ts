// The release's name scan (plan §4 M-M2): every file a release ships, read for the owner's identity before the
// draft goes up. Git hooks see only what enters the repo; a build can still carry an absolute builder path or a name
// in a binary (the predecessor app's 0.2.001 leak), so the gate reads the built files themselves. The patterns live OUTSIDE this
// repo, in the owner's local-only guard (~/norma-private/git-hooks/name-guard.sh `artifacts`): a tracked copy would
// publish the strings it keeps out. So the gate fails closed on a machine without the guard, and only the owner's
// Mac cuts a release.
//
// What it reads: each asset as it is, and inside it where it opens without running anything (the update zip, the
// deb's data, the rpm's payload, through bsdtar), plus the signed app as built. A dmg, the Windows installer and the
// AppImage are read as raw bytes: their contents are the app the zip and the packages also carry.
//
// Accepted (not read by the guard), each for its own reason, and widening this list is a security decision:
//   *.THIRD_PARTY_NOTICES.txt   third parties' license texts, with their authors' names and addresses, which can
//                               collide with a pattern by chance. They are generated in CI from pinned sources (srt-
//                               win.ts: sandbox-runtime's LICENSE and cargo-about's report), never on the owner's
//                               machine, and carry no build path. The rest of each asset is read in full.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const NAME_SCAN_ACCEPTED: readonly RegExp[] = [/(^|\/)[^/]+\.THIRD_PARTY_NOTICES\.txt$/];

export function guardPath(home: string | undefined): string {
  return join(home ?? "", "norma-private", "git-hooks", "name-guard.sh");
}

/** How an asset is opened for reading: `zip`, `rpm` and `deb` through bsdtar (the deb's data archive inside it), else raw. */
export function openerFor(name: string): "zip" | "rpm" | "deb" | "raw" {
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".rpm")) return "rpm";
  if (name.endsWith(".deb")) return "deb";
  return "raw";
}

/**
 * Every file under `root` to hand the guard, and the accepted ones left out (`list` gives a folder's entries without
 * following links, `isDir` doesn't follow them either). Regular files only, as the guard reads them.
 */
export function scanFiles(root: string, list: (dir: string) => string[], isDir: (p: string) => boolean): { read: string[]; accepted: string[] } {
  const read: string[] = [];
  const accepted: string[] = [];
  const walk = (p: string): void => {
    if (isDir(p)) { for (const n of list(p)) walk(join(p, n)); return; }
    (NAME_SCAN_ACCEPTED.some((re) => re.test(p)) ? accepted : read).push(p);
  };
  walk(root);
  return { read, accepted };
}

function sh(cmd: string[], cwd?: string): number {
  return spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: ["ignore", "ignore", "pipe"] }).status ?? 1;
}

/**
 * Runs the scan over `assets` (absolute paths) and `apps` (unpacked app folders, read whole). Returns the problems:
 * none means every file was read and nothing was found. The guard prints its own findings.
 */
export function nameScan(assets: readonly string[], apps: readonly string[], home = process.env.HOME): { problems: string[]; read: number; accepted: string[] } {
  const guard = guardPath(home);
  if (!existsSync(guard)) return { problems: [`the name scan needs the owner's local guard (${guard}); this machine can't cut a release`], read: 0, accepted: [] };
  const work = mkdtempSync(join(tmpdir(), "clover-name-scan-"));
  const problems: string[] = [];
  try {
    const roots: string[] = [...apps];
    for (const asset of assets) {
      roots.push(asset);
      const how = openerFor(basename(asset));
      if (how === "raw") continue;
      const into = join(work, basename(asset));
      mkdirSync(into, { recursive: true });
      if (sh(["bsdtar", "-xf", asset, "-C", into]) !== 0) { problems.push(`${basename(asset)} doesn't open for the scan`); continue; }
      if (how === "deb") {
        const data = readdirSync(into).find((n) => n.startsWith("data.tar"));
        if (data === undefined || sh(["bsdtar", "-xf", join(into, data), "-C", into]) !== 0) problems.push(`${basename(asset)}'s data doesn't open for the scan`);
      }
      roots.push(into);
    }
    const files = roots.map((r) => scanFiles(r, (d) => readdirSync(d, { withFileTypes: true }).filter((e) => !e.isSymbolicLink()).map((e) => e.name), (p) => lstatSync(p).isDirectory()));
    const read = files.flatMap((f) => f.read);
    const accepted = files.flatMap((f) => f.accepted);
    // In batches, so no command line grows past the OS's limit.
    for (let i = 0; i < read.length; i += 500) {
      // The guard's findings go to the owner's terminal as it prints them.
      const r = spawnSync(guard, ["artifacts", ...read.slice(i, i + 500)], { stdio: ["ignore", "inherit", "inherit"] });
      if ((r.status ?? 1) !== 0) { problems.push("the name scan found the owner's identity in the release (the guard printed where)"); break; }
    }
    return { problems, read: read.length, accepted };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
