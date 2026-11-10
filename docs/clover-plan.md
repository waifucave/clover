# Clover — implementation plan

Date: November 4, 2026; updated November 5 for spec revision 18. Builds [the spec](clover-spec.md) at revision 18, whose plugin section is frozen.
Status: **approved by the owner** (§12). Wave 2 is under way; the status board is [`clover-status.md`](clover-status.md).

---

## 1. How the work runs

* **Thirteen lanes, all at once.** Each lane is one big chunk of the spec, owned end to end by one Opus implementer and paired with its own Opus reviewer. The lanes are A to M (§4).
* **Four milestones per lane,** M0 to M3. Each milestone is one large pull request with one big review. There are no small tasks.
* **Contracts first.** A short spine pins every surface that crosses lanes: the manifest and the plugin API, the protocol, the core's interfaces with a fake for each, the repo layout and CI (§3). Lanes build against the contracts and the fakes, so no lane waits for another to finish; real neighbours replace the fakes as they merge.
* **Spikes run first, alongside the spine.** The spikes in spec §14.1 are their lanes' M0, so each answer arrives before its lane commits to a design.
* **Nobody waits on a review.** An implementer opens its milestone PR and goes straight on to the next milestone, on a branch stacked on the first. The review's fixes land on the milestone branch, and the controller merges it.
* **Each lane owns its paths.** Shared files belong to the controller, which merges every PR, keeps main green on all three OSes and keeps the status board (§11).
* **Live gates come last,** in one batch with the owner (§10), by the owner's standing rule.

## 2. Waves

```text
Wave 0  prepare    free disk space (an agent that checks with the other sessions first)
                   C0, the move: tag Winter, branch winter/maintenance, renames, repo transfers, fresh clone
Wave 1  start      spine: B-M0 contracts + M-M0 skeleton and CI
                   spikes, in parallel: C, D, E, H, J, K, L (each lane's M0)
                   head starts, in parallel: A-M1, F-M1, G-M1, I-M1
Wave 2  build      every lane's M1 and M2, against contracts and fakes; fakes give way to real neighbours as they merge
Wave 3  integrate  every lane's M3 · end-to-end runs across lanes on all three OSes
                   integration review · security review · release dry run
Wave 4  ship       live gates with the owner · fixes · 1.111.1
```

Wave 2 starts when the spine has merged; the spikes and head starts keep running into it. In practice Wave 2 started on November 5 while B-M0 was still in review: lanes build against B's contracts as they stand on its branch until it merges.

## 3. The spine

Lanes B and M pin these in Wave 1, and a fresh Opus reviewer checks them against the spec before Wave 2 starts.

| Contract | What it pins | By |
| :- | :- | :- |
| `packages/plugin-sdk` | The manifest's types and JSON Schemas (spec §5.9); the theme, layout, locale, index and revocation formats; the catalogs of spots, points, tokens, hooks and capabilities, as data; the plugin API and the UI API as TypeScript declarations (§5.4, §5.5) | B |
| `packages/protocol` | One file per area (plugins, approvals, sessions and bots, devices and links, computers and the tree, agents, the app and the pair, the browser, usage), each with the methods and events other lanes call; the roles and their allow lists | B |
| The core's interfaces (`packages/core/src/contracts/`) | `SecretStore`, `Fence`, `ApprovalBroker`, `PluginRegistry`, `PluginHost`, `SessionHost`, `LinkTransport`, `DeviceRegistry`, `Lease` and `Clock`, `ComputerRegistry`, `Tree`, `AgentBackend` and `BrowserApi`, each with an in-memory fake | B, with each owning lane's sign-off |
| The repo layout | `apps/desktop`, `plugins/clover/*`, `plugins/alpha`, `services/*` and `native/*` (§7) | M |
| CI | macOS arm64, Windows x64, Ubuntu x64 and arm64: typecheck, tests, the daemon binary for all four targets, and an unsigned app for each OS | M |
| The test harness | Temp homes, a throwaway secret store on each OS, several daemons in one test joined by the fake link, a fake app client, local emulators for the outside services, and the heavy-job limiter (§8) | M |
| The dev profile | `~/.clover-dev` with the `com.waifucave.clover.core.dev` secret service, and scripts to run the dev daemon and dev app | M |

After Wave 1 a contract changes only through the controller, which tells every lane that uses it.

## 4. The lanes

| Lane | Name | Spec | Spikes | Release blocker |
| :- | :- | :- | :- | :- |
| A | Runtime and model plugins | §3.3, §6.1, §6.3, §6.4, §6.7, §6.8 | — | |
| B | Plugin system | §5.1–§5.4, §5.6, §5.9, §6.8 | — | |
| C | Platform and security floor | §3.1, §4, §5.5, §9.1, §12 | S2, S8 | Windows bash |
| D | Bots, sessions and routines | §6, §7 | S4 | |
| E | App runtime | §3.1, §5.5, §5.8 | S9 | |
| F | Shell and conversation UI | §5.5, §5.8, §9.3 | — | |
| G | Surfaces, avatar and look | §5.5, §6.2, §6.6, §10 | — | |
| H | Links, identity and sync | §6.4, §8 | S1 | |
| I | Cloud services and companions | §7, §8.3, §8.4, §10 | — | |
| J | Computers and the folder tree | §9.1, §9.2 | S6 | |
| K | Agents | §9.3 | S5 | Winter's coding agent over ACP |
| L | The browser | §12.1 | S7 | |
| M | Build, CI and release | §2, §12, §13 | — | |

Every lane runs on this Mac, in its own worktree, with CI for the other OSes (§8). Lane C also uses the Windows and Linux VMs.

### A. Runtime and model plugins

* **Owns:**
  * the `clover-sdk` repo, except its sandbox (C) and its ACP package (K)
  * `packages/core/src/runtime-sdk/`
  * `plugins/clover/model-*` and `plugins/clover/web`
* **M1, the embedded runtime:**
  * the router removed, and code sessions embedded
  * the provider adapter interface on the keyed fetch (`net.fetch`), with SigV4 in a process of its own; the key's placement comes from the `auth` entry, never the call (spec §5.4)
  * the SDK's default brand required at the session boundary, failing closed (pulled forward from M2, so a missed thread can't land on the live Winter home); C0's `process-identity.ts` stays, calling the SDK's `installBrandIdentity`
  * the catalog row schema pinned
  * the conformance kit renamed and adapted
* **M2, every provider a plugin:**
  * each provider moved into `plugins/clover/model-<provider>/`, with its adapter, catalog and sign-ins
  * each loaded through the plugin host (B's fake until B-M2)
  * conformance passing for every one
  * Codex's `originator` set to `"clover"`
* **M3, the turn loop:**
  * hook events wired for B, from `tool.before` to `compact.*`
  * `Glossary` replacing `Skill` and `ToolSearch`
  * the harness-owned prompt blocks: bot instructions, the MCP block rebuilt at compaction, devices, safety
  * cache-timed compaction
  * user interrupts and fold-in
  * in-process subagents for K
  * the web plugin (`mcp__clover__WebSearch` and `mcp__clover__WebFetch`)
* **Needs:** the spine; B-M2 for real plugin loading.
* **Done when:** conformance is green for every provider, and the core's session tests pass on all three OSes with no router.

### B. Plugin system

* **Owns:**
  * `packages/plugin-sdk`, except `src/ui/` (E)
  * `packages/core/src/{plugins,registry,plugin-host,hooks,commands,glossary}/`
  * the `clover plugin …` commands
  * `packages/protocol/src/plugins.ts`
* **M0:** the spine's contracts (§3). Its token catalog is the one source of theme-token names (G's names, as `--clover-` properties, spec §5.5), and it adds the helper that keeps string caps in UTF-16 units on the wire, before M bumps zod.
* **M1, the registry:**
  * watching the folder, with its 2-second settle
  * manifests, ids, formats and child plugins
  * the tree hash and plugin states
  * data, web or code, and network hosts
  * the OK and its re-ask triggers, as cards through C
  * development folders
  * `clover plugin validate`, with `--json` and `--upgrade`
* **M2, the plugin host and its API:**
  * Bun workers, Node processes and helpers, with crashes, heartbeat and logs
  * two plugin-host processes, `clover`'s and third parties', chosen from the install record (spec item 84)
  * the macOS sandbox profile (with C)
  * points, schemas, formats, one declarer, and versions
  * `points.*`
  * commands, with `command.run` and `command.list`
  * `host.call`, `host.on` and `ui.send`
  * storage
  * the keyed fetch, with placements from the `auth` entry and echoed keys stripped, and `secrets.get`, on C's `SecretStore`
  * the waifucave account token and `keys.publicKey` and `keys.open`, for `clover`'s plugin host only
  * settings, the caller and `confirm`
  * capability gating
  * the hooks point (with A)
  * the `Glossary` index and tool
* **M3, getting plugins in:**
  * wrappers for MCP configs, skills, agent files and Claude Code plugin folders
  * indexes, signatures, revocation and npm installs
  * updates
  * add-ons of a plugin's own
  * the 18+ gate
  * `clover plugin new`, with its templates and bundled skill
  * docs generated from the catalogs
* **Needs:** C-M1's `SecretStore` and approvals, faked until then.
* **Done when:** every bundled plugin loads through it, and the plugin-API suite passes on all three OSes.

### C. Platform and security floor

* **Owns:**
  * `packages/core/src/{ipc,auth,lock,platform,secrets,fence,approvals,levels,reviewer,migration}/`
  * `native/sandbox/`
  * the sandbox in `clover-sdk`
  * the `winter/maintenance` branch
  * login start, as a command of the daemon's own; packaging is M's
* **M0, spikes S2 and S8,** on the Windows VM (§8) ([report](research/2026-11-05-s2-s8-fence-and-secrets.md)):
  * Git Bash (MSYS2) and PowerShell inside AppContainer or a restricted token: only a dedicated sandbox principal worked, so Bash runs as one (spec item 76)
  * the secrets file, with its key in the OS store, hidden from Bash while `gh`, Docker and git keep the OS store
  * bubblewrap with the D-Bus filter
* **M1, the daemon everywhere:**
  * sockets and pipes; on Windows, pipe handles with an explicit inherit list (`STARTUPINFOEX`)
  * login start on all three OSes: `clover-core login enable|disable|status` writes and removes a launchd agent with `ThrottleInterval` (or `SMAppService` when the app registers it), a Task Scheduler logon task that runs `clover-core supervise`, or a systemd user unit; `supervise` is C's too, and M's installers call the command
  * one daemon per home, under an OS lock
  * roles and tokens, matching B's protocol roles and allow lists
  * the caller check, with each OS's sandbox floor, the principal and how a process was started, and the two plugin-host processes told apart (spec item 84)
  * the daemon's side of the pair, with E-M1's app side over B's "the app and the pair" protocol
  * the levels' total order confirmed: read only < ask < ask for risky actions < accept edits < fully automatic
  * on Linux, spawning only through `Bun.spawn` until the `node:child_process` stall is isolated (the recipe is in the S7 report)
* **M2, the fence:**
  * Bash and PowerShell under the fence on all three OSes, with network denied (confirmed against Winter's real behaviour) and the escape floor's metadata block
  * the fenced set, the read fence and the escape floor, with transcripts, usage rows, per-bot browser profiles and the login-start locations of all three OSes in the set
  * on Windows, nothing carrying over: a principal per running session or one session at a time, the profile and hive reset per session, measured on every launch and failing closed, and per-session grants and temp folders
  * `/proc/<pid>/fd` denied on Linux (a PID namespace in bubblewrap), and process access denied on Windows
  * the Windows credential broker and its git, Docker, gh and ssh-agent adapters (spec item 76), and the Linux Secret Service broker
  * the secrets file, and the macOS Keychain ACL
  * the fence and secret hiding for the `clover-link` sidecar, which holds the device key (with H and M)
  * the git credential helper
  * the local approval level and the rewritten reviewer
* **M3, approvals and the hand-over:**
  * sealed-card data: fields, ids, hashes and signed answers
  * the 10-minute rule, by turn origin
  * `confirm` and sensitive changes as cards
  * the final Winter release that hands credentials over, built from `winter/maintenance`; cutting it needs the owner's go-ahead
  * the migration of Winter's settings and logins
* **Done when:** the fence suite passes on all three OSes in CI, and Bash works end to end on Windows.

### D. Bots, sessions and routines

* **Owns:**
  * `packages/core/src/{sessions,bots,memory,routines,usage,voices}/`
  * `plugins/alpha`, except its tab look (G)
  * `plugins/clover/{trigger-schedule,trigger-webhook,fish-audio}`
* **M0, spike S4:** Fish Audio's free voice, against a recorded fake until the live gates; folded into M1.
* **M1, a bot:**
  * the `bot` entry end to end
  * Alpha
  * one bot per plugin, and pack ids
  * the user layer
  * one continuous conversation, with side threads
  * usage counting
* **M2, a life:**
  * interrupts, fold-in and cache-timed compaction (with A)
  * the main computer from H, faked until H-M2
  * memory at its pre-C5 paths
  * `SendMessage` and `ListAgents` for bots
  * the pause switch
  * a session's changes and diff, the backend of F's diff panel
* **M3, routines and voice:**
  * routine files and the routine engine, with time zones and missed runs
  * raised levels as cards
  * the schedule and webhook triggers, on the forwarder's pull model (`next`, `ack`, `drop`, dropped deliveries listed)
  * the `Routine` tool
  * the `voices` point and the Fish Audio plugin
  * migrating Winter's routines and its `_assistant` memories
* **Needs:** A-M1 and A-M3, B-M2, H-M2, and I-M1 for the forwarder.
* **Done when:** Alpha keeps one conversation, with memory, across restarts; routines fire; and voice works in tests.

### E. App runtime

* **Owns:**
  * `apps/desktop`, except `src/main/browser/` (L)
  * `packages/plugin-sdk/src/ui/`
  * `native/input/`
* **M0, spike S9** ([report](research/2026-11-05-s9-layers.md)):
  * layers as out-of-process frames, one per plugin origin, and the memory each costs
  * menus, focus, keyboard and drag and drop across layers
  * the declared-host checks: WebRTC stays a known gap on stock Electron (spec item 94)
* **M1, the shell's host,** on stock Electron with no patches (spec item 94):
  * the Electron main process: windows, and the tray or a launcher Quit
  * the app's side of the pair: installing and starting the daemon, crash restarts, safe mode, Quit, and Hand over and quit, with a main-process heartbeat the daemon watches
  * the protocol client
  * UI halves loaded into layers, through core-issued single-use mounts, with layer crashes found by a process-ID census and shown with a reload
  * the main process's shortcut table, the menu broker and focus return
  * the island and the pill as related windows
  * `<Spot>`, keyed defaults, precedence and the smaller-part measure
  * style and hide entries, `needs` and `keep`
  * plugin webContents with `Connection-Allowlist` and the `disable_non_proxied_udp` WebRTC policy, and S9's PAC belt and preload stub off; plugin sessions with spellcheck downloads off and an explicit proxy on every session; S9's remote-candidate check rerun on every Electron upgrade
* **M2, looks and words:**
  * the theme engine: tokens, the stack and the CSS cleaner
  * layouts and web views
  * translations: `t()`, packs and trusted card strings
  * the welcome setup guide
  * safe mode
* **M3, the sealed path:**
  * sealed card frames, with the hardware-click check on each OS
  * visibility, and the 2-second fallback card
  * `<Card>` placement, and the hold on new card styling
  * `confirm` and the OK cards
  * sends counted as the user's
  * MCP Apps views and their bridge
* **Needs:** C-M1 for the pair, and C-M3 for card data.
* **Done when:** S9 passes, the sealed-card security tests pass on all three OSes, and a third-party shell can replace `app.root`.

### F. Shell and conversation UI

* **Owns:** `plugins/clover/{shell,sidebar,conversation,composer,panel,panel-terminal,panel-diff,panel-files,settings,bot-editor,plugin-index,archive}`. `panel` is the panel host, and each panel is its own plugin, `panel-<name>`; the browser panel is L's `browser-view`. The panels' backends are other lanes': the terminal's PTY and the files tree are J's, a session's changes and diff are D's, and the agents are K's.
* **M1, the parts,** as plain React against mocked props:
  * the conversation view, with every message kind, streaming and thinking titles
  * the composer
  * the sidebar
  * the panels, the settings modal and the language chooser, which started early for the owner's Claude-style layout
* **M2, on the runtime:**
  * the default shell in `app.root`, declaring the catalog's spots, laid out and measured like Claude's desktop app (spec items 83 and 86)
  * the bot tab and the panels: a bot's slim column (agents and tasks, context, outputs) and the browser panel, its agents opening in the right panel as transcripts; a code session's full set (spec item 90)
  * the settings screen: plugins with their states, OKs and logs; levels; devices; the account; themes; language
  * the bot editor and the plugin index browser
  * the archive of old Winter sessions
  * the add-on spots
  * live tabs for agents

  Built against B's UI API and mocks until E-M1's `<Spot>` lands, with the gallery as the proof.
* **M3, finishing:**
  * every sensitive change made through a card
  * every string through a `clover.` key
  * the command palette and shortcuts
  * the 18+ gate
  * accessibility
* **Needs:** E-M1 and E-M2.
* **Done when:** everything in the 1.111.1 floor can be done from the default shell.

### G. Surfaces, avatar and look

* **Owns:**
  * `plugins/clover/{island,pill,notifications,usage,vrm,live2d,base-theme}`
  * `plugins/alpha/tab` and Alpha's assets
* **M1, the look:**
  * the base theme
  * Alpha's tab theme and layout
  * the VRM renderer in the stage's `avatar` spot, with lip-sync
  * the island and the Dispatch pill rebuilt in React, from the Swift reference
* **M2, the surfaces, and Live2D:**
  * the island as an `app.surface`: the same top-centre island on all three OSes, themed by tokens, at the notch or growing from the top edge, and as a normal window on Wayland (spec item 82)
  * the island's Needs you, Usage and Devices tabs
  * the Dispatch pill, with `pill.target`
  * desktop notifications
  * the usage views
  * the Live2D renderer, `plugins/clover/live2d`, on Mochi2D (`@waifucave/mochi2d`), with the VRM renderer's caps and lip sync from the speech feed only; Alpha's avatar becomes Live2D, with a code-made placeholder until the owner supplies the model (spec item 87)
* **M3, finishing:**
  * all three OSes
  * translations
  * card styling in the island and the pill
* **Needs:** E-M1 and E-M2; H for the Devices tab.
* **Done when:** the island and the pill work on all three OSes, and Alpha's tab, avatar and voice are complete.

### H. Links, identity and sync

* **Owns:**
  * `packages/core/src/{identity,devices,links,sync,lease,clock}/`
  * `plugins/clover/{relay-n0,relay-cloud-computer}`
  * `native/link/`, the `clover-link` sidecar that holds iroh, and `native/link-sidecar/`, S1's lab code
* **M0, the lab half of spike S1** ([report](research/2026-11-05-s1-transport.md)):
  * iroh under Bun and inside `bun build --compile`, on all three OSes
  * punching through routers with no relay, and quinn as the alternative
  * delay and throughput
  * WebRTC from the browsers (with I)

  The runs on real networks wait for the live gates.
* **M1, identity and links:**
  * device keys, and an answer key apart from the link key, app-held where the OS can protect it (spec item 91)
  * waifucave accounts, against a local sign-in stack, with tokens signed ES256 or EdDSA and checked against a JWKS
  * pairing by code or QR, with the word check
  * revocation and rotation; a revoke also calls the forwarder's and push's device DELETEs
  * the device registry, ready for the account-less lease
  * one persistent link per device pair, behind `LinkTransport`, with prioritised streams and fast reconnects, through the `clover-link` sidecar: the dial policy per pair and QAD (spec items 79 and 80), stream windows sized per path, congestion control, and re-dials on network changes and wake
  * the handshake client for devices paired without an account (spec item 81), to I's wire format and the controller's rulings, and the group record their lease uses (with I)
* **M2, the main computer:**
  * the lease, takeover and fencing the old main, for devices without an account too, through the handshake service's group record (spec item 85, with I)
  * the shared clock
  * sleep and hand-over
  * RPC and events over links, for remote clients
* **M3, sync:**
  * transcripts
  * credentials and the refresher
  * memories
  * the routine list
  * installed plugins
  * settings and access
  * the n0 and cloud-computer relays
* **Needs:** C-M2 for secrets, B-M1 for the plugin list, D for transcripts and memory, and I-M2's handshake service.
* **Done when:** three test daemons pair, sync and hand over cleanly in CI, through relays too.

### I. Cloud services and companions

* **Owns:**
  * `services/`
  * `plugins/clover/{forwarder,push,relay-cloudflare,companion-ios,companion-web}`
  * the `clover-ios` repo
* **M1, webhooks and push,** all on local emulators:
  * the forwarder's Worker and Durable Object: holding, caps, hibernation and limits
  * the forwarder's plugin
  * waifucave push and its notifier
* **M2, the relay, the web and the handshake service:**
  * the waifucave handshake service for devices paired without an account (spec item 81): its wire format first, as a doc in `services/handshake/`, then the service, with room for their lease (spec item 85)
  * the Cloudflare relay and its plugin
  * the web companion: WebRTC or WebTransport to the user's computer, signalled through waifucave
  * CORS on push for the web companion
* **M3, the iOS app:**
  * the phone's gateway moved into the daemon
  * the iOS `companions` plugin
  * the Swift app pointed at Clover
  * cards answered with the device's signature
* **Needs:** H-M1 and H-M2.
* **Done when:** each service passes on its local emulator, and the iOS app talks to a dev daemon.

### J. Computers and the folder tree

There are no OS mounts (spec item 88): each computer's daemon serves its own tree over the link, behind its own fence.

* **Owns:**
  * `packages/core/src/{computers,tree}/`
  * the PTY behind the terminal panel, and the tree data behind the Files panel
  * `plugins/clover/{provider-gcp,provider-hetzner}`
  * `infra/image/`
* **M0, spike S6** ([report](research/2026-11-05-s6-mounts.md)): FSKit, FUSE and WinFsp mounts, failing fast, and `git status` and builds across a mount. The owner then ruled mounts out, and the prototype moved to `spikes/s6-mounts/native/` as evidence.
* **M1, the tree,** on the fake link with several daemons:
  * the computer registry, with holds, the user-working mark and `computers.control`, kept for opensky
  * the tree on each computer, served by the holder behind its fence (case and Unicode folding, links)
  * file tools and Bash run where the files are (with A), routed through B's `Tree` and `ComputerRegistry` contracts
  * an answer at once when a computer is offline, with S6's bound
  * a tree-data API for F's Files panel: list, watch and read under a root, behind the fence (through B where it is protocol)
* **M2, across computers:**
  * the cross-computer tree, and the direct path for moves and copies (spec item 89)
  * approvals that follow the files
  * MCP tools with `computer`, `saveTo` and Mirror (with B)
  * levels per computer
  * the PTY backend for code sessions' terminal panel, on the computer that holds the session's folder
* **M3, cloud computers,** on real links:
  * the `computer` point
  * the GCP and Hetzner provider plugins, against fakes until the live gates
  * the official image
  * the cards for creating, resizing and deleting
  * single-use pairing tokens
  * the cloud metadata address blocked
* **Needs:** H-M1 for real links, C for levels, and A for tool routing.
* **Done when:** a bot works across two test daemons as one tree on all three OSes.

### K. Agents

* **Owns:**
  * `packages/core/src/agents/`
  * `plugins/clover/agent-*`
  * the ACP package in `clover-sdk`
* **M0, spike S5:** Cursor's and Antigravity CLI's ACP, and MCP servers passed at `session/new` ([report](research/2026-11-05-s5-acp.md)).
* **M1, the Agent tool:**
  * the ACP client
  * the bridge MCP server and its token
  * `Agent`, with local placement
  * background agents and task notifications
  * `TaskStop` and `ListAgents`
  * transcripts
  * the stall watchdog
  * the agent API that F's slim column needs (spec item 90): a live transcript stream per agent, sending a running agent a message, setting its model, and listing a bot's running agents, in B's protocol
* **M2, the backends:**
  * each agent's own sandbox with the fenced set denied, and the OK for an agent with none
  * Claude Code, Codex, Grok, Gemini CLI, DeepSeek, Cursor (with its folder as the boundary, spec item 78), Antigravity CLI and Devin
  * skills, agent definitions and shimmed hooks placed in Claude Code
  * live tabs (with F)
  * direct coding sessions
* **M3, the release blocker:**
  * Winter's coding agent speaking ACP
  * in-process subagents (with A)
  * placement on other computers (with J)
  * the first vendor cloud-agent backend (Devin's cloud, over ACP, is a candidate)
* **Needs:** B-M2 for the bridge's plugin tools, C-M2 for the fenced set, A-M3 and J-M2.
* **Done when:** every backend passes the agent suite, and Winter's coding agent runs over ACP.

### L. The browser

Computer use is not in 1.111.1: it comes later as opensky (spec item 75). The core's holds, the user-working mark and `computers.control` stay, in J.

* **Owns:**
  * `plugins/clover/{browser,browser-view}`; `browser-view` fills the shell's `panel` keyed `browser`, from F's design
  * `apps/desktop/src/main/browser/`
  * `packages/core/src/browser/`
* **M0, spike S7** ([report](research/2026-11-05-s7-browser.md)):
  * tabs moving between headless and shown without reloading
  * hidden tabs' throttling and screenshots
  * Wayland
  * Chrome for Testing
* **M1, the Clover Browser,** on stock Electron with no patches (spec item 94):
  * bot tabs drawn offscreen and shown through the browser view's viewport (spec item 92), and, while a screen reader is on, new bot tabs as views in the hidden host window (spec item 93); the person's tabs as `WebContentsView`s; per-bot partitions
  * the CDP allow list
  * hidden screenshots
  * the plugin API (`browser`)
  * the browser view, with copy and drag-select in a viewport tab as assertions
  * `mcp__clover__Browser`
* **M2, beyond one screen:**
  * the streamed view for other devices, as video
  * the headless browser where no app runs: Chrome for Testing's headless shell, pinned to the Chromium of the app's Electron
  * the `computer` field across computers
* **M3, finishing:** all three OSes, and the browser's live-gate script.
* **Needs:** E-M1 for the Electron main process, and J-M2.
* **Done when:** the browser suite passes on all three OSes.

### M. Build, CI and release

* **Owns:**
  * the root build config (with the controller)
  * `.github/workflows/`
  * `packaging/` and `scripts/release/`
  * the app's builder config
* **M0, the move and the skeleton:** C0's renames (§7), then the spine's layout, CI (including `plugins/**` and `services/**`), harness and dev profile (§3).
* **M1, packages:**
  * the dmg and Homebrew
  * the Windows installer and winget
  * deb and rpm with the AppArmor profile, and the AppImage
  * the app installing the daemon and its login item, through C's `clover-core login` command
  * CI and the daemon moved to Bun 1.4.x, after the full suites and A's soak
  * the child plugins moved to `plugins/clover/plugins/<child>/` in one commit (§7)
  * zod bumped, once B's UTF-16 helper is in
* **M2, updates and the pipeline:**
  * electron-updater for both halves: channels, the idle gate and signatures
  * the release pipeline: versions, the name scan and the privacy scrub
  * macOS signing and notarization, the `clover-link` sidecar included
  * Windows unsigned
  * Linux repositories
  * the headless shell's pin moved with every Electron upgrade
* **M3, dry runs:** pre-release builds on all three OSes, ready for the live gates.
* **Needs:** E-M1, for an app to package.
* **Done when:** a pre-release installs and updates itself on all three OSes.

## 5. The critical path

Three chains set the end date, and their lanes get first claim on machines and reviews:

1. **Windows bash:** C-M0, then C-M2. It is a release blocker, and its spike is the riskiest.
2. **The app:** the spine, then E-M1, E-M2 and E-M3, with F and G following E.
3. **From devices to agents:** H-M1 and H-M2, with I-M2's handshake service, then J-M2, then K-M3, which also needs A-M3. K-M3 ends with Winter's coding agent speaking ACP, the other release blocker.

Everything else runs beside these chains. A spike that fails reroutes its lane: the controller proposes the change to the spec, and asks the owner when a [D] is involved.

## 6. Reviews

* **Every milestone gets a full review** from its lane's reviewer, covering:
  * the spec sections the lane owns
  * the contracts
  * the tests, with CI on all three OSes
  * every trust boundary the change touches

  The reviewer ranks its findings by severity. The implementer fixes them on the milestone branch, the reviewer checks the fixes, and the controller merges.
* **A reviewer stays with its lane,** resumed for each milestone, so each review builds on the last. When its context fills up, it hands over to a fresh reviewer with a summary.
* **Three fresh reviews cross lanes:**
  * the spine review, before Wave 2
  * in Wave 3, an integration review of the whole system against the spec
  * in Wave 3, a security review of every trust boundary: sealed cards, the fence, the caller check, secrets, the OK and its triggers, add-ons, MCP Apps and declared hosts

## 7. Repos, branches and merging

* **C0, the move:**
  1. Tag the last Winter commit, and branch `winter/maintenance` from it for the hand-over release.
  2. Transfer and rename the repos:
     * `yanlingLabs/winter` to `waifucave/clover`
     * `winter-agent-sdk` to `waifucave/clover-sdk`
     * `winter-ios` to `waifucave/clover-ios`
     * and archive `winter-runtime-sdk`

     GitHub redirects the old names, so the installed Winter keeps updating; its feed lives on `updates.yanlinglabs.com`.
  3. Clone them fresh into `Xcode progects/WaifuCave/`, and copy Claude's memory to the new path.
  4. Rename everything in the code, reusing the repo's rename codemod:
     * the npm scope
     * package and binary names (`clover-core`, `clover`)
     * product strings, homes and identities (spec §2)
     * Codex's `originator`
     * a new `CLAUDE.md`, keeping every rule that protects the live Winter install
     * Winter's `docs/claude/` marked as reference
  5. Keep the controller session in the old folder until the owner restarts Claude Code in the new one. The old folder stays as it is until the owner deletes it.
* **The layout:**

  ```text
  packages/protocol · core · cli · plugin-sdk
  apps/desktop                the Electron app
  plugins/clover/plugins/<child>  everything bundled under clover, as the installed tree has it
  plugins/alpha               Alpha
  services/<service>          Cloudflare Workers and the web companion
  native/<area>               per-OS helpers: sandbox, input, link (the clover-link sidecar), link-sidecar (S1's lab code)
  apple/                      WinterKit and WinterProtocol (iOS); ComputerUse and Winter (reference only, not built)
  ```

  The repo mirrors the installed tree, so a child of `clover` lives at `plugins/clover/plugins/<child>/`. Lane M moves every child there in one commit, once the open milestone PRs that add children have merged; until then they sit at `plugins/clover/<child>/`, and §4 names them that way. Tests and scripts resolve a child's path from one place, never hard-coded. There are no OS mounts (spec item 88), so there is no `native/mounts/`.

* **Worktrees and branches:** each lane works in its own worktree (`WaifuCave/wt/<lane>`), on branches named `lane/<x>-m<n>`, from `origin/main` unless its brief stacks it on another lane's branch. Every lane opens one PR per milestone, and CI must pass on all three OSes before a review closes.
* **Merging:**
  * Main requires the `gate` check. A lane merges `origin/main` into its branch before it asks for review.
  * The controller merges with merge commits, tags each milestone, and regenerates generated files at merge.
  * The controller owns the root config, CI, `CLAUDE.md`, `docs/` and the protocol's index.
  * A lane changes only its own paths and its own protocol file; anything else goes through the controller.
* **Upkeep:** lanes rebase on main at least once a day, and remove their worktree and build outputs after their last merge.

## 8. Machines

Every lane shares this Mac. So:

* **Disk, in Wave 0:** an agent frees space by removing old builds, dead worktrees and other leftovers. Before deleting anything another session might use, it checks with that session: "GitHub repo setup (fork)" (the overthrown project), `norma-v2-71` and `waifucave-a6`. It never deletes unmerged work it hasn't backed up, and it leaves the live Winter install alone.
* **Every lane runs on this Mac,** each in its own worktree, with CI for the other OSes: Windows, Linux and the app builds. Remote cloud agents turned out not to be available from the controller's session (the Agent tool's remote isolation ran lane H in a local worktree), so the six lanes once planned as remote (A, B, D, F, H and K) run here too.
* **Heavy jobs here:** a limiter (`scripts/heavy`, eight slots) queues every Electron or native build, every full test suite and every Xcode build. Agents run only their own scoped tests outside it.
* **CI:** runs the full suites, every Windows and Linux build, and every app build.
* **Windows and Linux VMs:** a Windows VM and an Ubuntu 26.04 VM on Google Cloud, through the owner's `gcloud` login, for lane C (and E's Windows checks). The Windows VM runs Windows Server 2025, since Google Cloud offers Windows 11 only on sole-tenant nodes; both share the 24H2 base, and a real Windows 11 machine is still live gate 3. A VM starts only when a lane needs it and stops as soon as the lane is idle; it is never left running.
* **The screen:** no agent opens an app window, takes focus or plays sound on this Mac while the owner works here. Electron and browser tests run offscreen or headless here, and UI tests with real windows run in CI, under xvfb on Linux and on macOS runners.
* **Outside services:** local only until the live gates (§12). Workers run under wrangler's local emulator, waifucave sign-in against a local stack, and Fish Audio and the cloud providers against fakes.

## 9. Rules for every agent

Every brief carries these:

* **Leave Winter alone:**
  * Never touch the live Winter install: `Winter.app`, `~/.winter*` or the `com.winter.core` Keychain.
  * Never touch `~/.claude*` or the real Keychain from a test.
* **Isolation:**
  * Tests use temp homes and a throwaway secret store.
  * Dev work uses only the Clover dev profile, `~/.clover-dev`.
* **Secrets:** never on disk, in fixtures, in logs or in error messages.
* **Paths:** change only your lane's paths; ask the controller for anything else.
* **Heavy jobs:** go through `scripts/heavy`, and run only the suites your change touches; CI runs the rest. No app windows, focus or sound on the owner's screen.
* **Off limits:** `docs/research/2026-10-16-cowork-mac-review.md`, and `waifucave/Lively2D-research`, the dirty room (spec item 87): never open it.
* **Nothing outward-facing without the controller:** no deploys, no package publishing, no cloud resources, no GitHub settings, no real outside accounts, and no messages to anyone. The controller asks the owner.
* **Commits, tags and PR bodies:** plain messages, with no Claude session links or trailers, and never the owner's first name.
* **Stop and report** when the spec conflicts with itself, a decision ([D]) seems wrong, or a spike's result would change the spec.
* **A report at every milestone:** what landed, the tests run on each OS, any departure from the spec, and what the next milestone starts with.
* **Clean up** your worktree and build outputs after your last merge.

## 10. Live gates

These run in one batch with the owner, at the end:

1. **The transport (S1) on real networks:** home Wi-Fi, mobile, carrier-grade NAT, and one strict NAT.
2. **Two real computers and the phone:** pairing, takeover (with and without an account), sync, and the folder tree across the two: file tools, Bash and the Files panel on the other computer's folder over the real link, a move and a copy of a project by the direct path, a lid closed mid-copy and a Wi-Fi switch, the holder's fence from the other side, and the streamed browser view decoded on the phone. There is no mount and no System Settings step.
3. **A Windows 11 x64 machine:** installing, Bash under the fence and its credential broker, the logon task with `clover-core supervise`, the holder's fence on NTFS (short names, trailing dots, other case), the island, input across layers, and the browser at 150 % and 200 % scaling.
4. **Ubuntu 26.04 and Fedora:** the deb and rpm, bubblewrap and the Secret Service broker, a headless computer with no TPM (reboot, sealing and hiding), and GNOME and KDE on Wayland: no window of the app's while bots work, input across layers, and the screen-reader host.
5. **macOS:**
   * sealed cards answered with real clicks
   * the island at the notch
   * Alpha's avatar and voice, with the owner's Fish key
   * the browser: a bot's tab shown through the viewport and back (IMEs, a trackpad, a Retina and a 120 Hz display), with VoiceOver and the screen-reader host
   * input across layers: real typing, shortcuts, IME windows and file drags
6. **The outside services for real:** waifucave sign-in, the forwarder, push, the Cloudflare relay and the web companion, after their first deploys.
7. **The iOS app on a device:** chat, cards and push.
8. **The web companion,** from Chrome, Firefox and Safari, the streamed browser view included.
9. **A cloud computer** created on Hetzner or GCP, which costs money, and taken on as the main computer.
10. **A webhook** through `hooks.waifucave.com` firing a routine.
11. **The migration from Winter** on the owner's real install: the hand-over release, credentials and settings, with a backup taken first.
12. **The release:** a signed and notarized dmg, winget, the deb and rpm repositories, and electron-updater moving a pre-release to 1.111.1.

Then the owner decides whether to ship.

## 11. The controller

The controller is the Claude session that runs this plan, and it:

* writes each lane's brief, from this plan, the spec sections and §9
* keeps the status board, `docs/clover-status.md`: lanes, milestones, PRs, blockers and the next merges
* merges reviewed milestones, keeps main green, and tells lanes about contract changes
* folds spike results into the spec: [P] changes directly, anything touching a [D] through the owner
* checks that lane C stops the VMs when idle, and never leaves one running idle
* watches for stalled agents, resuming them or handing their work to a fresh agent with a summary
* hands a lane's work to OpenCode or Cursor unchanged when a safety classifier stops a Claude agent, by the owner's standing rule (only Claude agents run otherwise; Codex is out)
* asks the owner every question through the questions tool, recommended option first

## 12. Decisions (the owner, November 4)

1. **C0:** yes, after renaming Wyrmhole to Clover, the bundled `wyrm` plugin to `clover`, and the phases to C0–C7 (spec items 74 and 75). The repos are named `waifucave/clover`, `clover-sdk` and `clover-ios`, in the org's lowercase style.
2. **Where lanes run:** split. The six lanes that need no Mac run remote, cloud sessions run the Linux tests, and an agent frees disk space first after checking with the other sessions. Since remote agents weren't available, every lane runs on this Mac, with CI for the other OSes (§8).
3. **Windows and Linux:** cloud VMs on Google Cloud through the owner's `gcloud` login, started when needed and always stopped after. Computer use leaves 1.111.1, so only lane C needs Windows interactively.
4. **Outside accounts:** local only until the live gates.

The owner's later decisions, items 76–94 of November 5, are in the spec (§14.2), and the controller's rulings are on the status board.
