// The other installs that share this machine with MOSS, named in ONE place so every guard refuses them by the same
// names: the live Winter install (spec §2: it keeps running beside MOSS until the hand-over), its dev profile, the
// legacy install kept as the rollback source (`legacy-names.ts`), and the installed Clover app (this product's previous
// name: its app bundle, its home folder, its launch agent and Keychain service, which stay in use until the owner
// hands over). A MOSS daemon, the dev scripts and the tests
// never run on, read or write any of these homes or Keychain services. MOSS's own names are in `profile.ts` and
// `moss-dir.ts`.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, sep, win32 } from "node:path";
import { LEGACY_DEV_HOME_DIR, LEGACY_HOME_DIR, LEGACY_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE_DEV } from "./legacy-names";

/** The installed Clover app's home folder, and its dev profile's: the app this one replaces, kept running beside it. */
export const CLOVER_HOME_DIR = ".clover";
export const CLOVER_DEV_HOME_DIR = ".clover-dev";
/** The installed Clover app's Keychain service (also its launch agent's label), and its dev profile's. */
export const CLOVER_KEYCHAIN_SERVICE = "com.waifucave.clover.core";
export const CLOVER_DEV_KEYCHAIN_SERVICE = "com.waifucave.clover.core.dev";

/** The same names under neutral identifiers, for the one-time copy (`migration/old-home/`), which reads the old home
 *  and its login item, never writes them: the old home's and its dev profile's folder names, the old engine's login
 *  item label (its Keychain service's name, which the copy never opens as a service), and the app's name as a person
 *  says it. */
export const OLD_INSTALL_HOME_DIR = CLOVER_HOME_DIR;
export const OLD_INSTALL_DEV_HOME_DIR = CLOVER_DEV_HOME_DIR;
export const OLD_INSTALL_LOGIN_LABEL = CLOVER_KEYCHAIN_SERVICE;
export const OLD_APP_NAME = "Clover";

/** The live Winter install's home folder, under the user's home. */
export const WINTER_HOME_DIR = ".winter";
/** Winter Dev's home folder. */
export const WINTER_DEV_HOME_DIR = ".winter-dev";
/** The live Winter install's Keychain service, and Winter Dev's. */
export const WINTER_KEYCHAIN_SERVICE = "com.winter.core";
export const WINTER_DEV_KEYCHAIN_SERVICE = "com.winter.core.dev";

/** The homes, by folder name under the user's home, and what each is. */
export const OTHER_INSTALL_HOMES: readonly { dir: string; what: string }[] = [
  { dir: WINTER_HOME_DIR, what: "the live Winter install's home" },
  { dir: WINTER_DEV_HOME_DIR, what: "Winter Dev's home" },
  { dir: LEGACY_HOME_DIR, what: "the legacy install's home (the rollback source)" },
  { dir: LEGACY_DEV_HOME_DIR, what: "the legacy dev home (the rollback source)" },
  { dir: CLOVER_HOME_DIR, what: "the installed Clover app's home" },
  { dir: CLOVER_DEV_HOME_DIR, what: "Clover Dev's home" },
];

/** The installed Clover app's data folders (Electron's userData, named after its product name), its own and Clover
 *  Dev's, under the OS's app-data folder. */
export const OTHER_INSTALL_APP_DATA_DIRS: readonly string[] = ["Clover", "Clover Dev"];

/** Every other install's home and the old app's data folders, under the user's home `home` in `os`'s own form: what
 *  the fence holds write-denied for every tool runner (bots, agents, plugins and sandboxed commands), as places a
 *  file written now is run later by another install, outside MOSS's sandbox (`fence/run-later.ts`). Reading them stays
 *  open. */
export function otherInstallPlaces(os: "macos" | "linux" | "windows", home: string): string[] {
  const p = os === "windows" ? win32 : posix;
  const appData = os === "macos" ? p.join(home, "Library", "Application Support") : os === "windows" ? p.join(home, "AppData", "Roaming") : p.join(home, ".config");
  return [...OTHER_INSTALL_HOMES.map((o) => p.join(home, o.dir)), ...OTHER_INSTALL_APP_DATA_DIRS.map((d) => p.join(appData, d))];
}

/** Their Keychain services, and what each is: a MOSS daemon, script or test never reads or writes one. */
export const OTHER_INSTALL_KEYCHAIN_SERVICES: readonly { service: string; what: string }[] = [
  { service: WINTER_KEYCHAIN_SERVICE, what: "the live Winter install's Keychain service" },
  { service: WINTER_DEV_KEYCHAIN_SERVICE, what: "Winter Dev's Keychain service" },
  { service: LEGACY_KEYCHAIN_SERVICE, what: "the legacy install's Keychain service (the rollback source)" },
  { service: LEGACY_KEYCHAIN_SERVICE_DEV, what: "the legacy dev Keychain service (the rollback source)" },
  { service: CLOVER_KEYCHAIN_SERVICE, what: "the installed Clover app's Keychain service" },
  { service: CLOVER_DEV_KEYCHAIN_SERVICE, what: "Clover Dev's Keychain service" },
];

export class OtherInstallHomeRefused extends Error {
  readonly code = "other_install_home";
  constructor(public readonly home: string, public readonly what: string) {
    super(`refusing to use ${home} as a MOSS home: it is ${what}, which MOSS never touches`);
    this.name = "OtherInstallHomeRefused";
  }
}

/** `path`'s real path, through its nearest existing parent when it does not exist yet. */
export function realPathOf(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** Whether `path` (by real path) is `root` or inside it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The other install whose home `home` is, or is inside, by real path — or `undefined` when it is none of them. Each
 *  home is matched where it sits under the user's home AND where it leads: an install whose home is itself a link
 *  (say Winter Dev's, moved to an external drive) is refused by its link and by its target alike. */
export function otherInstallHome(home: string, userHome: string = homedir()): { dir: string; what: string } | undefined {
  const real = realPathOf(home);
  const user = realPathOf(userHome);
  return OTHER_INSTALL_HOMES.find((o) => within(real, join(user, o.dir)) || within(real, realPathOf(join(user, o.dir))));
}

/** Throws `OtherInstallHomeRefused` when `home` is another install's home (see `otherInstallHome`). */
export function assertNotOtherInstallHome(home: string, userHome?: string): void {
  const hit = otherInstallHome(home, userHome);
  if (hit !== undefined) throw new OtherInstallHomeRefused(home, hit.what);
}
