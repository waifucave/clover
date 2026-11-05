// The other installs that share this machine with Clover, named in ONE place so every guard refuses them by the same
// names: the live Winter install (spec §2: it keeps running beside Clover until the hand-over), its dev profile, and
// the legacy install kept as the rollback source (`legacy-names.ts`). A Clover daemon, the dev scripts and the tests
// never run on, read or write any of these homes or Keychain services. Clover's own names are in `profile.ts` and
// `clover-dir.ts`.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { LEGACY_DEV_HOME_DIR, LEGACY_HOME_DIR, LEGACY_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE_DEV } from "./legacy-names";

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
];

/** Their Keychain services, and what each is: a Clover daemon, script or test never reads or writes one. */
export const OTHER_INSTALL_KEYCHAIN_SERVICES: readonly { service: string; what: string }[] = [
  { service: WINTER_KEYCHAIN_SERVICE, what: "the live Winter install's Keychain service" },
  { service: WINTER_DEV_KEYCHAIN_SERVICE, what: "Winter Dev's Keychain service" },
  { service: LEGACY_KEYCHAIN_SERVICE, what: "the legacy install's Keychain service (the rollback source)" },
  { service: LEGACY_KEYCHAIN_SERVICE_DEV, what: "the legacy dev Keychain service (the rollback source)" },
];

export class OtherInstallHomeRefused extends Error {
  readonly code = "other_install_home";
  constructor(public readonly home: string, public readonly what: string) {
    super(`refusing to use ${home} as a Clover home: it is ${what}, which Clover never touches`);
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
