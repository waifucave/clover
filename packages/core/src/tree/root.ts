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

/** Makes or repairs the tree folder: the user's own and closed to everyone else, `home/` read-only and holding only
 *  this computer's link (a rename moves it), and `bots/`. A tree folder another user made first is refused
 *  (`refused`); the caller then picks a random name and remembers it.
 *
 *  On macOS and Linux: owned by the user, 0700, `home/` 0500. On Windows (`%ProgramData%`, where any local user may
 *  make folders; review S3): the folder and `home\` must be owned by the user (or by Administrators or SYSTEM, which
 *  an elevated process's folders are), each gets a protected access list that grants only the user and SYSTEM, and
 *  `home\` denies everyone adding files or folders; the links in it are made again each time, by this user. */
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
  const hst = await fsp.lstat(homeDir);
  if (!hst.isDirectory()) throw new ContractError("refused", `${homeDir} isn't a folder`);
  if (os === "windows") await windowsAccess(o.root, homeDir, "open");
  else await fsp.chmod(homeDir, 0o700);
  try {
    for (const name of await fsp.readdir(homeDir)) {
      if (name === o.self && os !== "windows") continue;
      // Links only, never what they lead to: a plain remove of the entry itself.
      await fsp.rm(join(homeDir, name), { force: true, recursive: false }).catch(() => fsp.unlink(join(homeDir, name)));
    }
    await link(join(homeDir, o.self), o.home, os);
  } finally {
    if (os === "windows") await windowsAccess(o.root, homeDir, "closed");
    else await fsp.chmod(homeDir, 0o500);
  }
  await fsp.mkdir(o.botsRoot, { recursive: true, mode: 0o700 });
  await link(join(o.root, "bots"), o.botsRoot, os, os === "windows");
}

/** The tree folder's access on Windows, set by PowerShell's ACL classes (no window: `windowsHide`). Both folders must
 *  be owned by the user, Administrators or SYSTEM; each gets a protected list granting the user and SYSTEM full
 *  control, and `home\`, once `closed`, also denies everyone creating files or folders in it. */
const WINDOWS_ACCESS = String.raw`
$ErrorActionPreference = 'Stop'
$me  = [Security.Principal.WindowsIdentity]::GetCurrent().User
$sys = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$adm = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$all = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
function Check-Owner($p) {
  $o = (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (@($me.Value, $sys.Value, $adm.Value) -notcontains $o) { [Console]::Out.Write('owner ' + $o); exit 3 }
}
function Set-Closed($p, [bool]$denyCreate) {
  $item = Get-Item -LiteralPath $p -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [Console]::Out.Write('link ' + $p); exit 4 }
  # The access list only (never the owner): no inherited rules, and every explicit one replaced.
  $a = $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
  $a.SetAccessRuleProtection($true, $false)
  foreach ($r in @($a.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { [void]$a.RemoveAccessRuleSpecific($r) }
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  foreach ($s in @($me, $sys)) {
    $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
  }
  if ($denyCreate) {
    $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($all, [Security.AccessControl.FileSystemRights]'CreateFiles,CreateDirectories', [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny)))
  }
  $item.SetAccessControl($a)
}
Check-Owner $env:CLOVER_TREE_ROOT
Check-Owner $env:CLOVER_TREE_HOME
Set-Closed $env:CLOVER_TREE_ROOT $false
Set-Closed $env:CLOVER_TREE_HOME ($env:CLOVER_TREE_MODE -eq 'closed')
`;

async function windowsAccess(root: string, homeDir: string, mode: "open" | "closed"): Promise<void> {
  const encoded = Buffer.from(WINDOWS_ACCESS, "utf16le").toString("base64");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { CLOVER_TREE_ROOT: root, CLOVER_TREE_HOME: homeDir, CLOVER_TREE_MODE: mode });
  const proc = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code === 3) throw new ContractError("refused", `${root} belongs to another user (${out.trim()})`);
  if (code === 4) throw new ContractError("refused", `${out.trim().slice(5)} is a link, not a folder`);
  if (code !== 0) throw new ContractError("failed", `the tree folder's access couldn't be set: ${(err || out).trim().slice(0, 500)}`);
}

/** `at` → `target`, made or repaired; anything else at `at` is replaced. `fresh` makes it again even when it is right
 *  (on Windows, so the link is this user's own). */
async function link(at: string, target: string, os: Os, fresh = false): Promise<void> {
  const st = await fsp.lstat(at).catch(() => null);
  if (!fresh && st?.isSymbolicLink() && (await fsp.readlink(at)).replace(/[\\/]+$/, "") === target.replace(/[\\/]+$/, "")) return;
  if (st) await fsp.rm(at, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: true });
  await fsp.symlink(target, at, os === "windows" ? "junction" : "dir");
}

/** Whether a program here can write in `home/` of the tree (it must not). On Windows the access list decides, which
 *  `access` doesn't read, so it tries to make a folder there. */
export async function treeHomeWritable(root: string, os: Os = hostOs()): Promise<boolean> {
  if (os === "windows") {
    const probe = join(root, "home", `.clover-probe-${process.pid}-${Date.now()}`);
    try {
      await fsp.mkdir(probe);
    } catch {
      return false;
    }
    await fsp.rmdir(probe).catch(() => {});
    return true;
  }
  try {
    await fsp.access(join(root, "home"), FS.W_OK);
    return true;
  } catch {
    return false;
  }
}
