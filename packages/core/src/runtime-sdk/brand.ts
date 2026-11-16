// THE DAEMON'S BRAND: MOSS's names on the SDK's `BrandProfile` (C0, spec §2 and §3.3).
//
// The agent SDK is brand-parameterized. Its own default, `WINTER_BRAND`, is Winter's, and it keeps
// that name until lane A renames and republishes the SDK. The brand rides the wire
// (`RuntimeConfig.brand`), so every runtime child the router spawns, and every embedded session,
// derives its home, its environment variable names, its project folder, its instructions file, its
// MCP server name and its temp root from THIS object, never from the SDK's default. That is what
// keeps a MOSS session out of Winter's `~/.winter`, Winter's `WINTER_*` variables and Winter's
// `/private/tmp/winter-<uid>` while the SDK still ships Winter's defaults.
//
// `buildCoreBrand` starts from `WINTER_BRAND` and sets every field whose value is MOSS's:
//
//  - `productName: "MOSS"`, `packageName: "moss-core"` — the honest identity in user-facing
//    prose and in `User-Agent`/vendor-identity headers (`BrandProfile.packageName`'s own doc).
//  - `homeDirName: ".moss"` + `envPrefix: "MOSS_"` → THE HOME ALIGNMENT: the SDK's
//    `resolveWinterHome()` given `CORE_BRAND` returns exactly what core's own `resolveMossHome()`
//    (`../moss-dir.ts`) returns — `MOSS_HOME` when set, `~/.moss` otherwise — so the daemon's
//    home and the runtime's home are the SAME directory. Pinned in `test/runtime-sdk/brand.test.ts`.
//  - `projectDirName: ".moss"`, `instructionsFile: "MOSS.md"`, `pluginManifestDir:
//    ".moss-plugin"` — a repo's MOSS folder, instructions and plugin manifests (spec §14.2 item
//    11), never Winter's `.winter/` (which the live Winter install reads and writes).
//  - `mcpServerName: "moss"` → every daemon-owned capability tool is `mcp__moss__<key>__<tool>`
//    (spec item 74); `capabilities/names.ts`'s own header covers why a composed server name can
//    never collide with this bare value.
//  - `codexOriginator: "moss"` — spec §3.3, the owner's decision. THE value Codex calls send: a
//    runtime session's brand carries it, and `process-identity.ts` installs it process-wide for every
//    call outside a session (C0, review S1). `providers/codex-config.ts`'s header table repeats it,
//    pinned equal in `test/runtime-sdk/process-identity.test.ts`.
//  - `tempRootName: "moss"` → `/private/tmp/moss-<uid>/moss-<uid>/<projectKey>/<uuid>/…`.
//  - `keychainService: keychainService(profile)` — profile-aware (`com.waifucave.moss.core`,
//    dev `com.waifucave.moss.core.dev`); `auth/secret-store.ts`'s `SERVICE` resolves the same way,
//    from the same `MOSS_PROFILE`, so the daemon's secret store and its brand never disagree.
//  - `contactUrl: "https://github.com/waifucave/moss"` — where a report about this daemon belongs.
//
// TAKEN FROM `WINTER_BRAND` AS IT IS, on purpose:
//
//  - `presetName: "winter_code"` — the SDK's own system-prompt preset, which the runtime selects by
//    that name (`mode-options.ts`); it changes with the SDK.
//  - `processLabel: "winter"` — the label of the `winter` binary the router spawns (Winter's coding
//    agent); lane K names that binary.
import { WINTER_BRAND, type BrandProfile } from "@waifucave/clover-agent-sdk";
import { CORE_VERSION } from "../version";
import { keychainService } from "../profile";
import type { MossProfile } from "../profile";

/**
 * Build the brand. `profile` is threaded only so a test can assert both halves of the dev/dist
 * split without mutating `process.env` — production always takes the default, which resolves
 * `MOSS_PROFILE` exactly as `auth/secret-store.ts` does.
 *
 * `home` (test-keychain-isolation fix) is the daemon's ACTUAL `MOSS_HOME` — never inferred from
 * the `MOSS_HOME` env var here, since a daemon booted via `startDaemon({ home })` (every real
 * test) never sets that env var at all. Passing it through lets `keychainService(profile, home)`
 * decide whether `MOSS_KEYCHAIN_SERVICE` may override the returned service name (P9c-15's
 * default-home guard) — `CORE_BRAND` below omits it and keeps today's env-only resolution for
 * every OTHER brand field's consumer, but `create.ts` builds its OWN brand from this function with
 * the real `deps.home` for the object actually handed to the router, which is what the spawned
 * child's own Keychain resolution (`brand.keychainService`, the D30 advisor default fallback
 * included) is seeded from.
 */
export function buildCoreBrand(profile?: MossProfile, home?: string): BrandProfile {
  return {
    ...WINTER_BRAND,
    productName: "MOSS",
    packageName: "moss-core",
    homeDirName: ".moss",
    projectDirName: ".moss",
    instructionsFile: "MOSS.md",
    envPrefix: "MOSS_",
    keychainService: keychainService(profile, home),
    mcpServerName: "moss",
    codexOriginator: "moss",
    tempRootName: "moss",
    pluginManifestDir: ".moss-plugin",
    // `resolveBrand` parses this with `new URL` and requires `https:` (and no control bytes).
    contactUrl: "https://github.com/waifucave/moss",
    // A-M1 (SDK 0.0.63): MOSS's own release, so its identity reads `moss-core/<release>`, never the
    // SDK's version after MOSS's name.
    productVersion: CORE_VERSION,
  };
}

/**
 * THE brand. One frozen object for the daemon's lifetime.
 *
 * Module-load resolution of `keychainService()` follows `auth/secret-store.ts`'s precedent exactly,
 * including its caveat: `MOSS_PROFILE` must be set in the environment BEFORE this module is first
 * imported (mutating it afterwards is inert). Every production entry point — the launchd plist, the
 * app's own spawn — sets it in the environment it starts the process with.
 */
export const CORE_BRAND: BrandProfile = Object.freeze(buildCoreBrand());
