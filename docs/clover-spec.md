# Clover — direction spec

Date: November 5, 2026 (revision 18: the owner's decisions 76–94, the spikes' results and the controller's rulings)
Status: **draft for the owner's review**, and the contract the lanes build to ([the plan](clover-plan.md)). It records the direction and the decisions made so far. **[D]** The plugin section (§5) is frozen as of revision 16, by the owner's stopping rule; later changes to it come from building C1 and C2 (§14.2 item 73). Revision 17 renames the product Clover and moves computer use after 1.111.1 (items 74 and 75), by the owner's decision; neither changes how plugins work. Revision 18 changes §5 where the owner decided it (items 77, 83, 84, 86, 87, 90, 91 and 94: shared parts, the default shell, the two plugin hosts, avatars, card answers and WebRTC), and adds **[P]** details from building C1 and C2: S9's mounts, input and state, and the controller's rulings on the keyed fetch, theme tokens and per-computer keys.
Source repo at writing: `yanlingLabs/winter` @ `eccdda6c2` (Winter 0.124.0); revision 18 against `waifucave/clover` @ `7b1c56911`
Companion research: [Claude mods vs DeepSeek Harness plugins](research/2026-11-02-claude-mods-vs-deepseek-harness.md), [the plugin model proposals](research/2026-11-03-wyrmhole-plugin-model-proposals.md), [the final review of revision 11](research/2026-11-03-wyrmhole-spec-final-review.md), [the second review of revision 12](research/2026-11-04-wyrmhole-spec-second-review.md), [the plugin-ecosystem review of revision 13](research/2026-11-04-wyrmhole-plugin-ecosystem-review.md), [the check of revision 14](research/2026-11-04-wyrmhole-spec-rev14-check.md), [the last check, of revision 15](research/2026-11-04-wyrmhole-spec-rev15-check.md)
Spike reports (November 5): [S1 transport](research/2026-11-05-s1-transport.md), [S2 and S8 fence and secrets](research/2026-11-05-s2-s8-fence-and-secrets.md), [S5 ACP](research/2026-11-05-s5-acp.md), [S6 mounts](research/2026-11-05-s6-mounts.md), [S7 browser](research/2026-11-05-s7-browser.md), [S9 layers](research/2026-11-05-s9-layers.md)

Each statement below is marked:

* **[D]** decided by the owner (or delegated to us and decided here — noted where so)
* **[P]** proposed here, to accept or change
* **[Q]** an open question that needs the owner

---

## 1. What Clover is

Clover is the next major version of Winter, with a new name, a new home and a new shape. It is a **bot-first, endlessly moddable desktop agent platform** for macOS, Windows and Linux.

* **[D] Bots are the centre.** Each bot is a plugin. **Alpha** is the only bot that ships, and it is not special in any way; users install or create the rest.
* **[D] All bots are equal.** Every bot has the same tools and sees every plugin, MCP server and skill scoped to bots (§5.1). A bot changes only its own `<bot-instructions>` block; the harness owns the rest of the system prompt.
* **[D] Each bot lives one continuous life.** There is one conversation per bot, compacted over time, with persistent memory (a `MEMORY.md` index linking to memory files) and routines that wake it on schedules, webhooks and integrations.
* **[D] The user's messages interrupt a bot immediately,** to be as fast as possible. Messages from other bots and routines fold into the running turn instead.
* **[D] Bots reach the user's computers.** They run bash, tools and, once opensky arrives, computer use on every computer the user connects, including cloud computers, through one folder tree with a folder per computer (§9.1). By default a bot asks before risky actions.
* **[D] Bots work together.** They message each other (`SendMessage`) and delegate work to coding agents over ACP (`Agent`).
* **[D] A bot is live on every device that is on.** It thinks on the user's **main computer**, and the device in use takes over while the main is offline. Transcripts and memories stay in sync without a cloud server.
* **[D] Bots can talk and listen** through voice provider plugins, with the avatar lip-syncing. Alpha ships with a Fish Audio voice.
* **[D] Everything outside a fixed core is a plugin.** That includes models, UI, themes, floating surfaces (island, Dispatch pill), voice, computer use, relays, companion apps and bots themselves. The agent runtime and core app functions are **not** replaceable.
* **[D] A plugin is just a folder with files.** Making one never needs a tool: the user or a bot writes the folder, and the app finds it. A plugin can hold other plugins (§5.1).
* **[D] The default look is waifu-themed.** Each bot can have an animated avatar, a VRM model or a Live2D Cubism model (item 87). The whole app starts from `clover`'s base theme, every bot tab included, and the bot's own plugin styles its tab on top, as Alpha's own tab theme does (§5.5). Users restyle by editing the bot's plugin, or with plugins that dress any part of the app (§5.5). **[D]** The default shell around the tabs is laid out and measured like Claude's desktop app, with Clover's own marks, icons and wording (items 83 and 86, §5.5).

It is much closer to Grok Bot (bots with memory, routines and their own computer) than to a chat window like Claude Desktop.

### 1.1 Non-goals

* **[D] Replacing the agent runtime is not allowed.** DeepSeek Harness lets a plugin replace the agent loop, storage or the model plumbing; Clover does not.
* **[D] No relation to Discord Waifus.** Discord Waifus is an ordinary plugin (§11), and nothing in Clover's design comes from it.
* **[D] No group rooms for now.** Conversations are one user to one bot; bots coordinate with `SendMessage`. Rooms could come later as a plugin.
* **[D] No paid cloud backup.**
* **[D] No spending limits or loop guards.** Bots spend freely, and the user watches their provider dashboards.
* **[P] No promise of a full sandbox for plugins.** Plugins are trusted code, as with DeepSeek Harness and Claude Code mods. The core keeps them away only from other plugins' UI and the sealed cards, keeps their UI code to the hosts they declare (WebRTC aside, a known gap, §5.3), and on macOS keeps host code from Clover's Keychain items and the daemon's socket (§5.2, §5.5, §5.6).

---

## 2. Names and homes

| Item | Winter today | Clover |
| :- | :- | :- |
| Product | Winter | **Clover** [D] (revision 17; called Wyrmhole until then) |
| First version | 0.124.0 | **1.111.1** [D], on macOS, Windows and Linux at once [D]; nothing ships on Windows until bash works there [D] |
| GitHub org | `yanlingLabs` (deprecated) | `waifucave` [D] |
| Main repo | `yanlingLabs/winter` (public, Apache-2.0) | `waifucave/clover` — **transfer + rename, history kept** [D] |
| Agent SDK | `yanlingLabs/winter-agent-sdk` | `waifucave/clover-sdk` — transfer + rename [D] |
| Runtime SDK (router) | `yanlingLabs/winter-runtime-sdk` | **archived** [D] — the daemon drives the SDK directly (§3.3) |
| iOS companion app | `yanlingLabs/winter-ios` | `waifucave/clover-ios` [P] |
| npm scope | `@yanlinglabs/*` | `@waifucave/*` [D] (`@waifucave/clover-protocol`, `-core`, `-cli`, `-sdk`…) |
| Local folder | `Xcode progects/Norma v2` | `Xcode progects/WaifuCave/clover` [D] (Claude memory copied to the new path key the same day) |
| Web | — | `clover.waifucave.com` (web companion, §8.4), `hooks.waifucave.com` (webhooks, §7) |
| Home folder | `~/.winter` (dev `~/.winter-dev`) | `~/.clover` (dev `~/.clover-dev`) [P] |
| App identity | `com.winter.app` / Keychain `com.winter.core` (dev: `com.winter.app.dev` / `com.winter.core.dev`) | `com.waifucave.clover` / `com.waifucave.clover.core` (dev: `com.waifucave.clover.dev` / `com.waifucave.clover.core.dev`) [P] |

---

## 3. Architecture

### 3.1 Processes on one device

```text
┌───────────────────────── one device ─────────────────────────┐
│                                                              │
│  Clover app (Electron, always on)     other clients          │
│  ├─ main: windows, tray, updater      CLI · iOS · web        │
│  ├─ Clover Browser tabs (§12.1)             │                │
│  ├─ sealed approval cards; shell = plugins  │                │
│  └─ plugin UI in layers (§5.5) ─────┐       │                │
│                                     │ local socket (JSON-RPC)│
│  clover-core (Bun daemon, always on) ◄──────┘                │
│  ├─ fixed core: agent runtime (clover-sdk), event log,       │
│  │   permissions + approvals, routine engine, plugin         │
│  │   registry, settings, identity, pairing, sync, links      │
│  ├─ bots (thinking here when this computer runs them, §6.4)  │
│  ├─ plugin hosts (two Bun processes, clover's and third      │
│  │     parties', a worker per plugin; Node/native plugins    │
│  │     get their own process)                                │
│  └─ starts the app, and restarts it if it stops (§3.1)       │
│                                                              │
└──── one persistent encrypted link to each other device ──────┘
```

* **[P] Keep a real daemon.** Bots must answer other devices, run routines and stay reachable while every window is closed, and survive the app crashing. DeepSeek Harness's model, where the app owns a child process, cannot do that. `clover-core` starts at login:
  * macOS: a launchd user agent
  * Windows: a per-user scheduled task
  * Linux: a `systemd --user` unit

  It also runs headless on servers and cloud VMs.
* **[D] The daemon stays on Bun.** It ships as a `bun build --compile` binary for `darwin-arm64`, `windows-x64`, `linux-x64` and `linux-arm64`; macOS 27 runs only on Apple silicon, so there is no `darwin-x64` (§4). `Bun.secrets` (experimental since Bun 1.2.21) already maps to macOS Keychain, Windows Credential Manager and the Linux Secret Service, which needs a running secret-service daemon such as GNOME Keyring or KWallet. **[P]** The daemon and CI run Bun 1.4.x: Bun 1.3 stopped firing timers while a native addon delivered a steady stream of completions (S1, fixed in 1.4.4), and crashed under Worker churn in 1.3.14.
* **[D] The app is Electron and TypeScript.** It is one client of the daemon, as the Swift app is today. The daemon remains the single source of truth, and every client is a view of its event stream. Today's JSON-RPC 2.0 over NDJSON protocol carries over; the transport is a Unix socket on macOS and Linux and a named pipe on Windows. **[P]** As in Winter, every client says hello with its role and proves it with a token, and each role has its own list of allowed methods (`packages/core/src/ipc/server.ts`, `auth/app-token-acl.ts`). The daemon also checks a caller's process tree, so a command started by a bot, an agent or a plugin never counts as the user or the app (§5.5). **[P]** A caller counts as the user or the app only if it also runs outside every sandbox and escape floor: not sandboxed on macOS, in the host's namespaces on Linux, and neither restricted (`IsTokenRestricted`) nor in an AppContainer on Windows. A command that leaves Bash's sandbox still runs under the escape floor (§4), so a bot's command never counts as the user, even after a double fork, which a process-tree check alone misses. **[P]** Besides the process tree and token flags, the check asks which principal a process runs as and how it was started, so a process launched through a service, or one whose token was changed, never passes as the user; on Windows, Bash's sandbox principal (§9.1) never counts as the user (S2). **[D]** It also tells the two plugin-host processes apart, since only `clover`'s may use the waifucave token and `keys.open` (item 84, §5.2). Bash's fence keeps Winter's closed doors on macOS (`open`, `launchctl`, `osascript`) and closes `systemd-run --user` on Linux and the Task Scheduler on Windows. A bot may run the CLI with its own session's rights. Plugin code on Windows and Linux runs as the user and is trusted as such (§5.2).
* **[P] The app can install, start and update the daemon.** On first launch the app installs the matching `clover-core` and its login item. electron-updater updates both on all three OSes, replacing Sparkle.
* **[D] On desktops the app and the daemon are one always-on pair** (revision 12, the owner's design). Starting either one starts the other, so the app always runs in the menu bar (the tray on Windows and Linux), with no window until the user opens one. Closing a window only closes it. If the app crashes or is killed, the daemon starts it again. The menu-bar icon's Quit stops both. This keeps surfaces, approval cards (§5.5) and the Clover Browser (§12.1) working while every window is closed. **[D]** The app's own Quit (⌘Q on macOS) also stops both (revision 13), but on a computer running bots, routines or agents, either Quit first says what will stop and offers **Hand over and quit**, which releases the lease at once so another computer takes the bots (§6.4); with no other computer to take them, it says they stay offline until this one is back. **[P]** On Linux the daemon starts the app once the graphical session is up. A server or cloud computer with no display runs the daemon alone. **[D]** While a screen reader is on, the Clover Browser's host window, which the user isn't meant to see or use, is the one window open before the user opens one (§12.1, item 93).
* **[P] The pair, precisely:**
  * One daemon per home, holding an OS file lock for its life, and one app per user. Winter's pid-file lock lets a second daemon take over one that is still starting (`packages/core/src/lock.ts`); this one doesn't.
  * Each starts the other through the OS: Launch Services and `launchctl kickstart` on macOS, the scheduled task on Windows, `systemctl --user start` on Linux. The daemon's unit restarts it only after a crash, so a Quit holds until the next login.
  * On Windows the logon task runs `clover-core supervise`, which runs the daemon as its child and restarts it after a crash: in S7, Task Scheduler's restart on failure never fired for a killed task, and its interval can't be under a minute anyway.
  * A side that exits on purpose tells the other first. A crashed app restarts with growing delays, and after three crashes in two minutes it starts in safe mode (§5.8).
  * A daemon restart stops agents, the plugin host and background commands, and records running calls as interrupted.
  * An update waits until the daemon is between turns and no agent runs, then stops the pair, installs both and starts them again.
  * On Linux the app copies the daemon out of the AppImage and starts with the desktop session (XDG autostart). A server turns lingering on and updates its daemon itself, checking the same signature.

### 3.2 The fixed core

These are **not** pluggable [D]. Plugins can extend them only through the declared extension points in §5.

| Core part | Owns |
| :- | :- |
| Agent runtime | The turn loop, tool dispatch, interrupts, compaction and context assembly, from `clover-sdk` |
| Event log and storage | Event-sourced transcripts and bot state; the source for sync (§8.5) |
| Permissions and approvals | Approval policy, rules, the fence that keeps bots out of settings, levels and credentials (§9.1), and **sealed approval cards** whose text plugins can show but never read, and which only sealed buttons and paired devices can answer (§5.5) |
| Routine engine | Watches the routine files on each computer and fires each routine on the computer that holds its file (§7) |
| Plugin registry | Watches the plugins folder, asks before loading a new plugin, reads manifests without running anything, starts each contribution once its extension point exists, stops dependents first, hot reloads, checks capabilities (§5) |
| Plugin host | Runs every plugin's host half in its own worker, under its own identity, in `clover`'s plugin-host process or the third parties' (§5.2) |
| Folder tree | One folder per connected computer, served by the computer that holds it; runs file tools and bash on that computer (§9.1) |
| Clover Browser | A browser on each computer, in the app's Electron on desktops and headless on servers, with an API for plugins (§12.1) |
| Settings | Layered settings with the live-reload rules Winter already has |
| Identity, pairing, links, sync | Device keys, accounts, the main computer and its lease, encrypted links, replication |
| Protocol | Every RPC method and event. Plugins add none and cannot change them: clients run a plugin's `commands` by full name, `<namespace>.<name>`, through the core method `command.run` (§5.4) |

### 3.3 The agent SDK and model plugins

* **[D] `winter-runtime-sdk` is archived.** Today every session is a runtime child driven through the router. In Clover the daemon embeds `clover-sdk` directly. Chat and Dispatch already run the SDK inside `winter-core` (one Bun Worker per session). Code sessions stop going through the router too: in C1 they run embedded, and in C6 they become Winter's coding agent, an ACP agent started like any other (§9.3).
* **[D] Model plugins are ordinary plugins.** They use the same folder format and the same install flow as any other plugin. Adding a model is installing a plugin.
* **[D] Every model adapter is a plugin, including the ones Winter has today.** This replaces Winter's rule that providers live in the SDK:
  * `clover-sdk` keeps the agent loop, a stable **provider adapter interface** and the **catalog row schema**. It ships no providers.
  * Every provider the SDK has today moves out into a **bundled model plugin**, one per provider, carrying its adapter, its catalog and its sign-in. **[P]** They are children of the bundled `clover` plugin (§5.1).
  * A third-party model plugin works the same way. It can also be declarative only: catalog rows plus an OpenAI- or Anthropic-compatible endpoint, with no code.
  * **[P] Where adapters run:** in the plugin host, like every host half (§5.2). Each streamed chunk crosses local IPC, which adds microseconds. If the plugin host restarts mid-turn, the model call is retried.
  * **[P] Logins stay in the core.** As in Winter (`packages/core/src/runtime-sdk/host-credentials.ts`), refresh tokens never leave the core. It refreshes `oauth-pkce` sign-ins itself, and only on the refresher (§8.5); a `custom` sign-in handler refreshes only when the core calls it there. Adapters get access tokens by reference, with a generation number, and ask for a newer one after a 401. Other computers get the new token over the link.
* **[D] Model access on first launch:** a **welcome setup guide** walks the user through entering an API key or signing in to one of the supported subscriptions. Claude subscription sign-in is not supported, as in Winter today. **[P]** Anthropic Console sign-in (API billing, through the official login) carries over from Winter.
* **[D] Subscriptions may be used for anything,** routines and bot-to-bot turns included; staying within a plan's terms is the user's responsibility.
* **[D] Codex `originator` becomes `"clover"`.** Codex's `originator`, now set in the bundled Codex model plugin, identifies Clover as `"clover"`, replacing `"winter"`. The CLAUDE.md hard rule is updated with the rename in C0.

---

## 4. Platforms

**[D] 1.111.1 ships on macOS, Windows and Linux at once,** on the latest OS versions only:

* macOS 27 or later (Apple silicon only)
* Windows 11 x64 (arm64 later)
* Ubuntu 26.04 LTS and current Fedora. **[P]** The deb and rpm are the main Linux packages, since they install the AppArmor profile that Electron's sandbox needs on Ubuntu; the AppImage can't, so it is a fallback. Where GNOME shows no tray (it needs the AppIndicator extension, which Fedora doesn't ship), a launcher entry carries Quit. Wayland has no always-on-top, so there the island is a normal window.

| Area | macOS | Windows | Linux |
| :- | :- | :- | :- |
| Daemon and app | ✓ | ✓ | ✓ |
| Login start | launchd | scheduled task | `systemd --user` |
| Secrets | Keychain | One encrypted file, its key in Credential Manager (§9.1) | One encrypted file, its key in the Secret Service; with none unlocked, sealed by `systemd-creds --user`, else in a file only the user can read (§8.5) |
| Bash tool | Seatbelt sandbox (exists today). Winter's escape floor carries over: a command that leaves the sandbox (`dangerouslyDisableSandbox`) still may not write the fenced set (§9.1), at every level, fully automatic included (`runtime-sdk/home-fence.ts`) | **[D] Release blocker:** nothing ships on Windows until bash is ready. **[D]** Git for Windows' bash plus a PowerShell tool, as Claude Code does (Claude Code has since made Git for Windows optional; Clover still needs bash). **[P]** Both run under the same fence as on the Mac — writes limited to the allowed folders, the same network rules — **[D]** built on a dedicated sandbox principal with a write-restricted token, network filters keyed to that principal and a kill-on-close job; credentials go through the Clover broker (§9.1, item 76). S2 showed Git Bash (its MSYS2 runtime) working inside that fence; it is not yet admitted for release (§14.1 item 2). | bubblewrap, with a D-Bus filter that closes `systemd-run --user` (Landlock can't filter D-Bus). **[P]** The Secret Service reaches Bash only through a broker that authorizes each item by what a request and its answer carry, not by bus name, interface or object path, since a path-only allow list let a protected item through in a method's arguments (S8); host execution endpoints (the host bus, systemd's sockets, portals, Docker) stay hidden |
| Computer use | **[D]** none in 1.111.1; opensky later (revision 17) | same | same |
| Browser | **[D]** the Clover Browser, headless (§12.1) | same | same |
| Island | **[D]** the same top-centre island on all three OSes, themed by tokens, with no fixed Apple blue (item 82): at the notch, and on a screen without one it grows from the top edge | grows from the top edge | same as Windows; a normal window on Wayland |

**Release blockers for 1.111.1** [D]:

* **Windows bash.** Bash is the absolute main tool, so Windows ships nothing without it.
* **Winter's coding agent speaking ACP** (§9.3).

**[D] Computer use comes after 1.111.1, as opensky** (revision 17; this replaces starting with an open-source computer-use plugin). Computer use is a plugin like any other (§5.3), so nothing in 1.111.1 waits for it, and the core keeps what opensky will need: holds, the user-working mark and `computers.control` (§9.2). The backend research of November 2 (R1) goes to opensky.

---

## 5. Plugins

### 5.1 A plugin is a folder

* **[D] A plugin is just a folder with files.** Nothing else makes something a plugin. Installing one means putting its folder in the plugins directory (`~/.clover/plugins/` [P]), and **making one never needs a tool**: the user or a bot writes the folder there. The registry watches the directory and loads, reloads or unloads plugins live, with no restart. Installing from an index or npm only downloads a folder into that directory.
* **[D] A plugin contributes to any extension points** (November 3; this replaces "a plugin does one job, of one kind"). Its manifest, `clover.json` (§5.9), lists what it adds and where: a bot, models, tools, skills, themes, parts of the UI and so on (§5.3). **Plugins have no kinds.** What a plugin is ("Bot", "Model provider", "Tools", "Theme", "UI", "Cloud computer", "Collection") and whether it is data, web or code are worked out from what it contributes, never declared.
* **[D] Plugins can hold plugins** (November 3; this replaces plugin packages). A plugin may keep **child plugins** in its `plugins/` folder, one level deep:
  * A child is a full plugin, with its own manifest, contributions, on/off switch, secrets and worker. Its id is `<parent>/<folder>`.
  * **[P]** Wherever a plugin's id names a file, a folder or an origin, its `/` is written `--` (`plugin-data/luna--tarot-panel/`, or `bots/pack--luna/memory/` for a bot in a child), which no id can contain.
  * The top-level folder is installed, synced, updated, approved and removed as one unit, so a whole suite is still one folder to share.
  * **[P]** Each child is switched on and off by itself (default: on), and switching the parent off switches its children off. The parent's `version` covers the whole tree, which updates in one step.
  * **[P]** A child does not plug into its parent automatically; it contributes like any plugin. A parent that declares an extension point can ship its default guests as children (§5.4).
  * **[P]** No dependencies by plugin name in 1.111.1. Plugins depend on each other through extension points: a contribution whose point is missing waits, and Settings shows what it is waiting for. Running another plugin's commands (`call:<plugin-id>`, §5.4) is not a dependency either: a call to a missing plugin fails with "not installed".
* **[P] The folder shape,** with a bot as the example:

  ```text
  luna/                          # the folder name is the plugin's id
  ├── clover.json              # the manifest (§5.9)
  ├── bot/instructions.md  greeting.md  memory/
  ├── tab/theme.json  theme.css  layout.json   # Luna's tab look, as data (§5.5)
  ├── client/index.tsx           # optional: React components (code)
  ├── host/index.ts              # optional: runs in the plugin host (code)
  ├── assets/luna.vrm  portrait.webp  fonts/ …
  └── plugins/                   # optional: child plugins
      └── tarot-panel/
          ├── clover.json      # id luna/tarot-panel: a panel in every tab
          └── client/index.tsx
  ```

* **[P] Ids:** lowercase letters, digits and single hyphens (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), 2–40 characters, so there is never a `_` or `.` and tool names always split cleanly (§6.7). The folder name must equal the id; a mismatch is not loaded, and the app offers a one-click rename.
* **[P] What ships:** two read-only plugins in the app's resources. `alpha` is the bot, with its own tab theme. `clover` holds everything else we ship, as children:
  * the shell, sidebar, conversation view, composer, panel host and its panels (terminal, diff, files and the browser view), settings screen, bot editor, plugin index browser and the archive of old Winter sessions
  * the island and the Dispatch pill, with the island's Needs you, Devices and Usage tabs
  * the web and browser tools (`mcp__clover__…`)
  * one model plugin per current provider
  * Fish Audio, the VRM and Live2D renderers (item 87) and the base theme, which every bot tab starts from and the rest of the app uses until the user picks a theme (§5.5)
  * the schedule and webhook triggers, the waifucave forwarder, two relays (n0's public relays, on by default, and the cloud computer relay, off until a cloud computer exists), and the Google Cloud and Hetzner providers
  * the iOS and web companions, waifucave push and desktop notifications
  * the agent backends: Claude Code, Codex, Grok, Gemini CLI, DeepSeek, Cursor, Antigravity CLI, Devin and Winter's coding agent (§9.3)
* **[D] The app asks when it finds a new plugin.** A folder that appears in the plugins directory loads only after the user's OK, whoever wrote it; installs made through the app or the CLI were already confirmed there. **[P]** The OK says what the plugin is, and for a plugin with code it says plainly that it runs code on the user's computers (§5.6); on Windows and Linux it adds that this code could read Clover's logins and approve its own cards (§5.2), **[P]** and, since any desktop answers another computer's cards (item 91), approve actions on the user's other computers. One card covers a plugin and its children, with a checkbox per child. The OK is bound to the tree's hash, so other devices don't ask again. A code change asks again, whoever made it (§5.6). An install counts as confirmed only when the user makes it in the app or in their own terminal; bots, agents and plugins can't act on the daemon's socket as the user (§3.1), so what they install is a found folder, and asks.
* **[D] The plugin is the only unit.** MCP servers, skills and agent definitions exist only inside plugins, and are **wrapped automatically**, so no one ever has to build a plugin by hand:
  * **Adding a bare item creates a plugin around it.** That covers a pasted MCP config, an MCP URL, `clover mcp add`, a bot adding a server, a dropped skill folder with a `SKILL.md`, or a Claude Code plugin folder (revision 14). Clover generates a small plugin around it in the plugins folder, and from then on it installs, syncs, gets approved and is enabled like any plugin. The user can open and edit the generated plugin. **[P]** Wrappers are named `mcp-<server>` (one per server, with the server's name lowercased, each run of characters other than `a-z` and `0-9` turned into one `-`, cut so the id fits 40 characters, hyphens at either end then dropped (the same for `skill-`, `agent-` and `claude-` names), and a number added on a clash or for `clover` (`server` if nothing is left), and that name used for its tools: `mcp-blender` gives `mcp__blender__Render`), `skill-<name>`, `agent-<name>` and `claude-<name>` (a Claude Code plugin, whose name is also its namespace), and record how they were made.
  * **[P] Accepted as-is and wrapped:** `.mcp.json` entries, the Claude Code `mcpServers` JSON shape, agent-skill folders (`SKILL.md`), and Claude-style agent files (`agents/*.md`). **[D]** Claude Code plugin folders (`.claude-plugin/plugin.json`) are wrapped too, since every plugin is Clover-shaped (revision 14). **[P]** The wrapper turns the plugin's skills and commands into `skills`, its agents into `agents`, its MCP servers into `mcpServers`, its hooks into Claude-style `hooks` (§5.3) and its `userConfig` into settings, and rewrites `${CLAUDE_PLUGIN_ROOT}` as `${plugin}` and `${CLAUDE_PLUGIN_DATA}` as `${data}`. Parts with no Clover point yet (output styles, LSP servers, mods) stay in the folder unused, and the OK names them. **[P]** A folder is a Claude Code plugin if it has `.claude-plugin/plugin.json`, or no `clover.json` but `skills/`, `commands/`, `agents/` or `hooks/hooks.json`, where Claude Code looks for them; a folder with only `.mcp.json` is wrapped per server. Its name gets a server name's clean-up, and each command file becomes a generated skill folder. `${user_config.KEY}` becomes `${setting:KEY}`, or `${secret:KEY}` when the option is `sensitive`, and `directory` and `file` options become strings. As in Claude Code, its hook processes get `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_OPTION_<KEY>`, its `stdio` processes the two paths, and both paths are filled in within its skill and agent text. A hook keeps its own timeout (600 seconds when unset). Unmatched hook events and types, `multiple` options, `bin/`, monitors, workflows, themes and `dependencies` stay unused too, and the OK names them.
  * **[D] A repo's own items are not wrapped.** MCP servers and skills a repo defines (its `.mcp.json` or skills folder) load only while a bot works inside that trusted repo. They are never installed, synced or shown to bots working elsewhere. **[P]** A bot works inside a repo while the turn's Bash folder, or a file tool's path, is in it; the repo's items then stay for the rest of that turn.
  * **[D] Every bot on every device sees every server.** Local servers (a `stdio` command such as Blender's, or plugin code bound to its computer, such as computer use) run on each computer they are installed on, and the user can mirror one to the other computers. Remote servers work from anywhere (§9.1). (Grok Bot also makes servers account-wide, but it has a single computer where they all run.)
  * **[P] Secrets stay out of the folder.** API keys and sign-in tokens go into the synced credential store, so a plugin folder can be shared or synced without leaking them. When the core wraps a pasted config, it moves every `env` and `headers` value into the credential store and writes `${secret:<name>}` in its place; the user can mark one as plain.
  * **[P] Settings:** a plugin's manifest declares its settings; the default shell shows them, and secret fields go straight to the credential store.
* **[P] Sign-ins:** any plugin may list `auth` for its own service. The core runs those sign-ins as it does a model's, the refresher refreshes them (§8.5), and the tokens reach the plugin's code only through the core's fetch, which adds them and reaches only the plugin's `network:` hosts; that is what the capability gates, for keys and tokens alike. Only a process of the plugin's own sees a value: a `stdio` server through `env`, or an adapter that must sign with it (§5.2) through `secrets.get` (§5.4). `${secret:<name>}` in `env` or `headers` names only the plugin's own secrets.
* **[P] Updates:** plugins from an index update automatically unless pinned, and only forward. The OK for an index plugin also covers later versions that add none of the triggers in §5.6; one that adds a trigger waits for a new OK. The previous version is kept until the new one starts, and comes back if it fails. Local plugins change only when their folder does; bundled plugins update with the app.
* **[P] Indexes and npm:** an index is a JSON file (`index: 1`) listing ids and versions, each with its tree hash and download URL, signed with the index's key. The official index's key ships in the app; another index is added by URL with its key and a warning (§14.2 item 25). The revocation list is signed the same way and names an id, with all its versions or listed hashes, and a reason. The app checks it at start and every 6 hours; a revoked tree stops on every device, stays on disk marked blocked, and Settings says why. An npm install unpacks the package as it is: no install scripts run and no dependencies are fetched, so code ships bundled. It updates like an index plugin. The tree hash is SHA-256 over a sorted list with one line per file: its path in the plugin folder (with `/`), its executable bit and the SHA-256 of its bytes. It leaves out only `.DS_Store`, `Thumbs.db` and `.git/`, and a symlink out of the folder makes the plugin invalid. A version downloads as a `.tar.gz` whose tree hash must match, and an index or a revocation list is signed with Ed25519 over its exact bytes, in a `.sig` file beside it.
* **[P] Live changes:**
  * On reload, the plugin's worker is replaced. Tool calls in flight get a grace period, then are recorded as interrupted; model calls retry; the client half remounts and loses its state.
  * A removal syncs as a delete, and the user's data stays under the plugin's id.
  * Bundled plugins, and children of index plugins, can only be switched off.
  * A refused plugin stays off until its folder changes.
  * Assets are served by hash, SVG with scripts off and never through a symlink, and Markdown renders without raw HTML.
* **[P] Formats:** the app reads every `manifest`, `theme`, `layout`, `locale` and `index` format it has shipped, and refuses a newer one with "needs a newer Clover"; `clover plugin validate --upgrade` rewrites old ones. A plugin whose `engines.clover` range leaves out the app's plugin API is invalid, with the version it needs, and is checked again when the app updates. In `contributes`, an unknown key without a dot refuses that contribution, and a dotted one is a plugin point and waits for it (§5.4). A child that fails validation is invalid alone, and the rest of its tree loads.
* **[P] Entry ids:** every id that other plugins or files refer to (a model provider, voice provider, agent backend, trigger type or computer provider) is unique among enabled plugins. On a clash only that entry is refused, and the plugin enabled first, by the synced list's order, keeps the id. Theme and `ui` ids are unique within their plugin; elsewhere a theme is named `<plugin-id>#<theme-id>`. A reference to another plugin's entry is resolved when it is used, and a missing one turns off only that feature, with the reason.
* **[P] States:** Settings shows each plugin as found (waiting for its OK), refused, invalid, off, waiting (for a point or a setting), running, stopped (after crashes) or blocked (revoked), with the reason. The registry reads a folder once it has been unchanged for 2 seconds and its manifest parses.
* **[P] Crashes and logs:** a crashed worker restarts after 1 second, the delay doubling up to 1 minute. After 3 crashes in 10 minutes the plugin stops on that computer, its tools answer "plugin stopped: <reason>", and Settings shows its last log lines until the user restarts it. A worker that misses the plugin host's heartbeat for 30 seconds counts as crashed. A folder holding a native module runs in a process of its own (§5.2). Each plugin logs to `logs/plugins/<id>.log`, which Settings and `clover plugin logs` show.
* **[D] Each plugin declares its scope: `bots`, `agents` or `both`.**
  * Scope covers a plugin's MCP servers, skills, agent definitions and hooks, and defaults to `both`.
  * A plugin may also limit itself to certain agent backends (`onlyBackends`), for example only Claude Code.
  * The user can override the scope in settings.
  * An agent definition can narrow which in-scope plugins its agent receives.
  * Bots stay equal: everything scoped to bots is visible to every bot.
* **[P] A plugin's UI half is React,** loaded into its own layer of the app. What it can fill and restyle, and how layers work, are in §5.5.

### 5.2 Where plugin code runs

**[D] (delegated, decided here).** Host halves run in a **plugin-host process**, separate from the daemon, with **each plugin in its own worker**. A plugin that needs Node or native modules, opensky for example, gets a process of its own. **[D] There are two plugin-host processes** (the owner, revision 18, item 84). The bundled `clover` tree's host halves run in one of their own, and every third-party host half shares the other. The core decides which from the plugin's install record, never from its manifest. Only `clover`'s process may use the waifucave account token and the per-computer keys (`keys.open`, §5.4), and the daemon's caller check tells the two apart (§3.1). **[P]** A plugin may also bring a **helper**, a native program such as opensky's, which the plugin host starts and supervises. OS permissions such as Accessibility and Screen Recording are granted to that helper.

| | Where plugins run | What one broken plugin does |
| :- | :- | :- |
| Claude Code mods | Inside the Claude Code process | Can stall Claude Code itself; per-hook time limits contain it |
| Claude Desktop extensions (MCP servers) | One separate process each; the Blender extension runs as its own Python process | Only that extension dies |
| DeepSeek Harness | All plugins inside one shared Node host process | Can take down every plugin and the agent with it |
| **Clover** | Two plugin-host processes (`clover`'s and third parties'), a worker per plugin; Node or native plugins in their own process | Only plugins die; the daemon and the bots keep running, and a third-party plugin can't take down the bundled ones |

Why not inside the daemon: a buggy plugin would freeze or crash the always-on daemon, and with it every bot on every device. Keeping plugins out of the daemon also enforces "plugins cannot replace the core" and checks declared capabilities at the boundary. The cost is a few milliseconds per call and roughly 40–60 MB for each shared host.

**[D] On macOS the plugin host is fenced away from secrets.** It runs as a separate signed binary, never as a re-run of the daemon's own (which the Keychain would serve), so it does not pass the Keychain's "this app only" check, and a macOS sandbox blocks it from the Keychain, as Winter's workflow workers are blocked today. A plugin gets only its own secrets, through the plugin API; workers in the shared host are not isolated from each other's memory. **[P]** So, on every OS, adapters never hold a key: a request that needs one goes out through the daemon, which adds the key or token (§5.1). An adapter that must sign with the secret (AWS SigV4 for Bedrock) runs in a process of its own. The SDK's adapter interface therefore hands adapters that fetch where Winter's hands them a credential store (`ProviderContext.credentials`).

**[P] On macOS every process that runs a plugin's code is fenced to its plugin** (B-M2's 2f, and the controller's rulings on #345): a plugin-host process, a supervised host, a hook's command and a stdio MCP server. Each one reads its plugin's tree, Clover's run files and shared packages, and its Bun. It writes only its own data and temp folders (and `/dev/null`, `/dev/tty`, `/dev/fd`). It can't read the Clover home or the user's home, the per-user temp and cache folders, the Keychain or credential files, can't reach any Unix socket but the DNS resolver and the ones it's named, and can't ask launchd to start anything. A hook or MCP server also reads the package managers' installs, keeps every cache in its own temp folder, and may run any program, fenced the same. **The session's project folders**, its working directories, are readable to a hook or MCP server of that session, and writable only when its plugin holds `project.write` (§5.4), bundled plugins included. The allow is added for each spawn from that session's own folders, which change only by the user's own act (the app's picker, `clover add-dir`, the phone). It never covers a home, a folder above one, or a folder holding a place where a write runs later or a tool's settings live (`~/Library`, `~/.config`, `~/.local`, `~/bin`, `~/.ssh` and the like). Writes are denied to anything in them that runs without the user running their project: `.git`, `.vscode`, `.idea`, `.claude` and `.clover` whole, `.mcp.json`, `.envrc`, `.gitconfig`, `.gitmodules`, shell start files and Git's `core.hooksPath` folder. The folders that hold any of these are write-denied too, so none can be renamed away and back. Credential files are neither read nor written. Last in every fenced process's profile, the places where a write runs later (§9.1's persistence list) and the fence's other places outside the Clover home are write-denied in both their own and their real spelling, so a dotfiles project can't reach `~/.zshrc` through its real file.

**[D] On Windows and Linux, plugin code runs as the user** (revision 13; this replaces the narrow jail chosen in revision 12). Windows Credential Manager and the Secret Service have no per-app check, and a jail loose enough for plugins to work can't stop a plugin asking another program (a terminal, the Task Scheduler, a desktop service) to act for it; AppContainer, the strict kind, would have shut out computer use. So, as in VS Code, Claude Code and Devin, the sandboxes go on what the models run (bots' Bash, §9.1; coding agents' commands, §9.3), and code the user installs is trusted: a plugin's OK there says its code could read Clover's logins and approve its own cards (§5.1), **[P]** and approve actions on the user's other computers, since any desktop answers another computer's cards (item 91, §5.5). Computer use is plugin code like any other and needs no exception. **[P]** On macOS the plugin host's sandbox also blocks the daemon's socket; on every OS the host talks to the daemon over the pipe it was started with.

**[P] Where each contribution runs:**

| Contribution | Runs on |
| :- | :- |
| `bot`, `skills`, `agents`, themes and layouts | data, on every device |
| `models`, `hooks` | every computer running a session (§6.4); started when first needed |
| Local MCP servers: `stdio`, and `host` servers bound to their computer | each computer they are installed on (§9.1) |
| Remote MCP servers: `http`, and every other `host` server | the computer running the session, or the one that holds a call's `saveTo` folder (§9.1) |
| `triggers` | each computer, started at once |
| `voices` | the computer the user is talking on; for the iOS app and the web page, the computer running the bot (§6.6) |
| `computerProviders`, `notifiers`, `companions`, `commands` | the main, or the takeover computer while the main is offline, unless the entry's `runsOn` says otherwise (desktop notifications say `each`) |
| `relays` | every device that uses them; a relay a computer serves (the cloud computer) runs there |
| `agentBackends` | the computer the agent is placed on |
| UI | every app instance |
| Entries for a point a plugin declares, other than UI spots | wherever the declarer runs (§5.4) |

A plugin's host half starts on a computer when one of its contributions runs there, or at once where its `host.start` says, for a plugin that runs a service of its own. **[P]** `host.start` and every entry's `runsOn` mean the same thing: `each` is every computer (for a command, the one it is called from), `main` is the main or the takeover computer while the main is offline, and `chosen` is the computers the user ticks, as for local servers (§9.1). An entry with no `runsOn` runs where the table says. **[P]** The computers ticked for `chosen` are an account setting, synced with the installed-plugins list (§8.5); a new plugin starts ticked on the computer it was added on. **[P]** On macOS a helper is a signed `.app` started through Launch Services, so OS permissions attach to it.

### 5.3 Extension points

**[D] Plugins have no kinds.** A plugin contributes to **extension points**, which are named places to plug into. **[P]** The core owns a fixed set, listed below; plugins declare the rest (§5.4). The test for a core point: it exists only where the core itself reads or calls what is contributed. So the core gains a point only when one of its own parts must read or call a contribution that the plugin API can't reach: the turn loop, tool dispatch, the routine engine, the links, the list of remote calls, the protocol's command method, the computer registry, the credential store, or the app's main process, plugin runtime, audio, theme engine and sealed frames. Everything else is a point some plugin declares. A new core point is a minor version of the plugin API, and no core rule names a point a plugin declares, or any plugin but `clover` and `alpha`.

**[P] Daemon core points** (the daemon reads or calls them):

| Point | Shape | What the core does with it | Data or code | Ships with |
| :- | :- | :- | :- | :- |
| `bot` | one per plugin | Builds `<bot-instructions>`, picks the default model, keys memory by the bot's id (§6) | data | **Alpha** only [D] |
| `models` | list, one per provider | Calls the adapter, or the declared endpoint, for every turn; the welcome guide reads the sign-in methods (§3.3) | code, or data for a compatible endpoint | every provider Winter has today [D] |
| `mcpServers` | named servers | Dispatches tool calls, builds the MCP block and shows MCP Apps pages (§5.5, §6.1, §6.7) | code (`host`, `stdio`) or data (`http`) | the **web** tools, `mcp__clover__WebSearch` and `mcp__clover__WebFetch` [D]; `mcp__clover__Browser` [P]; computer use later, as **opensky** [D] (`mcp__opensky__…`, or `mcp__clover__…` if it ships as a child of `clover`) |
| `skills` | list | Indexes them in `Glossary` (§6.8) | data | — |
| `agents` | list | Offers these presets to `Agent`: backend, model, effort, instructions, default computer and root folder, which plugins it gets (§9.3) | data | — |
| `agentBackends` | list, unique id | Starts agents for `Agent`: an ACP agent or a vendor cloud agent (§9.3); in-process subagents are a core backend (§14.2 item 15) | code | Claude Code, Codex, Grok, Gemini CLI, DeepSeek, Cursor, Antigravity CLI, Devin, Winter's coding agent |
| `hooks` | list | Calls them in the turn loop: before and after a tool call, messages in and out, turn start and end, compaction. A hook can block or adjust inputs and results, under time limits, but cannot replace the runtime or skip approvals [D]. Claude-style settings hooks return through it | code | — |
| `commands` [P] | list, unique name | Runs a plugin's public functions for any client at once, with no model turn (§5.4) | code | — |
| `triggers` | keyed by type | Arms them for routine files (§7) | code | schedule, webhook; later Slack, Git, Teams, Linear, Sentry, PagerDuty |
| `voices` | list, unique id | Speech-to-text and text-to-speech for the bot's voice choice (§6.6) | code | **Fish Audio** [D] |
| `computerProviders` | keyed by id | Creates, resizes and deletes the VMs that cloud computer folders describe (§9.2) | code | **Google Cloud** and **Hetzner** [D] |
| `computer` | one per plugin | A cloud computer, created after the user's OK (§9.2) | data | — |
| `relays` | list | Carries encrypted traffic when two devices cannot connect directly (§8.3), or holds encrypted sync mail for devices that are never on together (§6.5) | code | **n0's public relays** [D], on by default; the **cloud computer relay** [D], off until a cloud computer exists |
| `notifiers` | list | Wakes companions when something happens (§10) | code | **waifucave push** [D], content-free; desktop notifications |
| `companions` | list | Serves a remote client within the fixed list of remote calls (§10) | code | **iOS app** [D], `clover.waifucave.com` |

**[P] Hook order:** `tool.before` hooks run first. The reviewer, the fences and the approval check then judge the input as the hooks left it, as in Winter, and nothing changes an input after it is approved. `tool.after` hooks change only results. **[P] What each event may return:** `tool.before` may deny, ask or replace the input, never allow; `tool.after` may replace the result; `message.in` may replace a message's text before the model sees it, the user's or one that folds in, and `message.out` the bot's text before it is stored and shown, so while a `message.out` hook is on, replies show and are spoken only after it runs; `turn.start` may add a labelled note to the turn; `turn.end`, `compact.before` and `compact.after` only observe. Hooks on one event run one after another, in the order of their plugins' ids, each seeing the last one's output. A hook that throws or runs past its `timeoutMs` (default 10 seconds) is skipped, and Settings shows it. **[P] Handlers.** A `host` server is an MCP server built with the official MCP SDK on an in-process transport the plugin SDK provides. A hook handler gets `{ event, session, bot, computer, tool?, input?, result?, text? }` and returns only what its event allows. A hook's `command` speaks Claude Code's hook protocol (JSON on stdin and stdout, exit code 2 to deny) under Claude Code's event names where one exists (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`), and the core ignores an `allow`. `tools` lists exact names, or patterns with `*`.

**[P] App core points** (the app's fixed plugin runtime reads or calls them):

| Point | Shape | What the app does with it | Data or code | Ships with |
| :- | :- | :- | :- | :- |
| `themes` | list, unique id in its plugin | Applies the base theme in every bot tab, the user's global theme (the base theme until the user picks one), and each bot's theme in its tab (§5.5) | data | **the base theme** [D], in `clover`, which every bot tab starts from and the rest of the app uses until the user picks a theme; Alpha's tab theme comes with Alpha |
| `app.root` (a UI spot) | single | Mounts the main window's root: the shell, which declares every other spot (§5.5) | code | **the default shell** [D] |
| `app.surface` (a UI spot) | list | Opens top-level floating windows | code | **island**, **Dispatch pill** [D] |
| `bot.tab` (a UI spot) | keyed by bot | Holds each bot's tab, which the shell shows. A bot's plugin adds UI only inside its own tab, and the base theme, the bot's theme and `when.bot` apply there (§5.5) | code; a bot's layout is data | the default bot tab, in `clover` |
| `locales` | keyed by language | Supplies the strings for the core's own text, sealed cards (from trusted packs only) and the welcome guide included, and for each plugin's keys, in the user's language (§5.5) | data | English, built in |

**[P] Data, web or code** is worked out from the manifest, never declared, and the OK shows it (§5.6):

* **Code:** the plugin has a `host`, `client` or `helper` part, or a field that names something to run: a `stdio` server, a hook's or agent backend's `command`, or a field whose format is `program` or `code` (§5.4). Every handler, adapter, custom sign-in and component is an export of `host` or `client`, so this rule names no point a plugin declares.
* **Web:** no code, but a UI part that shows a web page in an isolated view (§5.5).
* **Data:** everything else: JSON, Markdown, images, audio, VRM and GLB files, fonts, cleaned CSS and layouts.

The network hosts a plugin talks to are listed separately, whatever its class: its `network:` capabilities, plus the host of every field whose format is `url` (an `http` server's `url`, `endpoint.baseUrl`, the `auth` URLs, `web.url`). **[D]** The plugin's components can reach only those hosts (revision 14), except through WebRTC (below): the core serves each plugin origin's documents and workers with a Content-Security-Policy listing only those hosts, as Figma does, and the layer's session refuses other requests that origin starts (`initiatorOrigin`); together they stop every request-based way out (S9). **[P]** Plugin documents and worker scripts also carry `Connection-Allowlist`, which drops ICE servers and closes DNS prefetching, and DNS prefetching and speculative hints (preconnect, prefetch, prerender) stay off, since they can reach a host before `webRequest` or the CSP sees the request. **[P]** As defence in depth, plugin webContents also get Chromium's `disable_non_proxied_udp` WebRTC policy. Together with `Connection-Allowlist` it read zero on every vector that had a positive control in S9's runs. These closures are per document or per webContents, so the Clover Browser keeps WebRTC. **[D] WebRTC is a documented known gap** (the owner, revision 18, item 94; this replaces "WebRTC is off in plugin origins"). In stock Electron a directly mounted plugin document can still try to send WebRTC connectivity checks (remote ICE candidates), carrying text it chose, to an address it never declared, and no stock configuration is proven to close that: the TCP route had no positive control, and the sandboxed srcdoc was never tested with both measures on. Clover ships stock Electron, so the gap stays documented until an upstream Electron's Chromium closes it, and S9's check runs again on every Electron upgrade. **[P]** S9's PAC belt and its preload stub are both off: the PAC broke the plugin's declared host on Ubuntu and, on a shared session, would let every plugin reach every plugin's hosts, and the preload never reached the out-of-process plugin frames. Isolated web views stay open, since a site loads from many hosts, and host code isn't held to the list; the OK says so. Scripts inside skills are not plugin code: a bot runs them with `Bash` under the computer's approval level, and the OK says so.

**[D] A bot's plugin may carry code** (November 3; this replaces "a bot plugin is data only"). A bot can bring React components for its own tab (§5.5), and its plugin can contribute anything any plugin can. A bot with only a theme and a layout is still data, and its OK says so.

**[D] Computer use is not special.** A computer-use plugin contributes an MCP server, plus a helper when it needs one (opensky's native helper). Several can be installed at once, each with its own tool names, and they drive browsers too, the Clover Browser included (§12.1).

**[P] What became of the old kinds:** `tool` is the point `mcpServers`, `ui` is the UI spots (§5.5), `surface` the spot `app.surface`, `avatar-renderer` the spot `avatar` that the bot stage declares, keyed `vrm` or `live2d` (§5.5), and `webhook-ingress` the point `webhook.ingress`, which the webhook trigger declares (§7). A cloud computer folder gets the new point `computer`. Every other kind became the point of the same name.

### 5.4 Plugins that host plugins, and the plugin API

**[D]** A plugin may declare its own extension points, and other plugins may contribute to them. For example:

* The **island** plugin declares `island.tab` (with its requirements: size, idle state, attention rules), and other plugins add tabs such as Usage, Devices or Servers.
* The **Dispatch pill** declares `pill.target`. Every bot is a target the user can pick to message, and plugins can add others.
* The **webhook trigger** declares `webhook.ingress`, and the waifucave forwarder fills it (§7).

**[P] How it works:**

* A point is declared in a `declares` field, on any contribution or on the `host` part, with its shape (`single`, `list` or `keyed`), its fields and props as JSON Schemas, and a short description. It exists while the contribution that declares it is active; a point the host declares exists wherever the host half runs, so such a host sets `host.start` (§5.2). A UI spot exists while the entry that declares it is active, and waiting and Settings go by that; it is mounted only while that entry's component is on screen, so several can be mounted at once, such as two windows that each have a `composer`.
* A point whose declaration has `props` (what it hands each component; `{}` for nothing) is a UI spot: only a `ui` entry with a `component` declares one, and it is filled through `ui`. Any other point a plugin declares is filled with a top-level key in `contributes`, and its name always has a dot. New names start with the declaring top-level plugin's id and a dot (`luna.cards`). The well-known names the plugin SDK publishes (§5.6), such as `composer`, `island.tab` or `webhook.ingress`, are exempt, and a plugin that declares one must use the catalog's schema, or it is refused. A `private` point is open only to the declaring plugin's own tree.
* Hosting and packaging are separate. A child plugin does not plug into its parent automatically, and any plugin can fill another plugin's point. A host may ship its default guests as children, as the island ships its Needs you tab. A plugin that fills another plugin's point is still an ordinary plugin, which Clover installs, syncs and approves like any other; only add-ons in a format of a plugin's own are outside Clover (below).
* A contribution whose point is missing waits, and Settings says what it is waiting for ("waiting for `island.tab`"). Contributions start as their points appear, and stop before the plugin they depend on does.
* **Point schemas:** an entry is checked against its point's schema when the point appears; one that fails is invalid, with the reason, and the rest of the plugin runs. When a point appears, or its declarer's update changes the schema, and an entry's values then name a program, code or a host its plugin's OK didn't list, that entry waits for a new OK, as an update adding them would (§5.6). A format in a schema tells the core what a value is: `path` (a file in the plugin, handed over as an asset URL), `url` (its host is a network host, §5.3), `handler` (an export of `host.entry`), `component` (an export of `client.entry`), `program` (a program to run) or `code` (a folder of code). A point other than a UI spot has one active declarer; a second one waits ("declared by …") until the user picks between them. Points change only compatibly: new fields are optional, a breaking change takes a new name (`luna.cards2`), and `deprecated` marks the old one in Settings, `validate` and `Glossary`.

**[P] The plugin API.** Every host half and component gets one object from the plugin SDK (§5.6), and nothing in it names a kind of plugin:

* **Points:** a declarer reads its point's entries (`points.entries`, with paths turned into asset URLs), hears them change (`points.watch`) and calls an entry's handler (`points.call`). The handler runs in the contributor's worker, on the declarer's computer. A plugin's events are points too: listeners contribute handlers, and the declarer calls them.
* **Commands:** a command is a plugin's public function, named `<namespace>.<name>`, with a JSON Schema for its `args` and a JSON result. The user runs one from the app (the command palette, or a button that names it), the CLI (`clover run <namespace>.<name>`) or the iOS app, and **[D]** another plugin runs one only with `call:<plugin-id>`, which its OK lists (revision 14). Callbacks and events go the other way, through points. **[P]** `call:<plugin-id>` names a top-level plugin and covers its children, whose commands share its namespace, and command names are unique within that namespace. A call to a plugin that isn't installed fails at once with "not installed". Its `key` is a default shortcut, bound while a Clover window has focus, and the user can rebind it; a core shortcut or the user's own binding wins over it.
* **Its own host:** a component calls its plugin's handlers (`host.call(name, args)`) and hears what its host half sends it (`host.on(event)`). A call runs on the component's own computer, where the host half starts with the component (§5.2), unless `platforms` leaves that computer out; then it runs on the main, which starts it if needed.
* **Storage:** each plugin has a data folder on each computer (`<home>/plugin-data/<id>/`, `${data}` in `stdio` arguments), never synced, kept when the plugin is removed, and fenced from bots' writes (§9.1), and a synced store of up to 1 MB. Neither sits in the plugin folder, so neither changes its hash.
* **The keyed fetch:** `net.fetch(url, init, { auth })` goes through the core, which adds the named `auth` entry's key or token (the only one, by default), reaches only the plugin's `network:` hosts, refuses a redirect elsewhere, streams both ways with no time limit while data flows, and after a 401 gets a newer token from the refresher and retries once (§3.3). A process of the plugin's own that must sign (§5.2) reads its secret with `secrets.get(name)`; a worker can't. **[P]** Where the key goes is never chosen per call. The core takes it from the `auth` entry's `placement` (§5.9), one of a fixed list: `authorization` with a scheme (`Bearer` when none is named), `x-api-key`, `api-key` or `x-goog-api-key`. It refuses a request that sets that header itself, and strips from every response it hands back, redirects and 401s included, each header whose value holds the key. The SDK's model adapters follow the same rules.
* **The account token and per-computer keys** (only in `clover`'s plugin-host process, item 84): **[P]** a bundled plugin's keyed fetch can add the user's waifucave account token (`auth: "waifucave"`), sent only to the `*.waifucave.com` hosts in its `network:` list, and `keys.publicKey(name)` and `keys.open(name, …)` give it a key pair per computer whose private half never leaves the core (HPKE base mode, never synced). The forwarder opens webhooks with it (§7).
* **Settings:** `settings.get` and `settings.watch` read the plugin's own values, and `settings.set` changes them, from its host half or its components alike; a plugin changes only its own values, and the core's settings change only as §5.5 says.
* **Its components:** `ui.send(event, data)` reaches their `host.on`.
* **The caller:** every command, tool and point handler is told who called: the user and the client, a bot's or agent's session, or a plugin by id. Clients run commands through the core method `command.run`, with `command.list` for the palette, and a bot that runs one through the CLI runs it as the bot (§3.1). **[P]** A call a plugin makes while it serves a tool call acts as the session that made the tool call. The core binds that session from the tool call's own context, which the plugin host carries, and never trusts a caller the plugin supplies, such as a caller it writes into `_meta` (the controller's ruling R7).
* **Capabilities:** each one gates a fixed set of calls and live events, listed in the plugin SDK's reference and versioned with `engines.clover`. Without the capability, those calls don't exist for that plugin.

  | Capability | Lets the plugin |
  | :- | :- |
  | `conversation.read` | Read bots' conversations and follow them live; sealed card fields never reach it |
  | `conversation.post` | Add a note to a conversation, or send a bot a message; a turn it starts is the plugin's, never the user's (§5.5) |
  | `memory.read` | Read bots' memories |
  | `bots.read` | Read the list of bots and their settings |
  | `routines.read` | Read the list of routines and their runs (§7) |
  | `computers.read` | Read the computer registry: each computer's folders, level and state (§9.1) |
  | `computers.control` | Take and release holds and the user-working mark, learn where Clover's windows are, and say when an action is running (§9.2). The OK says it "controls the screen and input of your computers" |
  | `approvals` | Hear which cards are pending, never their text, and place their sealed frames (§5.5). The OK says it "restyles approval cards" |
  | `files` | Read and write files through the folder tree, inside the fence (§9.1) |
  | `project.write` | Let its hooks and stdio MCP servers change files in the session's project folders, never `.git/hooks`, `.git/config` or a credential file; without it those folders are read-only to them (§5.2). The OK says it "changes files in your project folders" |
  | `browser` | Drive the Clover Browser through its API (§12.1) |
  | `usage.read` | Read usage rows and plan readings (§12) |
  | `logs.read` | Read Clover's logs and every plugin's |
  | `notify` | Send the user a notification through the `notifiers` (§10) |
  | `audio` | Record and play audio through the app (§6.6). It records only while push-to-talk is held, unless the user turns listening on (§5.7), and the OK says it "can hear your microphone" |
  | `call:<plugin-id>` | Run that plugin's commands (above) |
  | `network:<host>` | Reach that host (a name, with `:port` if needed, or `*.` and a domain for its subdomains): through the core's fetch, which adds the plugin's own keys and tokens (§5.1), and from the plugin's components, which reach no other host (§5.3) |

* **Asking the user:** `confirm(text)` shows a sealed card that says it comes from a plugin, with the plugin's name, id and source and its text, and returns only the user's answer; no plugin can read or answer it. Unanswered, it is denied after 10 minutes.
* **Limits:** arguments and results are structured-clone data. A plugin-API call times out after 10 seconds unless the caller sets a longer limit, up to 10 minutes (tool calls, hooks, `confirm` and the keyed fetch keep their own limits), and a call to a stopped plugin fails at once with the reason.

**[D] Add-ons of a plugin's own** (revision 14): a plugin may run add-ons in a format it chooses, such as a video editor's effects, which Clover doesn't install, sync, check or list. **[P]** Its manifest says so (`addons`, with a short description), its OK says "loads add-ons of its own, which Clover doesn't check", and adding `addons` in an update asks again (§5.6). The add-ons live in the plugin's data folder, which bots' tools can't write (§9.1). Since a `stdio` server can still write there, the plugin loads an add-on with code only if its hash is in the plugin's synced store, put there after a call whose caller was the user, or after the user's yes to its `confirm` when a bot or another plugin asked. They reach bots only through the plugin's own tools and show only inside its own components, so they need no point. Since the core can't see inside a plugin's code, the official index checks that a plugin with add-ons keeps these rules.

### 5.5 The UI and styling

**[D] Users can restyle anything.** Themes stack, lowest first [P]:

1. core defaults
2. **[D]** in bot tabs, the base theme for all bot tabs, which `clover` ships (revision 13)
3. the user's global theme
4. the bot's theme (applies in that bot's tab; Alpha ships its own)
5. plugins that dress a smaller part, inside that part, style-only entries included (below)
6. the user's own overrides

**[P]** Settings picks the base theme, `clover`'s by default, as it picks the global theme, and a bot with no theme of its own simply skips step 4. **[D]** Until the user picks a global theme, step 3 is the base theme too, so the whole app starts from it (revision 14).

Themes use design tokens first, and arbitrary CSS when tokens are not enough. **[P]** The plugin SDK publishes the token catalog: each token's name, type and default, with `card.*` the set sealed frames take. It is the one source of token names. **[P]** In CSS a token is the custom property `--clover-` and its name with dots as hyphens (`color.text.muted` is `--clover-color-text-muted`). A plugin's own tokens are `plugin.<top-level id>.<name>`, and in CSS the id's hyphens become underscores (`plugin.mcp-blender.glow` is `--clover-plugin-mcp_blender-glow`), so the map from names to properties stays one to one. **[P]** Tokens flow down, so a plugin that dresses a smaller part uses the colours around it unless it sets its own. CSS stops at the edge of a part that a smaller plugin dresses (CSS `@scope … to …`).

**[D] The whole shell is plugins,** as in DeepSeek Harness:

* The sidebar, bot tabs, conversation view, composer and panels ship as **bundled UI plugins**.
* Any of them can be replaced, for example with a visual-novel-style conversation view.
* The panel's contents (the session view, terminal, diff, browser and files, and later an editor) are bundled plugins too, each its own, enabled by default and replaceable (item 83).

**[D] The default shell is laid out like Claude's desktop app** (its Code view; the owner, revision 18, item 83):

* the left sidebar
* the conversation, with runs of tool calls collapsed
* the composer, with model and level pills
* panel toggles at the top right
* a right panel holding the session view, terminal, diff, browser and files, each panel a replaceable plugin
* the settings modal and the language chooser

It uses Clover's own marks, with no Claude logo, mark or wording.

**[D] Its look matches Claude's desktop app almost exactly** (item 86): radii, spacing, colours, borders, states and type, measured from the owner's screenshots, with Clover's own icons (an open-licensed set), system fonts and wording. Controls follow the OS accent colour, and Clover's pink appears only in its mark. The left sidebar is its own plugin and translucent (the macOS sidebar material, Windows acrylic, solid on Linux), the top bar is semi-translucent, with the transcript scrolling beneath it, and two panels can be stacked.

**[D] Which panels a tab gets** (item 90):

* **A bot's tab** gets a slim column (agents and tasks, context, outputs) and the browser panel. The bot's running ACP agents show in the slim column; clicking one opens it in the right panel as a code-session-style transcript, with its own composer and model picker, but without the code panels or a slim column of its own (§9.3).
* **A code session** keeps the full set: the session column, terminal, changes, files (rooted at the session's folder, §9.1) and browser.
* Bots have no file view (item 88).

**[P] UI spots.** A UI plugin fills named spots. A spot shows one entry (`single`), every entry in order (`list`), or one entry per key (`keyed`). **[P]** In a keyed spot, an entry with no `key` fills every key that has no entry of its own, as the default bot tab fills `bot.tab`; a `key` ending in `*` (`image/*`) fills the keys it matches, after exact ones. A plugin can replace one part and leave the rest alone: only the composer, say, or only the bot's message bubble. **[D] It can also restyle a part or hide it without replacing it** (revision 14), so plugins style, add and remove parts. **[P]** An entry with only `style` (a theme-format file: tokens and cleaned CSS) restyles whatever fills its spot or key, inside that part, as step 5 of the theme stack. It is data, it does not compete to show, and several apply in the reverse of the order the rules below give, so the one that would win applies last; the core inserts each after the filler's own CSS and gives the part it dresses `contain: layout paint`, as a tab's root has. An entry with `hide: true` in a single spot or a keyed cell competes like any entry and, when it wins, shows nothing there; Settings can bring the part back. A key that its point's declaration lists in `keep` can't be hidden (the catalog lists `approval`, as item 70 says), and the 2-second fallback card still applies (below). The default shell declares the well-known spots, and the plugin SDK's catalog (§5.6) lists each one's shape, fields and props:

* `app.root` holds the shell, which declares `sidebar`, `sidebar.bot`, `sidebar.app` (app buttons), `main` (keyed by route: bot, agent, settings, plugins, app), `panel` (the panel host, keyed by panel: `session`, `terminal`, `diff`, `files` and `browser`, which the browser view fills; a key no plugin fills shows the host's placeholder), `panel.view` and `settings.section`.
* A bot's tab is the app core point `bot.tab` (§5.3), which holds `bot.header`, `bot.stage`, `bot.side`, `conversation` and `composer`. The stage declares `avatar`, keyed by the avatar file's format (`vrm` or `live2d` [D], item 87, or a plugin's own), which draws the bot's avatar and lip-syncs it to the speech the app plays; the composer declares `composer.action` (keyed by action id, so one button can be dressed on its own).
* `conversation` declares `conversation.message`, keyed by `user`, `bot`, `tool`, `approval`, `question`, `routine-result`, `task-notification`, `agent-report` and `note`, and `tool.result`, keyed by tool name.
* The island declares `island.tab`, and the pill declares `pill.target`.
* Parts also declare list spots for add-ons, so a plugin can add to a part without replacing it: `conversation.message.extra` under each message, `bot.header.action`, the shell's `status` bar, and menus such as `menu.message`. Wherever a file shows, the part declares `file.preview`, keyed by media type. The bot editor declares `avatar.packs`, a data point of avatar files with their format and portrait, so an avatar pack is a data plugin.

A replacement for a container should declare the container's own spots (a new composer declares `composer.action`); otherwise what fills them waits, and Settings says why. **[P]** A component shows a spot with the plugin SDK's `<Spot name key props>`, and the core mounts each entry there, inline when it is in the same layer or as a frame from its own layer. An entry gets only the declared props (data, plus callbacks the core routes back) and the tab's resolved tokens, which its own CSS may override. A declaration lists the capabilities its props carry data for (`needs`; the catalog sets `conversation.read` wherever messages show), and an entry whose plugin lacks one isn't mounted there. A callback that sends a message counts as the user's only when it uses up the frame's transient user activation from a key press or click the app saw come from the hardware, as for sealed buttons (below). One such key press or click covers one send, and any other send is the plugin's (§5.4). A layout's `{ spot }` nodes place spots that the tab's components or the bot's plugin declare, and `prefer` lists `<plugin-id>` or `<plugin-id>#<entry-id>`. The user can hide and reorder the entries in a list spot. A whole new shell goes in `app.root`, and part replacements keep working inside any shell that declares their spots. A shell that breaks the app is what safe mode is for (§5.8).

**[D] A bot's plugin styles its own tab, and only its own tab** (November 3). Everything a bot's plugin adds to the UI applies inside that bot's tab, and it can fill only the spots inside the tab. A panel in every tab, an island tab or a new look for the whole app comes from another plugin, which can be a child in the bot's folder (§5.1). **[P]** A bot's tab look has three optional layers, all inside the bot's plugin:

* **A theme** (data): design tokens, fonts, backgrounds, and CSS that applies only in that tab. The CSS is cleaned first: no `@import`, `url()` only for files inside the folder, and no remote fonts or images. The tab's root has `contain: layout paint`. The cleaner keeps only the at-rules it knows (`@media`, `@supports`, `@container`, `@scope`, `@starting-style` and the named ones below) and drops the rest, `@property` included; it prefixes the names that `@keyframes`, `@font-face`, `@layer`, `@counter-style` and `@font-palette-values` define, and the plugin's own uses of them, with the plugin's id. A layer's preload answers only frames of its plugin's origin. Every ancestor of a sealed frame stays free of filters, opacity below 1 and transforms other than moves or enlargements, whatever a theme says; S9 checks the base theme and Alpha's. The user can also pick a bot's theme as their global theme.
* **A layout** (data): how the tab's parts are arranged, as a small tree of rows, columns, stacks, tabs, spots, images, text and spacers, with sizes and rules for narrow windows. It has no events, scripts or outside URLs, so the bot editor, and bots themselves, can write one safely.
* **Components** (code): React components for any spot in the tab, or for the whole tab. They run in the bot's own layer (below), and they make the plugin code; its OK says so.

The iOS app and the web page honour a bot's theme tokens and can honour its layout, since both are data; components run only in the desktop app.

**[D] Each bot's tab renders in its own layer, and shared parts render once** (revision 12). A layer is a renderer process of its own, and code in one layer cannot reach another, so "only its own tab" holds for a bot's components too. A part that several tabs share, such as a composer two bots use, renders in one layer and is the same in each. **[D]** It takes each tab's colours, unless its plugin sets its own (revision 13), so a shared composer matches each bot's tab. **[D] "Renders once" means** one origin and one renderer process for each shared plugin, one frame for each place it appears, its state held by the core, and each frame themed by its own tab (the owner, revision 18, item 77). A document can't show in two places at once, and S9 found that a second window reuses each plugin's renderer. **[P] How:**

* Every plugin with UI code gets its own layer and origin, a child included (its origin writes the child's `/` as `--`, §5.1), so a bot's components never share a process with what its children add to other tabs. Everything we ship under `clover` shares one layer, the default shell's, and keeps it when a third-party shell fills `app.root`. A bot whose plugin is data only needs no layer: the core applies its theme and layout, which cannot run.
* A part from another layer shows as a frame from that plugin's own origin, drawn by its own process (Chromium's out-of-process frames). The core sizes the frame, and a menu that must cross the frame's edge asks the core to draw it on top.
* The core applies data (tokens, CSS, layouts) in every layer it dresses.
* Only parts near the screen are mounted, and a layer hidden for a while sleeps and is rebuilt from the core's state.
* No layer has Node, and the plugin API in every layer has the limits listed under approvals (below).
* **Mounts (S9):** plugin documents load only through single-use, unguessable mount tokens the core issues, with `frame-ancestors` naming the parents allowed and `frame-src` holding each plugin to its own contributions. The core and the sealed cards use schemes of their own, never a name in the plugin-id namespace. A host component still controls how frames nested in it look (process isolation doesn't stop it clipping or covering them), so the sealed cards' visibility and hardware checks stay mandatory (below).
* **Input and state (S9):** the app's main process owns app shortcuts, ahead of every layer (the window's `before-input-event`). Menus go through a broker in the main process that binds the sender, the coordinates and the action ids. The main process returns focus to a layer's frame, and the layer's SDK restores the focused element. Shared state lives in the core. A plugin's popup HTML never runs in the core's origin.
* Spike S9 checked the isolation, the memory each layer costs (about 18–24 MiB of private memory each), and focus, keyboard and drag and drop across layers (§14.1).

**[P] Other plugins** fill spots everywhere, or only in some bots' tabs with `"when": {"bot": ["alpha"]}`. Turning on a plugin that dresses parts of bots' tabs asks which bots it applies to, ticked as its entries' `when.bot` say together, or all if none says; its settings change that later, and the ticks replace `when.bot`. `when.bot` applies to UI only: tools, skills and hooks can't be limited to some bots, because bots are equal (§1).

**Which entry shows** in a single spot or a keyed cell:

1. **[P]** the user's pick, for this bot first, then globally
2. **[D] the smaller part** (revision 12): an entry that dresses a smaller part beats one that dresses a part around it. A bot's tab look counts as dressing the whole tab, so a composer plugin turned on for that bot takes the composer, and a plugin for one composer button takes that button.
3. **[P]** the bot layout's preference
4. **[P]** the most specific `when.bot`: one bot, then some bots, then all (a bot's own entries count as limited to that bot); other `when` conditions only decide whether an entry applies
5. **[P]** a plugin the user installed, over a bundled one
6. **[P]** the most recently enabled

When step 6 decides, Settings shows a conflict badge on that spot with a picker. Authors never set priorities. **[P]** The part an entry dresses is the smallest spot holding all its plugin's entries in that tab, a child counting as its own plugin: a send-button plugin dresses the button, a bot's tab look the tab, a shell the app. The bots ticked when a part plugin is turned on are its `when.bot`; "all" includes bots added later. Sealed frames take only `card.*` tokens, so card styling is that set plus the components that place sealed frames.

**[P] Web pages:** a UI part can show a web page (a URL, or a page inside the folder) in an isolated view with its own session, no Node, no plugin API and no access to sealed cards. Discord Waifus works this way (§11). Connecting such a page to bots needs a component, which makes the plugin code.

**[D] MCP Apps** (revision 14): when a tool names a `ui://` page (`_meta.ui.resourceUri`, the MCP Apps extension `io.modelcontextprotocol/ui`), the page shows where the tool's result shows, and the core runs it in an isolated view like a web page's, with no plugin API. **[P]** The core bridges the page's JSON-RPC calls to its own server under the same approvals and levels, enforces the page's declared domains and content rules (`_meta.ui.csp`; undeclared domains are refused), and shows the result as text where no view can run, such as on the iOS app and the web page. Since the page runs isolated, it doesn't change its plugin's class. **[P]** The bridge gives the page `tools/call` only for its own server's tools whose `_meta.ui.visibility` includes `app`, plus `resources/read` and `ui/request-display-mode`. `ui/message` and `ui/update-model-context` reach the bot as outside content labelled with the plugin, never as the user's, so a turn they start is the plugin's; `ui/open-link` opens the user's browser; the page gets no camera, microphone, location or clipboard. A tool whose visibility leaves out `model` never reaches a bot, `Glossary` or an agent. A component that shows a tool's result places the page with the plugin SDK's `<AppView call>`; a page no component places within 2 seconds shows as text.

**[D] Translations** (revision 14): the app core point `locales`, keyed by language, holds string tables for the core's own text, sealed cards and the welcome guide included, and for any plugin's keys, which components read through the plugin API (`t(key)`). Keys start with their plugin's id and a dot, and the core's and `clover`'s with `clover.`, so one language pack, a data plugin, can translate the core and many plugins. A bot's plugin translates only its own keys, as its UI stays in its tab; a pack for the rest can be a child in its folder (§5.1). **[D]** The strings on sealed cards and in the OK come only from the built-in tables, `clover`'s packs and packs whose tree hash matches the official index (revision 15), so a pack that a bot edits can't relabel them; other packs translate everything else, and those strings fall back to English. **[P]** The user picks a language in Settings; a missing string falls back from a regional language to its base (`pt-BR` to `pt`), then to English, then to any language its plugin has, and a manifest's `Text` can carry its translations inline (§5.9). Strings use `{name}` placeholders, and a key may hold plural forms (`{ one, other, … }`, by the language's rules). A child's keys start with its top-level plugin's id. For one key, a plugin's own table beats a pack's, and between two packs the user picks in Settings, the first enabled applying until then.

**[D] Approvals are core data that plugins show but cannot read.**

* The core hands each approval to the UI as **sealed fields** (what is asked, the command, the computer, the risk…) and **sealed approve and deny buttons**. A plugin places and styles them however it likes, but never sees their text, so it cannot rewrite or fake it.
* A plugin may leave fields out. For example, a clean UI can show one approve and one deny button and nothing else, and the buttons themselves can be restyled, even without text.
* **[D] A bot's plugin can style the approval card in its own tab** (November 3), through its theme or its components, like any UI plugin.
* **[P] How:** each sealed field is a small frame from a core-owned origin, isolated from the plugin's page. Style tokens go in; nothing comes out. The core accepts a click only while its button is visible and uncovered (Chromium's IntersectionObserver v2).
* **[P] Only sealed buttons answer:**
  * The core takes an answer only from a sealed frame, over a channel the app's main process opens for that frame alone, or from a paired device's own app, signed with its answer key over the card's id and hash.
  * **[D] Who may answer another computer's card** (the owner, revision 18, item 91): any desktop, as well as phones; browsers never. A desktop signs with an answer key apart from its link key, held by the app where the OS can protect it (the macOS Keychain, Windows Hello or the TPM). Receivers always rebuild the card for the bound call and compare hashes. The owner accepted that a compromised plugin on a Windows or Linux computer, where plugin code runs as the user (§5.2), could approve actions on the user's other computers.
  * Cards and answers travel on the core's own link; a companion plugin never sees either (§10).
  * The layers that run UI plugins have no Node, and their plugin API cannot answer cards, change levels or devices, or read secrets. Only the `clover` layer changes the core's settings and the user layers directly (a plugin's own settings are its own, §5.4); another layer's change becomes a sealed card, and sensitive changes (below) are a sealed card from every layer.
  * Socket clients prove their role with a token, and the daemon checks a caller's process tree (§3.1).
  * A click counts only while no other window overlaps the button and no computer-use action is running on that computer. **[P]** The overlap check counts Clover's own surfaces too (R12). **[P]** It counts only when the app saw it come from the hardware: on macOS an event no other process posted (`eventSourceUnixProcessID`), so an accessibility press never counts; on Windows one without `LLMHF_INJECTED`; on X11 one not sent through XTEST. The whole button must show, at 24 by 24 CSS pixels or more, with no browser view over it. On Wayland, plugin overlay windows hide while a card is pending, and only the focused Clover window takes clicks. A plugin with `computers.control` learns where Clover's windows are (§5.4) and must not act on them, as Winter never controls itself today (`WINTER_OWN_BUNDLE_IDS`); ours also blacks them out of its screenshots.
* **[P] A fallback:** if no plugin puts the approve and deny buttons on screen, visible, within 2 seconds, the app shows its own card. A filter, opacity below 1, or a transform other than a move or an enlargement, on a sealed frame or anything around it, counts as hidden (IntersectionObserver v2 reports it so), so card styling may not use them.
* **[P] The limit:** a plugin can still put misleading words next to a button that has no text, or make deny look like approve. So the OK given when the plugin was found (§5.1) says "restyles approval cards" for any plugin that does, a bot's included, and **[D] a later change to that styling waits for its own OK** (revision 12): until the user OKs it, cards keep the styling last OK'd, while the rest of the change applies at once. **[P]** Card styling is every component that places sealed frames, wherever it shows them (the `approval` cell, an island tab, the pill), plus the token values handed to the frames. A component gets sealed frames only if its plugin has the `approvals` capability, so the OK can say so before anything runs, and no other CSS reaches inside an approval card. A development folder (§5.6) is exempt. **[P]** A component with `approvals` hears pending cards' ids and computers, never their text (`approvals.watch`), and places one with the plugin SDK's `<Card id>` and its parts (`<Card.Field name>`, `<Card.Approve>`, `<Card.Deny>`). While a change to a component's card styling waits for its OK, the core keeps the last OK'd version of that component and mounts it wherever it places frames.
* **[P] Sensitive changes are approvals too.** Raising a routine's level, changing a computer's level, adding or revoking a device, choosing the main computer, loading a found plugin, adding a development folder, trusting a repo, and adding a saved allow rule or a connector permission all end in a sealed card unless the user makes them in their own terminal (§5.1), so a plugin can ask for them but never do them silently. On Windows and Linux that holds for UI code; host code runs as the user there (§5.2).
* **[P] Where cards appear:** in any surface (conversation view, island, Dispatch pill), on the user's other desktops (item 91) and in the native iOS app, but not on the web page (§14.2 item 5). Every device shows a pending card, and the first answer wins. A request from a turn the user's own message did not start (a routine, another bot, a task notification, an agent working alone, a plugin) is denied after 10 minutes unanswered; one from a turn the user started waits, in any session (§9.1).

**[D] `AskUserQuestion` is different.** Plugins can read its question and options and show them in any form, charts included. It is a conversation, not a security boundary.

### 5.6 Trust

* **[P] Plugins are trusted code within their reach.** UI code can restyle anything in its own layer, but no other layer (§5.5). Host halves run as the user. On macOS they are kept from Clover's Keychain items and the daemon's socket; on Windows and Linux nothing keeps them from either (§5.2).
* **[P] The OK shows what a plugin is:** data, web or code (§5.3), what it adds, the network hosts it declares (saying that its components reach only those, except WebRTC connectivity checks, a known gap (§5.3), while its host code can reach any), the OS permissions its helper wants, its capabilities, its children (a checkbox each), and who wrote it, from the core's own record: the user through the app, a bot through its tools, the migration, or "found on disk" (`generated.by` in the manifest is only a hint). It flags `stdio` commands that fetch code at run time (`npx`, `uvx`) and plugins that load add-ons of their own (§5.4), and marks plugins from outside the official index "not reviewed", since `adult` is self-declared.
* **[P] When the app asks again:**
  * A code change waits for a new OK, whoever made it, since the core cannot always tell who wrote a file.
  * An update asks again if it turns data into code, or adds capabilities, network hosts, helper permissions, hook events, add-ons of its own (`addons`), a `stdio` command that fetches code at run time, code children or adult content. These are **the triggers**.
  * A local edit asks again on the same triggers, and any edit that changes what runs is a code change wherever it is written: a `stdio` server's `command`, `args` or `env`, a hook's or agent backend's `command` or `args`, the `host`, `client` or `helper` fields, or a field whose format is `program` or `code`; a changed setting `default` waits for the user's OK too, since bots can't change settings (§9.1). Other data edits (themes, layouts, CSS, Markdown) apply at once, except approval-card styling (§5.5). A change to a bot's instructions applies at the next compaction, or at once if the user chooses to pay for the cache miss.
  * **Development folders** are the exception. A folder the user adds in Settings, or with `clover plugin dev <folder>` from their own terminal, reloads on every change without asking. It never syncs, the fence keeps bots out of it (§9.1), and no agent's root may contain it. Adding one is a sealed card, unless the user adds it in their own terminal (§5.1). While one is on, the tray shows it and lists each reload, and it turns off after 24 hours unless renewed. **[P]** A development folder's contributions exist only on its own computer: a bot in one thinks and shows there, and its models, tools and UI serve only that computer. One with an installed plugin's id replaces that plugin there while it is on; if that plugin holds a bot, it takes effect only on the computer running that bot and waits elsewhere, so the bot keeps one writer (§6.5).
* **[P] The guards:**
  * the OK when a plugin is found (§5.1)
  * the approval level for each computer (§9.1); bots are equal, so there is no per-bot policy
  * **sealed approval cards** (§5.5)
  * on macOS, the plugin host's own identity and its sandbox away from the Keychain and the daemon's socket (§5.2)
  * the layers, which keep each plugin's UI code to its own part of the app (§5.5)
  * the manifest's capability list, which gates the plugin API only. It is **not** a containment boundary: a host plugin can do anything the user can, except, on macOS, reach Clover's Keychain items and the daemon's socket.
  * **the load guard** (#234): a plugin process Clover starts (a host half, a hook, a stdio MCP server) runs Bun as `clover-plugin-bun`: a Bun binary of its own, the core's version, signed under its own identifier, so no Keychain item's access list (which names `clover-core` alone) admits it. Never the core's binary, never with `BUN_BE_BUN`, never one the plugin ships. It runs with Clover's own `bunfig.toml`, no `.env`, and a preloaded guard that refuses to load any file, native addon or worker code from outside the plugin's own folder and Clover's shared packages. Bun hands an ESM load of a file without an extension to no hook, so two more walls stand in for the guard there: no runner may write a `node_modules` in any folder above one plugin code loads from (`~/node_modules` among them), and the OK refuses a plugin that imports or declares a dependency it doesn't ship in its own `node_modules`. A host half therefore runs under Bun; only Clover's own plugins keep a Node host. **Known limit:** a program that isn't Bun (a `stdio` server's command, a helper, a `node` the plugin's code starts) resolves its own imports as it likes. It is code by declaration, the OK says "It runs its own programs, which Clover doesn't confine", and the static check in `clover plugin validate` is its only early warning. Neither does the guard judge what the approved code chooses itself: `eval`, or a child it starts with a clean environment.
* **[P] `clover plugin validate`** prints a folder's class, contributions, declared points, network hosts, helper permissions, capabilities, tool names, settings and children without running anything, like `claude plugin validate`. It checks every schema and catalog name, prints the OK's text, takes `--json`, and exits non-zero on any error. Model plugins also get Winter's provider conformance suite (`@yanlinglabs/winter-provider-conformance`, renamed) as their test kit.
* **[P] The plugin SDK** (`@waifucave/clover-plugin-sdk`) ships on day one, from one source: JSON Schemas and TypeScript types for the manifest, theme, layout, locale and index formats; the catalogs of spots, points, tokens, hooks and capabilities; the plugin API (§5.4); `clover plugin new <template>`, with templates for a bot, a theme, a tool, a UI part, a model, a trigger and a point; and a bundled skill that teaches bots the same. A template is only a starting point that writes an ordinary plugin folder. The docs are generated from the same catalogs.
* **[P]** A full OS sandbox for plugins can come later; until then only macOS keeps host halves from Clover's Keychain items and the daemon's socket.

### 5.7 Content and age

* **[D] Clover is rated 13+.**
* **[D] The default app ships with no adult content.** Alpha, the default theme and everything bundled are safe-for-work. Adult content can only come from plugins other users make (bots, mods…).
  * **[P] Stated precisely:** it can also come from bots and avatars the user makes, and from what the model writes, which follows the user's own provider's rules.
  * **[P]** Provider terms differ by age: some providers require users to be 18 or older, others need a parent's permission under 18. The welcome guide shows each provider's terms before sign-in.
  * **[P]** The harness keeps a safety block in the system prompt that no bot or data plugin can remove. A model plugin sees the whole prompt, and its OK says so.
* **[P] Because users can be 13:**
  * the official index admits no adult plugins
  * a plugin that may contain adult content must say so in its manifest
  * the app keeps such plugins off until the user confirms they are 18 or older
  * the official index has a report and takedown path
  * voice listens only while the user holds push-to-talk, by default

### 5.8 What is not a plugin

**[D] The fixed core** (§3.2): the agent runtime (turn loop, tool dispatch, interrupts, compaction, context assembly), the event log and storage, permissions and approvals with the sealed approval cards, the routine engine, the plugin registry and the plugin host, settings, identity, pairing, links and sync, the folder tree, the Clover Browser, and the protocol.

**Also core, stated here so nothing is implied:**

* the system-prompt blocks the harness owns, the safety block included (§6.1, §5.7)
* memory storage and its sync, including merging after a takeover (§6.5); there is no memory tool
* the credential store and its sync (§8.5)
* the main computer, its lease, takeover and the shared clock (§6.4)
* the waifucave handshake, discovery and the links themselves (§8.3); only relays are plugins
* the Bash tool and its safety fence on each OS (§4), and the fence that keeps bots out of settings, levels and credentials (§9.1)
* the safety reviewer behind "ask for risky actions", with the rules that choose its model (§9.1)
* the bridge MCP server that carries plugins to ACP agents (§9.3)
* the list of calls a remote client may make (§10)
* the Electron main process: windows, tray, updater, daemon installer and the Clover Browser's tabs (§3.1, §12.1)
* **[P]** the app's plugin runtime: loading UI halves, the theme engine, the sealed frames, and the app core points (§5.3)
* the welcome setup guide (§3.3)
* the core tools and the `Glossary` index (§6.7, §6.8)
* **[P]** the index revocation check (§14.2 item 25), opt-in crash reporting (§14.2 item 27), and the usage counting of Clover's own turns (§12)
* **[P] Safe mode:** if a replaced shell plugin breaks the app, safe mode starts only the app's own plugins (`clover` and `alpha`) and a core plugin manager, reachable from the tray or the CLI. No third-party UI, host half or hook runs in it.

**Clients, not plugins:** the CLI and TUI, which talk to the daemon like the app does; `clover doctor` carries over from `winter doctor`. Remote clients such as the iOS app and the web page are served by plugins contributing to `companions` (§10).

**[D] Plugins, decided November 3:**

* **Tools:** core except the web, computer-use and browser tools, which are plugins (§6.7).
* **Agent-loop hooks:** the `hooks` point (§5.3), shipping in C1.
* **The shell and the panel:** plugins (§5.5), the browser view included.
* **Bots:** plugins with a `bot` entry, which may carry code for their own tab (§5.3, §5.5). Themes and skills are data.
* **Cloud computers:** each one is a plugin folder (§9.2).

**[P] The remaining items:**

* **Commands:** the `commands` point.
* **Workflows:** a later plugin with an MCP server.
* **Output styles:** for bots, `<bot-instructions>` covers them; for coding sessions they return later as a plugin (§12).
* **LSP:** a plugin with an MCP server.
* **Usage tracking:** the counting is core; each computer reads its own apps' usage (§12); the views are UI plugins.
* **The settings screen, the bot editor, the plugin index browser and the archive of old Winter sessions:** bundled UI plugins. Sensitive changes made from them still end in a sealed card (§5.5).
* **Desktop notifications:** a bundled plugin contributing to `notifiers`.
* **A browser tool before opensky:** a bundled plugin over the Clover Browser's API (§12.1).


### 5.9 Manifest reference

**[P]** `clover.json`, format 1. JSON with comments and trailing commas is accepted.

```ts
type Path = string;   // relative to the plugin folder; must resolve inside it (real path, no symlinks out)
type Text = string | { en: string; [lang: string]: string };
type Os = "macos" | "windows" | "linux";
type Platform = "darwin-arm64" | "windows-x64" | "linux-x64" | "linux-arm64";   // no darwin-x64: macOS 27 is Apple silicon only
type Scope = "bots" | "agents" | "both";
type JsonSchema = object;   // JSON Schema 2020-12; its formats (path, url, handler, component, program, code): §5.4

interface Manifest {
  manifest: 1;                      // required
  id?: string;                      // required at top level; must equal the folder name. Children omit it
  name: Text;                       // required
  version?: string;                 // semver; default "0.0.0"; required to publish to an index; children inherit
  description?: Text; icon?: Path;  // icon: svg, png or webp, at most 256 KiB
  author?: { name: string; url?: string }; license?: string; homepage?: string;
  namespace?: string;               // tool prefix (top level only): lowercase letters, digits and
                                    // single hyphens, a letter or digit at each end, at most 40; default = id; children share it; "clover" reserved
  engines?: { clover: string };   // plugin-API semver range; required when the plugin has code
  platforms?: Platform[];           // code runs only on these; default all
  adult?: boolean;                  // whole tree; off until the user confirms they are 18+
  enabledByDefault?: boolean;       // children only; default true
  scope?: Scope;                    // default "both"; covers mcpServers, skills, agents, hooks
  onlyBackends?: string[];          // only these Agent backends receive it, e.g. ["claude-code"]
  host?: { entry: Path; runtime?: "bun" | "node";   // bun = a worker in the plugin host; node = its own process, Clover's own plugins only (§5.6, the load guard)
           start?: "each" | "main" | "chosen";     // starts at once there (§5.2); otherwise only when needed
           declares?: Record<string, PointDecl> };  // points the host serves (§5.4)
  client?: { entry: Path };         // React module loaded into the app
  helper?: { bin: Partial<Record<Platform, Path>>;   // a signed .app on macOS, started through Launch Services
             permissions?: ("accessibility" | "screen-recording" | "input-monitoring" | "microphone" | "camera")[];
             ipc?: "socket" | "stdio" };
  capabilities?: string[];          // conversation.read, conversation.post, memory.read, bots.read, routines.read,
                                    // computers.read, computers.control, approvals, files, browser, usage.read,
                                    // logs.read, notify, audio, call:<plugin-id>, network:<host> (§5.4).
                                    // They gate the plugin API; they are not containment
  settings?: Record<string, Setting>;
  auth?: Auth[];                    // sign-ins for the plugin's own service (§5.1)
  addons?: { description: Text };  // runs add-ons of its own, in a format it chooses (§5.4)
  contributes?: Contributions;
  generated?: { from: "mcp-config" | "mcp-url" | "skill-folder" | "agent-file" | "claude-plugin" | "winter";
                by: "user" | "bot" | "migration"; at: string };   // a hint; the OK shows the core's own record (§5.6)
}

interface Setting {
  type: "string" | "number" | "boolean" | "enum" | "color" | "secret";  // a secret goes to the credential store only
  title: Text; description?: Text; default?: unknown; options?: (string | { value: string; title: Text })[];
  min?: number; max?: number;
  scope?: "account" | "device" | "bot";   // default account; device values don't sync; bot = one value per bot
  required?: boolean;                     // the plugin waits until the value is set
}

interface Contributions {
  bot?: Bot;                                  models?: Model[];
  mcpServers?: Record<string, McpServer>;     skills?: Path[];            // folders holding SKILL.md; globs allowed
  agents?: (Path | AgentDef)[];               agentBackends?: AgentBackend[];
  hooks?: Hook[];                             commands?: Command[];
  triggers?: { type: string; title: Text; fields?: JsonSchema; handler: string; declares?: Record<string, PointDecl> }[];
  voices?: { id: string; name: Text; speak?: boolean; listen?: boolean; auth?: Auth[]; handler: string }[];
  computerProviders?: { id: string; name: Text; auth: Auth[]; handler: string }[];
  computer?: { provider: string; name: string; size: string; region: string; image?: string;
               makeMain?: "ask" | "no"; onRemove?: "ask" | "keep" };   // deleting a VM always asks
  relays?: Service[];  notifiers?: Service[];  companions?: Service[];
  themes?: { id: string; file: Path }[];      // theme format 1 (below)
  locales?: { lang: string; file: Path }[];   // locale format 1 (below)
  ui?: Ui[];
  // any entry above may also carry declares?: Record<string, PointDecl> (§5.4)
  [pluginPoint: `${string}.${string}`]: unknown;   // a point another plugin declares, e.g. "webhook.ingress"
}
interface Service { id: string; name?: Text; handler: string; runsOn?: "each" | "main" | "chosen" }   // runsOn: §5.2
interface Command { name: string; description: Text; args?: JsonSchema; handler: string;
                    key?: string; runsOn?: "each" | "main" | "chosen" }   // run as <namespace>.<name> (§5.4)
interface PointDecl { shape: "single" | "list" | "keyed"; fields?: JsonSchema; props?: JsonSchema;   // props: a UI spot
                      needs?: string[];      // capabilities an entry's plugin must have for the data its props carry
                      keep?: string[];       // keys that can't be hidden
                      context?: string[];    // the keys the spot offers to `when`, such as "bot"
                      private?: boolean; deprecated?: Text; doc?: Text }

interface Bot {                                // one per plugin; the bot's id is the plugin's id
  name: Text; instructions: Path;              // Markdown that becomes <bot-instructions>
  model?: { default: string; effort?: string }; // a qualified catalog id; with no key for it, the user's default model
  avatar?: { file: Path; format: string; portrait?: Path };   // format: "vrm", "live2d" or a plugin's own
  voice?: { provider: string; voice: string; model?: string;
            listen?: { provider: string; model?: string } };   // listening from another voice provider (§6.6)
  theme?: string; layout?: Path;               // a theme id from this plugin, and a layout file; both apply in its tab
  greeting?: Path;
  memory?: Path;                               // starter memories, copied once into the bot's memory folder
}
interface Model {
  provider: string; name: Text; terms?: string; catalog: Path | object[];   // rows follow the SDK catalog schema
  auth: Auth[];
  endpoint?: { protocol: "openai-chat" | "openai-responses" | "anthropic-messages"; baseUrl: string };  // data, no code
  adapter?: string;                            // a handler in host code, instead of an endpoint
}
type Auth = ({ method: "api-key"; secret: string; help?: string }
          | { method: "oauth-pkce"; authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[];
              secret: string }                 // redirects to a loopback address (RFC 8252)
          | { method: "custom"; handler: string })
          & { placement?: { header: "authorization"; scheme?: string }   // where the keyed fetch puts it (§5.4);
                        | { header: "x-api-key" | "api-key" | "x-goog-api-key" } };   // default: authorization, Bearer
interface McpServer {
  type: "host" | "stdio" | "http";           // host = the plugin's own code, served as an MCP server
  command?: string; args?: string[]; env?: Record<string, string>;   // stdio
  url?: string; headers?: Record<string, string>;                     // http
  tools?: Record<string, "preload" | "on-demand">;                    // "*" sets the default for the rest
  instructions?: Path;                       // extra text for the MCP block (capped at about 4 KB)
  perComputer?: boolean;                     // host only: bound to its computer, so it is a local server (§9.1)
  scope?: Scope; when?: { os?: Os[] };
}
// stdio servers, and host servers with perComputer, are local; http and other host servers are remote (§9.1).
// Which computers a local server is on is an account setting (§8.5), not part of the folder.
interface Hook { id: string; on: ("tool.before" | "tool.after" | "message.in" | "message.out" | "turn.start" | "turn.end"
                                  | "compact.before" | "compact.after")[];
                 tools?: string[]; handler?: string; command?: string; args?: string[]; timeoutMs?: number; scope?: Scope }
interface AgentBackend { id: string; name: Text; protocol: "acp" | "cloud"; command?: string; args?: string[]; handler?: string }
interface AgentDef { id: string; name: Text; backend: string; model?: string; effort?: string; instructions?: Path;
                     computer?: string; root?: string; plugins?: { only?: string[]; except?: string[] } }
interface Ui {
  spot: string; id?: string;                 // id defaults to the spot; required if the plugin fills one spot twice
  key?: string; order?: number;              // order: position in a list spot; default 500, then plugin id
  when?: { bot?: string | string[]; surface?: string | string[]; os?: Os[];
           setting?: Record<string, unknown>; [ctx: string]: unknown };   // in a bot's plugin, bot is implied
  component?: string;                        // an export of client.entry. An entry has one of component, web, style or hide
  web?: { url?: string; entry?: Path; partition: string };   // the partition is prefixed with the plugin's id
  style?: Path;                              // a theme-format file; restyles what fills this spot or key (§5.5)
  hide?: boolean;                            // when this entry wins, the spot or key shows nothing (§5.5)
  window?: { type: "overlay" | "window"; alwaysOnTop?: boolean;   // alwaysOnTop: the clover tree only, in 1.111.1 (§10)
             transparent?: boolean;
             placement?: Partial<Record<Os, string>> };
  declares?: Record<string, PointDecl>;
  [field: string]: unknown;                  // fields the spot defines: title, icon, opens…
}
// Theme format 1:  { theme: 1, name, appearance?: "light" | "dark" | "both", tokens: {…}, dark?: { tokens },
//                    css?: Path, fonts?: [{ family, src: Path }], icons?: { <name>: Path } }
// Layout format 1: { layout: 1, root: Node, background?: Path, css?: Path }
//                  Node = { row | column | stack: Node[] } | { tabs: [{ title, node }] } | { spot, prefer?: string[] }
//                       | { image: Path } | { text } | { markdown: Path } | { spacer: true },
//                  plus size, min, max, grow, hideBelow, class, gap, padding and align on any node
// Locale format 1: { locale: 1, lang, strings: { <key>: string | { one?, other, … } } }; {name} placeholders;
//                  keys start with the top-level plugin's id and a dot (§5.5)
// Index format 1:  { index: 1, name, plugins: [{ id, versions: [{ version, hash, url }] }] }; signed (§5.1)
// Revocations 1:   { revocations: 1, entries: [{ id, versions?, hashes?, reason }] }; signed (§5.1)
// Interpolation, in a stdio server's command, args and env, an http server's url and headers, and a hook's or
//                agent backend's command and args: ${plugin} (the folder path), ${data} (its data folder, §5.4),
//                ${setting:k}, and ${secret:k}, which names only the plugin's own secrets. Secrets may appear only
//                in env and headers.
```

**[P] Checked before anything runs:** the folder name equals the id; paths stay inside the folder; a bot's plugin fills only spots in its own tab, and its `locales` hold only its own keys; tool names are unique within a top-level plugin and contain no `__`; nothing is an expression. A contribution to a point that is missing at run time is allowed, and waits.

**[P] Alpha's manifest,** as an example. More worked examples are in the [plugin model proposals](research/2026-11-03-wyrmhole-plugin-model-proposals.md) (its §3.9); they predate revision 11, so where they differ, this spec wins.

```json
{ "manifest": 1, "id": "alpha", "version": "1.111.1", "name": "Alpha", "icon": "assets/portrait.webp",
  "contributes": {
    "bot": { "name": "Alpha", "instructions": "bot/instructions.md", "greeting": "bot/greeting.md", "memory": "bot/memory",
             "model": { "default": "<qualified catalog id>", "effort": "medium" },
             "avatar": { "file": "assets/live2d/alpha.model3.json", "format": "live2d", "portrait": "assets/portrait.webp" },
             "voice": { "provider": "fish-audio", "voice": "<fish voice id>", "model": "s2.1-pro-free" },
             "theme": "alpha", "layout": "tab/layout.json" },
    "themes": [{ "id": "alpha", "file": "tab/theme.json" }] } }
```

---

## 6. Bots

### 6.1 A bot plugin

**[D] What a bot can change:**

* **The harness owns the system prompt.** It enforces fixed blocks (tools, safety, memory, devices…). A bot plugin supplies only its **`<bot-instructions>`** block: who the bot is, how it talks, what it cares about.
* **There are no tools specific to a bot.** Every bot has the same tools and sees every installed plugin, MCP server and skill scoped to bots (§5.1). Tools, skills or hooks that come inside a bot's plugin serve every bot.
* **[D] MCP server instructions go into the system prompt.** The instructions every enabled MCP server gives (in `initialize`, or from `server/discover` under MCP 2026-07-28) are always included, whether its tools are preloaded or on-demand, in a harness-owned block.
  * **[D] The block is rebuilt only at compaction,** so the prompt cache is not thrown away every time something changes. It lists installed and enabled servers, not only connected ones: a server on a sleeping computer stays listed, and its tools answer "computer offline". Servers added between compactions, and a repo's own servers, arrive as an appended note in the conversation at the next turn and move into the system prompt at the next compaction.
  * **[P] When the cache has already expired,** the next turn rebuilds the MCP block, the devices block and the `computer` lists without compacting, since there is no cache left to save. A conversation under the compaction threshold would otherwise never rebuild.
  * **[P] Labelled and capped:** each server's text is labelled with its plugin and server name and capped in size (about 4 KB), since it is third-party text.
  * **[P] Stable order:** servers are sorted by plugin id, so a rebuilt block differs only where servers or their text changed.
  * **[P] Plugins too:** a plugin's own tools are an MCP server of type `host` (§6.7), so they supply instructions the same way.
  * **[P] ACP agents:** the bridge MCP server sends the instructions of the plugins it serves as its own server instructions. Since Cursor and Antigravity don't put server instructions in the prompt, the bridge's essentials also go into the agent's system prompt where the backend allows it (§9.3, S5).

**[D] A bot is the `bot` entry of a plugin's manifest** (§5.9): its `<bot-instructions>`, a default model and effort, an avatar, a voice choice, a greeting and optionally starter memories. **[P]** One plugin holds one bot, and the bot's id is the plugin's id; a pack of bots keeps each one in a child plugin (`pack/luna`). If the user has no key for the default model, the bot uses the user's default model.

**[D] A bot's plugin may also carry code, and it styles its own tab** (November 3): a theme, a layout and React components, all applying only inside that tab, where its components run in the tab's own layer (§5.5). Anything meant for outside the tab comes from another plugin, which can be a child in the bot's folder.

**[P] User state lives outside the plugin folder.** Memories, the transcript and the user's edits are stored in the user's data under the bot's id, and routines in routine files (§7). Updating or swapping the plugin therefore never loses a bot's memory. "Editing the bot plugin" writes a user layer over the plugin, or forks it into a local plugin.

**[P] The user layer** holds the user's changes to a bot's name, instructions, model, effort, voice, avatar, theme and layout. A field it sets wins over the plugin's, and Reset clears it. Bots cannot write it (§9.1); a bot changes itself by editing its plugin folder, which sits under the user layer.

### 6.2 Alpha

**[D]** Alpha is the only preinstalled bot, with a Live2D avatar (the owner, revision 18, item 87; a code-made placeholder until the real model arrives, §14.2 item 26) and a waifu-style tab theme of its own, which Alpha's plugin ships on top of `clover`'s base theme for all bot tabs (§5.5). **It is not special in any way:** it has the same tools and powers as any other bot, and is simply the first one the user meets.

### 6.3 One continuous life

* **[D] One conversation per bot,** like texting a person. There are no separate chats per bot and no rooms for now.
* **[D] Compaction:** besides compacting before the context window fills, a bot compacts its conversation **when the cached prompt is about to expire and the context is over about 100k tokens**.

  **[P] Why that moment is cheapest:** compacting just before expiry reads the long context while it is still cached and cheap. The next message then starts from a short summary, instead of paying full price to re-read 100k+ tokens of expired cache. The threshold and the timing come from the model's cache lifetime, and are settings.

  **[P] A user message during compaction:** a cache-timed compaction is dropped and retried at the next idle moment, since the cache is still warm; a compaction forced by a full context window finishes first.
* **[P] Switching model:** the user can change a bot's model or effort at any time, as with Winter's mid-session switch; the next turn uses it.

### 6.4 Messages, interrupts and the main computer

* **[D] A bot is live on every device that is on.** The user can talk to it from any device, and every device shows its activity live.
* **[D] Messages are ordered by send order, on one shared clock,** so every device sees the same time.
  * **[D] Sending needs a live connection.** A device can message a bot only while it is connected to the user's other devices, so no message ever arrives late from an offline device.
  * **[P] Precisely:** connected to the computer running the bot. A user with one computer is always connected to it. A phone or browser that cannot reach any computer keeps the draft and says the bot is asleep (§14.2 item 18).
  * **[P] The shared clock:** the main computer keeps its time from public time servers (Cloudflare's and Google's). Every other device continuously measures its offset from the main over the persistent link, the way NTP does, and stamps messages in that shared time. Accuracy is about half the round trip: a few milliseconds on the same Wi-Fi, tens over the internet. Ties go by device id, and while the main is offline the takeover device is the reference.
  * **[P] Late arrivals:** a message whose stamp falls before output the model has already produced is placed after that output, showing its real send time, so the log always matches what the model saw.
* **[D] The user's messages interrupt.** A message from the user stops the bot's current step at once and starts a new step with that message.
  * **[P]** The model's in-flight answer is cancelled.
  * **[P]** A running tool call is cancelled and recorded as interrupted. Background tasks such as a running dev server keep running.
  * **[P]** A pending approval card for that step is withdrawn. If the cancel cannot reach the computer running the tool, the call is recorded as interrupted and that computer stops it when the link returns.
* **[D] Messages from other bots and routines fold in.** They join the running turn after its next tool call, as Winter's mid-turn push does today, so bots cannot keep cutting each other off.
* **[D] Background work never runs in the main conversation:**
  * **Routine runs** each run in a **side thread** of the bot (its own context, the same `<bot-instructions>` and memory) on the computer that holds the routine, and post a short result into the main conversation (§7).
  * **`Agent` delegations run as background agents** with their own context (§9.3); their messages and final reports arrive in the main conversation.

  The user's interrupt stops only the main conversation, never side threads or background agents, so a quick "hi" never cancels a deploy or a long delegation.
* **[P] The computer running a session:** the main (or the takeover computer) for a bot's main conversation; the routine's computer for a side thread; the agent's computer for a background agent. "The computer running the bot" means the one running its main conversation.
* **[D] The main computer:**
  * **Chosen automatically** — the always-on device, meaning a connected cloud computer, otherwise a desktop — and **the user can change it** in settings.
  * **While the main is online:** bots think and write memory there. The other devices show everything live and lend the bot their bash, files and screen.
  * **[D] The main holds a lease.** It renews a short lease with the waifucave handshake (metadata only). Another device takes over only after the lease lapses. If the main is alive but unreachable, the app says "can't reach your main computer" instead of taking over. **[D]** Without an account it works the same way, automatically, through the handshake with the pair credential in place of the account (§8.1; the owner, revision 18, item 85). **[P]** A user's devices without an account share one group record at the handshake service: each device joins it at pairing, and the service holds one lease record for the group, so "the first computer to take it wins" (below) holds with three or more devices too. This links those pairs to each other at the service, only within one user's own devices; per-pair leases could split the main computer, so they are not used.
  * **[P] Fencing the old main:** a main that can't renew its lease stops starting turns, tool calls and memory writes before the lease ends, with a margin for clock error, unless no other computer could take over, or it still has a live link to each such computer that is on. A computer takes the lease only after failing to reach the main over every link, relays included. Events carry their lease epoch. A tool call's start syncs before the call runs, so a takeover computer that finds a started call with no result records "interrupted, may have run on <computer>". It never re-runs that call on its own, and the real outcome is posted once the link returns. When several computers could take over, the one the user is using takes the lease first; if the user is on a phone, on the web page or away, the first computer to take it wins.
  * **While the main is offline:** the device in use takes over and runs the bots locally. **[P]** Only a computer running `clover-core` can take over, never a phone or the browser.
  * **When the main returns:** it catches up from the synced log and takes back over between turns, never in the middle of one: **[P]** each bot at that bot's next idle moment. **[D]** Work already running (side threads, background agents) finishes where it started and posts its result.
  * **[D] A new cloud computer becomes main only after the user confirms** (§9.2).
* **[P] Why one main computer:** credentials, plugins and memory writes stay in one place, there is no race over who answers, and memory sync stays simple (§6.5). The network adds little to a turn (§8.2).
* **[P] Sleep:** a computer running bots stays awake while a turn, an agent or a routine runs, and wakes for its next routine. A laptop main hands its bots over before it sleeps, when another computer is on to take them.

### 6.5 Persistent memory

* **[D] Each bot keeps its own persistent memory,** like Claude Code's: a main `MEMORY.md` index the bot maintains, linking to individual memory files in the bot's memory folder.
* **[D] There is no memory tool.** Bots read and write `MEMORY.md` and their memory files with `Bash` and the ordinary file tools.
* **[D] Memory syncs across the user's devices without a cloud server.**
* **[P] Where it lives:** a bot's memory is `bots/<bot>/memory/` at the top of the folder tree (§9.1). It always resolves to the computer running the bot, and side threads and background agents on other computers use it over the link. Agent transcripts go in `bots/<bot>/agents/` (§9.3), and scratch is `home/<Computer>/.clover/scratch/<bot>/`. The system prompt names all three. Until C5 there is no tree: the prompt names real local paths (`<home>/bots/<bot>/memory/` and so on), and C5 changes the prompt, not the files.
* **[P] The computer running the bot is the only writer,** and every other device receives copies of its memory files.
* **[P] During a takeover,** the takeover computer writes. When the main returns:
  * a file changed on only one side keeps that side's version
  * a file changed on both sides is kept twice, and the bot merges the two copies on its next turn

  No CRDT library is needed.
* **[P] When devices actually sync:** whenever any two of them are on and connected. A connected cloud computer is always on, so it carries changes between devices that are never on at the same time.
* **[P] A later free option:** a plugin that uses the user's own iCloud Drive, Google Drive or Dropbox as an **encrypted mailbox** between devices, at no cost to waifucave. Paid backup is ruled out [D].
* **[P] Scratch is per computer and not synced.** Each computer keeps the bot's scratch folder for working files (`home/<Computer>/.clover/scratch/<bot>/`), as Grok Bot keeps its scratch on its cloud computer.

### 6.6 Voice

* **[D] Voice providers are plugins** (contributing to `voices`): speech-to-text and text-to-speech, local or cloud. The avatar, VRM or Live2D, lip-syncs to the bot's voice, from the speech the app plays only. Text works with no voice plugin installed.
* **[P] Voice runs on the device the user is talking on.** Speech-to-text and text-to-speech happen there, and only text crosses to the computer running the bot, which keeps voice fast when that computer is far away. On the iOS app and the web page, which run no plugins, the client records and plays the audio, and the voice plugin runs on the computer running the bot. Listening is push-to-talk by default. **[P]** On desktops the app records and plays the audio too and hands it to voice plugins (`audio`, §5.4), so no plugin needs the microphone permission. A bot's `voice.listen` may name a different voice provider for listening (§5.9).
* **[D] Alpha ships with a Fish Audio voice.** Fish Audio's API is pay-as-you-go, with no subscription or monthly minimum. Prices from docs.fish.audio, November 2, 2026:

  | Use | Model | Price |
  | :- | :- | :- |
  | Speaking | `s2.1-pro` | $15 per million bytes of text (about a million English characters) |
  | Speaking | `s2.1-pro-free` | **$0** |
  | Listening (real time, preview) | `transcribe-stream-1` | $0.36 per hour of session |
  | Listening (recordings) | `transcribe-1` | $0.36 per hour of audio |

* **[P] Defaults for Alpha:**
  * Alpha speaks with `s2.1-pro-free` by default if its quality and limits hold up, with `s2.1-pro` one switch away. Fish lists the free model with "No TTFA or DPA guarantees".
  * The welcome setup guide gets an optional Fish Audio step for the user's own key.
  * Without a key, Alpha is text-only.

### 6.7 Tools

| Tool | Comes from | What it does |
| :- | :- | :- |
| `Bash` (and `PowerShell` on Windows) | core | Runs commands on the computer that holds its working folder in the folder tree (§9.1), under that computer's approval level |
| `Read`, `Write`, `Edit` | core | Work with files anywhere in the folder tree, on any computer, each call running on the computer that holds the file (§9.1); they are also how a bot keeps its memory (§6.5) |
| `Glob`, `Grep` | core, **on-demand** [D] | Find files and search their contents anywhere in the folder tree; the search runs on the computer that holds the files. Loaded through `Glossary` when needed |
| `SendMessage` | core | Messages another bot or any running session (§9.3); it folds into the target's turn (§6.4). Background agents message their bot the same way |
| `Agent` | core | Starts a **background agent** (ACP or a vendor cloud agent), choosing agent, model, effort, computer and root folder. It returns at once; the final report arrives later as a task notification (§9.3) |
| `TaskStop` | core | Stops a running background agent |
| `ListAgents` | core | Lists every running session (bots, side threads, background agents, the user's own coding sessions) with its status |
| `Routine` | core | Writes a new routine file on the computer the bot chooses, which then runs it. The bot changes a routine by editing its file. A routine gets the computer's approval level unless the user OKs a higher one (§7) |
| `Glossary` | core | Finds and loads tools, skills, agent definitions and plugins (§6.8) |
| `AskUserQuestion` | core | Asks the user a question with options |
| `mcp__clover__WebSearch`, `mcp__clover__WebFetch` | the bundled **web** plugin | Web search and page fetch; the search provider can be swapped, and Winter's Exa `Search` becomes one. **[P]** Winter's web floors carry over: the dangerous-domain list, asking before private addresses, and the audit log |
| computer-use tools | ordinary plugins | Drive a computer's screen and its browsers. **[D]** Several computer-use plugins can be installed at once, each with its own tool names. None ships in 1.111.1; opensky comes later (revision 17). On two or more computers each takes a `computer` field (§9.1) |
| `mcp__clover__Browser` [P] | a bundled plugin, until opensky covers browsers | Drives the Clover Browser through its API (§12.1). On two or more computers it takes a `computer` field |
| any other plugin tool | plugins | Named `mcp__<plugin>__<Tool>` |

* **[P] Winter's other tools:** the to-do list (`TaskCreate` and the rest), `TaskOutput` and `Monitor` stay core, for the bot's own task list and its background commands. The MCP resource tools stay core, since MCP is on the 1.111.1 floor. `NotebookEdit` and worktrees go to the coding agents, and the advisor returns later as a plugin.
* **[D] Plugin tools are named `mcp__<plugin>__<Tool>`.** `mcp__clover__…` belongs to the plugins we ship (`mcp__clover__WebSearch`, `mcp__clover__Browser`); every other plugin uses its own name, as in `mcp__blender__Render`. **[P]** The separator is a double underscore, as in Claude Code: model APIs allow only letters, digits, `_` and `-` in tool names, so `mcp__plugin:tool` would be rejected, and a single underscore would be ambiguous because plugin and tool names can contain one.
* **[P] Tool names are unique.** The registry refuses a plugin whose tool name is already taken, and a name longer than 64 characters gets a short digest form, as in Winter. An MCP tool name with characters model APIs refuse (MCP allows `.`) has each of them turned into `-` first.
* **[P] Where the names come from:**
  * `<plugin>` is the top-level plugin's `namespace`, which defaults to its id. Children share it, and only one enabled plugin may use a namespace.
  * Everything we ship is a child of the reserved plugin `clover` (§5.1), which is why bundled tools read `mcp__clover__…` with no special rule.
  * A wrapped server takes the server's name: `mcp-blender` gives `mcp__blender__Render`.
  * Plugin ids can't contain `_`, and tool names can't contain `__`, so a name always splits cleanly.
  * Every plugin tool is an MCP tool. A plugin's own code serves an MCP server of type `host`, so instructions, preloading, `Glossary` and the bridge to ACP agents work the same for every tool.
  * A duplicate name written in a manifest refuses the plugin; one that shows up only when a server connects refuses just that tool.
* **[D] Local tools on more than one computer take a `computer` field, and remote tools take a `saveTo` folder** (§9.1).
* **[D] Every tool is `preload` or `on-demand`.**
  * Plugin tools declare it in their manifest.
  * Among the core tools, `Glob` and `Grep` are on-demand and the rest are preloaded.
  * Preloaded tools are always visible; on-demand tools are found and loaded through `Glossary`.
* **[D] `Skill` and `ToolSearch` are retired;** `Glossary` replaces both.

### 6.8 Glossary

**[D]** `Glossary` is the single tool for finding and loading anything a bot or agent might want: agent definitions, plugin and MCP tools, plugins, skills…

* **The call:** `Glossary(query?, load?)`. Both are optional, each takes one value or many, and several searches and loads can happen in a single call.
  * **`query`** — free-form text, such as `"deploy to hetzner"` or `"pdf"`. It returns the matching items with their name, what they are and a short description.
  * **`load`** — names to load:
    * a tool becomes callable (`Glob`, `Grep` or `mcp__<plugin>__<Tool>`)
    * a skill's instructions are returned
    * an agent definition becomes available to `Agent`
* **Search:** keyword and semantic search together. It may read a skill's full text to rank results better.
* **[P] Extension points too:** a search can return points, with their shape, fields, current occupants and whether filling one replaces shipped UI, so a bot writing a plugin knows where it can plug in. It also lists the plugins that take add-ons of their own, with their `addons` description.
* **[P] The index:**
  * **When it updates:** whenever a plugin is installed, changed or removed.
  * **What it holds:** names, descriptions, tool schemas and the full text of every `SKILL.md`.
  * **Where it lives:** in the core, on every computer that runs sessions, built from the synced plugins.
  * **Semantic search** uses a small local embedding model, so it works offline at no cost per query, with keyword-only search as the fallback.

---

## 7. Routines

**[D]** Bots have routines, like Grok Bot's: a routine runs a bot with saved instructions when a trigger fires.

* **[D] A routine is a file.** The bot creates one with the `Routine` tool, choosing a computer; the file is saved on that computer, and that computer runs it. The bot (or the user) changes the routine by editing the file.
  * **[P] The file:** `home/<Computer>/.clover/routines/<bot>/<name>.md`, Markdown with frontmatter (triggers, approval level, time zone, missed-run rule); the body is the instructions.
  * **[P] Live:** the core watches each computer's routines folder, so a new, changed or deleted file takes effect at once. A file written directly, without the tool, works too; the tool only saves writing the frontmatter by hand and hands back a webhook URL.
  * **[P] Secrets stay out:** a webhook's key is kept in the credential store, never in the file.
  * **[P] Moving:** `mv` the file to another computer in the folder tree (§9.1) and that computer runs it; its forwarder re-registers the routine. A copy with the same id on a second computer is paused, and the user is asked.
  * **[P] The id:** `Routine` writes an `id` into the frontmatter, and a file without one gets one when loaded. The same-id rule and the webhook URL both use it.
  * **[P]** The system prompt suggests putting routines that must always run on an always-on computer, such as a cloud computer.
* **[D] Each run is a side thread.** A routine run happens in a side thread of its bot, on the routine's computer, and posts a short result into the bot's main conversation (§6.4). If the main conversation cannot be reached, the result waits and posts when it can.
* **[P] The routine engine is core; triggers are plugins.** Winter's scheduler (`packages/core/src/routines`: interval and cron schedules, runner, store, audit) carries over, computing schedules in the routine's time zone where Winter uses the host's local time.
* **[P] Trigger sources:**
  * **Schedule** (bundled): Winter's `every 15m` and 5-field cron grammar
  * **Webhook** (bundled, from C4 with the forwarder): a URL plus a key, as Grok Bot gives
  * **Integrations** (plugins): Slack messages, Git events (GitHub, GitLab), Microsoft Teams, Linear issues, Sentry alerts, PagerDuty incidents. These should prefer connecting outward (Slack's Socket Mode, polling an API), which needs no public URL.
* **[D] Webhooks arrive through the waifucave forwarder by default,** and the forwarder is itself a plugin, filling the `webhook.ingress` point that the bundled webhook trigger declares (§5.4). It is installed by default and removable like any other.
  * The service (GitHub, Sentry…) posts to `hooks.waifucave.com/<tag>/<routine>` with the routine's key. **[P]** The tag is the account's alias: a version byte, the account's stable id and a MAC under numbered tag keys that can be rotated, so a made-up tag never reaches a Durable Object (I-M1).
  * A Cloudflare Worker checks the key and forwards the payload to the computer that holds the routine.
  * Waifucave sees payloads in transit, because the sender cannot encrypt for the user's device, and deletes them after delivery.
  * **[P] How the Worker reaches a device:** a Worker cannot dial a device behind a router, so each device's forwarder plugin keeps one outbound connection to the user's Durable Object, used only for webhooks. This is the one content path through waifucave. **[P]** The account's Durable Object seals each payload on arrival (HPKE) to every computer on the account, so a held payload is never stored in plaintext. Each computer opens it with its own key, whose private half stays in its core (§5.4).
  * **[P] Drops are reported:** webhooks dropped by the caps or the hold, sent under a key the routine has since replaced, or that a computer can't open, are counted per routine and reported to its computer until it has listed them.
* **[D] Holding rule:** hold a payload for as long as holding stays flat in cost.
* **[P] Holding a payload longer adds almost nothing to the cost,** as long as the object takes the devices' connections through the WebSocket Hibernation API. Holding a payload in a Durable Object costs nearly the same for a minute or a week:
  * Cloudflare charges for the writes and the delete — a few row writes per payload.
  * Stored data is billed per GB-month, a rounding error for webhook payloads.
  * An idle object waiting for a device is not billed for time with the Hibernation API; a plain `accept()` bills the whole connection. Incoming messages count 20 to a request, and keep-alives use automatic responses, which are free.

  So time is not what limits holding. The proposed policy:
  * **Hold until the routine's computer comes back, for at most 7 days,** capped per user (for example 1,000 payloads or 50 MB, oldest dropped first).
  * The routine's missed-run setting decides whether a late webhook still runs.
* **[P] What the free plan covers:** 100,000 requests and 100,000 rows written per day across all users, roughly 30,000 webhooks a day. Past that, the Workers Paid plan is a $5 monthly minimum covering 1 million requests and 50 million rows written.
* **[P] Other ways in, as plugins filling `webhook.ingress`:**
  * the user's cloud computer receiving webhooks itself (fully private)
  * a tunnel plugin (Cloudflare Tunnel, ngrok, Tailscale Funnel)
* **[D] Each routine has its own approval level,** fully automatic included. A routine gets its computer's level by default. **[P]** The level is a field in the file; when the tool or an edit sets it above the computer's level, the routine waits for the user's OK on an approval card (§5.5) before it runs at that level. Lowering it needs no OK. A raised level is bound to the file's hash and to its computer: any edit to the file, or moving it, drops it back to the computer's level until a new OK. A webhook routine's card says that anyone with the URL can start it. A removed bot's routines pause.
* **[P] Outside text is marked as untrusted.** Text from webhooks and integrations still reaches the bot labelled as untrusted outside content.
* **[P] A routine file holds:** the bot, its triggers, the instructions, its approval level, its time zone, and what to do about runs missed while its computer was off (run once on wake, the default, or skip). Where it runs is simply the computer that holds it.
* **[D] Once per fire:** only the computer holding the file fires the routine, so it never fires twice and no lease is involved. While that computer is off, the missed-run rule applies when it wakes.
* **[P] Time zone:** schedules use the routine's time zone, which defaults to the user's (an account setting), not the computer's clock zone, which matters when the main is a cloud computer running on UTC.

---

## 8. Devices, accounts and links

### 8.1 Identity and accounts

**[D] Accounts are optional:**

* **With a waifucave account:** sign in with the existing waifucave.com accounts (Supabase: email, Discord and Google are live). Waifucave keeps the device list and makes the handshake that introduces devices to each other. It never stores transcripts or memories.
* **[D] Signing in is enough to add a device.** The account is the root of trust. **[P]** This makes the account the key to every computer, so the welcome guide strongly suggests two-factor sign-in, and any device or the account page can revoke a device at once.
* **Without an account:** pair devices with a code or QR, as Winter pairs the phone today, plus its 4-word check, which Winter already has.

**[P]** Every installation has its own Ed25519 key in the OS secret store. Revoking a device cuts its links at once. Keys and logins already synced to it cannot be taken back, so revoking starts a guided rotation of them. **[D]** An app that may answer cards (desktops and phones) also holds an answer key, apart from the link key, kept by the app where the OS can protect it: the macOS Keychain, Windows Hello or the TPM (item 91, §5.5).

**[P] Without an account:** devices pair by code and save a pair credential; afterwards they find each other on the LAN, at their last known address, or **[D]** through the waifucave handshake with that credential and no account, with n0's address lookup as the fallback (S1; the owner, revision 18, item 81); phone push is off; webhooks arrive only through a cloud computer or a tunnel (§7); **[D]** the main computer is handed over automatically, through the handshake with the pair credential (§6.4, item 85); the web companion needs a one-time pairing.

### 8.2 One persistent link per device pair

* **[P] One link for everything.** Each pair of devices keeps one long-lived, encrypted link open, and everything travels over it: RPC, live event streams, sync, screenshots and files. This avoids the slow part, which is setting up a connection (finding a direct path can take a second or two).
* **[P] Not a WebSocket:**
  * Two devices behind home routers cannot open a WebSocket to each other, because one side would have to be reachable like a server.
  * Over a single TCP connection, a large screenshot holds up the small messages behind it.

  Between devices the link uses QUIC, whose independent streams run over UDP, through iroh (chosen in spike S1, §8.3). The browser uses WebRTC data channels.
* **[P] Speed, in typical figures:**

  | Path | Delay |
  | :- | :- |
  | Same Wi-Fi | 1–5 ms |
  | Direct over the internet | the plain network delay, usually 10–80 ms |
  | Through a relay | roughly 20–100 ms more |

  A model takes 0.5–3 s just to start answering, so the network is a few percent of a turn. Bandwidth matters more than delay for screenshots and files.

### 8.3 Direct first; relays are plugins

* **[D] Links are direct.** The waifucave handshake only exchanges each device's addresses (signalling); it never carries content.
* **[D] Relays are plugins.** **[D] n0's public relays are on by default** (revision 12; this replaces "none is on at first"), and the welcome setup guide has a page to swap them quickly for the user's own: their cloud computer, a server of their own, or their own Cloudflare account. **[P]** Each choice is a relay plugin. No iroh relay exists for Cloudflare yet, so that one is a relay we write: a Durable Object can carry the relay's WebSockets, and finding direct paths stays with STUN, since Workers can't serve UDP. Traffic through any relay stays end-to-end encrypted, so a relay never sees what devices say. **[D]** It does see presence, which is accepted (S1; the owner, revision 18, item 79): each device keeps a connection to its home relay, so the relay knows which devices are online, from which IP addresses, which of them talk through it, and how much they send. No relay is added per pair at run time. The cloud computer relay, bundled and off until a cloud computer exists, has a public address, so every device can reach it directly. Winter's phone already uses n0's relays.
* **[D] Discovery works like waifucave's pairing service today.** pair.waifucave.com and ts-connect exchange each device's addresses as **signed, encrypted** records, so even the handshake never sees them in the clear. Public STUN servers (Cloudflare, Google) find each device's internet address reliably. Clover reuses this design for coordination. **[D]** A relay also tells each device its public address (QUIC address discovery, QAD, on; item 79). It carries the traffic of pairs that can't go direct, and the first packets of a connection that starts on it: where direct is unlikely, where the direct dial misses its head start, or where a device paired without an account falls back to n0's address lookup, which gives only the relay. Such a connection moves to a direct path when one opens (the dial policy, under "LAN first"; S1, items 80 and 81).
  * **[P] What the handshake carries (S1):** each device's LAN address, STUN's answer asked from the port the link then binds (iroh has no STUN of its own), and any port mapping its router granted; and a "dial now" that makes both devices dial each other at once, and again about 100 ms later. A device behind a symmetric NAT gets a STUN answer no peer can use: two STUN servers that see different addresses mark it, and its pairs need the relay.
  * **[P] The handshake for devices paired without an account** (item 81; lane I builds the service, lane H the client):
    * **Keys:** each device signs its requests with its own key for the pair: a fresh signing key per device per pair, or the link key with a domain-separation prefix, so a signature to the service can't double as a link signature. Both devices sign the registration at first pairing.
    * **Revoking:** a revoke ends the pair at the service, deleting its record and both keys, and the remaining device re-pairs if it needs to. §8.1's local revoke, which cuts the links at once, always comes first, since a lost device can still reach the other at its last known address, on the LAN or through n0.
    * **Limits:** pair registration is rate-limited hardest, since pairs cost nothing to create. Per-IP limits group IPv6 addresses by /64 and leave headroom for shared IPv4 addresses such as carrier NAT. Addresses, presence and "dial now" messages live briefly; a registration expires only after months of silence from both devices. Signed requests carry replay protection.
    * **What the service keeps:** current state only, with no presence history, and IP addresses only for the rate-limit window. Payloads stay end-to-end encrypted, so it sees keys, IP addresses and timing, never the candidates.
    * **The n0 fallback:** only devices without an account publish to n0's address lookup, and only their relay URL. Links refuse unpaired and revoked keys.
* **[P] What turning every relay off means:**
  * A small share of device pairs cannot connect, typically when both sides are behind strict routers or a mobile carrier's network.
  * The web companion needs either WebRTC, which can connect directly, or a relay (§8.4).
* **[D] The connection must be the absolute fastest.** S1 decides on measured speed: time to first connect, time to reconnect, delay, and throughput on the same Wi-Fi, directly over the internet, and through a relay. **[D]** Where the fastest first byte meets keeping set-up off the relay, the dial policy decides per pair (under "LAN first"; item 80).
* **[P] Transport choice (research R2, November 2, 2026):** **iroh 1.0 (QUIC) between devices, WebRTC data channels for the browser.**

  | | iroh 1.0 (QUIC) | WebRTC data channels | Tailscale-style WireGuard (ts-connect) |
  | :- | :- | :- | :- |
  | First connect | 1 round trip for QUIC + TLS 1.3 once a path is known; addresses are the device keys | Slowest: ICE, then DTLS, then SCTP setup | WireGuard is quick, but TCP and a userspace network stack sit on top |
  | Network change or sleep | The connection survives a switch of path, but with relays off it took 1.1 s to follow a new address in S1's lab, and 6 s on a network without a default route (plain QUIC migration: 0.1 s); Clover re-dials on network changes either way | Needs an ICE restart: slow and fragile | WireGuard copes, but TCP inside it stalls briefly |
  | Big transfer vs small messages | Independent streams with priorities, so nothing blocks | Shared congestion control; a big transfer slows small messages | One TCP stream, so a screenshot blocks the messages behind it |
  | Throughput | Native QUIC | Weakest (SCTP; about 10 MB/s reported on one machine) | High on a LAN; window-limited on long paths |
  | iOS / browser | Official Swift bindings / browser only through relays | Yes / **yes, direct** (the only option) | Possible / no |
  | Bun | `@number0/iroh` 1.2.0 loads under Bun and compiled on all four targets, but passes bytes as JS arrays (18–64 MB/s, and Bun 1.3 stops firing timers meanwhile); Clover holds iroh in a sidecar process of its own (below) | `node-datachannel` 0.33.6 loads under Bun and compiled on all four targets; compiling needs a small build plugin | Go helper process |

  * **ts-connect is the slowest** of the three for this traffic, but its pairing, word check and revocation design is still worth porting.
  * **A bonus browser path:** WebTransport (HTTP/3) when a device can be reached directly (same LAN or a public IP), using a pinned self-signed certificate.
* **[D] Settled (S1; the owner, revision 18, items 79–81):** the waifucave handshake and STUN do the coordination (above): they swap each pair's addresses and tell both devices when to dial, for devices paired through an account or, without one, through a pair credential (§8.1). n0's relays, on by default, see presence and tell each device its public address (above), and carry a connection's set-up only where direct is unlikely, where the direct dial misses its head start, or where a device paired without an account falls back to n0's address lookup, which gives only the relay.
* **[P] The transport (S1's lab half, November 5, 2026): iroh.** Plain quinn matched iroh's speed and punched the same NATs, and followed a new address faster (0.1 s against 1.1 s, or 6 s on a network without a default route, which re-dialling covers), but needs its own identity, discovery and relay fallback, has no iOS or Bun binding, and cannot use n0's relays. With relays off, iroh connects directly through every NAT pair that allows it (13 of 15 in the lab) given two things from the handshake: each device asks a public STUN server for its address from the port iroh then binds, since iroh has no STUN and, without a relay, learns an address only from a router that grants it a port mapping (UPnP, NAT-PMP or PCP), and both devices dial each other at once ([lab report](research/2026-11-05-s1-transport.md)).
* **[P] How clover-core holds iroh:** in `clover-link`, a Rust sidecar process of Clover's own that holds iroh and speaks a framed protocol over stdio. clover-core starts it, hands it the device key over its stdin (never in arguments, the environment or a file), and restarts it and re-dials if it exits. Out of process, iroh's threads, aborts and native completions can't stall the daemon's timers, which n0's binding did under Bun 1.3; the hop measured 0.02–0.08 ms per round trip and 0.4–1.7 GB/s each way in S1, against an async napi call's 21–99 µs, both far above any network. `LinkTransport` hides which it is, so the same crate can ship as an in-process addon instead if M1 finds the hop costly. n0's binding is not used.
* **[P] Spike S1 (about 2 days), on real networks** — home, mobile, hotel or carrier-grade NAT, and one strict-NAT case:
  1. `@number0/iroh` loads under Bun and inside `bun build --compile` on macOS, Windows and Linux.
  2. Relay-free mode with addresses from waifucave's handshake reaches a direct path; record the success rate per network type.
  3. Time to first byte: cold, on a LAN, after sleep, and after a Wi-Fi-to-mobile switch.
  4. Small-message delay (median and 99th percentile) while a 100 MB transfer runs on the same connection.
  5. Throughput for 1 MB screenshots and for bulk files.
  6. WebRTC from Chrome, Firefox and Safari to the daemon: time to open, throughput, and delay under a parallel transfer.
  7. The WireGuard approach against iroh on the same path, to confirm QUIC wins.
  8. With n0's relays on, how often traffic falls back to them, and what the Cloudflare relay we write takes (§8.3).

  S1's lab half (November 5, 2026) answered item 1 and the lab part of items 2–6 ([lab report](research/2026-11-05-s1-transport.md)): items 2 and 5 on emulated networks; item 6 from Chrome, Firefox and Safari on the same machine as the daemon; item 3 as connect times and re-dials without NATs, not after a real sleep or behind real NATs; item 4 over repeated 8–32 MB transfers rather than one of 100 MB, with at least 200 samples behind each percentile. The runs on real networks, item 8 and, if still wanted, item 7 wait for live gate 1.
* **[P] Speed measures whatever the transport:**
  * **LAN first:** local discovery, then the LAN and direct paths, dialled by both devices at once and again about 100 ms later, keeping the fastest. **[D]** Whether the relay joins from the start is chosen per pair (S1; the owner, revision 18, item 80): each device asks two STUN servers when it binds and after every network change; when each device's two answers match, the relay is added only after a head start of about 0.5 s; otherwise, or when a device got no STUN answer, it races from the start, and the connection moves to a direct path when one opens.
  * **Connect early, stay connected:** connect at login and wake, send keep-alives, and re-dial at once on network-change and wake events, keeping whichever connection answers first. In S1's lab an existing connection came back 4.5–8.4 s after a 20 s outage ended, telling the stack about the change didn't shorten that, relay-free iroh took 1.1 s to follow a new local address (6 s on a network without a default route), and a connection is gone after 30 s of silence; a re-dial without NATs had its first reply back within 0.1 s on a 20 ms path, or within 0.85 s for iroh while the stale connection was still open. Behind NATs a re-dial also needs a fresh STUN answer and the handshake, so the handshake service must be up at every wake and network change. Requests in flight on the old connection are retried on the new one only if they are safe to repeat; a tool call whose start went out but whose result never came is recorded "interrupted, may have run" (§6.4).
  * **Fast resumption** (QUIC 0-RTT), only for requests that are safe to repeat.
  * **Priorities:** binary frames on separate streams for bulk data, with token streams and control messages ahead of screenshots and files. Priorities only order what QUIC sends next; during a transfer a control message still waits behind the bulk data already in flight, so bulk streams keep in-flight data near the path's bandwidth-delay product (a tuned stream window, or a controller like BBRv3). In S1's lab the default 1.25 MB stream window added about 8 ms to every control message on a clean LAN path whatever its priority, and a window of 1.25 times the bandwidth-delay product cut that to about 0.3 ms at the median, at 0–4 % of the throughput; the same fixed window would cap one stream at about 8 MB/s on a 150 ms path, so the window is sized per path.
  * **[P] Congestion control is chosen for lossy paths.** In S1's lab, with loss falling on single datagrams, Cubic moved 0.2–0.3 MB/s at 1 % loss and 80 ms, and at 0.5 % and 150 ms, on both stacks; noq's BBRv3 mostly under 1.3 MB/s; quinn's BBR 3.4–4.9 MB/s, though it added up to 26 ms of queueing at 1 % loss. M1 picks and tunes the controller (iroh accepts one from Clover); live gate 1 checks it on real Wi-Fi and mobile.
  * **Compression:** zstd for text and JSON, none for images.
  * **Screenshots:** hardware-encoded JPEG or WebP at about 100–200 KB, or only the changed regions.

### 8.4 The web companion

**[D]** `clover.waifucave.com` lets the user chat with their bots from a browser, connecting to the user's own devices.

* **[P]** The page connects to the computer running the bots over WebRTC data channels, with waifucave doing the signalling. It uses WebTransport when the device can be reached directly, or a relay (n0's, by default). Screenshots and bulk data go to the browser at reduced size, since this link is slower than device-to-device QUIC. In S1's lab, Chrome, Firefox and Safari connected directly with their own addresses hidden behind mDNS names, as on a real page: the browser reaches one of the daemon's candidates, and the daemon learns the browser's address from it. So the page's direct path needs the daemon's LAN address, or its STUN address across the internet, to be reachable from the browser; the browser's own addresses can stay hidden.
* **[P]** It needs the account (or a one-time browser pairing) to find the devices.
* Waifucave still never sees the content.

### 8.5 What syncs, and how

| Data | How it syncs [P] |
| :- | :- |
| Transcripts | Append-only logs. The computer running the bot gives each event its place, and every copy keeps that order; the user's messages keep send order among themselves, and the stamp shows the send time (§6.4). Events from an earlier lease that arrive late go at the end, marked late. Winter's phone sync already refuses a stale base (`packages/core/src/ipc/sync.ts`) |
| Credentials | **[D] Everything syncs:** API keys and subscription logins, end-to-end encrypted. **[P]** Subscription refresh tokens rotate, so only one device refreshes a login at a time — the main, or the takeover computer while the main is offline — and it pushes each new token to the others at once. Otherwise devices would log each other out. This device is **the refresher**: any other computer that makes a call uses the current token and asks the refresher when it expires (§3.3). **[P]** On a headless computer with no unlocked keyring, the secrets file's key is sealed with `systemd-creds --user` (systemd 256 or later, as in Ubuntu 26.04) and the machine's TPM where one exists; otherwise it sits in a file only the user can read, which the app labels as plaintext. `systemd-creds` unseals for any process of the user, so what keeps bots out is Bash's fence, which hides the secrets file and any key file (§9.1). |
| Memories | Copied from the computer running the bot, the single writer; files changed during a takeover are merged by the bot (§6.5) |
| Routines | **[D]** Not copied: each routine file lives on the computer that runs it, reachable through the folder tree. **[P]** The core keeps a synced list of every routine (name, bot, computer, triggers), so any device can show them, even while that computer is off |
| Installed plugins | **[P]** The unit is the top-level plugin. The account-level list syncs: each plugin's id, version, tree hash, source, on/off state and child switches, the devices that opted out, and the computers each local server is on (§9.1). Index plugins are fetched by hash, staged, then swapped in. Local ones (wrapped, hand-made, bot-written) are copied from the main, and an edit on another computer goes to the main first; while the main is offline, the takeover computer stands in for it. If two computers change one file before they sync, the later write by the shared clock wins; the other copy is kept as `<file>.conflict-<device>`, and counts as a code change if it lands in code. A host half runs only when its hash matches the main's. A device can opt a plugin out, except plugins with a bot or models on a device that can become main. A plugin the index revokes is blocked everywhere |
| Files on computers | **[D]** Not synced. Bots reach them live through the folder tree (§9.1) |
| Attachments and screenshots | **[P]** An attached image becomes part of the transcript. Other attachments stay where they are and are passed as folder-tree paths. Screenshots and large tool outputs stay on the computer that made them and are fetched when opened |
| Scratch, device-local settings | Not synced |
| Settings and access | **[P]** Account settings, the user's picks, bots' user layers and connector permissions sync; levels, saved rules, trust and development folders stay on each computer. A raise reaches another computer only with the signed answer that confirmed it (§5.5). Agent transcripts sync like memories |

---

## 9. Computers

### 9.1 Computers and the folder tree

**[P]** A computer is **any device running `clover-core`** that the user has connected. Each one reports:

* its OS
* whether it has a display
* which ACP agents are installed

**[D] One folder tree across every computer** (the owner's design, November 3):

* The bot sees `home/<Computer>/` for each connected computer, for example `home/Studio/`, `home/Desktop1/` and `home/Laptop1/`. Each one is that computer's home folder: `home/Desktop1/` is `~` on Desktop1.
* `Read`, `Write`, `Edit`, `Glob` and `Grep` work on any path in the tree. Each call runs on the computer that holds the files; `Glob` and `Grep` search there and send back only the results.
* `Bash` runs on the computer that holds its working folder: `cd home/Desktop1/project1 && git status` runs git on Desktop1.
* Commands can cross computers: `mv home/Desktop1/project1 home/Studio/` moves the folder to the computer called Studio. **[D]** It goes by the direct path (below; the owner, revision 18, item 89).
* `Agent` takes a computer and a root folder in the tree. The core translates the root to the real path on that computer, and the agent runs there only (§9.3).
* The system prompt lists the computers, their OS and how each is linked (same Wi-Fi, over the internet). It says that moving large files between computers is slower, so the bot should work on a project on the computer where it already is, **[D]** and that a command runs on the computer that holds its working folder and sees only that computer's files, so a build, an install, git or a search of another computer's project runs there, by `cd`-ing into its folder first (item 89).

**[D] No OS mounts** (the owner, revision 18, item 88; this replaces mounting other computers' folders as a network file system, which spike S6 measured). No computer mounts another computer's folders into its file system: there is no NFS, WinFsp or FUSE. Clover works on each folder through the computer that holds it: the holder's daemon serves the tree over the link, behind the holder's fence.

**[P] How it works:**

* **Live access, not sync.** Files are not copied to every device. Each call goes over the link to the computer that holds the files, when it is needed. Syncing whole home folders would copy terabytes to every device and bring conflicts.
* **The tree is Clover's, not the file system's.** `home/<Computer>/…` is a path in Clover's tools. A tool's call on another computer's path goes over the link to that computer's daemon. The daemon serves the tree from its own disk (stat, list, read, write, rename, links, change events) and applies its own fence to every request (below). Nothing is mounted.
* **[D] Tools and Bash run where the files live** (item 89). `Read`, `Write`, `Edit`, `Glob` and `Grep` run on the computer that holds the path. `Bash` runs on the computer that holds its working folder, in the real folder there, so builds, installs, git and searches run at that computer's own speed. A program sees only its own computer's files: a command can't open another computer's path, so the bot copies the file over first, or runs the command where the file is. The system prompt says so.
* **[D] Moves and copies between computers take a direct path** (item 89). When Bash's command is a plain `mv` or `cp -r` between two computers' folders, the core streams the tree from one holder to the other over the link. **[P]** It copies first and deletes the source only once the copy is whole, so a drop mid-move leaves the source as it was. Each move is judged by both computers' levels.
* **Same-computer paths are native.** On each computer, `home/<itself>/…` is its home folder, so any program there resolves it at full speed. **[P]** The tree's root is a folder of the user's own outside every home folder: `$XDG_RUNTIME_DIR/clover` on Linux, `/Users/Shared/clover-<uid>` (0700) on macOS, and a folder outside the user's profile on Windows (M1 picks it). The computer's own entry is a symlink (a junction on Windows), so a search of the home folder never walks into the tree. Other computers' entries aren't on disk, and `home/` is read-only, so a program that names one gets "no such file", and nothing it writes lands on the wrong computer.
* **[P] Computer names** are unique ignoring case and use only letters, digits and hyphens, so a path typed in either case means one computer. A Windows computer's own name is never one Windows reserves (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`). A renamed computer keeps its old name as an alias.
* **[P] `bots/<bot>/`,** at the top of the tree, holds each bot's memory and its agents' transcripts (§6.5). It always resolves to the computer running that bot.
* **Offline computers fail fast.** A computer known to be offline answers "computer offline" at once and never hangs. **[P]** A link that drops silently is known within 1.5 s: any bytes from the computer prove it alive, and both ends ping every 250 ms. Calls in flight then fail with "computer offline", within about 1.7 s of the drop, and a closed link fails them at once. On a live link, a call fails once the link has carried no answer for 10 s; a slow link that keeps delivering answers isn't offline, and a call can then wait up to 60 s (S6).
* **Approvals follow the files.** Each action is judged by the level of the computer it touches, and a move between computers needs both computers' levels. **[P]** At ask for risky actions, the computer that holds the files runs its own reviewer on another computer's calls, as it does on its own (R1). Only the calls the reviewer judges risky need a card, never a blanket card for every edit from another computer; the card goes to the user's devices, any desktop or phone (item 91), and the signed answer travels with the call.
* **[D] The Files panel exists only in code sessions** (item 88). It is rooted at the session's folder (for example `~/xcode/clover/`), on whichever computer holds it, and never shows more than that folder. Its listings and its change events come from the holder's tree service. Bots have no file view.
* **Outside the home folder,** a computer's other paths (`/usr`, `C:\Program Files`) are reached by Bash running on that computer.
* Computer-use tools on two or more computers take the computer's name in their `computer` field, since screens are not files (below). The system prompt says which computer-use tools work on which computer.

**[D] MCP tools across computers** (the owner's design, November 3):

* **Local servers run on each computer separately.** A local server runs on one machine: a `stdio` command such as Blender's, or plugin code bound to its computer, such as computer use. The user installs it on one computer, or presses **Mirror** to install it on the others too, and each copy runs on its own computer.
* **A local server on two or more computers gets a `computer` field.** Each of its tools gains a field listing the computers that have it, and the model picks one: `mcp__blender__Render({ computer: "Desktop1", … })`. A server on one computer gets no field, and every call goes there.
* **Remote servers work from anywhere.** An `http` server, or plugin code that only talks to the web (such as `mcp__clover__WebSearch`), is not tied to a computer. The computer running the session makes the call, and files the call returns are saved there.
* **A remote tool's `saveTo` field sends its files elsewhere.** It takes a folder in the tree, and the computer that holds that folder makes the call, so the files land there without a second transfer: `mcp__figma__Export({ saveTo: "home/Laptop1/designs/", … })`.

**[P] The details:**

* **Files** are a call's embedded resources and images. The core writes them to `saveTo` and puts their tree paths in the result. Every remote tool gets an optional `saveTo`.
* **Without `saveTo`,** files go to the bot's scratch folder on the computer running the session (§6.4). An ACP agent's bridged remote calls run on the agent's computer.
* **[D] The `computer` field is always required** wherever it appears, so nothing runs on the wrong machine by accident. **[P]** Each user message says which device it came from, so the bot knows where the user is.
* **The list in the field is refreshed at compaction,** or once the cache has expired anyway, like the MCP block (§6.1), so the prompt cache survives. A copy mirrored in between is announced in an appended note and works at once, because the core checks the field against the live list. A server that gained its second computer in between has no field yet, so its calls go to its first computer until the refresh.
* **A computer that is off** answers "computer offline" at once.
* **A name clash:** if a server already has its own `computer` or `saveTo` field, ours is called `cloverComputer` or `cloverSaveTo` for that server.
* **[D] Plugin folders still sync to every computer** (§8.5). A local server inside a plugin runs only on the computers ticked for it, and Mirror ticks the rest. To take it off one computer, the user unticks that computer; removing the plugin removes it everywhere.
* **Sign-ins:** a remote server's sign-in is a synced credential. Only the refresher of §8.5 refreshes it; another computer that makes the call uses the current token and asks the refresher when it expires.

**[D] Default access on a newly connected computer is "ask for risky actions".** Reads and safe commands run freely. These ask the user first:

* risky commands
* deleting files
* purchases
* screen control outside windows and tabs the bot opened

This works like Winter's auto mode with the safety reviewer. The user can change the level for each computer. Bots are equal, so the level never depends on which bot is acting.

**[P] The levels and the reviewer:**

* The levels are read only, ask, ask for risky actions (the default: Winter's `auto` with the reviewer), accept edits, and fully automatic (`bypass`). Until C5, one level covers the local computer. **[P]** They form a total order, read only < ask < ask for risky actions < accept edits < fully automatic: accept edits is ask for risky actions plus edits and moves without asking. Read only is absolute; no saved rule beats it.
* Bash may write in the home and temp folders, except the fenced set (below), under Winter's network rules. That is wider than Winter's working-folder fence, so the reviewer's prompt is rewritten. **[P]** On every OS a sandboxed Bash or PowerShell command gets no network, as S2 read Winter's sandbox (it takes no domain lists); C-M2 confirms this against Winter's real behaviour. A command that leaves the sandbox keeps a native floor over the fenced set (reads, writes, links and renaming an ancestor) and still can't reach the cloud metadata address, so the escape floor carries an address rule as well as paths (S2, S8).
* The reviewer chooses its model by Winter's `reviewer.model` rules, and asks the user when no model can run.
* As in Winter (`isHumanTurnOrigin`), a card or question from a turn the user's own message did not start is denied after 10 minutes (§5.5).

**[D] Bots cannot raise their own access.** A core fence keeps bots' tools away from the files that hold settings, approval levels, credentials and bots' user layers, on every OS. Bots change those only through core tools, and anything that raises access ends in an approval card (§5.5). The plugins folder and routine files are not fenced: bots write plugins and routines as files, and the app asks before loading a plugin (§5.1) or running a routine at a raised level (§7).

**[P] The fence, precisely** (built in C1):

* **The fenced set:** settings, levels, saved rules, connector permissions, trust, the device list, bots' user layers, the credential store, development folders (§5.6), plugins' data folders (§5.4), the daemon's run folder, **[P]** transcripts and usage rows, the Clover Browser's per-bot profiles (§12.1) and the places the OS starts programs from (below). Bash's fence denies writing to them on every OS, and Winter's escape floor holds too: a command that leaves the sandbox still may not write them (§4). It also denies reading the run folder, as Winter's does (`runtime-sdk/mode-options.ts`), and on Windows and Linux the secrets file and any key file (§8.5).
* **The secret store:** on macOS, Clover's Keychain items trust the daemon's binary alone, as Winter's do (`auth/credential-acl.ts`), so no other binary is ever served them silently. As in Winter, Bash's sandbox denies the Keychain (the runtime's `sandbox/profile.ts` allows four system services, none of them the Keychain), so the CLI, the daemon's own binary, can't read its token under a bot. **[D]** Windows and Linux have no such check, so there Clover keeps its secrets, tokens and device key in one encrypted file, with the key in the OS store (revision 13, item 59). Bash's fence hides the file and the run folder. **[D]** On Windows, model-run Bash and PowerShell run as a dedicated sandbox principal (the owner, revision 18, item 76), so they don't inherit the user's DPAPI, Credential Manager or ssh-agent access. `gh`, git credential helpers, Docker registry logins and ssh-agent signing reach them only through a Clover credential broker acting in the user's logon context, as on Linux, where the same tools reach the Secret Service through the broker of §4. The broker never hands over raw keys or stores. **[P]** It admits only the credential operation allowed for that session, destination and identity, and Clover's own secrets, approval tokens and device keys are never served to model commands. On macOS those tools can't reach their Keychain logins from a bot's Bash, so C1 adds a git credential helper that gets logins from the core, which hands bots only the ones the user allows.
* **[P] Nothing a command writes runs later on its own, or carries over** (S2, with the controller's ruling). Bash's writable home and temp folders exclude the places the OS starts programs from at login or on a schedule; they join the fenced set on every OS, escapes included: on macOS `~/Library/LaunchAgents`, login items and shell startup files; on Linux `~/.config/systemd/user`, `~/.config/autostart` and shell startup files; on Windows the Startup folders, the Run and RunOnce keys, PowerShell profiles and Git Bash's startup files. As with the rest of the fenced set, a bot asks the user to change them. On Windows, where Bash runs as a sandbox principal, nothing the principal writes carries over to another command or session, concurrent ones included: a principal per running session or one session at a time; its profile and registry hive reset for each session, checked on every launch and failing closed; its grants and temp folder per session. Fencing a list of auto-run paths is only an interim measure there.
* **[P] The holder enforces its own rules** (S6). The computer that holds the files applies its own fence to every request that comes over the link: the tree service's, every file tool and Bash call routed to it, and the Files panel's. It resolves each path on its own disk, links included, and refuses whatever lands outside the home or in the fenced set, checking the real path of what it opened. It compares names the way its disk does, with case and Unicode form folded and, on Windows, trailing dots, spaces and short names too, so a folder swapped for a link, or a fenced name in another case, can't lead into the fenced set. Over the link the fenced set can't be read or written and doesn't show in listings, whoever asks. The approval levels still apply on the computer where the program runs.
* **[P] Links inside a home** (S6): an absolute link that points inside the home is served as a relative link, so it resolves on every computer. A link that points outside the home, absolute or relative, answers "permission denied" when read from another computer, since it would resolve against that computer's own disk.
* **Other writers:** `stdio` servers, host halves and computer use run as the user and can write these files (§5.2), and agents have them denied through their own sandboxes and settings (§9.3). A change made outside the core takes effect at once only if it lowers access; one that raises access waits for a sealed card.
* **No core tool changes these items in 1.111.1;** a bot asks the user.

### 9.2 Cloud computers

**[D]** Bots can use cloud computers, and all of the user's bots share them.

* **[P] Simplest form:** the user runs Clover headless in any VM and pairs it, after which it is just another computer.
* **[D] A cloud computer is a plugin folder.** Making one means writing a folder that names its provider, size and region (for example `computer-hetzner-1/`) into the plugins folder. The user or a bot can write it; no tool is involved.
  * **[D]** The app finds the folder and asks the user before creating the VM. The provider plugin (contributing to `computerProviders`; **Google Cloud** and **Hetzner** first) then creates the VM, installs the image and pairs it in one step.
  * **[D]** The app then asks whether to make it the main computer.
  * **[P]** Removing the folder asks whether to delete the VM too; deleting a VM always asks, whatever the folder says.
  * **[P]** The folder contributes `computer` (§5.3, §5.9). The VM's own state (server id, address, pairing) lives in the computer registry, not in the folder, and editing `size` in the folder asks before resizing.
* **[P] Official image:** Linux that runs the daemon alone, with Chrome for Testing's headless shell as the bots' browser (§12.1), and turns lingering on so the daemon starts at boot. A desktop session for computer use comes with opensky.
* **[P] Safety:** pairing tokens work once; VMs get no cloud service account; the bash fence blocks the cloud metadata address, so a bot cannot lift cloud credentials from inside the VM. A core switch pauses all bots and routines at once.
* **[P] Sharing rules:** sharing between bots needs per-app and per-window holds, like Winter's held apps, so two bots don't fight over one window. The core keeps each computer's holds and the user-working mark. Plugins with the `computers.control` capability take and release them through the plugin API, which also tells the approval cards when an action is running (§5.5); its OK says "controls the screen and input of your computers" (§5.4).
* **[P] More than a computer:** a connected cloud computer naturally becomes the **main computer** (once the user confirms), a **relay** the user can choose over n0's (§8.3) and a webhook receiver (§7).

### 9.3 The Agent tool and its placement

**[D]** A bot can delegate to an ACP agent, choosing **which agent**, **model**, **effort**, **which computer** and the **root folder** in the folder tree (§9.1), or a vendor's cloud.

**[D] How a delegation runs.** It works like Claude Code's background agents:

1. **`Agent` starts a background agent and returns at once.** The agent never runs in the bot's main conversation.
2. **While it works,** the agent can message its bot with `SendMessage`. Those messages fold into the bot's conversation like any bot message (§6.4).
3. **The bot keeps control:** `ListAgents` shows the agent (with every other running session and bot), and `TaskStop` stops it.
4. **When the agent finishes,** the bot receives a **task notification** carrying the agent's final report and the path to its full transcript.

**[D] The user can drive agents directly:**

* Each background agent opens as a **live tab** under its bot. The user can watch it, type to it, interrupt it and stop it. **[D]** In the default shell a bot's running agents show in its tab's slim column, and clicking one opens it in the right panel as a code-session-style transcript, with its own composer and model picker (item 90, §5.5).
* The user can also start a coding agent directly from the app or the CLI (`clover code`), with no bot involved.
* **[P]** A **session** is any running conversation: a bot's main conversation, a side thread, a background agent, or a coding session the user started. `SendMessage` and `ListAgents` work on sessions.

**[D] How plugins reach an ACP agent,** for plugins scoped to `agents` or `both`:

| Plugin part | Reaches the agent? | How |
| :- | :- | :- |
| MCP servers and Clover tools | Yes, on every ACP agent | Through **one Clover bridge MCP server**, handed to the agent at session start (ACP's `session/new` accepts MCP servers; every agent supports stdio). The bridge serves the plugin's tools and MCP servers wherever they actually run, under the same approval rules, and also provides `SendMessage` and `Glossary` |
| Skills | Yes | Through the bridge's `Glossary` tool on any agent, plus placement in the agent's own skills folder where it reads one natively (Claude Code) |
| Agent definitions | Only on backends with subagents | Placed in the backend's own folder (Claude Code's agents directory) |
| Claude Code plugins | As wrapped plugins, on every agent | **[D]** Wrapped into Clover plugins when they are added (§5.1, revision 14); Clover never loads them natively; a Claude Code agent still loads what the user installed in Claude Code itself, as it would outside Clover. Their parts then reach agents like any plugin's, by the rows above and below |
| Hooks | Only on calls through the bridge and on in-process subagents, plus Claude Code's own calls | An ACP agent's own loop is out of reach; **[P]** a hook with a `command` is also placed in Claude Code's own settings for Claude Code's own tools, as skills are placed in its skills folder, through Clover's shim, which passes its deny and ask and drops an allow (§5.3) |
| UI, themes, surfaces, voice, avatars | No | They belong to the app, not to agents |

**[P] How that maps onto ACP:**

* **Messages from the agent:** the bridge MCP server gives the agent `SendMessage`.
* **[P] The bridge's link:** a token for that one agent session, whose role allows only the bridge's own tools, `SendMessage` and `Glossary`. **[P]** Clover treats everything handed to an agent as stored in plain text, readable by the user's other processes and passed to every server the agent starts: its environment, argv, `mcpServers` entries, `_meta` and prompts (Antigravity writes every `mcpServers` entry, `env` and headers included, into its conversation database). So:
  * The bridge token is the only secret handed over, and it goes only in the bridge entry's `env`.
  * The daemon accepts the token only from a process descended from that session's agent process (the caller check of §3.1), with one live connection per token: a descendant in the process tree on macOS and Linux, and a member of the agent's job object on Windows, where a process can name any process it can open as its parent. The job is unnamed and allows no breakaway.
  * The token is revoked at `TaskStop`, at session end and on a daemon restart, and minted anew on `load` or `resume`.
  * The agent's environment comes from an allow-list. It carries the agent's own login only where that backend needs it there.
  * Settings marks the backends that store what they are given in plain text, or pass their environment on to the servers they start (Antigravity does both).
* **[P] The bridge's essentials reach the prompt.** Cursor and Antigravity file MCP server instructions as documents the model may open, not in its prompt. So the bridge's essentials (who sent the work, `SendMessage` to report, `Glossary` for skills) go into the agent's system prompt where the backend lets a client add to it (Antigravity's `_meta.antigravity.systemPrompt.append`, the unstable ACP `systemPrompt`, or the Claude adapter's `_meta.systemPrompt`), where they survive the agent's own compaction; otherwise they go into the first prompt. The plugins' instructions, which the bridge still sends as its server instructions, stay reachable through `Glossary`, and every bridge tool's description stands on its own.
* **Messages to the agent:** a message from the bot reaches the agent as its next prompt.
* **Stopping:** `TaskStop` sends ACP's cancel, then ends the process. **[P]** One agent process serves one delegation, contained as a group: a process group on macOS and Linux, a job object on Windows. `TaskStop` sends `session/cancel` (both agents S5 tried answered `cancelled` within 15 ms and killed the running command), then ends the group. When a cancel leaves tool calls open, Clover closes them itself.
* **The transcript:** Clover records the agent's session updates into `bots/<bot>/agents/` (§6.5), so the path in the notification opens with the bot's own file tools. **[P]** Updates that arrive between a `session/load` or `session/resume` request and its response are a replay, and are neither recorded nor shown again. Clover reattaches with an honest `resume` where the backend has one, otherwise with `load`, dropping the replay; Antigravity's `resume` replays too, so it counts as a `load`. Clover keeps its own record of agent sessions and never relies on `session/list`, which Cursor limits to the calling process's own session and Antigravity answers with every session on the computer.
* **Delivery:** a task notification folds in after the bot's next tool call if the bot is busy. If the bot is idle, it starts a new turn. **[P]** A refused card ends the agent's turn on Antigravity, with no reply, so the task notification says the agent stopped at a refusal, and the bot can message it to go on. A plan or quota refusal can arrive as ordinary agent text (Cursor), so the notification carries the final text unchanged.
* **Paths:** files the agent's report cites are given as folder-tree paths (`home/Desktop1/…`), so the bot can open them wherever they are.

* **[P] Local placement:** the daemon on the chosen computer starts the agent's ACP process there and streams its events back to the bot.
* **[P] Agents with ACP today** (checked in spike S5, November 5):
  * Native: Gemini CLI (`gemini --acp`), Grok CLI (`grok agent stdio`), Cursor's CLI (`cursor-agent acp`), Antigravity CLI (`agy acp`), Devin (`devin acp`) and DeepSeek Harness (`dsh --profile acp`, one workspace; MCP servers need `dsh-acp` 0.1.2 or later, a prerelease today). Since June 18, 2026, Gemini CLI needs a Gemini API key or Vertex AI, and Google's free and subscription accounts use Antigravity CLI.
  * Through adapters: Claude Code (`@agentclientprotocol/claude-agent-acp`) and Codex (`@agentclientprotocol/codex-acp`, which drives `codex app-server`).
  * Cursor's CLI and Antigravity CLI accept the stdio and HTTP MCP servers passed at `session/new`, pass on their `env` and `headers`, and give their tools to the model.
  * Clover never trusts a command name on PATH: `agent` is both Cursor's and Grok's. It resolves each backend's binary to its real path and checks that it is that vendor's (its version output, and the signer where the OS has one) before starting it.

  Model and effort are passed where the agent exposes them, **[P]** through `session/set_config_option` (categories `model` and `thought_level`). Cursor folds effort into its model values, and the models offered depend on the account's plan (Cursor) and on the client's name (Antigravity). On Cursor a delegation's model choice becomes the user's own selection, kept across processes and in Cursor's config, so Clover restores the user's selection after the delegation unless M2 finds a way to choose that doesn't persist. Antigravity doesn't persist its choice.
* **[D] Winter's own coding mode becomes an ACP agent** that bots can delegate to like any other. **1.111.1 waits for it.** The release ships only once this agent speaks ACP, so Winter users keep a first-party coding agent.
* **[P] Cloud placement:** vendor cloud agents (Claude Code on the web, Codex cloud, Cursor background agents) are **not** ACP. Each needs its own plugin, contributing to `agentBackends`, that speaks that vendor's API. Devin's cloud is the exception: `devin acp --cloud` relays ACP to cloud Devin sessions, so its backend is an ACP backend with cloud placement. Whether the stdio bridge reaches a cloud session, and what the root folder means there, is settled before it ships.
* **[D] Permissions work as in Devin Desktop and Zed, plus our levels.** Each agent runs as its own process with its own install, login and sandbox; Clover does not wrap it in another sandbox (macOS cannot nest them). It is started in a mode where it asks before risky actions, and each request it sends (ACP's `session/request_permission`) goes through the computer's or the routine's approval level: answered automatically where the level allows, otherwise shown as an approval card. A model never answers them.
  * **[P] How Clover answers:** with `allow_once` or `reject_once`, never an agent's "always" option, which Cursor would write into its own allowlist, out of reach of Clover's levels. A card's "always" answer is saved as Clover's own rule, and the agent still gets `allow_once`. An agent that offers no `allow_once` gets a refusal (`reject_once`, or the cancelled outcome when it offers none). Clover keeps its own record of each answer, since agents report a refused call as `completed` (Cursor) or `failed` (Antigravity).
  * **[P] The bridge's own tools:** a permission request is answered `allow_once` at once only when it exactly matches the session's bridge server name and a tool from the bridge's own list, read from the structured input of the matching tool call (Cursor's `rawInput.providerIdentifier` and `toolName`), never from its title, since Cursor titles MCP requests `<server>-<tool>: <tool>` and either part can hold a hyphen. The bridge applies Clover's approval when the call arrives. Anything else, or anything ambiguous, goes to the level and the card.
  * **[D] Cursor is accepted with its workspace folder and its deny rules as the boundary** (the owner, revision 18, item 78). On Cursor, edits inside the agent's root, commands on the user's own Cursor allowlist and, by Cursor's code, deletes inside the root never send a request, so they never reach a card. Settings marks the backend as "edits inside its folder without asking". **[P]** At the read-only level Clover starts Cursor in its `ask` or `plan` mode, which ACP offers. Antigravity's own settings may pre-approve actions as well (`access_grants`, and `--include-default-customizations`, on by default); the bridge's tools still go through Clover's approval.
* **[D] The fence reaches agents through their own settings** (revision 12), **the way Devin does it** (revision 13). Each agent's commands run in its own sandbox, started with the fenced set (§9.1) denied in its own format (Claude Code's deny rules and sandbox settings, Codex's sandbox settings, Devin's `Read(...)` and `Write(...)` rules), and with the run folder and, on Windows and Linux, the secrets file hidden from its commands and its read tool. An agent with no sandbox on that computer (on native Windows, Claude Code and Devin today) starts only after the user's OK, which says it could read Clover's logins and approve its own cards; like Devin, Clover never quietly runs one unsandboxed. `Agent` refuses a root folder that contains the Clover home, and a permission request that touches a fenced path is always a card, at every level. **[P]** A backend that can't take the deny list relies on the rest (its own sandbox, a root outside the Clover home, and cards for fenced paths), and Settings marks it; on Windows and Linux it also needs the OK above. **[P]** A backend counts as protected only for an exact version and configuration shown to protect its shell's descendants and its file tools, to refuse a widened policy, and to keep the floor on retries and exclusions (S8); every other combination needs the OK above, and Clover still adds no outer sandbox.
* **[P] Stalled agents:** Winter's stall watchdog carries over. An agent that makes no progress for 10 minutes is stopped, and its bot gets a task notification saying so.

---

## 10. Surfaces and companions

* **[D] The island and the Dispatch pill become plugins contributing to `app.surface`.** In Electron they become frameless, transparent, always-on-top windows that the app opens from their `app.surface` entries, with small native add-ons only where needed (notch geometry, gestures). The Swift versions stay in the repo as the reference for rebuilding them (§12).
* **[P] Always-on-top surfaces are the `clover` tree's** (R12). In 1.111.1 only the bundled `clover` plugin and its children may open `app.surface` windows that stay on top (`alwaysOnTop`); the sealed cards' overlap check counts Clover's own surfaces (§5.5).
* **[D] The island looks the same on all three OSes** (the owner, revision 18, item 82): one top-centre island, themed by tokens, with no fixed Apple blue. It sits at the notch, and on a screen without one it grows from the top edge; on Wayland, which has no always-on-top, it is a normal window (§4).
* **[P] The default VRM avatar renderer** (filling the bot stage's `avatar` spot for the `vrm` format, §5.5) starts from `yanlingLabs/companions` (an Electron app using `@pixiv/three-vrm`) and `waifucave/daydreamers` (VRM desktop companions).
* **[D] The Live2D avatar renderer** (the owner, revision 18, item 87) fills the `avatar` spot for the `live2d` format. It draws Live2D Cubism models with Mochi2D (`waifucave/Mochi2D`, MIT, shipped as `@waifucave/mochi2d`), the owner's clean-room Cubism runtime, and takes the VRM renderer's caps: nothing over sealed frames, memory bounds, and lip sync from the speech feed only, so Mochi2D's live-microphone lip sync stays off. No one working on Clover opens `waifucave/Lively2D-research`, the dirty room.
* **[D] The companion app is the iOS app.** It becomes a plugin contributing to `companions` (its daemon-side adapter) and keeps its native Swift app, re-pointed at Clover. The web companion (§8.4) is a second one, and several can be active at once. **[P]** Winter's phone link carries over: iroh-ffi, n0's relays and the signed relay list (`apple/WinterKit`). The Swift `Gateway` in the Mac app, which connects to the daemon as `remote`, moves into the daemon in C4.
* **[P] What a remote client may do is core.** The core keeps a fixed list of the calls a remote client may make, as Winter's `REMOTE_ALLOWED_METHODS` does, with a shorter list for the web page. A companion plugin cannot widen it. The native iOS app shows approval cards (§5.5); its answers are signed with the device's answer key (item 91) and travel on the core's link, never through the companion plugin.
* **[D] Phone notifications use a content-free waifucave push:**
  * A small waifucave service sends an empty "you have N updates" push through Apple.
  * The app then connects directly to fetch what happened, so waifucave never sees content.
  * It is a removable plugin contributing to `notifiers`.

---

## 11. Discord Waifus

**[D] Discord Waifus is just a plugin.** It adds an app button to the sidebar that opens its panel inside the harness. It shows that a whole existing app can run inside Clover, and nothing more: **Clover has no other relation to Discord Waifus.**

---

## 12. What happens to Winter's parts

| Winter part | In Clover |
| :- | :- |
| `packages/protocol`, `core`, `cli` | Renamed under `@waifucave`; the core loses the router (§3.3) and gains the plugin registry, the main computer, links and sync. The CLI stays as a client for talking to bots. |
| Providers in `winter-agent-sdk` (adapters, catalogs, sign-ins) | **[D]** move out into bundled model plugins, one per provider (§3.3) |
| `packages/core/src/routines` | Becomes the core routine engine, reading routine files (§7) |
| `packages/plugin-sdk` | Becomes the Clover plugin SDK, `@waifucave/clover-plugin-sdk` (§5.6). Winter's `contributes.shortcuts` become commands with a `key`, and its `tile` (a title, value, icon, progress and action buttons the plugin pushes) becomes an entry in the shell's `status` spot (§5.5) |
| `apple/Winter` (Swift menu-bar app) | **[D] retired from the start.** The code stays in the repo for now as the reference for rebuilding the Dispatch pill and island as plugins. |
| `apple/WinterProtocol`, `WinterKit` | Kept for the iOS companion. `WinterChatKit` retires with the phone's chat engine (§14.2 item 18) |
| `apple/ComputerUse`, `WinterCUCore`… (the Winter Computer Use helper) | **[D]** not bundled in 1.111.1, since computer use comes later as opensky (§4, revision 17). **[P]** Proven pieces (holds, user-working marks, wake triggers) move into opensky. |
| `extensions/winter-for-chrome` | **[P]** waits for opensky, as part of its browser support |
| Winter's code mode | **[D]** becomes an ACP agent; **1.111.1 waits for it** (§9.3) |
| CEF and the Chromium headless helper | **[D]** the code stays in the repo but is not bundled. **[D]** the Clover Browser replaces them (§12.1) |
| Office live editing (LibreOffice host) | **[D]** stays in the repo, wired up later |
| **The 1.111.1 feature floor** | **[D]** MCP servers, MCP Apps, skills, the approval modes, the Clover Browser, usage tracking, the `hooks` point, translations, the default shell's panels (the session view, terminal, diff, browser and files; item 83), and the island's Needs you, Devices and Usage tabs (MCP Apps and translations since revision 14). Everything else returns later as plugins: Workflows, output styles, LSP, Office, Chat mode, the pill's command mode and terminal, the island's other tabs, and Claude marketplaces; Claude Code plugin folders are wrapped from 1.111.1 (§5.1, revision 14). Winter's Cron tools are replaced by `Routine`. |
| Usage tracking (`usage.db`, plan readings) | **[P]** Each computer reads its own apps' usage (Codex, Claude Code, OpenCode, Antigravity) and syncs append-only rows to the main; the core counts Clover's own turns. What ACP agents spend on the user's own subscriptions shows up through those apps' readings. Plan alarms carry over, and the readers still take only numbers, never content. |
| Other Winter features | **[P]** Carry over in core: image attachments (§8.5), per-tool connector permissions, MCP sign-ins and URL elicitation, saved "allow always" rules. Move: plan mode to the coding agent; thinking titles to the conversation view; `PushNotification` to `notifiers`; `ScheduleWakeup` to `Routine`; Dispatch mode, `SpawnSession` and `ListSessions` to bots, `Agent` and `ListAgents`. Also carry over: model and effort switches mid-session (§6.3) and the subagent stall watchdog (§9.3). Retire: the phone's own chat engine, since the phone is a companion (§14.2 item 18), and the Norma migrations. Later, as plugins: the phone's computer-use mirror, the island's computer-use pill and turn-result cards, and the battery charge limit (Winter's hardware broker). |
| **Cowork** | **[D]** paused |
| Release pipeline (Sparkle, Homebrew cask, signed macOS builds) | **[P]** electron-updater, keeping Sparkle's update channels and idle gate, and per-OS packages: dmg and Homebrew; Windows installer and winget; deb and rpm, with the AppImage as a fallback (§4). Built in C7. **[D] Windows ships unsigned at first,** so users see SmartScreen's "unknown publisher" warning; signing comes later. **[P]** macOS stays signed and notarized by the existing company. |
| Existing Winter installs | **[D] Settings and logins carry over:** provider keys, subscriptions, MCP servers and settings. Old Winter sessions stay readable in an archive view but do not become bot history. **[P]** Also: skills and agents are wrapped as plugins; Winter routines become Alpha's routine files on the computer they ran on, paused until the user reviews them; per-project MCP servers become repo items (§5.1); trust, saved rules, connector permissions and MCP sign-ins carry over; code-mode memories stay with the coding agent; installed Claude-format plugins (`<name>@<marketplace>`) are wrapped like any Claude Code plugin folder (§5.1) and start switched off. The final Winter release that hands credentials over (§14.2 item 28) ships before C1's migration can read them. C3 migrates Winter's routines, paused, and Alpha's starting memories from `_assistant` (§14.2 item 12). |

### 12.1 The Clover Browser

**[D] Clover runs its own browser, headless, on each computer.**

* **A browser plugin shows it.** The browser view (a UI plugin) displays its tabs in its own way, and another plugin could display them differently.
* **It has an API.** Plugins with the `browser` capability can open tabs, navigate and use the DevTools protocol, so users can build their own browser tools.
* **Computer use sees it as one more browser.** To a computer-use plugin, the Clover Browser is a browser like Chrome or Safari, and it can drive it headless, as it can Chrome. opensky covers both the computer and its browsers.

**[P] How:**

* **[D] On desktops, the browser lives in the app's own Electron** (revision 12, the owner's design; this replaces the separate browser process first chosen in the same review). A tab is either headless, in a hidden window that is never shown, or shown in the browser view, and it moves between the two without reloading. The always-on pair (§3.1) keeps it running while every window is closed.
* **[D] A bot's tab is drawn offscreen** (design B; the owner, revision 18, item 92). It renders with no window and is shown through the browser view's viewport without reloading, as in Winter's headless helper. The [D] sentence above and §3.1 stay as written: its "hidden window that is never shown" is an offscreen one. A plain tab in a never-shown window would never draw, on any OS (S7).
* **[D] Screen-reader users** (item 93). A screen reader reads nothing in the viewport, so while one is on, new bot tabs start instead as real views in a hidden host window that is shown but that the user isn't meant to see or use (design A, only then), and a screen-reader user takes one over as a real view. No tab ever reloads: the switch decides only where a new tab starts and never moves one, and tabs made before stay offscreen.
* **[P] How:** tabs live in the app's main process, each bot's tabs in that bot's own session partition and the user's in another, with sandboxed renderers and no Node or preload. **[P]** A bot or a coding session uses its own partition. Driving the person's own logged-in partition needs an explicit card for each session, and is never the default (R10). A bot's tab is an offscreen `BrowserWindow` that is never shown (Electron's offscreen rendering), and the person's own tabs are `WebContentsView`s. DevTools access goes through each tab's own debugger and reaches only browser tabs, never the app's windows or the sealed cards; there is no debugging port. The API passes an allow list of CDP domains (no `Target`, `Browser` or `Storage`; no paths outside the bot's scratch), and the app's own schemes never serve browser partitions. If the app crashes, the daemon restarts it and the tabs reload.
* **[P] Drawing a bot's tab:** it is laid out at the agent's 1280×800 at a scale of 1 (on Windows, `setContentSize` after it is made). It paints at 10 fps while a bot works and nobody watches, with painting stopped while the bot only reads, and at 60 fps while the person watches; a tab no bot has used for a few minutes stops painting. Its frames are CPU bitmaps. GPU shared textures are an optimization for later: only where Chromium composites on the GPU (`app.getGPUFeatureStatus().gpu_compositing`), only once their dropdowns draw, and on Linux only once dmabufs pass the live gate.
* **[P] Screenshots:** a bot's screenshot is the newest painted frame, or `capturePage` while painting is stopped or frames are textures. Both are 1280×800 at a scale of 1, whatever the display.
* **[P] Showing:** the browser view's viewport draws the tab's frames and sends the person's input back: mouse, wheel and keys with `sendInputEvent`, the IME and HTML5 drags over CDP, paste and edit commands as Electron's own, and the page's cursor.
* **[P] A page's own windows:** a window a bot's page opens is offscreen where Electron can make it so, as a cross-site one is. A same-site one can't be (Electron #55565): while the person watches, it opens as a real window; while a bot is alone, it is refused, or its address is reopened as a new offscreen tab without its opener.
* **[P] What a bot's pages may raise:** nothing the user would see. Permissions are denied by default. `window.open` goes through the browser's own handler. File choosers are answered over CDP (`Page.setInterceptFileChooserDialog`). JavaScript dialogs are answered at once (`disableDialogs`), with CDP telling the bot what the page asked; offscreen that is required, since otherwise a dialog brings the tab's hidden window on screen on macOS. `beforeunload` goes through `will-prevent-unload`. Fullscreen, notifications and printing are refused. On macOS a power blocker keeps App Nap off while a bot works.
* **[P] Private addresses** (R13): bot tabs refuse loopback, private (RFC 1918 and ULA), link-local and cloud metadata addresses by default. The check runs at connect time, after DNS, so DNS rebinding can't get round it. A code session's tabs may reach loopback, for local dev servers, but never the metadata address. A per-bot setting to allow the LAN comes later.
* **[P] The proxy** (R14): tabs connect directly at first. A setting then offers three choices: off (direct); the system proxy, including the system's own PAC file but never WPAD discovery; or an explicit http, https or socks proxy.
* **[P] The screen-reader host** (item 93): a 1×1 window, used only for bot tabs made while a screen reader is on (on Windows a 32×32 tool window at opacity 0; on X11 an empty window shape, so no pixel shows and it takes no click; on macOS M1 decides whether it is transparent). A tab a bot works in there has background throttling off and draws at the display's rate, a CDP override holds its page at 1280×800 and a scale factor of 1, and its screenshots are `capturePage` of its view, scaled to 1280×800. The host never takes focus, even when its page asks; passes a click at its point to the window below; stays out of the taskbar, the Dock, Alt-Tab, Mission Control and the Window menu; has a neutral title; and is left out of other apps' screen captures where the OS allows. On Wayland it can show in the window list and its one pixel can take a click; whether GNOME and KDE keep drawing it when covered is a live gate, and the fallback is XWayland. A tab that no bot has used for a few minutes, that plays no sound and that no one watches rests in a never-shown window with throttling on, and goes back to the host before the bot's next command.
* **[P] Winter's headless lessons carry over** (`docs/claude/headless.md`, where a windowless tab shown in the Mac app's panel was fully clickable and laid out to the panel's size): a shown tab is laid out at the view's size, and the agent's own 1280×800 returns when it goes back to headless. A Point from a screenshot taken at another size is refused. While the person holds a tab, the agent's commands on it are refused (Winter's control lease).
* **[P] From another device,** the view streams the tab as video over the link, on its own low-priority stream. The app captures the tab and encodes it with WebCodecs: S7 measured about 2.3 Mbit/s for 30 fps of full motion, and tens of kbit/s for a still page. The codec is H.264 where a hardware encoder exists, else VP8, which measured the same; where no hardware encoder exists, H.264 would mean the software encoder built into Electron, and shipping that raises a patent-licensing question. When the link falls behind, the sender skips to the next keyframe and lowers the bitrate, a design not yet measured on a real link. The codec contract (what the iOS companion decodes with VideoToolbox, H.264 and not VP8, and what Safari and Firefox decode for the web companion) belongs to lane I.
* **[P] Where no app runs** (a server or cloud computer without a display), the browser is Chrome for Testing's headless shell. It is pinned by SHA-256 to the Chromium of the app's Electron, or to the nearest build of the same milestone when that exact build isn't published, and the pin may move ahead of Electron for a security fix. The install fails closed: no pin, no install, and a reused install is checked again. The daemon drives it over the DevTools pipe (no port), with a profile folder per bot. The pipe is a browser-level connection (`Target`, `Browser`, `Storage`), so the CDP allow list sits in the daemon's API here too. On Linux it needs the AppArmor profile, as Electron does, and the server package's dependencies (S7 lists them).
* Until opensky arrives, a bundled plugin's `mcp__clover__Browser` tool drives it through the API, ported from Winter's browser tool over the DevTools protocol.

The limits to plan around:

* **[D] Clover ships stock Electron, with no patches** (the owner, revision 18, item 94: "stock Electron, wait upstream"). So a same-site window a page opens works only while the person watches (Electron #55565), a page's dialogs are answered at once and never offered to the person, and a watched tab's frames are CPU bitmaps. Fixes go upstream instead.
* Electron has no Widevine, so DRM video sites won't play without the castLabs Electron build, which also needs VMP signing through castLabs' free EVS service.
* Chrome extension support is partial.
* Partitions are per bot, never per site, so sign-ins that hop domains keep their cookies; none mixes with the app's own.

---

## 13. Phases

Each phase ends merged, tested and usable [P]. Live gates stack at the end, per the owner's standing rule. 1.111.1 ships after C7, on all three OSes, and only once Windows bash is ready and Winter's coding agent speaks ACP (§4).

| Phase | Delivers |
| :- | :- |
| **C0 Move** | Org transfers and renames; npm scope; repo moved into `WaifuCave/`; Claude memory copied to the new path; CI green under the new names. No behaviour change. |
| **C1 Core cut** | Router removed and SDK embedded; daemon on Windows and Linux (sockets and pipes, secrets, login start); **Windows bash and PowerShell under the fence**; plugin folders with child plugins, the manifest, the plugin API and the plugin SDK with its schemas, catalogs and templates, development folders, the wrappers for MCP configs, skills, agent files and Claude Code plugin folders, and `clover plugin validate`, the registry and the plugin host (with its macOS sandbox); model plugins, with every current provider converted into one; the `hooks` point; the core tools, with `Glossary` replacing `Skill` and `ToolSearch`; the web plugin; usage counting; the bot fence and the git credential helper (§9.1); Linux bash under bubblewrap; the local approval level and the rewritten reviewer (§9.1); the caller check (§3.1); the secrets file on Windows and Linux (spike S8); `commands`; the plugin index and its revocation list; the final Winter release that hands credentials over (§14.2 item 28), then the Winter settings and logins migration |
| **C2 App** | Electron main process (tray at login), the default shell plugins, the always-on app and daemon pair, the spot catalog and precedence, layers (spike S9), sidebar apps and panels, themes, bot-tab layouts and components, isolated web views, MCP Apps views, translations (`locales`), sealed approval cards, safe mode, the welcome setup guide, the Clover Browser in the app and the browser view (spike S7), `mcp__clover__Browser`, the plugin index browser, the archive view, desktop notifications and the 18+ gate; island and Dispatch pill as `app.surface` plugins (Needs you and Usage tabs) |
| **C3 Bots** | Bot plugin format and Alpha, the user layer and the bot editor, one continuous life with interrupts and cache-timed compaction, persistent memory, routine files with the schedule trigger, the pause switch, `SendMessage`, the VRM and Live2D renderers, voice plugins with Fish Audio for Alpha |
| **C4 Devices** | Spike S1 (transport); identity, account and code pairing, the waifucave handshake service for devices paired without an account, persistent links, the device registry (every paired device, phones and browsers included), the main computer with its lease and takeover, transcript, memory and plugin sync, credential sync and the refresher, the webhook trigger and the waifucave forwarder plugin, the n0 and cloud computer relay plugins with the welcome guide's relay page, waifucave push, the island's Devices tab; the phone's gateway moved into the daemon and the iOS companion re-pointed; web companion |
| **C5 Computers** | Computer registry (the devices that run `clover-core`, with their folders and levels), **the folder tree**, served by each computer that holds a folder, with no OS mounts (spike S6, item 88), with file tools and bash where the files are and the direct path for moves and copies, MCP tools across computers (`computer`, `saveTo` and Mirror), approval levels per computer, cloud computers as plugin folders with the image and the Google Cloud and Hetzner provider plugins, the browser where no app runs |
| **C6 Agent tool** | ACP agent backends and placement; background agents with live tabs, `SendMessage`, `TaskStop`, `ListAgents` and task notifications; direct coding sessions; in-process subagents (§14.2 item 15); each agent's own sandbox with the fenced set denied, and the OK for one with none (§9.3); **Winter's coding agent over ACP**; the first vendor cloud-agent backend |
| **C7 Release** | The release pipeline for three OSes: electron-updater with update channels and the idle gate; dmg and Homebrew; the Windows installer and winget; deb and rpm, the main Linux packages, and AppImage; macOS signing and notarization |
| **After 1.111.1** | Trigger integrations (Slack, Git, Teams, Linear, Sentry, PagerDuty); the Discord Waifus panel plugin; the free encrypted-mailbox sync plugin; rooms if wanted |

C1 and C2 can run in parallel once the protocol, the plugin manifest and the plugin API with its catalogs are pinned. C6 starts with local placement once C4's device registry exists; placement on other computers waits for C5's folder tree. C7 can start once C2 has an app to ship. Each spike in §14.1 opens its phase.

---

## 14. Open items

### 14.1 Spikes and research

1. **S1 transport:** relay-free iroh vs plain QUIC with STUN punching; iroh, quinn and WebRTC under Bun; speed on real networks; with n0's relays on, how often traffic falls back to them (§8.3). Lab half done November 5, 2026: iroh, held in a sidecar of Clover's own; real networks and the relay share remain for live gate 1 ([lab report](research/2026-11-05-s1-transport.md)).
2. **Windows bash fence:** AppContainer or a restricted token, matching the Mac's fence, with its escape floor and the Task Scheduler closed (§4). M0 done November 5, 2026 (S2): only a dedicated sandbox principal both fenced writes and ran Bash, so Bash runs as one and credentials go through a broker (item 76). Not yet admitted for release: the Session 0 launch, the per-session reset of the principal's profile and hive, a per-command escape, the full fenced set and the password-principal startup task remain, and Windows 11 is a live gate ([report](research/2026-11-05-s2-s8-fence-and-secrets.md)).
3. **Computer-use backends:** moved to opensky with computer use (revision 17); no spike for 1.111.1.
4. **Fish Audio's free voice:** the quality and rate limits of `s2.1-pro-free` (§6.6).
5. **Cursor's and Antigravity CLI's ACP support:** answered November 5 (S5): both speak ACP and accept the MCP servers we pass; see [the report](research/2026-11-05-s5-acp.md) (§9.3).
6. **S6 folder-tree mounts:** closed November 5 (S6). FUSE, WinFsp and NFS loopback worked with limits and FSKit didn't yet, but the owner decided on no OS mounts (item 88): each holder serves its own tree, and tools and Bash run where the files are (§9.1, [the report](research/2026-11-05-s6-mounts.md)).
7. **S7 the Clover Browser:** tabs moving between headless and shown without reloading; background throttling and screenshots of hidden tabs; the app and daemon pair (login start, restart after a crash, Quit) on all three OSes; Chrome for Testing where no app runs; the streamed view from other devices (§3.1, §12.1). Answered November 5 (S7): a never-shown window draws nothing on any OS, so bot tabs are drawn offscreen and shown through a viewport (item 92), with a host window for screen-reader users (item 93), on stock Electron (item 94); the pair works on all three OSes, with `clover-core supervise` on Windows ([the report](research/2026-11-05-s7-browser.md)).
8. **S8 hiding Clover's secrets:** the encrypted secrets file on Windows and Linux with its key in the OS store; Bash's fence hiding it and the run folder while `gh`, Docker and git keep the OS store, and closing `systemd-run --user` with a D-Bus filter; each agent's own sandbox hiding the same paths, for Claude Code, Codex, Devin, Cursor and Antigravity CLI (§9.1, §9.3). M0 done November 5 (S8, in [the S2 report](research/2026-11-05-s2-s8-fence-and-secrets.md)): the secrets file and the headless fallback work; on Linux the Secret Service needs a broker that checks items, not a path filter (§4); each agent's sandbox is admitted per exact backend, version and configuration.
9. **S9 layers:** each plugin's UI code, children included, in its own renderer process (out-of-process frames from per-plugin origins), with the memory each layer costs, menus that cross a layer's edge, and focus, keyboard and drag and drop across layers; and the declared-host checks: CSP, `initiatorOrigin`, and WebRTC, DNS prefetching and speculative hints off (§5.3, §5.5). Answered November 5 (S9): the process split works; each layer costs about 18–24 MiB; crossing layers works with the main process's help; every request-based way out is closed, but WebRTC stays a documented known gap in stock Electron (item 94) ([the report](research/2026-11-05-s9-layers.md)).

### 14.2 Open questions from the November 2 review

These come from an independent review of this spec and Winter's docs, plus our own. A second independent review ran on November 3 (revision 9); its findings are written into the sections above, and its decisions are items 34–42 (items 43–46 came with revision 10). The final review of revision 11 is in [its own report](research/2026-11-03-wyrmhole-spec-final-review.md); its decisions are items 51–57. The second review, of revision 12, is in [its report](research/2026-11-04-wyrmhole-spec-second-review.md); its decisions are items 58–62. Item 63 is a change the owner made after it. The plugin-ecosystem review of revision 13 is in [its report](research/2026-11-04-wyrmhole-plugin-ecosystem-review.md); its findings are written into the sections above as revision 14, and its decisions are items 64–68, and items 69–71 are changes the owner made after it. A check of revision 14 is in [its report](research/2026-11-04-wyrmhole-spec-rev14-check.md); its fixes are revision 15, and its decision is item 72. A last, narrow check of revision 15 is in [its report](research/2026-11-04-wyrmhole-spec-rev15-check.md): it found nothing blocking or unsafe, so the plugin section froze at revision 16 (item 73), which applies its three minor fixes and the revision-14 check's A4, which revision 15 had missed. Items 74 and 75 are changes the owner made after the freeze. Items 76–94 are the owner's decisions of November 5, from the spikes and the first builds (revision 18). Each has a recommended answer (**rec**). Every question asked so far is answered. The rest carry a recommended default, which applies unless the owner objects.

**Trust and security**

1. **Answered (Nov 3):** approvals are sealed data that plugins show but cannot read, and every sensitive change ends in a sealed card (§5.5).
2. **Answered (Nov 3):** all bots are equal, with the same tools, plugins, MCP servers and skills; a bot changes only its `<bot-instructions>` block (§6.1).
3. **Answered (Nov 3):** each routine chooses its approval level, including fully automatic (§7).
4. **Answered (Nov 3):** signing in is enough; the account is the root of trust (§8.1). Asked again after the final review, since a stolen login reaches every key and computer: kept (item 55).
5. **What the web companion may do** (waifucave serves its code). Rec: chat and read-only activity. No approvals, device, plugin or permission changes from the web.
6. **Answered (Nov 3):** a plugin is just a folder with files, and making one never needs a tool; the app asks when it finds a new plugin (§5.1). Plugin sync pins versions and hashes (§8.5). Host halves start where their contributions run (§5.2, §9.1).

**Bots and Winter's features**

7. **Answered (Nov 3):** routine runs happen in side threads. `Agent` delegations are background agents that report through `SendMessage` and a final task notification, and are managed with `TaskStop` and `ListAgents`. The user interrupts only the main conversation (§6.4, §9.3).
8. **Answered (Nov 3):** no limits (§1.1).
9. **Answered (Nov 3):** subscriptions are allowed for everything; the originator becomes `"clover"` (§3.3).
10. **Answered (Nov 3):** 1.111.1 waits until Winter's coding agent speaks ACP (§9.3).
11. **Answered in part (Nov 3):** one folder tree across computers (§9.1). Rec for the rest: a trusted repo loads its instructions (CLOVER.md or AGENTS.md) and skills; trust is per computer and repo; each bot has a home folder per computer.
12. **Winter memory and internal jobs.** Rec: Alpha starts with Dispatch's `_assistant` memories. The dreamer becomes an opt-in memory routine for each bot. The bash safety reviewer stays in core. Titles and the session cleaner retire.
13. **Answered (Nov 3):** the core floor, with the rest returning later as plugins (§12).
14. **How a non-coder makes or edits a bot.** Rec: a bundled bot-editor UI plugin (name, `<bot-instructions>`, model, avatar, voice, theme including a plain one, layout) that writes the user layer, plus Alpha drafting bot plugins through the one-OK install.
15. **Proposed:** the SDK's in-process subagent tool is already called `Agent`. In-process subagents become one more backend of the `Agent` tool.

**Devices and sync**

16. **Answered (Nov 3):** everything syncs; one device at a time refreshes a login (§8.5).
17. **Answered (Nov 3; revised Nov 5 after S1):** the main holds a lease renewed with the waifucave handshake, through the account or, without one, through the pair credential, and hands over automatically either way (§6.4, §8.1; item 85). Routines fire only on the computer that holds their file (§7).
18. **Can the phone or the browser run a bot?** Rec: never. With no computer on, messages wait and the app says the bot is asleep, suggesting a cloud computer.
19. **Answered (Nov 3):** discovery by the waifucave handshake plus STUN (§8.3); phone notifications through a content-free waifucave push (§10). The relay part changed in revision 12: n0's public relays are on by default (item 57). S1 (Nov 5) settled what n0's relays do besides: they see presence, tell each device its public address, and carry a connection's set-up only where direct is unlikely or late, or for a device without an account that falls back to n0's address lookup; devices without an account reach the handshake with a pair credential (§8.1, §8.3; items 79–81).
20. **Answered (Nov 3):** one shared clock across devices, and sending needs a live connection (§6.4).
21. **Deleting things and exporting a bot.** A deleted item comes back from a device that was offline. Rec: delete and redact events that sync and override the merge, a "forget" the bot honours, and "Export bot" / import as one encrypted file.
22. **Proposed:** links negotiate a protocol version and support one release back. Headless daemons update themselves between turns. The plugin API follows semver, with experimental parts marked and one major version of deprecation notice.

**Product, legal and money**

23. **Answered (Nov 3):** Windows ships unsigned at first (§12).
24. **Answered (Nov 3):** 13+; the default app has no adult content, which can come only from third-party plugins (§5.7).
25. **Who runs the plugin index, and pulling bad plugins.** Rec: an official curated index in a waifucave GitHub repo (reviewed by PR, pinned hashes), plus a revocation list the app checks. Other indexes can be added by URL with a warning.
26. **Alpha's avatar and voice rights, and whose Fish key.** Fish's free model still needs a key, and a key embedded in the app can be extracted. Alpha's avatar is now a Live2D model (item 87); until the owner supplies it, with its portrait and licence, a code-made placeholder ships. Rec: assets that are commissioned or self-made and owned, under an asset licence. The renderers honour VRM licence fields. Real-person voice clones are kept out of the official index. Alpha speaks with the user's own Fish key, or is text-only.
27. **Waifucave service policies:** terms, a privacy policy, account deletion, per-user webhook rate limits, and crash reports (Winter has none). Rec: publish terms and a privacy policy before 1.111.1, add per-user limits, and make crash reports opt-in to a self-hosted endpoint, with no analytics.
28. **How Winter users move over.** Winter's Keychain items are readable only by the signed `winter-core`. Rec: a final Winter update whose daemon hands credentials to Clover on request and then stops. Winter stays installed as the rollback, and the iOS app updates in place.
29. **Clover's licence:** Winter is Apache-2.0. Rec: keep Apache-2.0 for the app and SDK, with a separate asset licence for Alpha's avatar and voice.
30. **An Android companion:** rec, after 1.111.1.

**Engineering**

31. **Answered (Nov 3):** Git for Windows' bash plus a PowerShell tool, under the same fence (§4).
32. **Answered (Nov 3):** latest OS versions only (§4).
33. **Proposed:** idle budgets checked in CI on all three OSes: daemon under 50 wakeups/s and 150 MB; an app with no window under 1% CPU; the avatar animating only while its tab is visible.

**From the November 3 review (revision 9)**

34. **Answered:** a routine gets its computer's level; a higher one waits for the user's OK. A core fence keeps bots out of settings, levels and credentials (§7, §9.1).
35. **Answered:** the plugin host is fenced away from the Keychain on macOS (§5.2). Windows and Linux changed in revision 12 (a narrow jail, item 54) and again in revision 13: plugin code there runs as the user (item 58).
36. **Answered:** ACP agents keep their own sandbox, as in Devin Desktop and Zed, and their permission requests go through our levels and cards (§9.3). Revision 12 passes our fence to them through their own settings (item 52).
37. **Answered:** the Clover Browser runs headless on each computer, a plugin shows it, and computer-use plugins drive it like any browser (§12.1). On desktops it lives in the app's Electron (item 56).
38. **Answered:** a cloud computer is a plugin folder; the app asks before creating it and before making it main (§9.2).
39. **Answered:** one folder tree across computers, with live access rather than sync (§9.1).
40. **Answered:** background agents open as live tabs, and the user can start coding sessions directly (§9.3).
41. **Answered, then changed in revision 11:** bots may now carry code, and child plugins replace plugin packages (items 47 and 48).
42. **Answered:** the MCP block is rebuilt only at compaction, and every server is visible everywhere (§6.1, §5.1). Where servers run changed in item 49.

43. **Answered:** every model adapter is a plugin, including today's providers (§3.3).
44. **Answered:** a routine is a file on the computer that runs it; the bot creates it with `Routine` and edits the file (§7).
45. **Answered:** several computer-use plugins can coexist, each with its own tool names; `mcp__clover__…` is for the plugins we ship (§6.7).
46. **Answered:** computer use is not special; a computer-use plugin contributes an MCP tool and, if needed, a helper (§5.3). Since item 47, plugins have no kinds at all.

**From the plugin-model review (revision 11)**

47. **Answered:** plugins contribute to extension points and can hold child plugins (proposal C of the plugin-model review). Kinds and plugin packages are gone (§5.1, §5.3).
48. **Answered:** a bot's plugin may carry code, and it styles only its own tab; anything for outside the tab comes from another plugin, which can be a child (§5.5, §6.1). Revision 12 makes that a wall with layers (item 53).
49. **Answered:** local servers run on each computer separately, with a Mirror button, and take a `computer` field, always required, when on two or more computers. Plugin folders still sync everywhere, and a local server runs only on the computers ticked for it. Remote servers work from anywhere, save files on the computer that calls them, and take a `saveTo` folder (§9.1).
50. **Answered:** a bot's plugin can style the approval card in its own tab (§5.5). A later change to card styling waits for its own OK (item 51).

**From the final review (revision 12)**

51. **Answered:** a later change to a plugin's approval-card styling waits for its own OK; until then, cards keep the styling last OK'd (§5.5).
52. **Answered:** the fence reaches ACP agents through their own settings; `Agent` refuses roots that contain the Clover home, and a request that touches a fenced path is always a card (§9.3). Revision 13 adds Devin's rule for an agent with no sandbox (item 59).
53. **Answered:** each bot's tab renders in its own layer, and parts several tabs share render once. The plugin that dresses the smaller part wins that part (§5.5).
54. **Answered, then changed in revision 13:** a narrow jail around the plugin host on Windows and Linux. The second review found AppContainer isn't narrow, and a narrower jail can't stop a plugin acting through another program, so plugin code there runs as the user (item 58).
55. **Answered:** signing in stays enough to add a device (§8.1).
56. **Answered:** on desktops the Clover Browser lives in the app's own Electron, and a tab moves between headless and shown without reloading. The app and the daemon are one always-on pair: starting either starts the other, the daemon restarts a crashed app, closing a window only closes it, and the menu-bar Quit stops both (§3.1, §12.1). This replaces the separate browser process first chosen in the same review.
57. **Answered:** n0's public relays are on by default, and the welcome guide has a page to swap them for the user's own server or Cloudflare (§8.3); the Cloudflare relay is one we write.

**From the second review (revision 13)**

58. **Answered:** on Windows and Linux, plugin code runs as the user, as in VS Code, Claude Code and Devin, and its OK there says it could read Clover's logins and approve its own cards. The sandboxes go on what the models run, and macOS keeps the plugin host's Keychain fence (§5.2). This replaces item 54.
59. **Answered:** coding agents work the way Devin does. On Windows and Linux, Clover's secrets move into one encrypted file; each agent's own sandbox hides it and the run folder, and an agent with no sandbox on that computer starts only after the user's OK (§9.1, §9.3).
60. **Answered:** installs and other sensitive changes made through the CLI from the user's own terminal stay confirmed there. The owner kept this knowingly: on macOS a coding agent that isn't sandboxed can run the CLI as the user (§5.1).
61. **Answered:** ⌘Q quits the app and the daemon, but on a computer running bots, routines or agents, either Quit first says what will stop and offers "Hand over and quit" (§3.1).
62. **Answered:** a part several tabs share takes each tab's colours, unless its plugin sets its own (§5.5).
63. **Answered (the owner, after the review):** Alpha ships its own tab theme in its own plugin, and `clover` ships, among much else, the base theme that every bot tab starts from (§5.1, §5.5).

**From the plugin-ecosystem review (revision 14)**

64. **Answered:** a plugin calls another plugin only by running its commands by full name, with `call:<plugin-id>`, which the OK lists; callbacks and events go through points, and a call to a missing plugin fails with "not installed" (§5.4).
65. **Answered:** `clover`'s base theme is also the default global theme, so the whole app starts from it until the user picks one (§5.5).
66. **Answered:** MCP Apps are in 1.111.1: a tool's `ui://` page shows in an isolated view, its calls go through the same approvals, and its declared content rules are enforced (§5.5, §12).
67. **Answered:** a plugin's components reach only the network hosts it declares; isolated web views and host code aren't held to the list, and the OK says so (§5.3, §5.6). Revision 18 records WebRTC as a known gap in stock Electron (item 94).
68. **Answered:** translations are in 1.111.1, through the app core point `locales`, so a language pack is a data plugin (§5.3, §5.5).
69. **Answered (the owner, after the review):** every plugin is Clover-shaped. A Claude Code plugin folder is wrapped into a Clover plugin automatically when it is added, like an MCP config or a skill folder, and nothing loads Claude Code plugins natively (§5.1, §9.3, §12).
70. **Answered (the owner, after the review):** besides filling a spot, a plugin can restyle one part in place (an entry with only `style`) or hide it (`hide: true`), so the UI supports styling, adding and removing parts; the `approval` cell can't be hidden (§5.5).
71. **Answered (the owner, after the review):** a plugin may run add-ons of its own, in a format it chooses, that Clover doesn't install, sync or check. Its manifest says so and its OK warns; its data folder is closed to bots' tools, and an add-on that a bot or another plugin supplies loads only after the user's yes on a sealed card (§5.4). A plugin that fills another plugin's point is still an ordinary Clover plugin.

**From the check of revision 14 (revision 15)**

72. **Answered:** only trusted packs translate sealed cards and the OK: the built-in tables, `clover`'s packs and packs whose tree hash matches the official index. Other packs translate everything else, and those strings fall back to English (§5.5).

**From the last check (revision 16)**

73. **Answered:** the plugin section (§5) is frozen as of revision 16. By the owner's stopping rule, the last check of the new plugin text found nothing that blocks a phase or breaks a safety guarantee, so later changes to §5 come from building C1 and C2.

**From the owner, after the freeze (revision 17)**

74. **Answered:** the product is renamed Clover, from Wyrmhole: `waifucave/clover`, `@waifucave/clover-*`, `~/.clover` and `com.waifucave.clover`. The bundled root plugin is `clover`, from `wyrm`, so its tools read `mcp__clover__…`, and the phases are C0–C7, from W0–W7, since other specs already use W-numbers (§2, §13).
75. **Answered:** no computer-use plugin ships in 1.111.1; computer use comes later as opensky. The core keeps holds, the user-working mark and `computers.control` for it (§4, §9.2).

**From the spikes and the first builds (revision 18)**

76. **Answered:** on Windows, Bash runs as a dedicated sandbox principal. `gh`, git credential helpers, Docker registry logins and ssh-agent signing reach it only through a Clover credential broker, which never hands over raw keys, as on Linux (§4, §9.1; S2).
77. **Answered:** "renders once" means one origin and process per shared plugin, one frame per place it appears, state held by the core, and each frame themed by its tab (§5.5; S9).
78. **Answered:** Cursor is accepted with its workspace folder and its deny rules as the boundary. Settings marks it "edits inside its folder without asking" (§9.3; S5).
79. **Answered:** n0's relays stay on by default and may see which devices are online, from which IP addresses and how much they send. QUIC address discovery (QAD) is on (§8.3; S1).
80. **Answered:** the dial policy is chosen per pair from a two-STUN check. Pairs whose two STUN answers match dial direct with a 0.5 s head start (and a second dial at 100 ms); the rest race the relay at once (§8.3; S1).
81. **Answered (the owner's own idea):** devices paired without an account save a pair credential at first pairing, and afterwards use waifucave's handshake service with it, with no account; n0's address lookup is the fallback. Lane H builds the client side and lane I the service. "No relay for coordination" and "relays only carry traffic that can't go direct" are reworded to match (§8.1, §8.3; S1).
82. **Answered:** the island is the same top-centre island on all three OSes, themed by tokens, with no fixed Apple blue. On screens without a notch it grows from the top edge (§4, §10).
83. **Answered:** the default shell is laid out like Claude's desktop app (its Code view): the left sidebar, the conversation with collapsed runs, the composer with model and level pills, panel toggles at the top right, a right panel holding the session view, terminal, diff, browser and files, each panel a replaceable plugin, and the settings modal and the language chooser. It uses Clover's own marks, with no Claude logo, mark or wording (§5.5, §12).
84. **Answered:** the bundled `clover` tree's host halves run in a plugin-host process of their own, and third-party host halves share the other one. The core decides which process from the install record. Only the `clover` process may use the waifucave token and `keys.open` (§3.1, §5.2, §5.4).
85. **Answered:** devices paired without an account get the same automatic hand-over of the main computer (the lease) as account devices, coordinated through waifucave's handshake service with the pair credential. This revises item 17 (§6.4, §8.1).
86. **Answered:** the default shell's look matches Claude's desktop app almost exactly: radii, spacing, colours, borders, states and type measured from the owner's screenshots; Clover's own icons (an open-licensed set), system fonts and wording; controls in the OS accent, and Clover's pink only in its mark; a translucent left sidebar (the macOS sidebar material, Windows acrylic, solid on Linux); a semi-translucent top bar with the transcript scrolling beneath it; the sidebar its own plugin; and two panels stacked (§5.5).
87. **Answered:** a bot's avatar is VRM or a Live2D Cubism model, rendered by the owner's clean-room runtime Mochi2D (`waifucave/Mochi2D`, MIT). Alpha's avatar becomes a Live2D model. The Live2D renderer has the VRM renderer's caps and lip-syncs from the speech feed only, and no one opens `waifucave/Lively2D-research`, the dirty room (§5.5, §6.2, §10).
88. **Answered:** other computers' folders are never mounted into a file system; there's no NFS, WinFsp or FUSE. Clover works on each folder through the computer that holds it, whose daemon serves the tree over the link behind its own fence. The Files panel exists only in code sessions, rooted at the session's folder, and bots have no file view. The speed-versus-freshness choice for the mount's cache is moot (§9.1; S6).
89. **Answered:** builds and git run on the computer that holds the files, and moves and copies between computers take a direct path (§9.1; S6 edits 7 and 8).
90. **Answered:** a bot's tab gets a slim column (agents and tasks, context, outputs) and the browser panel. The bot's running ACP agents show in the slim column, and clicking one opens it in the right panel as a code-session-style transcript, with its own composer and model picker but without the code panels or a slim column. Code sessions keep the full set: the session column, terminal, changes, files (rooted at the session's folder) and browser (§5.5, §9.3).
91. **Answered:** any desktop may answer another computer's card, as well as phones; browsers never. The owner accepted that a compromised plugin on a Windows or Linux computer could approve actions on the user's other computers. Desktops still sign with an app-held key where the OS can protect it (the macOS Keychain, Windows Hello or the TPM), and receivers always rebuild the card for the bound call and compare hashes (§5.5, §8.1, §10).
92. **Answered:** the bots' browser is design B: bot tabs render offscreen with no window and are shown through a viewport without reloading, as in Winter's headless helper. §3.1 and §12.1's [D] stay as written (§12.1; S7).
93. **Answered:** for screen-reader users, a hybrid: while a screen reader is on, new bot tabs start as real views in a hidden host window (design A, only then), so no tab ever reloads (§3.1, §12.1; S7).
94. **Answered ("stock Electron, wait upstream"):** Clover ships stock Electron with no patches. The browser patches S7 proposed (popups, dropdowns and dialogs) are dropped, and Electron #55565's same-site popup case works only while the person watches. The WebRTC escape S9 found stays a documented known gap: a plugin UI can still try to send WebRTC connectivity checks to an undeclared address. Plugin webContents get `Connection-Allowlist` and Chromium's `disable_non_proxied_udp` policy as defence in depth, which read zero on every vector with a positive control in S9's runs; the gap stays documented because the TCP route and the sandboxed srcdoc are unproven. S9's PAC belt and preload stub are off, and fixes go upstream instead. This replaces the [D] "WebRTC is off in plugin origins" (§5.3, §12.1; S7, S9; the stock measures as the controller ruled after E's final review).

Defaults written in as [P] from the same review, to change if the owner objects: how webhooks reach a device (§7), routine time zones (§7), late messages (§6.4), revocation and headless secrets (§8.1, §8.5), the no-account mode (§8.1), plugin sync (§8.5), the remote-client list (§10), unique tool names (§6.7), safe mode (§5.8), usage (§12), migration (§12) and the age wording (§5.7).

Defaults written in as [P] with revision 10: the routine file, its folder, live changes and moving (§7).

Defaults written in as [P] with revision 11, also to change if the owner objects: ids, child switches, no name dependencies, wrapper names and the `clover` plugin (§5.1), model plugins as `clover` children in the plugin host (§3.3), where each contribution runs and helpers started through Launch Services (§5.2), the core points and how data, web or code is decided (§5.3), how points are declared and how they wait (§5.4), the spot catalog, the three layers of a bot's tab, web pages, which entry shows and the 2-second fallback card (§5.5), when the app asks again (§5.6), the manifest (§5.9), one bot per plugin (§6.1), namespaces (§6.7), points in `Glossary` (§6.8), the details of `computer` and `saveTo` (§9.1), and cloud computer folders (§9.2).

Defaults written in as [P] with revision 12, from the final review, also to change if the owner objects: socket roles and the process-tree check, and the pair on Linux and servers (§3.1), logins kept in the core (§3.3), live changes and index updates (§5.1), hook order (§5.3), point names (§5.4), how layers work, which bots a part plugin applies to, sealed answers and card styling (§5.5), development folders and what the OK shows (§5.6), prompt rebuilds and the user layer (§6.1), the computer running a session and fencing the old main (§6.4), where memory lives (§6.5), Winter's other tools and web floors (§6.7), routine ids and raised levels (§7), transcript order, the refresher and conflicting edits (§8.5), the tree on disk, computer names, files, the levels and the fence (§9.1), holds (§9.2), stalled agents (§9.3), and how the browser works (§12.1).

Defaults written in as [P] with revision 13, from the second review, also to change if the owner objects: the caller check and the pair's details (§3.1), Linux packages (§4), wrapped configs' secrets (§5.1), keys kept out of adapters (§5.2), the base theme's place in the theme stack, the part an entry dresses, theme containment, real clicks on sealed cards, the 10-minute rule and the wider sensitive list (§5.5), development folders' notice and expiry (§5.6), the lease in an outage, the takeover order and sleep (§6.4), memory paths before the tree (§6.5), the Cloudflare relay (§8.3), settings sync (§8.5), the read fence (§9.1), the cloud image (§9.2), the bridge's token (§9.3), the migration's routines and memories (§12), and the hidden window, DevTools domains and partitions (§12.1).

Defaults written in as [P] with revision 14, from the plugin-ecosystem review, also to change if the owner objects: ids in paths, sign-ins for any plugin and the scope of `${secret:…}`, indexes and npm installs, formats, entry ids, plugin states, crashes and logs (§5.1), host start and `runsOn` (§5.2), the rule for a new core point, `bot.tab` as a core point, the data, web or code rule without point names, and what each hook event may return (§5.3), points declared anywhere, their schemas, formats and versions, and the plugin API with its capabilities (§5.4), the token catalog, the stage's `avatar` spot, add-on spots, how a spot hands over props, the CSS cleaner's allow list, a layer per child, `when.bot` ticks and card styling by capability (§5.5), manifest edits that change what runs, development folders on one computer and the plugin SDK (§5.6), listening from another voice provider (§6.6), tool names with dots (§6.7), `computers.control` (§9.2), keys out of adapters on every OS (§5.2), the app recording audio (§6.6), data folders in the fence (§9.1), hooks placed in Claude Code (§9.3) and the `shortcuts` and `tile` mapping (§12); and, with the owner's answers, how MCP Apps pages are bridged and how translations fall back (§5.5), how a Claude Code plugin is wrapped (§5.1), how style and hide entries stack (§5.5), and `confirm` with the rules for add-ons of a plugin's own (§5.4).

Defaults written in as [P] with revision 15, from the check of revision 14, also to change if the owner objects: how a Claude Code plugin folder is found and wrapped, the tree hash, archives and signatures (§5.1), `chosen` computers (§5.2), declared hosts enforced by CSP and the handler contracts (§5.3), schemas that arrive later, `call:` and children, the keyed fetch, settings, the caller, `confirm`'s card and add-ons approved by hash (§5.4), keyed defaults and `*` keys, how style entries apply, `needs` and `keep`, sends counted as the user's, card placement, the MCP Apps bridge and string formats (§5.5), changed setting defaults and development folders that hold a bot (§5.6), and hooks placed in Claude Code through a shim (§9.3).

Defaults written in as [P] with revision 16, from the last check, also to change if the owner objects: DNS prefetching and speculative hints off in plugin origins (§5.3), a plugin's own settings changed directly (§5.4, §5.5), and sends counted as the user's through transient user activation (§5.5).

Defaults written in as [P] with revision 18, from the spikes, the first builds and the controller's rulings, also to change if the owner objects: Bun 1.4, the caller check's principal and provenance, and `clover-core supervise` on Windows (§3.1); the Linux Secret Service broker (§4); `Connection-Allowlist` and the UDP policy on plugin webContents, with S9's belt and stub off (§5.3); the OK naming other computers' cards on Windows and Linux, and the WebRTC exception in the OK (§5.1, §5.2, §5.6); the keyed fetch's fixed placements, and the account token and per-computer keys for bundled plugins (§5.4, §5.9); token names in CSS, core-issued mounts, and input and state across layers (§5.5); the account-less group lease (§6.4); the tag in webhook URLs, sealing to every computer in the Durable Object, and reported drops (§7); what the handshake carries, the account-less handshake's rules, the transport, the `clover-link` sidecar, re-dials, stream windows and congestion control (§8.3); the browser's direct path in the web companion (§8.4); the tree served by the holder, its root, computer names, the offline bound, the levels' order, network denial and the escape floor, nothing carrying over, the holder's fence and links (§9.1); the bridge token's rules, the bridge's essentials in the prompt, process groups, replays, refusals, Clover's own permission answers, the bridge's auto-allow, protected backends, verified binaries, model and effort over ACP, Devin's cloud, and Cursor's read-only mode (§9.3); and the offscreen tab's drawing, screenshots, showing, a page's windows and raises, the screen-reader host, the streamed video and the pinned headless shell (§12.1). The controller's later rulings add, as [P]: a plugin's calls acting as the tool call's session (§5.4, R7), Clover's own surfaces in the overlap check and always-on-top for the `clover` tree only (§5.5, §10, R12), the holder's reviewer on other computers' calls (§9.1, R1), and the person's partition behind a card, private addresses refused and the proxy setting (§12.1, R10, R13, R14).
