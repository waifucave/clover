// MOSS refuses to start with a debugging switch (spec §3.1 "The apps' peer image"): the engine takes an `app` hello only
// from the signed program, and a process that starts that program with Chromium's remote-debugging switches, or Node's
// inspector, could drive its window and its preload's bridge, going around the signature. MOSS's own copy of MOSS Code's
// rule (apps/desktop/src/main/debug-guard.ts): the packaged app never; the dev app only on an explicit `MOSS_DEV_DEBUG=1`;
// a test-marked build asking for its DevTools port (`MOSS_TEST_DEBUG=1`, the acceptance run's) takes
// `--remote-debugging-port` alone (on 127.0.0.1: no address switch is taken), never the pipe or the inspector.
// Pure (no Electron import), so the tests drive it under Bun.

/** Switches that open a debugging door into the window or the main process. */
export const DEBUG_SWITCHES: readonly string[] = [
  "remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address",
  "inspect", "inspect-brk", "inspect-port", "inspect-wait", "inspect-publish-uid", "debug", "debug-brk", "debug-port",
];

/** Switches that write a request's secrets to disk (a net log keeps headers and cookies); refused in a packaged app. */
export const SECRET_LOG_SWITCHES: readonly string[] = ["log-net-log", "net-log-capture-mode"];

function switchName(arg: string): string | undefined {
  if (!arg.startsWith("--")) return undefined;
  const eq = arg.indexOf("=");
  return (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
}

/** The refused switches among the arguments and Chromium's command line; empty means start. */
export function refusedLaunchSwitches(input: {
  argv: readonly string[];
  hasSwitch: (name: string) => boolean;
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** A test-marked build (the compile-time label, tested by the caller) whose run asked for its DevTools port. */
  testDebug?: boolean;
}): string[] {
  if (!input.packaged && input.env.MOSS_DEV_DEBUG === "1") return [];
  const base = input.packaged ? [...DEBUG_SWITCHES, ...SECRET_LOG_SWITCHES] : [...DEBUG_SWITCHES];
  const names = input.testDebug === true ? base.filter((n) => n !== "remote-debugging-port") : base;
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
