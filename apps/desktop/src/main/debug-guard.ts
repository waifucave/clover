// The daemon accepts an `app` connection only from the code-signed app. A process that launches that signed app with a
// debugging switch could drive its renderer and the preload bridge, going around the signature. So the app refuses to
// start with one, before any window or daemon connection (the packaged app always; the dev app only behind
// CLOVER_DEV_DEBUG=1, never in a packaged build).
//
// `--enable-logging` and `--v` do not expose secrets: Chromium's log lines carry its own diagnostics, not page content,
// cookies or headers, and the app logs no secret. `--log-net-log` and `--net-log-capture-mode` do (a net log records
// request and response headers, cookies and Authorization), so the packaged app refuses those too.

/** Switches that open a debugging door into the renderer or the main process. */
export const DEBUG_SWITCHES: readonly string[] = [
  "remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address",
  "inspect", "inspect-brk", "inspect-port", "inspect-wait", "inspect-publish-uid", "debug", "debug-brk", "debug-port",
];

/** Switches that write a request's secrets to disk; refused in the packaged app only. */
export const SECRET_LOG_SWITCHES: readonly string[] = ["log-net-log", "net-log-capture-mode"];

/** The file the packaged-app UI test drops into the app's resources beside its fake daemon. The release build has no
 *  such file, and adding one to a signed app breaks its signature, so the daemon would refuse that app's connection. */
export const TEST_BUILD_MARKER = "clover-test-build";

/** The name of a `--name`, `--name=value` argument, else undefined. */
function switchName(arg: string): string | undefined {
  if (!arg.startsWith("--")) return undefined;
  const eq = arg.indexOf("=");
  return (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
}

/** The refused switches among the arguments and Chromium's command line (empty: start). `hasSwitch` is
 *  `app.commandLine.hasSwitch`; the argv scan covers the `--inspect*` forms Node reads before Electron does. */
export function refusedLaunchSwitches(input: {
  argv: readonly string[];
  hasSwitch: (name: string) => boolean;
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** The marker file is in the app's resources (a test build): with `CLOVER_TEST_NETLOG=1` it lets the packaged app
   *  take the net-log switches the UI test asserts on. Never the debugging switches. */
  testBuild?: boolean;
}): string[] {
  // The dev app may debug, on an explicit opt-in; a packaged app never reads the opt-in at all.
  if (!input.packaged && input.env.CLOVER_DEV_DEBUG === "1") return [];
  const netLogOk = input.testBuild === true && input.env.CLOVER_TEST_NETLOG === "1";
  const names = input.packaged && !netLogOk ? [...DEBUG_SWITCHES, ...SECRET_LOG_SWITCHES] : [...DEBUG_SWITCHES];
  const found = new Set<string>();
  for (const arg of input.argv) {
    const n = switchName(arg);
    if (n !== undefined && names.includes(n)) found.add(n);
  }
  for (const n of names) {
    let has = false;
    try { has = input.hasSwitch(n); } catch { /* an unreadable command line is not a switch */ }
    if (has) found.add(n);
  }
  return [...found].sort();
}
