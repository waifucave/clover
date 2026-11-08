// The app's install (C-M3 item 5; the #259 review, and #306's): the bundled plugins ship in its resources folder
// (Clover.app/Contents/Resources/plugins, <install>\resources\plugins, /opt/Clover/resources/plugins) and are approved
// without a card, the daemon and its sidecar sit in `resources/daemon/`, and the app's own code is around them
// (Contents/MacOS, Frameworks and Info.plist on macOS; the install folder's executable and libraries on Windows and
// Linux). A drag-installed app, or one in a user-owned /opt/Clover, is the user's to write, so a write tool or an escape
// command could change a bundled plugin or the app, which would then run as trusted code. The WHOLE install is fenced
// like `runtimes`: in the Bash sandbox's `denyWrite`, refused by the escape floor on any mention, denied to the write
// tools (`selfGrantDenyWrite`, `controlPlaneDenyRules`), and write-denied in Clover's own fence (`plugins`).
//
// It is found from the daemon's own binary, never from the environment: a compiled daemon at
// `<resources>/daemon/clover-core` has `<resources>` as its resources folder, and the install around it is the `.app`
// bundle on macOS (`<X>.app/Contents/Resources`) and `<resources>`'s parent elsewhere. Both spellings are kept: the
// binary's path as the process was started (`process.argv0` when absolute: a compiled Bun's `process.execPath` is
// already resolved, so a `Link.app` that links to `Real.app`, how a command may name it, shows only there) and with its
// links resolved. A daemon run from source, or a compiled one anywhere else (a server's `<home>/bin`, which is
// fenced on its own), has none; an install folder that is a filesystem root, or holds the user's home, is never taken
// (the resources folder alone is, then).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { isCompiledBinary } from "../build-kind";

/** The resources folder of the daemon binary at `binary` (as spelled, not resolved), or undefined. */
function resourcesOf(binary: string, platform: NodeJS.Platform): string | undefined {
  const path = platform === "win32" ? win32 : posix;
  const daemonDir = path.dirname(binary);
  if (path.basename(daemonDir).toLowerCase() !== "daemon") return undefined;
  const resources = path.dirname(daemonDir);
  return path.basename(resources).toLowerCase() === "resources" ? resources : undefined;
}

/** The install around a resources folder: the `.app` on macOS, the resources folder's parent elsewhere, unless that is
 *  a filesystem root or holds `userHome`, when it is the resources folder alone. */
function installOf(resources: string, platform: NodeJS.Platform, userHome: string): string {
  const path = platform === "win32" ? win32 : posix;
  const fold = (p: string) => (platform === "linux" ? p : p.toLowerCase());
  let root: string;
  if (platform === "darwin") {
    const contents = path.dirname(resources);
    const app = path.dirname(contents);
    root = path.basename(contents).toLowerCase() === "contents" && path.basename(app).toLowerCase().endsWith(".app") ? app : resources;
  } else {
    root = path.dirname(resources);
  }
  const isRoot = path.dirname(root) === root;
  const rel = path.relative(fold(root), fold(userHome));
  const holdsHome = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return isRoot || holdsHome ? resources : root;
}

/** The resources folder of the daemon at `execPath` (links resolved), or undefined. */
export function appResourcesDirFor(
  execPath: string, compiled: boolean, platform: NodeJS.Platform = process.platform, realpath: (p: string) => string = realpathSync,
): string | undefined {
  if (!compiled) return undefined;
  try { return resourcesOf(realpath(execPath), platform); } catch { return undefined; }
}

/** The app's install folders for the daemon at `execPath`: the install around it as started (`argv0`, when absolute:
 *  a compiled Bun's `process.execPath` is already resolved, so a `Link.app` that links to `Real.app` shows only there),
 *  as `execPath` names it, and with its links resolved (one entry for the same folder), or none. */
export function appInstallDirsFor(
  execPath: string, compiled: boolean, platform: NodeJS.Platform = process.platform, realpath: (p: string) => string = realpathSync,
  userHome: string = homedir(), argv0?: string,
): string[] {
  if (!compiled) return [];
  const path = platform === "win32" ? win32 : posix;
  let real: string | undefined;
  try { real = realpath(execPath); } catch { real = undefined; }
  const out: string[] = [];
  for (const binary of [argv0 !== undefined && path.isAbsolute(argv0) ? path.normalize(argv0) : undefined, execPath, real]) {
    if (binary === undefined) continue;
    const resources = resourcesOf(binary, platform);
    if (resources === undefined) continue;
    const root = installOf(resources, platform, userHome);
    const fold = (p: string) => (platform === "linux" ? p : p.toLowerCase());
    if (!out.some((o) => fold(o) === fold(root))) out.push(root);
  }
  return out;
}

let current: readonly string[] | undefined;

/** The install folders the fences hold: this daemon's own, found once. */
export function appInstallDirs(): readonly string[] {
  if (current === undefined) current = appInstallDirsFor(process.execPath, isCompiledBinary(), process.platform, realpathSync, homedir(), process.argv0);
  return current;
}

/** Sets them (tests); gives back the previous value's restore. */
export function setAppInstallDirs(dirs: readonly string[]): () => void {
  const before = current;
  current = [...dirs];
  return () => { current = before; };
}
