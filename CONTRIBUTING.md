# Contributing to Clover

Thanks for wanting to help. This document is the practical stuff: how to get a working build, how to
run the tests, and the handful of rules that will save you a wasted afternoon.

**Before anything nontrivial, [open an issue](https://github.com/waifucave/clover/issues) or start a
[discussion](https://github.com/waifucave/clover/discussions).** Clover has a lot of load-bearing
structure that isn't obvious from a diff, and it's much easier to point you at it before you write
the code than after.

Found a security problem? Don't open an issue — see [SECURITY.md](SECURITY.md).

## Table of contents

- [What you need](#what-you-need)
- [First build](#first-build)
- [Running Clover in development](#running-clover-in-development)
- [The dev/dist split — read this one](#the-devdist-split--read-this-one)
- [Tests](#tests)
- [Changing the protocol](#changing-the-protocol)
- [Rules that bite](#rules-that-bite)
- [Sending a pull request](#sending-a-pull-request)

## What you need

| | |
| --- | --- |
| **macOS 26+**, Apple silicon | The deployment target. There is no legacy compatibility path — see [rules](#rules-that-bite). |
| **[Bun](https://bun.sh) ≥ 1.3** | The runtime. TypeScript runs directly; there is no build step in dev. |
| **pnpm** | Orchestrates the workspaces. `bun install` is what you actually run. |
| **A GitHub token with `read:packages`** | The `@waifucave` packages (the agent SDK's `@waifucave/clover-*` among them) are on GitHub Packages, which needs a token even to read. `bun install` takes it from `NODE_AUTH_TOKEN` (see [First build](#first-build)). |
| **Xcode 26+** | Only if you're touching the Swift packages the iPhone app uses (`apple/WinterKit`, `apple/WinterProtocol`). |

TypeScript-only contributions (the daemon, the CLI, tools, providers) need nothing from the Xcode
column.

## First build

```sh
git clone https://github.com/waifucave/clover.git
cd clover
NODE_AUTH_TOKEN=$(gh auth token) bun install   # gh's token needs read:packages: `gh auth refresh -s read:packages` once
```

The repo's `.npmrc` reads the `@waifucave` scope from GitHub Packages with `NODE_AUTH_TOKEN`; no token is ever
written to disk. CI uses the workflow's own token (`packages: read`), so nothing needs to be configured there.

That's the whole TypeScript setup. The Swift packages the iPhone app uses fetch one large artifact
rather than committing it:

```sh
./apple/WinterKit/vendor/fetch-iroh.sh  # iroh transport xcframework   (~133 MB, checksum-pinned)
```

The Mac app under `apple/Winter` is retired: it stays in the repo for reference and is not built.
Clover's own desktop app comes with the plan's app phase ([docs/clover-plan.md](docs/clover-plan.md)).

## Running Clover in development

```sh
cd packages/cli
bun src/main.ts daemon run        # headless daemon
bun src/main.ts -p "hello"        # one-shot prompt, another terminal
bun src/main.ts                   # interactive TUI (Code mode)
```

Useful CLI surface while developing: `clover status`, `clover ping`, `clover sessions`,
`clover agents`, `clover watch <sessionId>`, `clover bg list <session>`, `clover plugin list`.

## The dev/dist split — read this one

Clover keeps two separate installs that must never be confused:

| | Distribution | Development |
| --- | --- | --- |
| Bundle id | `com.waifucave.clover` | `com.waifucave.clover.dev` |
| Home | `~/.clover` | `~/.clover-dev` |
| Keychain service | `com.waifucave.clover.core` | `com.waifucave.clover.core.dev` |
| Command | `clover` | `clover-dev` |

**Never launch a distribution install during development**, and never Winter's: `Winter.app`, with
its `~/.winter` home and `com.winter.core` Keychain, is somebody's daily driver, updated by Sparkle. A
locally launched copy under the same bundle id is indistinguishable from it in the menu bar and
defeats the entire split. The same goes for local Release builds — build them, don't run them.

Two rules worth stating outright:

1. **Plain `clover` is the distribution CLI** (and plain `winter` is Winter's). With a dead socket
   it *auto-launches the dist app*.
   Use `clover-dev` and `bun run dev:daemon` (the signed dev binary on `~/.clover-dev`), or a daemon
   from the checkout on a throwaway home and a throwaway Keychain service:

   ```sh
   cd packages/cli
   CLOVER_HOME="$(mktemp -d)" CLOVER_PROFILE=dev CLOVER_KEYCHAIN_SERVICE=com.waifucave.clover.core.scratch bun src/main.ts daemon run
   ```

   Never run a daemon or the CLI from the checkout under plain `bun` on `~/.clover-dev`: after the
   dev daemon's one-time `--transition`, the dev Keychain items trust only the signed dev binary,
   and plain `bun` is prompted for every one.

2. **After any change under `packages/`, restart the daemon**, not just a client. A client-only
   relaunch is a silent no-op for daemon code.

## Tests

```sh
pnpm test                              # every workspace, serially
cd packages/core && bun test           # one package
bun test path/to/file.test.ts          # one file (path substring match)
bun test -t "test name"                # one test by name

cd apple/WinterProtocol && swift test   # protocol mirror round-trip
cd apple/WinterKit      && swift test   # daemon client library

bun run verify:workflow                # workflows e2e against the REAL compiled binary
```

`verify:workflow` matters more than its name suggests: the workflows runtime spawns the daemon's own
binary as a sandboxed subprocess, and the dev path (`bun run src/…`) and the compiled path differ.
It must stay green.

New behaviour needs a test. The bar isn't coverage percentage — it's that the *specific claim* your
change makes is pinned by something that fails when the claim stops being true.

## Changing the protocol

`packages/protocol` is the contract between the daemon and every client, in two languages. Adding or
changing a `SessionEvent` variant or an RPC method touches these, **in order**:

1. `packages/protocol/src/events.ts` (or `methods.ts`) — the zod schema
2. `packages/protocol/scripts/generate.ts` — add a canonical fixture for the new variant
3. `pnpm protocol:generate` — regenerates the JSON schema + Swift round-trip fixtures
4. `packages/core/src/agent/subagent-transcript.ts` — its exhaustiveness map fails core's `tsc`
   until you update it
5. `apple/WinterProtocol` — mirror the Swift type. Its test asserts the exact fixture count, so it
   fails until synced
6. `apple/WinterKit` — has exhaustive `switch`es over event variants (the `seq`/`sessionId`
   accessors). A new variant breaks compilation **here**, not in WinterProtocol
7. **Build WinterKit** — not just `swift test` in WinterProtocol. That's the only way to catch step 6

### Adding a *field* is more dangerous than adding a variant

Every step above is keyed to something failing to compile. **Nothing fails to compile when a
producer simply doesn't set a new optional field.** So sweep the field's producers *by meaning*: who
else writes this event, in either language, and would the consumer's fallback silently accept the
old shape? This has shipped a bug before — a correct daemon and a second, stale Swift producer
emitting the old shape past a consumer with no gate.

### Two more lockstep lists

- **The remote method allowlist** is four hand-mirrored lists: `REMOTE_ALLOWED_METHODS` in
  `packages/core/src/ipc/server.ts`, its literal parity test, Swift `Gateway.remoteAllowedMethods`,
  and its count test. Adding a remote method is a deliberate edit to all four.
- **Transient events** are one shared constant — `TRANSIENT_EVENT_TYPES` in the protocol package,
  mirrored in Swift, with parity tests both sides. Never hand-copy the strings. A new transient
  variant must also be added to `REMOTE_STREAM_EVENT_TYPES`; omitting it drops that event for every
  remote client, silently and permanently, and the parity tests will *not* catch that direction.

`session.history` and the remote stream are **allowlists, never denylists**. `reasoning_item` must
never pass either one; a security test pins that.

## Rules that bite

- **Tests must never touch `~/.clover`, or Winter's `~/.winter`.** Always point at a temp `CLOVER_HOME`.
  Never kill or restart a user's live daemon or app.
- **No setting may ever require a daemon restart.** `~/.clover/settings.json` is watched and
  hot-swapped atomically; feature code reads live getters. New settings follow that pattern — this
  is a product promise, not a preference.
- **Secrets live in the Keychain.** `Bun.secrets`, service `com.waifucave.clover.core`. Never on disk, never in
  a fixture, never in a log line.
- **Provider `encrypted_content` / `reasoning_item.itemJson` is opaque.** The session JSONL is its
  only sink. Never log it, never write it into a model-readable transcript.
- **Versions are generated.** `VERSION` (format `#.###.#` — major.feature.patch) is canonical; edit
  it only via `bun run version:bump` (patch) / `version:bump:feature` / `version:bump:major` /
  `version:sync`. Never hand-edit a version in a `package.json` or plist.
- **Minimum OS targets track the latest major Apple OS.** No legacy compatibility shims.
- **Codex's `originator` is `"clover"`.** That's a deliberate terms-of-service decision. Don't "fix" it
  to a first-party value. The value sent is `codexOriginator` in `packages/core/src/runtime-sdk/brand.ts`
  (every session's brand, and the process-wide identity `runtime-sdk/process-identity.ts` installs).
- The Sparkle public key in `apple/Winter/project.yml` is Winter's production key, which its live update
  feed depends on. Its private half exists only in one login Keychain and is committed nowhere.

## Sending a pull request

- **Branch from `main`.** Keep the PR scoped to one thing.
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) with a
  scope** — the repo's history is `feat(app):`, `fix(editor):`, `docs(brand):`, `perf(app):`,
  `chore(release):`. Match it.
- **Explain *why* in the body.** Clover's code carries unusually heavy comments explaining why
  something is the way it is, because the alternative is somebody helpfully undoing it in six
  months. Write your PR description the same way.
- **Run the tests for what you touched**, and say which ones you ran. If your change crosses the
  TS/Swift boundary, that means both sides plus an app build.
- **Don't bump the version** — releases run through `scripts/release.ts`.
- **UI changes: include a screenshot.** For anything visual, `docs/brand.md` is the source of truth
  for color and type; use the named tokens, never raw hex.

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
