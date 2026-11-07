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

import { existsSync } from "node:fs";

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

/** The variables that change whom the core's TLS trusts: turning verification off, or adding certificate authorities.
 *  With a proxy (`HTTPS_PROXY`, which stays allowed: without a trusted CA it can't read TLS) either would let whoever
 *  starts the binary read provider keys and sign-in tokens off the wire. */
export const TLS_TRUST_ENV = ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

/** Why a dist build refuses to start with this environment, or undefined. `NODE_TLS_REJECT_UNAUTHORIZED` refuses only
 *  when it turns verification off (`0`); the others whenever set. Dev and test builds never refuse. */
export function tlsEnvRefusal(env: Record<string, string | undefined>, distBuild: boolean = DIST_BUILD): string | undefined {
  if (!distBuild) return undefined;
  const set = TLS_TRUST_ENV.filter((k) => (k === "NODE_TLS_REJECT_UNAUTHORIZED" ? env[k] === "0" : env[k] !== undefined && env[k] !== ""));
  if (set.length === 0) return undefined;
  return `clover-core: refusing to start: ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set, which would change whom this process's TLS trusts. A release build takes no certificate authority or verification setting from its environment; unset ${set.length === 1 ? "it" : "them"} (a proxy, HTTPS_PROXY, is fine).`;
}

/** The exit code of that refusal (`EX_CONFIG`). */
export const TLS_ENV_REFUSAL_EXIT = 78;

/** The process holder lane A's F8 runs a bot's commands under (macOS): `clover-process-holder` beside the core. */
export const PROCESS_HOLDER_FILE = "clover-process-holder";

/** The holder's expected path when a compiled macOS core lacks it, else undefined (not macOS, not compiled, or there). */
export function missingProcessHolder(o: { platform?: NodeJS.Platform; compiled?: boolean; execPath?: string; exists?: (p: string) => boolean } = {}): string | undefined {
  if ((o.platform ?? process.platform) !== "darwin" || !(o.compiled ?? isCompiledBinary())) return undefined;
  const execPath = o.execPath ?? process.execPath;
  const path = `${execPath.slice(0, execPath.lastIndexOf("/"))}/${PROCESS_HOLDER_FILE}`;
  return (o.exists ?? existsSync)(path) ? undefined : path;
}
