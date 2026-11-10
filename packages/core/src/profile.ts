import { isDefaultCloverHome } from "./clover-dir";

/** The dev/distribution profile. Everything identity-shaped that CLOVER_HOME does not already
 *  parameterize derives from this: the Keychain service (secret-store.ts) and the CLI's launchd
 *  label (packages/cli/src/launchd.ts). Unset/unknown env values mean "dist" — the dist Keychain
 *  service is now `com.waifucave.clover.core` (dev: `com.waifucave.clover.core.dev`), a NEW pair holding nothing
 *  until Migration B (9c) copies over the pre-rename items. See `legacy-names.ts`'s
 *  `LEGACY_KEYCHAIN_SERVICE[_DEV]` for the pre-rename pair that 9c's migrator reads from. */
export type CloverProfile = "dist" | "dev";

export function resolveCloverProfile(env: NodeJS.ProcessEnv = process.env): CloverProfile {
  return env.CLOVER_PROFILE === "dev" ? "dev" : "dist";
}

/** The overrides `keychainService` has already reported, so each is said once per process. */
const overrideWarned = new Set<string>();

/**
 * Keychain service for Bun.secrets. `com.waifucave.clover.core` (dev: `.dev`) is a NEW, empty pair —
 * the pre-rename items (`legacy-names.ts`'s `LEGACY_KEYCHAIN_SERVICE[_DEV]`) are copied over
 * only by Migration B (9c).
 *
 * HERMETICITY FIX (test-keychain-isolation): `CLOVER_KEYCHAIN_SERVICE`, when set, overrides the
 * returned service name — but ONLY when the caller EXPLICITLY passes a `home` that is NOT the
 * profile's own default home (`~/.clover` dist, `~/.clover-dev` dev — `clover-dir.ts`'s
 * `isDefaultCloverHome`, the P9c-15 rule). `home` is intentionally NOT defaulted to
 * `resolveCloverHome()`: that resolver reads only `CLOVER_HOME` (never `CLOVER_PROFILE`), so with
 * no `CLOVER_HOME` set it always answers the DIST path regardless of `profile` — silently mismatching
 * a caller who passed `profile: "dev"` for its literal alone (`console-profile-broker.ts`,
 * `migrate-b.ts`, a bare `keychainService("dev")`) and wrongly treating that as a "non-default home".
 * Omitting `home` therefore means "I'm not asserting anything about which home this is" and NEVER
 * engages the override. A daemon on its profile's DEFAULT home (`~/.clover`, `~/.clover-dev`) can
 * never be redirected by an env var some other process happens to have set; a daemon deliberately
 * run on a custom `CLOVER_HOME` DOES honour it (and warns), so the variable belongs only in a test
 * preload. This is the ONE function every consumer of the Keychain service name must derive from — the
 * brand handed to the router (`runtime-sdk/brand.ts`) and every `CredentialRef` the child resolves
 * against (`runtime-sdk/keychain.ts`, `runtime-sdk/provider-selection.ts`) thread their caller's
 * REAL `home` through explicitly. `test/preload.ts` sets the env var to a throwaway service name
 * with no items so a real-binary e2e test's spawned child can never reach the user's real
 * `com.waifucave.clover.core[.dev]` Keychain items.
 */
export function keychainService(
  profile: CloverProfile = resolveCloverProfile(),
  home?: string,
): string {
  const base = profile === "dev" ? "com.waifucave.clover.core.dev" : "com.waifucave.clover.core";
  const override = process.env.CLOVER_KEYCHAIN_SERVICE;
  if (!override || home === undefined) return base;
  if (isDefaultCloverHome(home, profile)) return base;
  // Once per process for each home and service: the name is resolved for every credential reference, and a line per
  // resolve buried the daemon's log (a UI loop once printed it ~900,000 times).
  const said = `${home}\0${override}\0${base}`;
  if (!overrideWarned.has(said)) {
    overrideWarned.add(said);
    console.warn(`[keychain] CLOVER_KEYCHAIN_SERVICE override honoured for non-default home "${home}": using "${override}" instead of "${base}"`);
  }
  return override;
}

/**
 * The CLI command a hint should name: `clover-dev` on the dev profile, `clover` otherwise. The CLI cannot
 * see the name it was invoked by — the `clover-dev` wrapper execs `bun …/main.ts`, and the dist `clover`
 * is a link to `clover-core` — so the profile the wrapper exports is the signal (a dev-profile process is
 * only ever reached through `clover-dev`; a plain `clover` is always the dist CLI).
 */
export function cliCommandName(profile: CloverProfile = resolveCloverProfile()): string {
  return profile === "dev" ? "clover-dev" : "clover";
}

export function profileDisplayName(profile: CloverProfile = resolveCloverProfile()): string {
  return profile === "dev" ? "Clover Dev" : "Clover";
}
