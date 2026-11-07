// Where an installed build's bundled plugins are (the registry's `bundledDirs`), and only when that folder can be
// trusted: the registry approves bundled plugins without a card, so whatever this returns is trusted code (#259 check
// 2, the controller's ruling). The folder is `<dirname(realpath(clover-core))>/../plugins` in one of two layouts:
//   - an app: `…/resources/daemon/clover-core` → `…/resources/plugins` (scripts/release/bundled-plugins.ts);
//   - a server (#244): `<cloverHome>/bin/daemon/clover-core` → `<cloverHome>/bin/plugins`.
// and only when the layout proves it is the installer's:
//   - every OS: the binary's REAL path decides (a symlink to the core, or a copy of it, proves nothing by its name);
//   - macOS: the enclosing Clover.app passes a strict code-signature check, its resource seal included (which covers
//     Contents/Resources/plugins), against Clover's identifier and team. An unsigned or dev build gets none (lane B
//     settles the dev layout);
//   - Linux: every folder from / down to resources/plugins is root's and writable by no one else (the packages'
//     /opt/Clover), or the folder is on a read-only mount (an AppImage's);
//   - Windows: as laid out (within a user there is no binary-trust boundary to keep);
//   - a server: its folder is the user's to write, so it counts only when each file matches the plugins tarball's
//     manifest from the signed release feed (#244 supplies `verifyServerPlugins`); a mismatch gives none and an error.
// Anything else (a dev checkout, plain `bun`, the old `<cloverHome>/bin/clover-core` layout, a copied core in a
// foreign `resources/`) has none. A server's `<cloverHome>/plugins`, the user's own folder, is never bundled.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CLOVER_TEAM_ID } from "./auth/app-token-acl";

/** The app's bundle identifier (apps/desktop/electron-builder.yml's appId). */
export const CLOVER_APP_IDENTIFIER = "com.waifucave.clover";

/** The code requirement Clover.app must satisfy: its identifier, signed by Apple's Developer ID chain for Clover's team. */
export const CLOVER_APP_REQUIREMENT = `identifier "${CLOVER_APP_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`;

export interface BundledPluginsDirOptions {
  cloverHome?: string;
  platform?: NodeJS.Platform;
  realpath?: (p: string) => string;
  /** macOS: whether the app at this path passes `codesign --verify --strict` (resource seal included) against
   *  CLOVER_APP_REQUIREMENT. */
  verifyMacApp?: (app: string) => boolean;
  /** Linux: whether `dir` is root's and unwritable by anyone else all the way up, or on a read-only mount. */
  linuxTrusted?: (dir: string) => boolean;
  /** A server's folder: whether each file matches the signed release feed's plugins manifest (#244). None: never. */
  verifyServerPlugins?: (dir: string) => boolean;
  log?: (line: string) => void;
}

/** The bundled plugins folder for the core at `execPath`, or undefined when there is none it can trust. */
export function bundledPluginsDir(execPath: string, o: BundledPluginsDirOptions = {}): string | undefined {
  const platform = o.platform ?? process.platform;
  let real: string;
  try {
    real = (o.realpath ?? realpathSync)(execPath);
  } catch {
    return undefined;
  }
  const daemonDir = resolve(dirname(real));
  if (basename(daemonDir) !== "daemon") return undefined;
  const parent = dirname(daemonDir);
  const dir = join(parent, "plugins");
  const home = o.cloverHome === undefined ? undefined : resolve(o.cloverHome);
  // Never the user's own plugins folder.
  if (home !== undefined && dir === join(home, "plugins")) return undefined;

  if (home !== undefined && parent === join(home, "bin")) {
    // A server: user-writable by design, so only what the signed feed vouches for.
    if (o.verifyServerPlugins?.(dir) === true) return dir;
    o.log?.(`bundled plugins: ${dir} doesn't match the signed release's plugins manifest (or none was checked): no bundled plugins`);
    return undefined;
  }
  if (basename(parent).toLowerCase() !== "resources") return undefined;

  if (platform === "darwin") {
    // …/Clover.app/Contents/Resources/daemon/clover-core
    const contents = dirname(parent);
    const app = dirname(contents);
    if (basename(contents) !== "Contents" || !app.endsWith(".app")) return undefined;
    if (!(o.verifyMacApp ?? verifyMacAppSignature)(app)) {
      o.log?.(`bundled plugins: ${app} doesn't pass Clover's code-signature check: no bundled plugins`);
      return undefined;
    }
    return dir;
  }
  if (platform === "linux") {
    if (!(o.linuxTrusted ?? linuxFolderTrusted)(dir)) {
      o.log?.(`bundled plugins: ${dir} isn't root's and read-only to everyone else, nor on a read-only mount: no bundled plugins`);
      return undefined;
    }
    return dir;
  }
  if (platform === "win32") return dir;
  return undefined;
}

/** `codesign --verify --strict` of the whole app (its resource seal included) against Clover's requirement. */
export function verifyMacAppSignature(app: string): boolean {
  const r = spawnSync("/usr/bin/codesign", ["--verify", "--strict", `-R=${CLOVER_APP_REQUIREMENT}`, app], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0;
}

/** Linux: every folder from / down to `dir` is root's with no group or other write (a package's /opt/Clover), or
 *  `dir` is on a read-only mount (an AppImage's squashfs). */
export function linuxFolderTrusted(dir: string, stat: (p: string) => { uid: number; mode: number; isDir: boolean; isLink: boolean } = (p) => {
  const s = lstatSync(p);
  return { uid: s.uid, mode: s.mode, isDir: s.isDirectory(), isLink: s.isSymbolicLink() };
}, mountinfo: () => string = () => readFileSync("/proc/self/mountinfo", "utf8")): boolean {
  if (onReadOnlyMount(dir, mountinfo)) return true;
  const parts = resolve(dir).split(sep).filter((p) => p !== "");
  for (let i = 0; i <= parts.length; i++) {
    const p = sep + parts.slice(0, i).join(sep);
    let s: ReturnType<typeof stat>;
    try {
      s = stat(p);
    } catch {
      return false;
    }
    if (s.isLink || !s.isDir || s.uid !== 0 || (s.mode & 0o022) !== 0) return false;
  }
  return true;
}

/** Whether `dir` lies on a mount whose options include `ro` (/proc/self/mountinfo: field 5 the mount point, field 6
 *  its options); the deepest mount containing it decides. */
export function onReadOnlyMount(dir: string, mountinfo: () => string): boolean {
  let text: string;
  try {
    text = mountinfo();
  } catch {
    return false;
  }
  const target = resolve(dir);
  let best: { point: string; ro: boolean } | undefined;
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f.length < 6) continue;
    const point = f[4]!.replace(/\\040/g, " ");
    if (target !== point && !target.startsWith(point === "/" ? "/" : `${point}/`)) continue;
    if (best === undefined || point.length > best.point.length) best = { point, ro: f[5]!.split(",").includes("ro") };
  }
  return best?.ro === true;
}
