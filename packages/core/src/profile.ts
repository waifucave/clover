import { isDefaultMossHome } from "./moss-dir";

/** The dev/distribution profile. Everything identity-shaped that MOSS_HOME does not already
 *  parameterize derives from this: the Keychain service (secret-store.ts) and the CLI's launchd
 *  label (packages/cli/src/launchd.ts). Unset/unknown env values mean "dist" — the dist Keychain
 *  service is now `com.waifucave.moss.core` (dev: `com.waifucave.moss.core.dev`), a NEW pair holding nothing
 *  until Migration B (9c) copies over the pre-rename items. See `legacy-names.ts`'s
 *  `LEGACY_KEYCHAIN_SERVICE[_DEV]` for the pre-rename pair that 9c's migrator reads from. */
export type MossProfile = "dist" | "dev";

export function resolveMossProfile(env: NodeJS.ProcessEnv = process.env): MossProfile {
  return env.MOSS_PROFILE === "dev" ? "dev" : "dist";
}

/** The overrides `keychainService` has already reported, so each is said once per process. */
const overrideWarned = new Set<string>();

/**
 * Keychain service for Bun.secrets. `com.waifucave.moss.core` (dev: `.dev`) is a NEW, empty pair —
 * the pre-rename items (`legacy-names.ts`'s `LEGACY_KEYCHAIN_SERVICE[_DEV]`) are copied over
 * only by Migration B (9c).
 *
 * HERMETICITY FIX (test-keychain-isolation): `MOSS_KEYCHAIN_SERVICE`, when set, overrides the
 * returned service name — but ONLY when the caller EXPLICITLY passes a `home` that is NOT the
 * profile's own default home (`~/.moss` dist, `~/.moss-dev` dev — `moss-dir.ts`'s
 * `isDefaultMossHome`, the P9c-15 rule). `home` is intentionally NOT defaulted to
 * `resolveMossHome()`: that resolver reads only `MOSS_HOME` (never `MOSS_PROFILE`), so with
 * no `MOSS_HOME` set it always answers the DIST path regardless of `profile` — silently mismatching
 * a caller who passed `profile: "dev"` for its literal alone (`console-profile-broker.ts`,
 * `migrate-b.ts`, a bare `keychainService("dev")`) and wrongly treating that as a "non-default home".
 * Omitting `home` therefore means "I'm not asserting anything about which home this is" and NEVER
 * engages the override. A daemon on its profile's DEFAULT home (`~/.moss`, `~/.moss-dev`) can
 * never be redirected by an env var some other process happens to have set; a daemon deliberately
 * run on a custom `MOSS_HOME` DOES honour it (and warns), so the variable belongs only in a test
 * preload. This is the ONE function every consumer of the Keychain service name must derive from — the
 * brand handed to the router (`runtime-sdk/brand.ts`) and every `CredentialRef` the child resolves
 * against (`runtime-sdk/keychain.ts`, `runtime-sdk/provider-selection.ts`) thread their caller's
 * REAL `home` through explicitly. `test/preload.ts` sets the env var to a throwaway service name
 * with no items so a real-binary e2e test's spawned child can never reach the user's real
 * `com.waifucave.moss.core[.dev]` Keychain items.
 */
export function keychainService(
  profile: MossProfile = resolveMossProfile(),
  home?: string,
): string {
  const base = profile === "dev" ? "com.waifucave.moss.core.dev" : "com.waifucave.moss.core";
  const override = process.env.MOSS_KEYCHAIN_SERVICE;
  if (!override || home === undefined) return base;
  if (isDefaultMossHome(home, profile)) return base;
  // Once per process for each home and service: the name is resolved for every credential reference, and a line per
  // resolve buried the daemon's log (a UI loop once printed it ~900,000 times).
  const said = `${home}\0${override}\0${base}`;
  if (!overrideWarned.has(said)) {
    overrideWarned.add(said);
    console.warn(`[keychain] MOSS_KEYCHAIN_SERVICE override honoured for non-default home "${home}": using "${override}" instead of "${base}"`);
  }
  return override;
}

/**
 * The CLI command a hint should name: `moss-dev` on the dev profile, `moss` otherwise. The CLI cannot
 * see the name it was invoked by — the `moss-dev` wrapper execs `bun …/main.ts`, and the dist `moss`
 * is a link to `moss-core` — so the profile the wrapper exports is the signal (a dev-profile process is
 * only ever reached through `moss-dev`; a plain `moss` is always the dist CLI).
 */
export function cliCommandName(profile: MossProfile = resolveMossProfile()): string {
  return profile === "dev" ? "moss-dev" : "moss";
}

export function profileDisplayName(profile: MossProfile = resolveMossProfile()): string {
  return profile === "dev" ? "MOSS Dev" : "MOSS";
}
