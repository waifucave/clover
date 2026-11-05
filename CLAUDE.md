# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository. This file is the entry point. The hard rules at the bottom apply always.

## What this is

Clover is Winter's successor: one assistant across macOS, Windows and Linux, built from bots and plugins. Where it is going is in two documents, and they are the source of truth whenever anything else disagrees with them:

- [docs/clover-spec.md](docs/clover-spec.md) — the direction spec (names and homes in §2, what happens to each of Winter's parts in §12)
- [docs/clover-plan.md](docs/clover-plan.md) — the build plan: phases C0–C7, the lanes, the repos and how merging works

The code in this repo today is Winter's, renamed (C0). It is a TypeScript/Bun daemon (`clover-core`, package `@waifucave/clover-core`) with the `clover` CLI. They speak JSON-RPC 2.0 over NDJSON on a Unix socket (`<CLOVER_HOME>/run/core.sock`; default home `~/.clover`). The daemon is the single source of truth; every client is a view over its event stream.

**The daemon runs no agent loop of its own.** Every session is a runtime child driven through the router (`@yanlinglabs/winter-runtime-sdk`, now archived) on the agent SDK's runtime, which Clover's daemon names with its own brand (`packages/core/src/runtime-sdk/brand.ts`: `~/.clover`, `CLOVER_*`, `mcp__clover__*`). Code sessions spawn the `winter` binary (Winter's coding agent, from the SDK); chat and dispatch run the SDK embedded in `clover-core`, one Bun Worker per session. Session modes are `code`, `dispatch`, `chat`. **Cowork is paused** and not an implemented session mode — see [docs/cowork-status.md](docs/cowork-status.md).

Names that still say Winter on purpose: the SDK's npm packages (`@yanlinglabs/winter-*`, renamed when lane A republishes the SDK) and its API; Winter's coding agent and its build (`build:winter`, `dist/winter`); the Swift packages in `apple/` (`apple/Winter` is retired and not built; WinterKit and WinterProtocol serve the iOS app); computer use (Winter Computer Use, Winter for Chrome), which waits for opensky; values already on the wire or on disk; history. Each is listed with its reason in `scripts/rename/clover.ts`, and `packages/core/test/rename/clover-residue.test.ts` fails on any other.

## Commands

```sh
bun install                          # bun is the runtime; pnpm workspaces orchestrate

pnpm test                            # every workspace, serially
cd packages/core && bun test         # one package
bun test path/to/file.test.ts        # one file (substring match); `bun test -t "name"` for one test
bun run typecheck                    # every package (typecheck:core / typecheck:protocol / … for one)
pnpm protocol:generate               # REQUIRED after changing packages/protocol/src/events.ts

# Compiled-artifact gates — each builds a real binary
bun run verify:workflow              # also verify:automation-worker, verify:runtime-state, verify:runtimes, verify:embedded

# Swift — only the packages the iOS app uses
cd apple/WinterProtocol && swift test   # also apple/WinterKit

# CLI / daemon in dev — never a plain `clover` or `winter`: those are dist CLIs
cd packages/cli && bun src/main.ts daemon run   # headless daemon; `-p "hello"` one-shot; no args = TUI (a throwaway home only, below)
bun run build:winter                 # dist/winter from ../clover-sdk, for the built-binary e2e

# Live suites: WINTER_CU_LIVE_TESTS=1 bun run e2e:cu-live (NEVER from an agent); CLOVER_BROWSER_E2E=1 bun run e2e:browser (likewise)
```

Run a daemon from the checkout under plain `bun` only on a throwaway home with a throwaway Keychain service: `CLOVER_HOME="$(mktemp -d)" CLOVER_PROFILE=dev CLOVER_KEYCHAIN_SERVICE=com.waifucave.clover.core.scratch`. The dev home `~/.clover-dev` only through `bun run dev:daemon` (see Profiles). Every daemon tees its stdout/stderr into `<CLOVER_HOME>/logs/daemon.log` (`clover doctor` prints the path). Tests get a per-process temp root and a throwaway Keychain service from the preloads.

## Profiles — which daemon you are talking to

- The home and the profile are set INDEPENDENTLY: `CLOVER_HOME` picks the home (default `~/.clover`, treat it as a live install); `CLOVER_PROFILE=dev` changes only the Keychain service and the app identity, never the home. Always set BOTH — dev is `CLOVER_HOME=~/.clover-dev CLOVER_PROFILE=dev`.
- Identities: dist `com.waifucave.clover` with Keychain `com.waifucave.clover.core`; dev `com.waifucave.clover.dev` with `com.waifucave.clover.core.dev`.
- A plain `clover` is the dist CLI and, on a dead socket, tries to launch the dist app. A plain `winter` is **Winter's** dist CLI and launches the live Winter app. Never run either for dev or test work.
- `bun run dev:daemon` builds, signs and runs the dev daemon (`dist/dev/clover-core`) on `~/.clover-dev`. It refuses `~/.clover` and, by real path, every other install's home (`packages/core/src/other-installs.ts`); `clover daemon run` and `startDaemon` refuse those homes too. A boot never imports anything from another install: Migration B (`packages/core/src/migration/`) runs only for an explicit `clover migrate --from <legacy home>`, and Clover's carry-over from Winter is a later lane's.
- After the dev daemon's one-time `bun run dev:daemon --transition`, the dev Keychain items trust only the signed dev binary: never run a dev daemon or the dev CLI on `~/.clover-dev` under plain `bun`, which is prompted for every Keychain item. Use `bun run dev:daemon` (`--no-build` reuses the binary; `bun scripts/dev-daemon.ts --no-build --cli <args>` runs the dev CLI through it).
- `dev:helper` and `dev:headless` refuse to run in this repo until opensky: they would build and register Winter's Computer Use and Headless helpers under Winter's identities, replacing Winter Dev's own registrations and its native-messaging manifests.

## Where to read more

The topic files under `docs/claude/` describe **Winter's** code as it stood at the `winter-before-clover` tag. Most of it still holds for the renamed code (read `winter-core` as `clover-core`, `WINTER_*` as `CLOVER_*`, `~/.winter` as `~/.clover`), but they are reference, not rules: where one disagrees with the spec, the spec wins. Plain links, not `@` imports — read the file whose area you are about to touch.

| Read | When |
|---|---|
| [architecture.md](docs/claude/architecture.md) | Before touching more than one package, any `apple/*` or `extensions/*` target, the dev daemon, or the dev/dist split. Monorepo layout and the profiles/transition rules. |
| [runtime-and-sessions.md](docs/claude/runtime-and-sessions.md) | Before touching session create/resume, the embedded host, the `winter`/`ant` binary ladders, legacy-session adoption, model switches, the event log, per-call tool results and concurrency lanes. |
| [providers-and-credentials.md](docs/claude/providers-and-credentials.md) | Before touching a Keychain slot, `credential.*`/`provider.*` doors, the host-credential broker, the boot Keychain passes or Anthropic/Console sign-in. |
| [internal-jobs.md](docs/claude/internal-jobs.md) | Before touching titles, the bash safety reviewer, the dreamer or the session cleaner — model/effort/credential resolution and the role problems. |
| [protocol-and-remote.md](docs/claude/protocol-and-remote.md) | Before changing a `SessionEvent` variant or field (the 7-step checklist), adding an RPC method, or touching what a remote/phone client sees (allowlists, history, transients, thinking pill, phone mirror). |
| [settings-and-migrations.md](docs/claude/settings-and-migrations.md) | Before adding a setting (live reload, the one-reader rule), touching the legacy `~/.norma` home or project migration, or bumping the runtime-state schema (currently v21). |
| [runtime-home.md](docs/claude/runtime-home.md) | Before touching `<home>/sdk`, run folders, MCP/settings scopes and trust, Migration C, saved answers or the plugin format. |
| [tool-surface.md](docs/claude/tool-surface.md) | Before changing what a model can call: capability servers and plain names, deferral, chat/dispatch allowed lists, web tools, hooks, read/write fences, sandbox escapes, saved allow rules, skills. |
| [dispatch-and-messaging.md](docs/claude/dispatch-and-messaging.md) | Before touching mid-turn pushes (the fold), turn pairing, `SpawnSession`/children, `SendMessage`/`ListAgents`/`TaskStop`, `ListSessions`, or the Dispatch pill's command mode and terminal. |
| [mcp.md](docs/claude/mcp.md) | Before touching connector permissions, MCP OAuth sign-ins, URL-mode elicitation, an `mcp.*` RPC or `clover mcp`. |
| [images.md](docs/claude/images.md) | Before touching image attachments, `session.stageImage` or `images` on `session.send`/`steer`. |
| [computer-use.md](docs/claude/computer-use.md) | Before touching `packages/core/src/computer-use/**` (not `browser/`), `apple/ComputerUse/**`, the `computer_v2` tool, its policy/cards, the helper client, app adapters, the focus guardian. |
| [island.md](docs/claude/island.md) | Before touching `apple/Winter/Sources/Island/`, `packages/core/src/island/`, the hello's `capabilities`/`tty`, `island.pending`, or where an approval, question or desktop-switch prompt shows on the Mac. |
| [computer-use-browsers.md](docs/claude/computer-use-browsers.md) | Before touching `computer-use/browser/**`, `extensions/winter-for-chrome/**`, `apple/ComputerUse/WinterBrowserHost/**` or the browser link — tabs, readers, downloads, the sign-in hand-off, WebMCP. |
| [headless.md](docs/claude/headless.md) | Before touching the `headless` backend, the Winter Headless helper, its local-network rules or the Chromium embed layout. |
| [usage.md](docs/claude/usage.md) | Before touching usage and cost tracking: `packages/core/src/usage/`, the projector's `onTurnUsage`, `usage.*`, `settings.usage`, reading the user's Codex/Claude Code/Antigravity/OpenCode usage or plans. |
| [testing.md](docs/claude/testing.md) | Before running or writing tests, a verify gate, the live computer-use suite, or anything reading daemon logs/temp dirs. |
| [release.md](docs/claude/release.md) | Winter's release pipeline, for reference: Clover's is built in C7 (spec §12). |
| [cowork.md](docs/claude/cowork.md) | Before touching `packages/core/src/cowork/**`, `packages/protocol/src/cowork.ts`, `apple/Cowork/**`, `scripts/cowork-guest-artifact/**`, host-storage-fence or home-fence cowork roots, `refreshForStorage`, or the `workspace.*` / `project.*` methods and events. Cowork is paused. |

Other references: `clover-vs-cc-tools.md` (repo root, the tool comparison with Claude Code), `apple/ComputerUse/PROTOCOL.md` (the helper's wire contract), `apple/ComputerUse/WinterBrowserHost/PROTOCOL.md` (Winter for Chrome's).

## Hard rules

### Winter's live install

- **Never kill, restart, launch or write to a running Winter.app or the user's live Winter daemon.** The daily driver is `Winter.app` (`com.winter.app`) in `/Applications` on `~/.winter` with Keychain `com.winter.core`. A local Release build of the Mac app (`out/release/<version>/…/Winter.app`) carries the same bundle id and Launch Services can resolve `com.winter.app` to it at relaunch: never launch one, and never delete an `out/release/<version>` tree while a Winter process runs from it. The legacy `Norma.app` / `~/.norma` / `com.norma.core` items stay untouched as the rollback source.
- **Never launch a dist Winter instance** — `Winter.app`, a Release build, or the dist `winter` CLI, which launches the app on a dead socket. A Claude-launched dist instance is indistinguishable from the user's own in the menu bar and defeats the entire dev/dist split. Winter's dev work happens only in "Winter Dev" (`com.winter.app.dev`, `~/.winter-dev`), from the Winter checkout, never from this one.
- **Winter fixes go on `winter/maintenance`**, from Winter's own checkout. The `winter-before-clover` tag marks Winter's last commit before Clover: never move it.
- **Before C7, never build `apple/Winter` or run `scripts/release*.ts` or `bun run tap:publish`.** They produce `com.winter.app` against Winter's live update feed (`apple/Winter/project.yml`) and publish to Winter's tap; `release.ts` and `tap:publish` refuse until Clover's own release pipeline lands in C7.
- **Never run WinterKit's `winter-probe`.** Its defaults are the live Winter daemon's socket (`~/.winter/run/core.sock`) and Keychain (`com.winter.core`).
- **Never run the live suites from an agent.** `e2e:cu-live` takes over the screen (gated only by `WINTER_CU_LIVE_TESTS=1`); `e2e:browser` drives real browsers on the desktop (`CLOVER_BROWSER_E2E=1`).
- The Sparkle public key in `apple/Winter/project.yml` (`SUPublicEDKey`) is Winter's production key, and Winter's live update feed depends on it; the private half exists only in the login Keychain — never committed anywhere.

### Tests, secrets and identities

- **Tests never touch `~/.winter*`, `~/.clover*` (apart from temp homes), `~/.claude*`, or the real Keychain.** Always point at a temp `CLOVER_HOME`; every test daemon resolves credentials against a throwaway Keychain service (`packages/core/test/preload.ts` sets `CLOVER_KEYCHAIN_SERVICE`), never `com.winter.core*` or `com.waifucave.clover.core*`, which hold (or will hold) the user's real items.
- Secrets live in the OS secret store (on macOS the Keychain: `Bun.secrets`, service `com.waifucave.clover.core`) — never on disk, never in fixtures, never in a log line or an error message.
- Codex's `originator` is `"clover"` (spec §3.3) — a deliberate ToS decision; do not revert it to a first-party value. The value actually sent is `codexOriginator` in `packages/core/src/runtime-sdk/brand.ts`: it rides every session's brand, and `runtime-sdk/process-identity.ts` installs it process-wide when core loads, for the daemon's and the CLI's own provider calls (`providers/codex-config.ts` repeats it in its header table, pinned to it by a test).
- Version strings are generated; edit only `VERSION`, through the bump/sync scripts.
- Ordinary Code, plugin hooks, LSP and third-party MCP tools get no outer Cowork Seatbelt; each tool's own sandbox is unchanged, and Cowork fences only through the existing `sandboxConfigFor` deny arrays ([cowork.md](docs/claude/cowork.md)).
