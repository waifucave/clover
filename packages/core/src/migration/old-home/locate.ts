// Where the old install's home is, for the one-time copy (spec §12, item 125): THE ONE function that answers it, so
// nothing else in the core names the old home as a place to read.
//
//   * The real profile only: the dist profile, on its own default home (`~/.moss`, by `isDefaultMossHome`), in a build
//     that isn't test-marked. Then the old home is the installed old app's home under the user's home
//     (`other-installs.ts`, the one place that spells it).
//   * A dev profile, a custom or temp home, an engine run from source (not a shipped build, whatever its profile and
//     home), or a test-marked build, with no override: no old home. Nothing is offered,
//     and nothing of the old install is read (not even whether it exists).
//   * The override `MOSS_OLD_HOME` names a fixture for tests and the acceptance run (the same kind of seam as
//     `MOSS_HOME` for the home). A release build that isn't test-marked ignores it, saying so once: anything that
//     starts the engine could otherwise point the copy at a folder of its choosing.
import { homedir as realHomedir } from "node:os";
import { join, resolve } from "node:path";
import { DIST_BUILD, noteIgnoredEnvOverride } from "../../build-kind";
import { isDefaultMossHome } from "../../moss-dir";
import { OLD_INSTALL_HOME_DIR } from "../../other-installs";
import type { MossProfile } from "../../profile";

declare const __MOSS_TEST_BUILD__: string | false | undefined;

/** The override for tests and the acceptance run (honoured by a source, dev or test-marked build only). */
export const OLD_HOME_ENV = "MOSS_OLD_HOME";

export interface OldHomeQuery {
  /** The home this engine runs on. */
  home: string;
  profile: MossProfile;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  /** Seams for the tests of this function alone; the daemon never passes them. */
  distBuild?: boolean;
  testBuild?: boolean;
  log?: (line: string) => void;
}

export type OldHome = { path: string; via: "override" | "default" } | { path: undefined; why: string };

/** The old install's home to offer, or why there is none (see the file's header). */
export function oldHomeFor(q: OldHomeQuery): OldHome {
  const env = q.env ?? process.env;
  const dist = q.distBuild ?? DIST_BUILD;
  const testBuild = q.testBuild ?? typeof __MOSS_TEST_BUILD__ === "string";
  const override = env[OLD_HOME_ENV];
  if (override !== undefined && override !== "") {
    if (!dist || testBuild) {
      const path = resolve(override);
      if (path === resolve(q.home)) return { path: undefined, why: `${OLD_HOME_ENV} names this engine's own home` };
      return { path, via: "override" };
    }
    noteIgnoredEnvOverride(OLD_HOME_ENV, q.log);
  }
  if (testBuild) return { path: undefined, why: "this build reads no old home without the override (it is marked for tests)" };
  // A source run (a checkout's engine, not a shipped one) reads nothing without the override, even on the real
  // profile's default home: only a shipped engine finds the old home by itself.
  if (!dist) return { path: undefined, why: "an engine run from source reads no old home without the override" };
  if (q.profile !== "dist") return { path: undefined, why: "only the real profile is offered the old home" };
  const homedir = q.homedir ?? realHomedir;
  if (!isDefaultMossHome(q.home, "dist", homedir)) return { path: undefined, why: "this engine runs on a home of its own (not the profile's default)" };
  return { path: join(homedir(), OLD_INSTALL_HOME_DIR), via: "default" };
}
