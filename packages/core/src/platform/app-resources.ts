// The app's resources folder (C-M3 item 5; the #259 review): the bundled plugins ship there (Clover.app/Contents/
// Resources/plugins, <install>\resources\plugins, /opt/Clover/resources/plugins) and are approved without a card, and
// the daemon and its sidecar sit in its `daemon/` folder. A drag-installed app is the user's to write, so a write tool or
// an escape command could change a bundled plugin, which would then run as trusted code. The folder is fenced like
// `runtimes`: in the Bash sandbox's `denyWrite`, refused by the escape floor on any mention, and denied to the write
// tools (`selfGrantDenyWrite`, `controlPlaneDenyRules`), and write-denied in Clover's own fence (`plugins`).
//
// It is found from the daemon's own binary, never from the environment: a compiled daemon at
// `<resources>/daemon/clover-core` (links resolved) has `<resources>` as its resources folder. A daemon run from source,
// or a compiled one anywhere else (a server's `<home>/bin`, which is fenced on its own), has none.
import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isCompiledBinary } from "../build-kind";

/** The resources folder of the daemon at `execPath`, or undefined. */
export function appResourcesDirFor(
  execPath: string, compiled: boolean, platform: NodeJS.Platform = process.platform, realpath: (p: string) => string = realpathSync,
): string | undefined {
  if (!compiled) return undefined;
  const path = platform === "win32" ? win32 : posix;
  let real: string;
  try { real = realpath(execPath); } catch { return undefined; }
  const daemonDir = path.dirname(real);
  if (path.basename(daemonDir).toLowerCase() !== "daemon") return undefined;
  const resources = path.dirname(daemonDir);
  return path.basename(resources).toLowerCase() === "resources" ? resources : undefined;
}

let current: readonly string[] | undefined;

/** The resources folders the fences hold: this daemon's own, found once. */
export function appResourcesDirs(): readonly string[] {
  if (current === undefined) {
    const dir = appResourcesDirFor(process.execPath, isCompiledBinary());
    current = dir === undefined ? [] : [dir];
  }
  return current;
}

/** Sets them (tests); gives back the previous value's restore. */
export function setAppResourcesDirs(dirs: readonly string[]): () => void {
  const before = current;
  current = [...dirs];
  return () => { current = before; };
}
