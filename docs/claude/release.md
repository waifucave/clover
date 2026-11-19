# Versioning & release

> **Reference: Winter's code.** This file describes Winter's code as it stood at the `winter-before-moss` tag, before the MOSS rename (C0). Where it describes code that C0 renamed, read `winter-core` as `moss-core`, `WINTER_*` as `MOSS_*` and `~/.winter` as `~/.moss`. For MOSS itself, [the spec](../moss-spec.md) is the source of truth, then [the plan](../moss-plan.md).

*Read this before bumping a version, writing release notes or cutting a release.*

- `VERSION`'s format is `#.###.#` — major, three-digit feature counter, single-digit patch (`0.112.0`); the first digit moves only for a rebrand-scale event (`scripts/version-lib.ts`).
- The Computer Use helper has its OWN semver `apple/ComputerUse/VERSION` (rules + protocol number: `apple/ComputerUse/PROTOCOL.md`); `version:sync`, `dev:helper` and `verify:computer-helper` stamp it into the helper's Info.plist and the marked lines of `apple/Winter/project.yml`; Winter's own stamp skips those.

```sh
bun run version:bump                 # patch +1 (throws at 9 — use a feature bump)
bun run version:bump:feature         # feature +1, patch -> 0 (throws at 999 — version:bump:major)
bun run version:sync                 # restamp version.ts / package.jsons / plists from VERSION
bun run scripts/release.ts --dry-run --no-bump   # full rehearsal: builds, notarizes, staples, never publishes
bun run scripts/release.ts                       # real release (bumps first; --no-bump ships VERSION as is)
```

- Pipeline: `scripts/release.ts` + `scripts/release-lib.ts`; `packaging/winter.rb.tmpl` is the Homebrew cask template it renders.
- `releases/notes/<version>.md` is REQUIRED — the GitHub release body and the Sparkle appcast `<description>`, rendered by `releaseNotesHtml`, which throws (naming the line) on anything outside `#`/`##`/`###`, paragraphs, `- ` bullets with indented continuations (no nesting), ``` fences, `` `code` `` and `**bold**`. The preflight fails BEFORE the bump when it is absent: write and commit the notes for the next version, bump and sync, release with `--no-bump`.

## The Cowork native pair is an explicit choice
`release.ts` refuses to start a build until it knows whether the release ships the Cowork native pair (`coworkNativeReleasePlan` in `scripts/cowork-native-lib.ts`, read from `process.env` right after the output folder is cleared and before xcodegen or any build; `--dry-run` included). The pair is the signed launcher (`winter-cowork-launcher`) and VM worker (`winter-cowork-worker`) the daemon would spawn; shipping it activates nothing (the daemon still refuses Cowork sessions).

| Environment | Mode | What the release gets |
|---|---|---|
| `COWORK_LIBKRUN_INCLUDE` (the directory holding `libkrun.h`) AND `COWORK_LIBKRUN_ARCHIVE` (the stripped production archive) | build | `buildCoworkNative` builds the launcher (`swift build`) and the worker (`apple/Cowork/WinterCoworkHVFWorker/build.py`, which refuses unless the header and archive hash to that folder's `pins.json`) into `dist/cowork-native`; project.yml's "Embed Cowork native" phase (`scripts/embed-cowork-native.sh`) signs them into `Winter.app/Contents/Helpers/WinterCowork/` and writes `Contents/Resources/cowork-native-pins.json`. The release then verifies identifiers, team, hardened runtime, the stated designated requirement, entitlements (worker: the hypervisor key alone; launcher: none), platform dylibs only, no test hooks, and that the pin manifest's CDHashes and libkrun/worker/guest-artifact pins are the ones in this checkout. |
| `COWORK_NATIVE=omit` (and neither libkrun variable) | omit | Nothing is built or embedded: no `WinterCowork` helpers, no pins file. The release fails if a leftover from an earlier build is in the bundle (`checkCoworkNativeOmitted`). |

Anything else exits before any build with a message naming both ways out: neither given; only one of the two libkrun variables; `COWORK_NATIVE=omit` together with either libkrun variable; or any other value of `COWORK_NATIVE`. `omit` is never the default. `release.ts` does not build or fetch the libkrun archive; the patch queue and its reproducible build are in the libkrun patch-queue package under `apple/Cowork/` (its `scripts/build_archive.py`; deliberately not named by path outside CI, which its anti-wiring guard enforces), and its stripped archive is what `COWORK_LIBKRUN_ARCHIVE` points at. A release that must not wait on one uses `COWORK_NATIVE=omit`. `scripts/build-cowork-native.ts` reads the same two variables (or `--libkrun-include` / `--libkrun-archive`; `--launcher-only` skips the worker), and `embed-cowork-native.sh` itself also honours `COWORK_NATIVE=omit` and rejects any other value.

## Rolling back across a schema bump
A release that raises `RUNTIME_STATE_SCHEMA_VERSION` (the Cowork tables arrived in v8 to v17; v18 added the session binding, v19 the session reservations, v20 the export content binding, v21 the stable guest uids and cold-resume records; it is v21 now) cannot be undone by installing the older app: the older build refuses the newer store (`newer-schema`). A revert release reverts the feature, never the schema. The user-facing way back is `winter migrate --cowork-schema --rollback` with the newer CLI and the daemon stopped, before installing the older app (it accepts v8..v21, drops only empty Cowork tables and refuses with `cowork-data-present` if one holds a row); a store left at v18, v19 or v20 by an intermediate build needs the same step. Put that line in the release notes of any release that bumps the schema (see `docs/RELEASE-NOTES-cowork-schema.md`; what each version adds: [settings-and-migrations.md](./settings-and-migrations.md#runtime-state-schema-v21-and-the-way-back)).

## MOSS: one release, two apps (lane PK)

`scripts/release/build.ts` builds **both** apps of a release in every mode, MOSS Code (`apps/desktop`) and MOSS (`apps/moss`), from one stage: one engine binary and sidecars, one bundled tree, one host helper. There is no flag for one app alone. Before anything is built, both `package.json` versions must equal `VERSION`. After packaging, the build checks byte for byte that the two apps' `Resources/daemon` and `Resources/plugins` match. It also checks that both `Contents/Frameworks/MOSS Host.app` hold MOSS Code's own `app.asar` (the host is MOSS Code's main process), and that each helper's Info.plist names its own asar's integrity (`scripts/release/two-apps.ts`).

How the helper gets into both apps:
- MOSS Code's afterPack (`apps/desktop/scripts/host-helper.mjs`) makes the helper and stashes a copy in `apps/desktop/out/host-helper`.
- MOSS's afterPack (`apps/moss/scripts/host-helper.mjs`) carries that copy in before MOSS is signed.

On a signed build, each app must meet its own requirement (`appRequirement(…, "code" | "moss")`), and each helper must meet the engine's `hostRequirement`.

Where the outputs go:
- MOSS's dmg, zip and `MOSS.app` land beside MOSS Code's in the build's folder.
- MOSS's update files carry MOSS's own names in the same GitHub release (`moss-latest-mac.yml`, `moss-beta-mac.yml`; `MOSS_APP_FEED_PREFIX` in packages/update-feed).
- MOSS's updater (`@waifucave/moss-app-release/updater`, `feedPrefix`) reads only those files.

Not yet covered:
- `publish.ts` does not yet upload or sign MOSS's files.
- Linux packages (`scripts/build-packages.ts`) build MOSS Code only.
- On Windows and Linux there is no host helper: the host is MOSS Code's own executable, so a MOSS-only install there has no host.

### The controller's sign-only try of both apps (this Mac, the Developer ID in the login keychain)

From a clean checkout of the try's commit:

```sh
df -g /                                  # each app is several hundred MB; the twin pair doubles it
scripts/try/run.sh <commit> <out> --runs 0 --cold-start 0 --upgrade-from 3a3e247e3 --twin-only   # the upgrade pair alone
scripts/try/run.sh <commit> <out> --runs 1 --cold-start 0 --upgrade-from 3a3e247e3              # the full try
scripts/try/run.sh <commit> <out> --runs 0 --cold-start 0 --twin-only --keep-twin <dir>           # only build the test twin pair and keep it, to re-run packaged units against it
```

What each step proves:

| Step | Proves |
| :- | :- |
| `release/build.ts --sign --no-notarize` (run.sh step 1) | Both apps Developer ID signed and hardened, never notarized. Each app meets its own requirement, as the engine's caller check reads it. Each `MOSS Host.app` meets the engine's host requirement (the check the engine makes before Launch Services starts the host). One engine, tree and helper code in both apps. |
| `scripts/try/verify.sh <copy> <checkout> --sign-only` (step 2) | Statically, for each app: its signature, fuses and opening entitlements, the unpacked screen add-on signed by the team, the dmg's app equal to the built app, and both apps on one release (version, `daemon/` and `plugins/` the same, both helpers the same code and meeting the host requirement). |
| `release/build.ts --test-build` (step 3) | The test twin pair (`MOSS-Code-<v>-TEST.*`, `MOSS-<v>-TEST.*`). |
| `scripts/acceptance/run.ts --app <MOSS Code.app> --units <packagedUnitIds()> --moss-app <MOSS.app>` (step 4, under `watch.sh`) | MOSS Code's chain, `release` and the other units, packaged, named with `--units` (`shards.ts` `packagedUnitIds`: a run with no `--units` is the table from before the split). The `moss` unit runs the packaged MOSS in a home of its own. The upgrade's new half takes `--moss-app` too. The chain's driver says hello as the CLI on a packaged core, so a row that needs an `app` hello from the run says what the packaged core answered; the `moss` unit is the exception: its driver and its second (MOSS Code's) connection say hello as the `app`, through the test-marked core's one-pid seam (`MOSS_TEST_APP_PEER_PID`, `platform/peer-signature.ts`, compiled out of a real build), because that unit's rows read the router's places and sign as a second program. `--moss-app` must be the same release as `--app`, or the run stops. |
| `--upgrade-from 3a3e247e3` (step 5) | From the last build before the rename: its twin runs with `--keep-state`, then this MOSS Code twin offers the copy of the old home at first start. The old app and home are never touched. |

What only this signed run proves, and no unit test can:
- the host helper's signature against `hostRequirement`;
- the engine's signature check of the home's engine before an app starts it (`engine install`'s `unsafe`);
- the `release` unit;
- each packaged app's hello passing the caller check as its own program.

The `host` units cannot run packaged. A dist core ignores `MOSS_HOST_COMMAND`, and a test-marked core never starts a host through the OS. They stay source-only (`--units host`).

### Each install state: what runs, what the person sees, and what proves it

Test files:
- Engine level: `packages/core/test/update/two-apps.test.ts`.
- MOSS's side: `apps/moss/test/release.test.ts`, `apps/moss/test/install-record.test.ts`.
- Payload: `scripts/release/two-apps.test.ts`.

| State | What runs | What the person sees | Proved by |
| :- | :- | :- | :- |
| Only MOSS | MOSS writes `apps/moss.json` (`carries.host` true when its helper is there), runs `engine install`, then starts the home's engine through the OS (registering the login item only when none is installed). The engine starts the host from `MOSS.app/Contents/Frameworks/MOSS Host.app`. | MOSS's window. Cards in it while it's in front, else on the island. | Engine level: "only MOSS installed". Install record: "a copy that carries the host helper". Signed run: the helper's signature and the packaged `moss` unit. |
| Only MOSS Code | As before lane PK. | As before. | Engine level: "only MOSS Code installed"; MOSS Code's own tests. |
| Both, one release | One engine (the home's copy, whichever app installed it first wins the lock) and one host, from the newest record (a tie goes to the later start). Quitting either app stops nothing. | Both windows. | Engine level: "both installed on one release". The engine's quit rule (lane HS) is unchanged. |
| MOSS newer than the engine | Served the release door only. Asks `release.bring` from its own bundle. Through the switch, starts the engine itself after 8 s. | "This MOSS (release X) is newer than the engine: it is waiting for work to finish (n turns running)…" with a "Switch now" sheet. If the new engine never answers: "The engine hasn't answered since it switched to release X." with "Try again". | `release.test.ts`, "a MOSS newer than the engine (ahead)". Engine level: "the newer app is served the release door". |
| Older app open while a newer one brings the engine | `release_changed` names a newer release: the older app updates itself. Once the engine is switched, its hello is refused as behind, with the release it needs. | MOSS: "Updating MOSS to release X, the engine's, before it connects…", or "can't reach the update server…" when offline, or "couldn't update itself" with the `engine reset` command. MOSS Code: its own updating notice (RL). | `release.test.ts`, "a MOSS older than the engine (behind)". Engine level: "…the older one is refused as behind". |
| One app deleted | Its record is no longer listed (the file goes after 30 s). The engine starts the host from the other app's own bundle. | The other app works as alone. The host menu opens only the app that's there. | Engine level: "one app deleted…", "the host's menu opens whichever app is there". |
| Both deleted | The engine stays in the home and runs headless (no host source). Uninstall clean-up is open (item 109). | Nothing. | Engine level: "both apps deleted". |
| MOSS's own update | Downloads its own `moss-<channel>-mac.yml` from the same release. Installs only at the engine's idle moment, after `update.apply` and `pair.exiting{update}` and once the engine and host have gone, then relaunches. Never at Quit. | "A MOSS update is ready" notification, then MOSS opens again. | Payload: `packages/app-release/test/feeds.test.ts`. Install gate: `release.test.ts`, "MOSS's own update installs through the idle gate". |
