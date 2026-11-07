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

/** The variables that change whom the core's TLS trusts: turning verification off, or adding certificate authorities.
 *  With a proxy (`HTTPS_PROXY`, which stays allowed: without a trusted CA it can't read TLS) either would let whoever
 *  starts the binary read provider keys and sign-in tokens off the wire. */
export const TLS_TRUST_ENV = ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;

/**
 * Why a dist build refuses to start with this environment, or undefined. A CA variable refuses whenever it is PRESENT,
 * an empty value included: native code (Bun's CA loading) reads the FIRST of duplicate entries while `process.env`
 * shows the last, so `[NODE_EXTRA_CA_CERTS=<CA>, NODE_EXTRA_CA_CERTS=]` looked unset to JS and still added the CA
 * (#243 check 2, measured). `raw` is the process's environment as the kernel handed it (startup-guard.ts's
 * `rawEnvironment`), every entry, duplicates and all: any entry naming a CA variable, or turning verification off,
 * refuses. `NODE_TLS_REJECT_UNAUTHORIZED` refuses in any entry whose value isn't `1` (its default, verification on), so no
 * spelling of "off" a runtime might accept gets through. Dev and test builds never refuse.
 */
export function tlsEnvRefusal(env: Record<string, string | undefined>, distBuild: boolean = DIST_BUILD, raw: readonly string[] = []): string | undefined {
  if (!distBuild) return undefined;
  const set = new Set<string>();
  for (const k of TLS_TRUST_ENV) {
    // `!== undefined`, not `in`: Bun's process.env answers `in` true for NODE_TLS_REJECT_UNAUTHORIZED unset (measured).
    const v = env[k];
    if (v !== undefined && (k !== "NODE_TLS_REJECT_UNAUTHORIZED" || v !== "1")) set.add(k);
  }
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    const k = eq === -1 ? entry : entry.slice(0, eq);
    if (!(TLS_TRUST_ENV as readonly string[]).includes(k)) continue;
    if (k !== "NODE_TLS_REJECT_UNAUTHORIZED" || eq === -1 || entry.slice(eq + 1) !== "1") set.add(k);
  }
  if (set.size === 0) return undefined;
  const names = TLS_TRUST_ENV.filter((k) => set.has(k));
  return `clover-core: refusing to start: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} set, which would change whom this process's TLS trusts. A release build takes no certificate authority or verification setting from its environment; unset ${names.length === 1 ? "it" : "them"} (a proxy, HTTPS_PROXY, is fine; corporate CAs come from the OS's own store).`;
}

/** The exit code of that refusal (`EX_CONFIG`). */
export const TLS_ENV_REFUSAL_EXIT = 78;
