// The Clover Browser where no app runs (spec §12.1): Chrome for Testing's headless shell, pinned and installed failing
// closed, driven over the DevTools pipe as an `AppTabPort`, so the core's `BrowserService` drives it as it drives the
// app. The daemon makes one when no app runs on this computer (lane L's lead wires it):
//
//   const network = new NetworkFilter();
//   const headless = new HeadlessBrowser({ dir: join(home, "browser"), computer, network, report: (events) => service.report(events),
//     streamData: (stream, chunk) => link.streamChunk(stream, chunk), log });
//   const service = new BrowserService({ computer, app: () => appPort ?? headless, … });
//   // on a policy change (a per-bot LAN setting): await headless.refreshPolicies();
//   // on quit: await headless.shutdown(); await network.close();
export { HeadlessBrowser, DENIED_PERMISSIONS, screencastSettings, type HeadlessBrowserOptions } from "./browser";
export { CdpError, PipeConnection, splitFrames, type BrowserProcess, type CdpConnection, type CdpEvent, type PipeTransport } from "./cdp";
export { DISABLED_FEATURES, browserEnv, headlessArgs, profileDir, profileName, windowsBrowserDirs, windowsBrowserEnv } from "./flags";
export { imageSize } from "./image";
export {
  CFT_BASE, HEADLESS_PIN, InstallError, pinFrom, archiveUrl, binaryIn, cftPlatform, installDirFor, installHeadlessShell, treeDigestOfArchive,
  stageForLaunch, tightenTree, treeDigestOfDir, type StagedLaunch, type HeadlessShellPins, type HeadlessPin, type InstallOptions, type Installed, type PlatformPin,
} from "./install";
export { launchHeadlessShell, type LaunchSpec, type Launcher } from "./launch";
export { quoteWindowsArg, windowsEnvBlock } from "./winpipe";
