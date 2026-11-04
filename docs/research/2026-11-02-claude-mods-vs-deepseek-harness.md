# Claude mods vs DeepSeek Harness plugins: stacks and extension capabilities

Research date: November 2, 2026
Claude desktop app inspected: `/Applications/Claude.app` v4.29.0 (local install)
Claude Code docs read: mods overview and mods reference on code.claude.com (reference covers CLI/Desktop as of v2.1.290, VS Code as of v2.1.299); changelog through v2.1.316 (October 31, 2026)
DeepSeek Harness audited commit: `ce7073d51254c26cd63b22a60835b8f948deb447` (October 30, 2026), workspace version `0.2.2-alpha.2`
Process-model pass: November 2, 2026 — running processes and app bundles inspected on this Mac for `/Applications/Claude.app` v4.29.0 and `/Applications/ChatGPT.app` v26.1027.61615; DeepSeek Harness desktop source read at the same commit
Status: research only — no Winter code was changed, and this report makes no recommendation for Winter

This report answers three questions:

1. What the Claude desktop app and DeepSeek Harness are built with.
2. What Anthropic's new UI-capable plugins ("mods") and DeepSeek Harness's plugins, including Creator mode, can each do.
3. How the two extension models compare.
4. Which of the Claude, ChatGPT and DeepSeek Harness apps run a daemon, and how daemons written in Rust, Node and Bun differ.

---

## 1. Summary

* **Both desktop apps are Electron, and both cores are TypeScript.** Neither is native.
* **Claude mods** extend a closed product through a fixed, documented set of hooks and an API object. Their interface is a declarative element tree, so one mod draws in the terminal, the Desktop app's Code tab and VS Code. Organizations get strong controls over them.
* **DeepSeek Harness plugins** are the application itself: models, tools, sessions, storage, the sandbox, the agent loop and the UI are all Cordis plugins. A plugin can replace core pieces and draw any React UI. In exchange, plugins draw only in the web and desktop clients, organizational controls are weaker, and the API is an unstable developer preview.
* **Claude asks for less trust, DeepSeek gives more power.** Claude mods are auditable before install and run inside a product that keeps the permission prompt out of their reach. DeepSeek plugins can do almost anything, including rewriting the loop or shipping a floating always-on-top widget.
* **Only Codex runs a true daemon, and it is Rust.** The Claude app and DeepSeek Harness run their agents as child processes that end when the app quits. The ChatGPT app (the Codex app renamed) does the same, but the Codex CLI separately leaves a self-updating Rust daemon running. Claude Code is the only Bun piece in the three; DeepSeek and Codex use Node wherever they run JavaScript.

---

## 2. What each is built on

### 2.1 Claude desktop app

Checked directly on the local install (`/Applications/Claude.app`, v4.29.0):

* `Contents/Frameworks/` holds `Electron Framework.framework`, the four Electron helper apps (`Claude Helper`, `(GPU)`, `(Renderer)`, `(Plugin)`), and `Squirrel.framework` with its dependencies `Mantle.framework` and `ReactiveObjC.framework`. Squirrel is Electron's macOS updater.
* `Contents/Resources/` holds `app.asar`, `app.asar.unpacked` and `ion-dist.asar`, the packed web app.

Anthropic has not published a statement on the choice. Commentary attributes it to cross-platform reach and fast iteration, and John Gruber has argued it follows from Felix Rieseberg — Anthropic's engineering lead for Claude Cowork and Claude Code Desktop and an Electron co-maintainer — leading the app. That attribution is commentary, not confirmed.

Claude Code, the agent behind the CLI and bundled into the Desktop app's Code tab, is TypeScript with a React-based terminal UI. The Code tab ships its own copy of Claude Code; mods work there from v2.1.286.

### 2.2 DeepSeek Harness (`dsh`)

Checked from the source at the audited commit:

| Fact | Evidence |
| :- | :- |
| Language | GitHub reports about 69.1 MB of TypeScript out of about 73 MB of code. The remainder is CSS (0.97 MB), Python (0.95 MB: `python/sdk`, `python/sdk-runtime`, and the experimental macOS computer-use package), JavaScript (0.53 MB), Swift (0.34 MB, only in `packages/experimental/cua-macos/native`), and small amounts of PowerShell, C++, NSIS, C and C#. |
| Runtime and tooling | Node `>=24.9.0`, pnpm `11.28.5` workspaces, tsdown bundling, oxlint |
| Web client | React 18 and Vite. `react@^18.2.0` appears in 82 workspace manifests. |
| Desktop | `apps/desktop` (`@deepseek-ai/dsh-desktop`) describes itself as an "Electron desktop shell for a bundled dsh runtime and external plugins". It uses electron-builder and electron-updater, with package targets `mac-arm64`, `mac-x64` and `win-x64`. `apps/desktop-host` is a "Private Node-mode host process for the Electron desktop application". |
| Core framework | Cordis, vendored as `@deepseek-ai/cordis`. It came from the Koishi chatbot ecosystem, was created by Shigma, and is described in the arXiv paper *A Programming Paradigm for Spatiotemporal Composability*. |
| Other entry points | `apps/cli`, `apps/web` (`npx @deepseek-ai/dsh web` serves the UI on `127.0.0.1:3080`), runtime profiles `web`, `headless`, `sdk`, `sdk-minimal` and `acp`, and TypeScript and Python SDKs |
| Size | 636 top-level package directories and 381 `package.json` files under `packages/` |
| Licence and status | MIT. The README says "developer preview … THERE WILL BE COMPATIBILITY-BREAKING CHANGES." The repo was created August 13, 2026 and had 269,298 stars when checked. |

---

## 3. Claude mods

### 3.1 What a mod is

A mod is a Claude Code plugin whose code registers event handlers ("hooks") that run **inside the Claude Code process**. The files are:

```text
my-mod/
├── .claude-plugin/plugin.json   # ordinary plugin manifest
└── hooks/
    ├── hooks.json               # "modules": ["./register.js"]
    └── register.js              # ES module exporting register(on, options)
```

The hooks module may be `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` or `.tsx`. Each hook is middleware: `on(event, [matcher], async ($, e, next) => …)`. A hook can **observe** the event and call `next(e)`, **rewrite** it and call `next({...e, …})`, or **answer** it by returning a result without calling `next`. Hooks on `turn.step` and `process.spawn` are async generators.

Mods are on by default from Claude Code v2.1.287 in the terminal and v2.1.286 in the Desktop app. Anthropic publishes sample mods (`token-weather`, `blast-radius`, `replay-theater`) in `anthropics/claude-code-playground`. Some of Claude Code's own features are now built-in mods, such as `/diff` and AGENTS.md loading, with source in `anthropics/claude-code/mods`.

### 3.2 Events a mod can handle

| Group | Events |
| :- | :- |
| Tools | `tool.call` (pass, `{deny}` or a substitute `{result}`), `tool.check` (allow/ask/deny after rules, mode and `PreToolUse`; `decider: "person"` from v2.1.304), `tool.describe` (rewrite descriptions, defer behind tool search) |
| Prompts | `prompt.submit`, `prompt.fill`, `prompt.suggest`, `prompt.edit`, `prompt.autocomplete`, `prompt.compose` (the whole system prompt as sections), `prompt.section`, `prompt.context`, `prompt.attachment` (rewrite or remove reminders), `prompt.mention`, `skill.prompt`, `attribution.text` |
| Commands and configuration | `command.run`, `command.describe`, `config.set`, `config.describe`, `settings.read` (each settings layer, can rewrite the merge) |
| Turns | `turn.start`, `turn.step` (change `model` or `effort` per request), `turn.complete` |
| Session | `session.start`, `session.end`, `session.compact` (can skip compaction), `session.send`, `session.receive` (cross-session messages), `session.append` (rewrite stored rows), `session.attach`, `session.detach`, `session.measure` |
| Subagents | `agent.offer` (withhold a subagent type), `agent.spawn` (pick its model or deny it) |
| Interface | `ui.render`, `ui.resolve`, `ui.press`, `ui.input`, `ui.select`, `ui.focus`, `ui.scroll`, `ui.close`, `ui.message`, `ui.fault` |
| Other mods | `plugin.register` (refuse another mod), `engine.create` (add a namespace to the mods API) |
| Other | `telemetry.log`, `telemetry.mark`, `classic.<Event>` (every settings-hook event), and every mods API method, interceptable by name |

### 3.3 The mods API (`$`)

`$.plugin`, `$.ui` (`open`, `close`, `invalidate`, `toast`, `notify`, `status`, `ask`, `copy`, `blit`…), `$.command`, `$.tool` (register tools Claude can call), `$.agent` (`register`, `spawn`, `list`), `$.model` (`complete`, `fork`, `classify`), `$.prompt` (`submit`, optionally `asUser`), `$.turn.abort`, `$.session` (messages, usage and rate limits, `send` to other sessions, `compact`…), `$.config`, `$.settings`, `$.env`, `$.fs`, `$.store` (a 4 MiB key-value store shared by every session on the machine), `$.state` (reactive state), `$.clock`, `$.http.fetch`, `$.process` (`run`, `spawn`), `$.mcp` (`call`, `connect`), `$.audio` (`play`, `speak`), and `$.telemetry`.

The mods API is a mod's only route to I/O, which is why `claude plugin validate` can list a mod's events and calls without running it.

### 3.4 Interface

**Where a mod can draw:** a `Pane` docked beside the transcript or inline above the prompt, and the `AbovePrompt` band. A mod can also redraw Claude Code's own parts: `UserMessage`, `AssistantMessage`, `ToolUse`, `ToolResult`, `ToolGroup`, `CommandOutput`, `AskUserQuestion`, `Spinner`, `SessionMode` and `PromptHint`. The terminal adds `ToolProgress`, `TurnDuration` and `InfoNotice`.

**Elements and which apps draw them:**

| Element | Terminal | Desktop | VS Code |
| :- | :-: | :-: | :-: |
| `Box`, `Text`, `Button`, `Link`, `Code`, `Markdown`, `Input`, `Select` | ✓ | ✓ | ✓ |
| `Svg` (up to 131,072 characters) | | ✓ | ✓ |
| `Client` (a custom module) | ✓ | ✓ | |
| `Raster` (up to 512×256 cells), `Image` (up to 2 MiB) | ✓ | | |

**Where mods run:** hooks run in the CLI, the Desktop app's Code tab, VS Code, `claude -p`, the Agent SDK and cloud sessions. Drawing happens only in the terminal, the Desktop app and VS Code. Mods do not draw in the claude.ai chat, and plugins aren't available in Desktop WSL sessions.

**Limits** (selected): 10 s per hook (50 ms for `prompt.edit`), 30 s default for `$.process.run` (10 min at most), 4 MiB file reads and writes and HTTP bodies, 20,000 elements and 32 levels of nesting per tree, and redraws throttled to 10/s (30/s for the visible terminal pane).

### 3.5 Authoring by Claude

The built-in `plugin-authoring` skill lets you describe a mod in a session and Claude writes it. Mods Claude writes need a plain-text question to turn them on (v2.1.304). `claude --plugin-dir` reloads the mod when its file is saved, `claude plugin validate` checks it, and `claude plugin test` runs `*.test.ts` files without a session.

### 3.6 Trust and control

* **Not sandboxed.** A mod runs with your permissions: files, processes, network, secrets, every prompt and tool call. It can approve tool calls and spend your usage. A process a mod starts runs outside Claude Code's Bash sandbox.
* **Some limits on what a mod can override.** A mod cannot restyle the permission prompt. With managed settings or a Team or Enterprise login, a mod's approval does not get past `ask` rules or `PreToolUse` hooks by default.
* **Organization controls:** `allowManagedModsOnly`, `allowManagedHooksOnly`, `prependPlugins` and `appendPlugins` (load order), `allowModsToOverrideDenyRules`, `disableSideloadFlags`, and the built-in `sec-default` guard mod.
* **Turning mods off:** `disableAllHooks`, `--safe-mode`, or disabling the plugin in `/plugin`.
* **Distribution:** plugin marketplaces (`/plugin install name@marketplace`) and Anthropic's official directory.

---

## 4. DeepSeek Harness plugins and Creator mode

### 4.1 Everything is a plugin

A plugin is a Cordis module with `name`, `inject` (the services it needs) and `apply(ctx)`. It activates when its injected services exist and deactivates when they disappear. Disposing a plugin removes everything it registered — listeners, prompt sections, tool schemas — but does not undo external side effects such as shell commands it ran.

The things a plugin can supply or replace are model adapters (DeepSeek, Anthropic, OpenAI, OpenAI-compatible, local), tools, sessions (an append-only typed event log with resume, fork, search, replay and a trajectory view), storage, the sandbox (landlock or `sandbox-exec` through `ctx.sandbox`), scheduling, compaction, the system prompt, the agent loop, and the UI. A preset can be changed with a Loader YAML patch, with no edits to Harness source.

**Agent hooks** are interception points on `ctx`:

* Tools: `tools/pre-execute` (the policy layer), `tools/execute` (wraps dispatch), `tools/post-execute`, `tools/result`, and `ctx.tools.guard()` for a final denial that cannot be overturned.
* Turns and prompts: `agent/pre-step`, `agent/turn-stopping`, `system-prompt/assemble`.
* Streams: `session/event` and `agent/assistant-stream`.

Bridge plugins (`dsh-hooks-claude-code`, `dsh-hooks-codex`) map existing Claude Code and Codex hook config files onto these points.

### 4.2 UI plugins

UI plugins are ordinary React components loaded into the web client or Electron renderer:

* **Named UI regions:** `ui-slots` lets plugins declare and fill typed regions of four kinds — `single`, `list`, `keyed` and `chain` — and reusable Component Factories, with store seats and props supplied by the framework.
* **Panels:** `ui-dockkit` gives a split tree of tabbed panes with drag, split, undo/redo and floating panels.
* **Other surfaces:** packages under `packages/client/ui-*` show the other surfaces plugins fill, including conversation-row renderers, sidebar tabs (files, terminal, browser, document preview), settings cards, the plugin manager and plugin market, the trajectory view, and approvals.
* **Freedom:** because the UI is real DOM and React, a plugin can draw anything a web page can. DeepSeek's demo is a floating, always-on-top Pomodoro timer.

### 4.3 Creator mode

Creator is one of the agent presets, alongside Standard, PTC (formerly "Code mode") and Minimal. Per the design note `.agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.md` and `docs/user/develop/practice/dynamic-cordis.md`:

* **Tools:** Creator mode enables the `plugin_manager` tool plus two read-only Cordis runtime-inspection tools.
* **Building a plugin:** the agent writes a package and a Loader YAML patch as workspace files, then installs them with `plugin_manager install_bundle`. An MCP connection is a configuration-only bundle. A UI bundle has a Host entry and a Client artifact. Visual requests default to a Client plugin rendered in the current web page.
* **Activation:** with hot module replacement (HMR), new bundles activate in the running session. Replacing an installed package needs a restart.
* **Lifetime:** installed bundles belong to the profile, affect all of its sessions, and survive restarts.
* **Permission gate:** the tool needs a `danger-full-access` session or approval for each call, because "profile changes can load code with host permissions and affect other sessions".
* **Standard mode** has had the same tool and gate since September 16. PTC and Minimal keep it off.
* Creator mode is also used to author new presets (agent modes).

### 4.4 Distribution and trust

* **Sources:** plugins install from npm or git. The experimental **Custom plugin indexes** bundle adds a Discover tab that reads JSON index files you host. DeepSeek ships no index of its own, and installs need a confirmation that shows the source. Plugin authors are asked to tag repos with the GitHub topic `dsh-plugin`.
* **Trust:** `SAFETY.md` warns that untrusted plugins may damage the host, delete files or leak credentials. Plugins run with host permissions, and the project has had no security audit.

---

## 5. Side-by-side comparison

| | Claude mods | DeepSeek Harness plugins |
| :- | :- | :- |
| Architecture | Closed core with fixed places to hook in. Hook and restyle; the loop, model plumbing and storage stay Anthropic's. | Open microkernel. Plugins can replace the model adapter, loop, storage, sandbox and UI. |
| Language | JavaScript/TypeScript ES module | TypeScript Cordis plugin (host side in Node, client side in React) |
| UI model | Declarative element tree from a fixed set of elements, drawn by each app | Arbitrary React and DOM, typed UI regions, dockable and floating panels |
| UI placement | Pane beside the transcript or inline, band above the prompt, redrawing Claude's own parts, toasts and notifications | Any declared region, sidebar tabs, settings cards, conversation rows, floating panels |
| Where the UI draws | Terminal, Desktop Code tab, VS Code — one mod draws in all three | Web UI and Electron desktop only; nothing in a terminal |
| Agent hooks | Tool calls, prompts and the system prompt, per-request model and effort, sessions, subagents, settings, other mods | Tool calls before, during and after, steps, end of turn, system-prompt assembly, live stream; bridges that read Claude Code and Codex hook configs |
| Capabilities given to plugin code | A single `$` API object with time and size limits on every call | Any service the app offers on `ctx` (`ctx.tools`, `ctx.llm`, `ctx.sessions`…) plus all of Node |
| AI-authored plugins | `plugin-authoring` skill, reload on save, a question before turning it on | Creator mode builds, installs, hot-loads and checks the plugin in the open page |
| Live reload | `--plugin-dir` reloads on save; `/reload-plugins` | HMR into the running session; package replacement needs a restart |
| Static audit | `claude plugin validate` lists events and calls without running the mod | None equivalent |
| Sandbox | None for the mod itself | None for the plugin itself |
| Organization controls | Managed-only mods, load order, deny-rule ceiling, built-in guard mod | Profile-level only; human confirmation on installs from an index |
| Distribution | Plugin marketplaces and Anthropic's official directory | npm, git, self-hosted JSON indexes (experimental) |
| Source | Core closed; mod types and built-in mods public | Fully open source (MIT) and forkable |
| Maturity | Shipping product with a large, documented API | Developer preview with breaking changes promised |

**Verdict.** Use Claude mods to extend a stable tool you already run, especially for interface work that has to work in a terminal and a GUI, or anywhere an organization needs governance. DeepSeek Harness is the better base when you want to own the agent itself: swap models or the loop, or build rich custom GUI features. You take on preview-grade APIs and weaker controls in exchange.

---

## 6. Related: MCP Apps on claude.ai

MCP Apps launched January 26, 2026. They are a separate, earlier feature and not the same as mods. An MCP server can return an interactive UI that claude.ai shows inside the conversation, in a sandboxed iframe with restricted permissions, on web and desktop and later on mobile. Launch partners included Asana, Slack, Figma and Box. MCP Apps display a tool's output within the chat; they cannot change Claude's own interface or behaviour, which is what mods do.

---

## 7. Background processes and daemons

Here a **daemon** means a process that keeps running after its app or terminal is gone, with no window, and serves clients over a socket. It is usually supervised by launchd, systemd or its own watchdog. A **child process** that the app starts and stops is not a daemon, even if it is long-lived.

### 7.1 Summary

| | Daemon after you quit? | Where the agent runs | Bun? |
| :- | :- | :- | :- |
| Claude app | No | One Claude Code process per Code session, a child of the app | Yes: Claude Code is a Bun v1.4.4 single-file executable |
| ChatGPT app | Yes, but it belongs to the Codex CLI, not the app | A Rust `codex app-server`, a child of the app | No: Rust, plus Node for JavaScript |
| DeepSeek Harness | No | One Node "Host" process, a child of the app | No: Node, through Electron's Node mode |

### 7.2 Claude app (observed on this Mac)

* **Registered with launchd:** only `com.anthropic.claudefordesktop.ShipIt`, the Squirrel updater job. There is no LaunchAgent or LaunchDaemon.
* **The agent:** each Code session is a separate Claude Code process at `~/Library/Application Support/Claude/claude-code/2.1.309/<hash>/claude.app/Contents/MacOS/claude`. Two were running, at 666 MB and 236 MB resident. The app drives each one over stdin/stdout with `--input-format stream-json --output-format stream-json --permission-prompt-tool=stdio`.
* **Runtime:** that binary is 263 MB, carries a `__bun` section and reports `Bun v1.4.4`. It is a `bun build --compile` executable.
* **Launch wrapper:** each session is started through `Contents/Helpers/disclaimer`, a 72 KB wrapper. The name suggests it disclaims macOS privacy (TCC) responsibility so the child gets its own permission identity; this is inferred, not documented.
* **Other helpers:** `Contents/Helpers/` also holds `app-cu-helper` (computer use, a Rust binary), `chrome-native-host`, `claude-ssh-askpass`, `permission-fixer` and `Claude iOS Sim.app`. Installed desktop extensions run as children too (here a Python MCP server).
* **Lifetime:** every agent and helper is a child of the Claude app's main process and ends with it.

### 7.3 ChatGPT app (observed on this Mac)

* **Identity:** `/Applications/ChatGPT.app` has bundle id `com.openai.codex`, version 26.1027.61615. It is the Codex desktop app under the ChatGPT name.
* **Shell:** Electron with the framework renamed `Codex Framework.framework` (Chromium 156.0.8078.79; it contains Electron's `asar-fs-wrapper` and `___electron_webpack_init__`), `app.asar`, and Sparkle for updates.
* **Children of the app:**
  * `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex … app-server` — the agent server, a 271 MB Rust binary started without `--listen`, so over stdio
  * `codex … exec-server --remote https://codex-cloud-environments.chatgpt.com/api` — for cloud environments
  * `codex-code-mode-host` — a 66 MB Rust binary with V8 built in, for code mode
  * a bundled Node 24.22.1 (`Contents/Resources/cua_node`, runtime archive `cua-node-0.0.35`) for computer use, and another Node runtime under `~/Library/Application Support/Codex/artifact-sessions/` for artifacts
  * `SkyComputerUseService` from `~/.codex/computer-use/`, and `bare-modifier-monitor` among the native helpers
* **The daemon:** separate from the app, the Codex CLI keeps a managed app-server daemon under `~/.codex/packages/app-server-daemon/`:
  * **Supervisor:** `codex app-server daemon pid-update-loop` — parent PID 1, running 8 days 22 hours, 10 MB resident, 18 threads, 30 s of CPU in total
  * **Server:** `codex app-server --listen unix://` — a child of the supervisor, 48 MB resident, 22 threads, 2 min 20 s of CPU in 3 days 20 hours
  * **Not a launchd job:** it is a detached process with its own supervisor, not a LaunchAgent.
  * **Self-updating:** `releases/` holds 0.165.0 and 0.166.0, `current` was switched on October 29, and `auto-update-version` was written today. Third-party write-ups say the updater checks five minutes after start, then hourly.
  * **Origin:** per third-party write-ups, interactive `codex` CLI sessions have started it by default since Codex CLI 0.157.0 (September 25, 2026). The `install.lock` here is dated September 26.
  * **Turning it off:** `codex features disable daemon_auto_start`, then `codex app-server daemon stop`. Reports say `stop` leaves the updater running, which then needs `pkill -f 'app-server daemon pid-update-loop'`.
* **Bun:** none. Every `codex` binary is Rust, and no file in the bundle is named for Bun.

### 7.4 DeepSeek Harness (from source)

* **The Host:** `apps/desktop/src/host-process.ts` spawns one child — the Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`) running `@deepseek-ai/dsh-desktop-host` — with stdio pipes and an IPC channel.
* **How the window gets its UI:** the Host runs the `desktop` profile with `--host 127.0.0.1 --port 0`, serving the dsh web app on a random loopback port, and the window loads that page.
* **Closing vs quitting:** closing the window only hides it, and "the page and the Host keep running" (Windows keeps a tray icon). Quitting asks the Host what would be interrupted, closes it, then exits; the app warns "Scheduled tasks will not run while the app is closed."
* **No daemon:** the only LaunchAgent in the repo is `apps/desktop/scripts/macos-runner-service.sh`, for CI build machines. `dsh web` from the command line is a foreground server.

### 7.5 Rust, Node and Bun daemons compared

| | Rust | Node | Bun |
| :- | :- | :- | :- |
| What runs | Native machine code compiled ahead of time; no language runtime | JavaScript/TypeScript on V8 (Chrome's engine) with the libuv event loop | JavaScript/TypeScript on JavaScriptCore (Safari's engine), in a runtime written in Zig |
| Memory | Freed as soon as it is unused (ownership); no garbage collector, so usage stays flat | Garbage-collected; the heap grows, then collects; many tuning flags (`--max-old-space-size`…) | Garbage-collected by JavaScriptCore; fewer knobs (`--smol` trades speed for memory) |
| Typical idle footprint | A few MB to tens of MB — here, 10 MB + 48 MB for Codex's daemon | Roughly 30–60 MB before your own code loads | Often similar to or a little below Node; varies by workload |
| Startup | Milliseconds | Tens of milliseconds or more, plus module loading | Usually faster than Node |
| Shipping | One native binary per platform | Needs Node installed, a bundled Node (Codex and DeepSeek ship their own) or a single executable application | `bun build --compile` makes one executable with Bun inside (Claude Code's is 263 MB) |
| Concurrency | Real threads plus async (for example tokio); uses every core in one process | One JavaScript thread and an event loop; `worker_threads` for more | Same model as Node: one JavaScript thread plus Workers |
| Failure modes | Memory-safety bugs ruled out at compile time; a panic can still end the process | An unhandled exception or rejection ends the process unless caught; leaks through retained references | Same as Node, plus a younger runtime: more runtime bugs and gaps in Node compatibility |
| Idle CPU wake-ups | Can sleep completely when there is no work | Garbage collection and event-loop housekeeping wake the CPU; needs care in an always-on process | Same concern as Node |
| Long-run diagnosis | Native profilers (Instruments, perf) | The most mature: inspector, heap snapshots, many APM tools | Fewer tools; WebKit-inspector based |
| Speed of building it | Slowest to write; long compiles | Fast; the largest package ecosystem | Fast; runs TypeScript directly, with SQLite, a test runner, sockets and Keychain access (`Bun.secrets`) built in |
| Used here by | Codex app-server and its daemon, Claude's `app-cu-helper` | DeepSeek's Host, Codex's computer-use and artifact runtimes, every Electron main process | Claude Code; Winter's `winter-core` |

**In practice:**

* **Rust** suits a process that must stay up for weeks, start instantly and cost little when idle, which is why Codex's always-on daemon is Rust.
* **Node** suits teams that want the most proven runtime and tooling for a JavaScript server and can afford some memory.
* **Bun** suits a TypeScript codebase that wants fast startup, a single-file binary and batteries included, at the cost of a younger runtime that needs watching. Winter guards this with its `check:idle-wakeups` gate.

---

## 8. Caveats

* The Claude desktop app's framework is confirmed from the local bundle, not from an Anthropic statement.
* The process observations in §7.2–7.3 are one snapshot of this Mac. The Claude Code memory figures belong to active sessions holding conversations, not to an idle daemon, so they do not compare directly with the idle Codex daemon.
* Who started the Codex daemon here was not traced. The attribution to the Codex CLI comes from third-party write-ups and the install date, not from OpenAI documentation.
* The idle-footprint and startup figures in §7.5 are typical ranges, not measurements, except where a number from this Mac is given.
* The mods reference pins its tables to Claude Code v2.1.290 (CLI and Desktop) and v2.1.299 (VS Code). The changelog shows active changes through v2.1.316, so details move quickly.
* The DeepSeek Harness findings come from one commit of a developer-preview repo and will drift.
* DeepSeek's release history and any official launch date were not established. Secondary sources mention a "2.0 desktop app", which the audited source (version `0.2.2-alpha.2`) does not match.
* No DeepSeek Harness code was run. Its install was not tested, and no mod was written or loaded for this report.

---

## Sources

* Claude Code docs: [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview.md), [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference.md), [Changelog](https://code.claude.com/docs/en/changelog), [Docs index](https://code.claude.com/docs/llms.txt)
* Claude desktop app commentary: [Why is Claude an Electron App? (dbreunig)](https://dbreunig.com/2026/02/21/why-is-claude-an-electron-app.html), [WebProNews](https://www.webpronews.com/why-anthropic-chose-electron-for-claudes-desktop-app-and-what-it-reveals-about-the-future-of-ai-interfaces/), [Manual do Usuário](https://manualdousuario.net/en/claude-ia-electron/)
* MCP Apps: [Interactive connectors and MCP Apps (claude.com)](https://claude.com/resources/articles/interactive-tools-in-claude), [TechCrunch](https://www.techcrunch.com/2026/01/26/anthropic-launches-interactive-claude-apps-including-slack-and-other-workplace-tools/), [The New Stack](https://thenewstack.io/anthropic-extends-mcp-with-an-app-framework/)
* Mods coverage: [Tech Insider](https://tech-insider.org/claude-code-plugins-official-mods-cloud-sessions-2026/)
* DeepSeek Harness: [Official page](https://www.deepseek.com/en/harness/), [GitHub repository](https://github.com/deepseek-ai/deepseek-harness) (audited at `ce7073d5`), [DataCamp explainer](https://www.datacamp.com/blog/what-is-deepseek-harness), [MindStudio desktop guide](https://www.mindstudio.ai/blog/deepseek-harness-2-desktop-app), [SitePoint install guide](https://www.sitepoint.com/deepseek-harness-developer-preview/)
* Cordis: [cordiverse/cordis](https://github.com/cordiverse/cordis)
* Codex daemon: [openai/codex PR #20718 (daemon lifecycle commands)](https://github.com/openai/codex/pull/20718), [openai/codex PR #21853 (updater self-refresh)](https://github.com/openai/codex/pull/21853), [Developers Digest](https://www.developersdigest.tech/blog/codex-cli-background-daemon-auto-start-disable-2026), [Ecosistema Startup](https://ecosistemastartup.com/codex-cli-activa-un-daemon-de-374-mb-por-defecto/), [WikiDocs (Korean)](https://wikidocs.net/blog/@jaehong/33315/)
* DeepSeek Harness desktop process model: `apps/desktop/src/host-process.ts`, `apps/desktop/src/main.ts`, `apps/desktop/README.md` and `apps/desktop-host/src/index.ts` at `ce7073d5`
