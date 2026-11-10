// What a release build checks before anything else runs (packages/cli/src/main.ts, first thing): the environment it
// was started with can't choose whom its TLS trusts (build-kind.ts's `tlsEnvRefusal`), and on macOS can't choose its
// keychains. Both refuse with exit 78 (`EX_CONFIG`).
//
// HOME on macOS (#243 checks 2 and 3): the Security framework takes the user's keychain search list and the user trust
// settings from `$HOME/Library/Keychains`. Clover's own items are read and written in the login keychain opened by
// path (auth/login-keychain.ts, `<pw_dir>/Library/Keychains/login.keychain-db`), so no search list, HOME's or a
// reordered one, chooses which item is read. This refusal still guards what a path can't: the trust settings
// `--use-system-ca` honours, and anything else that reads HOME. A set HOME must be the account's own home
// (`getpwuid(getuid())->pw_dir`, compared by real path). An unset HOME is fine: Security then uses the password
// database's home itself.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { TEST_KEYCHAIN_ENV, UNDER_TEST_ENV } from "./auth/test-isolation";
import { DIST_BUILD } from "./build-kind";

/** The process's environment exactly as it was handed over (every entry, duplicates and `=`-led ones included), or
 *  undefined where it can't be read (Windows). macOS: `_NSGetEnviron()` through bun:ffi; Linux: /proc/self/environ. */
export function rawEnvironment(platform: NodeJS.Platform = process.platform): string[] | undefined {
  try {
    if (platform === "linux") {
      if (!existsSync("/proc/self/environ")) return undefined;
      return readFileSync("/proc/self/environ", "latin1").split("\0").filter((e) => e !== "");
    }
    if (platform === "darwin") {
      const { dlopen, FFIType, read, CString } = require("bun:ffi") as typeof import("bun:ffi");
      const lib = dlopen("/usr/lib/libSystem.B.dylib", { _NSGetEnviron: { args: [], returns: FFIType.ptr } });
      try {
        const envp = read.ptr(lib.symbols._NSGetEnviron()!, 0);
        const out: string[] = [];
        for (let i = 0; i < 100_000; i++) {
          const p = read.ptr(envp as never, i * 8);
          if (!p) break;
          out.push(new CString(p as never).toString());
        }
        return out;
      } finally {
        lib.close();
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The account's own home from the password database (`getpwuid(getuid())->pw_dir`), never from HOME. macOS only. */
export function accountHome(): string | undefined {
  try {
    const { dlopen, FFIType, read, CString } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", { getuid: { args: [], returns: FFIType.u32 }, getpwuid: { args: [FFIType.u32], returns: FFIType.ptr } });
    try {
      const pw = lib.symbols.getpwuid(lib.symbols.getuid());
      if (!pw) return undefined;
      // `struct passwd`'s pw_dir on Darwin (64-bit): after pw_name, pw_passwd, pw_uid, pw_gid, pw_change, pw_class,
      // pw_gecos — offset 48 (offsetof, measured).
      const dir = read.ptr(pw, 48);
      return dir ? new CString(dir as never).toString() : undefined;
    } finally {
      lib.close();
    }
  } catch {
    return undefined;
  }
}

/** Why a macOS release refuses this HOME, or undefined: set, and not the account's own home by real path. */
export function homeRefusal(o: { platform?: NodeJS.Platform; distBuild?: boolean; home?: string | undefined; account?: () => string | undefined; real?: (p: string) => string } = {}): string | undefined {
  if ((o.platform ?? process.platform) !== "darwin" || !(o.distBuild ?? DIST_BUILD)) return undefined;
  const home = "home" in o ? o.home : process.env.HOME;
  if (home === undefined) return undefined;
  const account = (o.account ?? accountHome)();
  const real = o.real ?? ((p: string) => { try { return realpathSync(p); } catch { return p; } });
  if (account !== undefined && home !== "" && real(home) === real(account)) return undefined;
  return `clover-core: refusing to start: HOME is ${JSON.stringify(home)}, not this account's home${account === undefined ? " (which could not be read)" : ` (${account})`}. On macOS HOME chooses the keychains and trust settings this process reads; start it with HOME unset or set to the account's home.`;
}

/**
 * Why a macOS release refuses this raw environment, or undefined: any `DYLD_` entry. Under the hardened runtime with
 * System Integrity Protection on, dyld removes every `DYLD_*` variable before the process starts, so one that is
 * still here means that protection is off, and the macOS seal (the `DYLD_…` names seal-bun-doors.ts gives Bun's own
 * variables) and the block on DYLD_INSERT_LIBRARIES are open. With SIP off a library can be injected before `main`,
 * which nothing in the core can undo; this refusal is the cheap guard that at least stops the core there.
 */
export function dyldRefusal(raw: readonly string[], o: { platform?: NodeJS.Platform; distBuild?: boolean } = {}): string | undefined {
  if ((o.platform ?? process.platform) !== "darwin" || !(o.distBuild ?? DIST_BUILD)) return undefined;
  const names = [...new Set(raw.filter((e) => e.startsWith("DYLD_")).map((e) => e.slice(0, Math.max(e.indexOf("="), 0) || e.length)))];
  if (names.length === 0) return undefined;
  return `clover-core: refusing to start: ${names.length === 1 ? "a DYLD_ variable is" : "DYLD_ variables are"} set (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}). dyld removes them from this hardened release when System Integrity Protection is on; one that reached it means SIP is off, and then any library can be injected into this process. Unset ${names.length === 1 ? "it" : "them"}.`;
}

/**
 * A test-marked release build's start (scripts/test-build.ts; main.ts calls this only behind the compile-time
 * `__CLOVER_TEST_BUILD__`, so a real build has none of it): it takes a test's keychain variables where a release
 * refuses them, and REFUSES to start without them, never falling back to the login keychain or the live home. It needs
 * the throwaway keychain FILE (`CLOVER_TEST_KEYCHAIN`, non-empty in every raw entry) and a HOME that is set and, in
 * every raw entry, not this account's home by real path (HOME chooses the keychains, the trust settings and the
 * default Clover home); a `CLOVER_HOME` must be outside this account's home. Undefined: start.
 */
export function testBuildStartRefusal(env: Record<string, string | undefined>, raw: readonly string[], o: { account?: () => string | undefined; real?: (p: string) => string } = {}): string | undefined {
  const refuse = (why: string) => `clover-core: refusing to start: this is a test-marked build, and ${why}. It runs only on a throwaway keychain file (CLOVER_TEST_KEYCHAIN) and a temp HOME, never the login keychain or the live home.`;
  const entries = (name: string) => [...raw.filter((e) => e === name || e.startsWith(`${name}=`)).map((e) => e.slice(name.length + 1)), ...(env[name] === undefined ? [] : [env[name]!])];
  const keychains = entries(TEST_KEYCHAIN_ENV);
  if (keychains.length === 0 || keychains.some((v) => v === "")) return refuse(`${TEST_KEYCHAIN_ENV} is ${keychains.length === 0 ? "not set" : "empty"}`);
  const account = (o.account ?? accountHome)();
  if (account === undefined) return refuse("this account's home could not be read");
  const real = o.real ?? ((p: string) => { try { return realpathSync(p); } catch { return resolve(p); } });
  const own = real(account);
  const homes = entries("HOME");
  if (homes.length === 0) return refuse("HOME is not set (it would be this account's home)");
  if (homes.some((h) => h === "" || real(h) === own)) return refuse("HOME is this account's home");
  for (const c of entries("CLOVER_HOME")) {
    const at = real(c);
    if (c === "" || at === own || at.startsWith(`${own}${sep}`)) return refuse("CLOVER_HOME is inside this account's home");
  }
  return undefined;
}

/** The variables that mark a test: the one list, `UNDER_TEST_ENV` (auth/test-isolation.ts). */
const TEST_KEYCHAIN_VARIABLES = UNDER_TEST_ENV;

/** Why a release refuses to start under a test's keychain variables, or undefined. A release never uses a test
 *  keychain or a test service; it says so at once, naming the variable, rather than failing at its first item. */
export function testKeychainRefusal(env: Record<string, string | undefined>, raw: readonly string[] = [], distBuild: boolean = DIST_BUILD): string | undefined {
  if (!distBuild) return undefined;
  const set = TEST_KEYCHAIN_VARIABLES.filter((k) => env[k] !== undefined || raw.some((e) => e === k || e.startsWith(`${k}=`)));
  if (set.length === 0) return undefined;
  return `clover-core: refusing to start: ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set, which only a test sets. A release build uses the login keychain and its own service, never a test's; unset ${set.length === 1 ? "it" : "them"}.`;
}
