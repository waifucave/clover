// Which build this process is, decided when it was built, never by its environment.
//
// `scripts/build-daemon.ts` (the binary every release, package and self-update ships) compiles with
// `--define __CLOVER_DIST__=true`. Every other build leaves it out: the dev daemon (`scripts/dev-daemon.ts`,
// `dist/dev/clover-core`), the `verify:*` gates' `compile:core`, and the core run from source under `bun`. A dist
// build ignores what the environment says about which programs to run (the runtime ladder's
// `CLOVER_RUNTIME_EXECUTABLE` and `CLOVER_ANT_EXECUTABLE`): anything that can start `clover-core` could otherwise
// hand its sessions to a program of its choosing. Dev and test builds keep those overrides, which is how a local
// runtime build is tried.
//
// `typeof` keeps an undefined identifier from throwing; with the define, Bun folds the whole expression to `true`.

declare const __CLOVER_DIST__: boolean | undefined;

/** True only in the binary `scripts/build-daemon.ts` makes. */
export const DIST_BUILD: boolean = typeof __CLOVER_DIST__ !== "undefined" && __CLOVER_DIST__ === true;

/** The define `scripts/build-daemon.ts` passes to every `bun build` step of `compile:core`. */
export const DIST_BUILD_DEFINE = "__CLOVER_DIST__=true";

/** True inside a `bun build --compile` binary, whose modules live under `/$bunfs/` (`B:/~BUN/` on Windows). */
export function isCompiledBinary(main: string = typeof Bun !== "undefined" ? Bun.main : ""): boolean {
  return main.startsWith("/$bunfs/") || main.includes("$bunfs") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main);
}

const ignoredOnce = new Set<string>();

/** One log line per variable per process: a dist build ignored an environment override. */
export function noteIgnoredEnvOverride(name: string, log: (line: string) => void = (l) => console.error(l)): void {
  if (ignoredOnce.has(name)) return;
  ignoredOnce.add(name);
  log(`clover-core: ignoring ${name}: a release build runs only the programs it ships or its settings name`);
}
