// THE DAEMON'S BRAND: Clover's names on the SDK's `BrandProfile` (C0, spec §2 and §3.3).
//
// The agent SDK is brand-parameterized. Its own default, `WINTER_BRAND`, is Winter's, and it keeps
// that name until lane A renames and republishes the SDK. The brand rides the wire
// (`RuntimeConfig.brand`), so every runtime child the router spawns, and every embedded session,
// derives its home, its environment variable names, its project folder, its instructions file, its
// MCP server name and its temp root from THIS object, never from the SDK's default. That is what
// keeps a Clover session out of Winter's `~/.winter`, Winter's `WINTER_*` variables and Winter's
// `/private/tmp/winter-<uid>` while the SDK still ships Winter's defaults.
//
// `buildCoreBrand` starts from `WINTER_BRAND` and sets every field whose value is Clover's:
//
//  - `productName: "Clover"`, `packageName: "clover-core"` — the honest identity in user-facing
//    prose and in `User-Agent`/vendor-identity headers (`BrandProfile.packageName`'s own doc).
//  - `homeDirName: ".clover"` + `envPrefix: "CLOVER_"` → THE HOME ALIGNMENT: the SDK's
//    `resolveWinterHome()` given `CORE_BRAND` returns exactly what core's own `resolveCloverHome()`
//    (`../clover-dir.ts`) returns — `CLOVER_HOME` when set, `~/.clover` otherwise — so the daemon's
//    home and the runtime's home are the SAME directory. Pinned in `test/runtime-sdk/brand.test.ts`.
//  - `projectDirName: ".clover"`, `instructionsFile: "CLOVER.md"`, `pluginManifestDir:
//    ".clover-plugin"` — a repo's Clover folder, instructions and plugin manifests (spec §14.2 item
//    11), never Winter's `.winter/` (which the live Winter install reads and writes).
//  - `mcpServerName: "clover"` → every daemon-owned capability tool is `mcp__clover__<key>__<tool>`
//    (spec item 74); `capabilities/names.ts`'s own header covers why a composed server name can
//    never collide with this bare value.
//  - `codexOriginator: "clover"` — spec §3.3, the owner's decision; `providers/codex-config.ts`
//    sends the same value.
//  - `tempRootName: "clover"` → `/private/tmp/clover-<uid>/clover-<uid>/<projectKey>/<uuid>/…`.
//  - `keychainService: keychainService(profile)` — profile-aware (`com.waifucave.clover.core`,
//    dev `com.waifucave.clover.core.dev`); `auth/secret-store.ts`'s `SERVICE` resolves the same way,
//    from the same `CLOVER_PROFILE`, so the daemon's secret store and its brand never disagree.
//  - `contactUrl: "https://github.com/waifucave/clover"` — where a report about this daemon belongs.
//
// TAKEN FROM `WINTER_BRAND` AS IT IS, on purpose:
//
//  - `presetName: "winter_code"` — the SDK's own system-prompt preset, which the runtime selects by
//    that name (`mode-options.ts`); it changes with the SDK.
//  - `processLabel: "winter"` — the label of the `winter` binary the router spawns (Winter's coding
//    agent); lane K names that binary.
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { keychainService } from "../profile";
import type { CloverProfile } from "../profile";

/**
 * Build the brand. `profile` is threaded only so a test can assert both halves of the dev/dist
 * split without mutating `process.env` — production always takes the default, which resolves
 * `CLOVER_PROFILE` exactly as `auth/secret-store.ts` does.
 *
 * `home` (test-keychain-isolation fix) is the daemon's ACTUAL `CLOVER_HOME` — never inferred from
 * the `CLOVER_HOME` env var here, since a daemon booted via `startDaemon({ home })` (every real
 * test) never sets that env var at all. Passing it through lets `keychainService(profile, home)`
 * decide whether `CLOVER_KEYCHAIN_SERVICE` may override the returned service name (P9c-15's
 * default-home guard) — `CORE_BRAND` below omits it and keeps today's env-only resolution for
 * every OTHER brand field's consumer, but `create.ts` builds its OWN brand from this function with
 * the real `deps.home` for the object actually handed to the router, which is what the spawned
 * child's own Keychain resolution (`brand.keychainService`, the D30 advisor default fallback
 * included) is seeded from.
 */
export function buildCoreBrand(profile?: CloverProfile, home?: string): BrandProfile {
  return {
    ...WINTER_BRAND,
    productName: "Clover",
    packageName: "clover-core",
    homeDirName: ".clover",
    projectDirName: ".clover",
    instructionsFile: "CLOVER.md",
    envPrefix: "CLOVER_",
    keychainService: keychainService(profile, home),
    mcpServerName: "clover",
    codexOriginator: "clover",
    tempRootName: "clover",
    pluginManifestDir: ".clover-plugin",
    // `resolveBrand` parses this with `new URL` and requires `https:` (and no control bytes).
    contactUrl: "https://github.com/waifucave/clover",
  };
}

/**
 * THE brand. One frozen object for the daemon's lifetime.
 *
 * Module-load resolution of `keychainService()` follows `auth/secret-store.ts`'s precedent exactly,
 * including its caveat: `CLOVER_PROFILE` must be set in the environment BEFORE this module is first
 * imported (mutating it afterwards is inert). Every production entry point — the launchd plist, the
 * app's own spawn — sets it in the environment it starts the process with.
 */
export const CORE_BRAND: BrandProfile = Object.freeze(buildCoreBrand());
