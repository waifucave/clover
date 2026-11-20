// One release for everything, as a person sees it (spec §3.1; RL). Two rows, each over a daemon and an app of the TEST builds
// whose version stamps the run sets (`MOSS_TEST_ENGINE_RELEASE` for the engine, `MOSS_TEST_APP_RELEASE` for the app; a release
// build reads neither), so no real update is fetched and no real engine is installed:
//   * BEHIND: an app on an older release than the engine updates itself before it connects. Its window says it is installing
//     the update (the test build's stand-in outcome `ready:<release>` installs nothing); and, with the stand-in offline, says
//     plainly that it cannot reach the update server, and the engine hears from it once and never again.
//   * AHEAD: an app newer than the engine, with a turn still running: its window says a newer MOSS Code waits for work to finish
//     (one running), and "Switch now" is in the window; pressed, the engine is asked to switch at once (`release.bring` with
//     `now`), which the app logs as it switching. The app's bundle is a stand-in folder the run makes (the test core takes it for
//     the code requirement and still checks its `--version`), so the engine is placed in the run's temp home; what is NOT proven
//     here is the signature check on a real signed build: that is the signed build's packaged run, on the Mac.
//   * INSTALL (EI): the engine the app's own install puts in the home runs the plugin code. The packaged bundle's `moss-core engine
//     install --app <bundle>` (what an app runs before it starts the login item) places the engine and every file beside it
//     (`engineSidecars`) in the run's temp home, the engine is started from there (`<home>/bin/daemon/moss-core`, as the login item
//     does), and a bundled plugin's MCP tool is listed and called, the process holder and the link sidecar are found. Every other
//     row runs a COPY of the whole bundle's `daemon/` folder (`packagedCore`), where the sidecars are always beside the engine: no
//     row saw an engine that had been placed without them, which is why this one installs the way the apps do. The code check is the
//     real one (the twin is signed with the Developer ID): each file against its own requirement.
export const RELEASE_INSTALL_STEP = "release: the engine an app's install places in the home runs the plugin code: every file beside it is placed and checked, a bundled plugin's tool is listed and called, the process holder and the link sidecar are found";
export const RELEASE_BEHIND_STEP = "release: an app older than the engine updates itself before it connects: its window says it is installing the update, and offline says plainly it can't reach the update server and doesn't connect";
export const RELEASE_AHEAD_STEP = "release: a newer app waits for the engine's work to finish and says so in its window, and Switch now asks the engine to switch at once";

/** The stamps: the engine is ahead of the older app, and behind the newer one. */
export const ENGINE_NEWER = "9.0.0";
export const APP_OLDER = "1.0.0";
export const ENGINE_OLDER = "1.0.0";
export const APP_NEWER = "9.0.0";

/** The words the window shows (apps/desktop core-strings.ts `moss.core.release.*`), the parts a row looks for. */
export const WORDS = {
  installing: "Installing MOSS Code",
  offline: "can't reach the update server",
  waiting: "waiting for work to finish",
  switchNow: "Switch now",
} as const;
