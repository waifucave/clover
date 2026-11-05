# Wyrmhole plugin model: proposals and recommendation

Date: November 3, 2026
Status: **proposals for the owner's choice** — written by an independent Opus design review of `docs/wyrmhole-spec.md` (revision 10), the DeepSeek Harness source and the prior research. Nothing here is decided until it is written into the spec.
**Outcome (November 3):** The owner chose C, with three changes: bots may carry code and style only their own tab (outside the tab is another plugin, which can be a child); a bot's plugin can style the approval card in its tab; and MCP servers follow his placement design (local servers per computer with Mirror and a `computer` field, remote servers from anywhere with `saveTo`). The spec's revision 11 has the result (§5, §9.1, §14.2 items 47–50) and wins wherever this note differs.
Companion: [Wyrmhole direction spec](../clover-spec.md), [Claude mods vs DeepSeek Harness plugins](2026-11-02-claude-mods-vs-deepseek-harness.md)

**Bottom line:** drop both kinds and packages, so the model has four concepts:

- **Plugin:** a folder whose `wyrmhole.json` lists its contributions.
- **Contribution:** something the plugin adds at an extension point.
- **Extension point:** a named place to plug into. The core owns a fixed set; any contribution can declare more.
- **Child plugin:** a plugin inside a parent's `plugins/` folder. Children replace packages.

Whether a plugin is data, web or code is worked out from its manifest, never declared. Bot tabs get declarative layouts, so bots stay data-only. Code UI for a bot comes from a separate plugin that can target that bot. Everything we ship becomes children of one reserved root, `wyrm`, and that is where `mcp__wyrm__…` comes from.

---

## 1. DeepSeek Harness findings

**What I read:** `deepseek-ai/deepseek-harness` at `8bd07339` (November 3, 2026, version `0.2.2-alpha.3`). That is 503 commits after our audit commit `ce7073d5`; the plugin docs changed only in wording since then. Cordis is vendored from upstream `cordiverse/cordis` at `0b96d9fd` (4.0.0-rc.11).

**How a plugin is defined**
- **A plugin is a JS module, not a folder.** It exports `name`, `inject` (the services it waits for), an optional `Config` (a Schemastery schema) and `apply(ctx, config)`. It can also be an object, or a `Service` subclass that publishes `ctx.<name>` (`docs/user/develop/basic/index.md`, `docs/user/develop/framework/service.md`).
- **Everything a plugin registers is undone when it unloads.** Each plugin runs in a fiber: PENDING → LOADING → ACTIVE or FAILED → UNLOADING → DISPOSED. `ctx.plugin(child)` starts a child fiber that unloads with its parent (`docs/user/develop/framework/index.md`).
- **There is no plugin manifest.** `package.json` carries a `dsh` key with these fields (`packages/util/package-manifest/src/types.ts`):
  - `bundle.patch` and `profile.bundles`
  - `client`, with `platform`, `inject`, `immediately` and `external`
  - `manifestVersion`, plus top-level `engines.dsh` and `icon`

  Display titles come from exported `locale/*.json` files.
- **A roster decides what runs.** It is a list of YAML rows (`id`, `name`, `config`, `disabled`, `inject`, `isolate`, `group`) composed in layers: bundles in order, then the profile patch, then the home patch, then `--patch`. A patch inserts rows or overrides them by id, replacing `config` wholesale, and `!!js` expressions are evaluated at mount (`docs/user/develop/basic/publish.md`, `packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md`). Their stated reason: "which plugins compose into a deployment is a composition decision, not a package property" (`.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md`).
- **DSH has the same two units our spec has.** A *bundle* is an npm package that ships a patch. It holds *plugins*, which are modules; one package can hold several at subpaths (`…/cordis-plugin-development/references/host-plugin.md`).

**How UI plugins attach to slots** (`docs/subsystems/slots.md`, `.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md`, and the generated catalog `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`)
- **Registering:** a plugin calls `ctx.slots.register({name, id|key, order, priority, select, children, store, inject}, Component)`. `ctx.slots.inject(key, cb)` waits until the slot is declared.
- **A slot exists only while the component that renders it is mounted.** A registration's `children` both declare the child slots and give that component alone the right to render them. `root` is the only built-in slot, and registering into an undeclared slot fails at load.
- **Slot shapes:**
  - `single`: the entry with the lowest priority number renders.
  - `list`: entries carry an id and an order.
  - `keyed`: the owner picks the entry by key.
  - `chain`: each entry has a pure `select()` function; the first match renders.

  There are three scopes (root, session, session-maybe). About 110 slots ship: 43 single, 44 list, 20 keyed and 4 chain.
- **Replacing one part works.** A plugin registers into a `single` slot or an occupied keyed cell with a lower priority number and shadows the shipped component. Examples: `conversation.composer.bar`, which `InputBar` occupies, and the `conversation.chat.node` keys `user`, `assistant-step` and `tool-call`. The catalog marks each slot `replaceRisk: shadows-shipped-ui | none`. Plugins written through the agent's runtime facade get a priority number below every shipped entry automatically, so "your entry is the one that renders". Replacing `root` replaces the whole shell.
- **Conflicts are silent.** The lowest number wins, then registration order, and nothing tells the user. UI cannot be scoped to one agent preset.
- **Components never receive `ctx`.** Everything arrives as props: what the owner passes, child renderers, a declared store, and the plugin's own injected data.
- **Approvals are an ordinary UI plugin.** `client-ui-approval` occupies the `conversation.composer` chain like any other entry; nothing is sealed (`packages/client/ui-approval/README.md`).
- **Themes are code:** `ctx.theme` with `--dsw-*` tokens and a replaceable icon sprite (`…/2026-10-21-replaceable-icon-sprite.md`).
- **Assets:** content-hashed files served per package, with SVG served with scripts off. Their file server follows symlinks out of the package (`…/2026-10-19-client-plugin-package-assets.md`).

**How plugins contain or depend on other plugins**
- **Dependencies are on services (`inject`), never on plugin names.** A missing service leaves a plugin PENDING with no message ("PENDING is a legitimate state"); only a boot audit reports it (`docs/cordis-tutorial/06-composition-and-hmr.md`).
- **Nesting exists in three forms:**
  - runtime nesting through `ctx.plugin()`
  - roster `group: true` rows that load and unload as one unit, with `isolate` for separate service instances
  - bundles

  Bundles that pull in other bundles were rejected: "only direct `dsh.profile.bundles` entries contribute layers" (`…/2026-08-05-profile-plugin-bundles.md`).

**How Creator mode writes plugins** (`…/2026-09-16-creator-persistent-plugin-management.md`, and the skill `packages/preset/agent-preset/skills/cordis-plugin-development/` with `templates/decoration` and `templates/mcp`)
- **The agent writes ordinary files, then installs them.** It writes a bundle as workspace files (`package.json`, `cordis.patch.yml`, `index.js`, `client.js`, `locale/`, `icon.svg`) and calls `plugin_manager install_bundle`. An MCP server is a configuration-only bundle that inserts the shipped `dsh-mcp-client` row.
- **It discovers only what it needs, then verifies live.** It reads live slots, services, events and theme tokens through `cordis_inspect`, installs a first working version, and checks it in the running page. No mock previews.
- **Every `plugin_manager` action needs approval unless the session has full access,** because "profile changes can load code with host permissions". Standard mode has had the tool since September 16; PTC and Minimal do not.
- **The human install dialog installs disabled, then offers Enable** (`…/2026-09-15-guided-plugin-installation.md`). Hot reload activates new bundles live; replacing an installed package needs a restart.

**How plugins are distributed and trusted**
- **Installs run pnpm in the profile:** npm, git, tarball or a local folder. A git install needs an `allowBuilds` grant before its `prepare` script runs, which they describe as "permission to execute the package's code on your machine at install time" (`publish.md`).
- **Registry fallback, updates and indexes:**
  - A failed registry falls back to mirrors, but never from a private registry to a public one, to prevent dependency confusion (`…/2026-09-18-plugin-install-registries.md`).
  - Updates only move forward, and the Host reinstalls the old version if one fails (`…/2026-10-14-registry-bundle-updates.md`).
  - Optional JSON indexes (`format: 1`) pin each version to an npm version or a git commit SHA, and `engines.dsh` is checked at install and startup. DSH ships no index of its own (`docs/user/guide/plugin-market.md`).
- **Plugins run with host permissions** and no sandbox; `SAFETY.md` warns about this.

**What to copy and what to avoid**

Copy:
- Registrations that are undone automatically when a plugin unloads or reloads.
- A UI spot that exists only while its component is rendered. This is what lets a whole-shell replacement and one-part replacements coexist.
- The shapes `single`, `list` and `keyed`, with components receiving props and never a context object.
- A generated catalog of spots that says which ones replace shipped UI. We should serve it through `Glossary`.
- Creator's working style: templates, a working first version, live checks. We do it with ordinary file tools plus the discovery OK, not a special mode.
- Forward-only updates with rollback, and per-version pinned sources in the index.
- Launching the macOS helper as a signed app through LaunchServices, so the OS grants permissions to the helper itself (`…/2026-10-09-cua-shared-native-helper.md`).
- Content-hashed assets, with SVG served with scripts off.

Avoid:
- `!!js` or any other expression language in configuration: a data-only bot would become code.
- A roster file. In Wyrmhole the folder's presence, plus the OK, is the roster.
- Package managers and install scripts at install time.
- Approvals as a replaceable UI plugin.
- Priority numbers set by authors, and silent winners.
- Service dependencies that wait with no message.
- Themes as code.
- Replacing a whole `config` block on override.
- Asset serving that follows symlinks.
- `chain` slots that need selector functions; bots cannot ship code, so conditions must be declarative.

---

## 2. Proposals

### A. Kinds and packages, cleaned up (the current spec, tidied)
- **Concepts:**
  - A plugin has exactly one kind; there are about 17 kinds after the folds.
  - A package (a folder with `wyrmhole-package.json`) groups plugins.
  - Plugins can declare their own extension points.

  The folds: `surface` and `avatar-renderer` into `ui`, and `webhook-ingress` into `trigger`. A `computer` kind has to be added, because the spec has none for a cloud computer folder.
- **Layout:**
  ```text
  alpha/
  ├── wyrmhole-package.json   {"id":"alpha","version":"1.0.0","plugins":["alpha-bot","alpha-theme"]}
  ├── alpha-bot/wyrmhole.json {"id":"alpha-bot","kind":"bot","bot":{…}}
  └── alpha-theme/wyrmhole.json {"id":"alpha-theme","kind":"theme","theme":{…}}
  ```
- **Pros:**
  - It is the smallest change to the spec.
  - Each plugin's role is obvious.
  - Consent and sync rules key directly off the kind.
- **Cons:**
  - There are two units: plugin and package.
  - The kind list keeps growing, and already misses `computer`.
  - "One kind" breaks for voice, model sign-in screens and surfaces, which all have two halves, so packages become mandatory glue.
  - Kinds do nothing for UI granularity.
  - A package is just a folder of folders plus an extra manifest.

### B. Contributions, flat, with dependencies (the VS Code model)
- **Concepts:** plugins, contributions, extension points, `requires` (an id plus a version range), and packs (`includes`: a list of ids to install together). No nesting.
- **Manifest:**
  - `{"id":"alpha","contributes":{"bot":{…},"themes":[…]}}`
  - `{"id":"starter-pack","includes":["alpha","midnight","vn-view"]}`
- **Layout:** every plugin sits at the top level of `plugins/`; a pack is only a manifest.
- **Pros:**
  - It is familiar.
  - Shared parts are not duplicated.
  - Each plugin updates on its own.
  - Ids stay flat.
- **Cons:**
  - Packs bring packages back: membership, orphans, partial installs.
  - A suite is N folders, not one folder you can zip and share.
  - It needs version resolution.
  - The shared `wyrm` tool prefix needs a special exception.
  - "Plugins that host plugins" exists only through points.

### C. Contributions plus child plugins (recommended; full detail in section 3)
- **Concepts:** plugin, contribution, extension point, and child plugin. The class (data, web or code) is derived.
- **Layout:** one folder, with optional `plugins/<child>/` subfolders one level deep.
- **Pros:**
  - It has the fewest concepts.
  - The folder stays the unit you share, sync, approve and remove.
  - The package concept disappears.
  - Bundled plugins sit under one trusted root.
  - It covers both halves of the owner's "plugins that host plugins": points for running, children for shipping.
- **Cons:**
  - Children shared between trees are duplicated (rare, and usually small data).
  - A child cannot be updated on its own.
  - Ids get one level deeper.

### D. Code-first services (Cordis, as DeepSeek Harness does it)
- **Concepts:** a plugin is a module (`apply(ctx)`, `inject`); services; a roster file; bundles that patch the roster; slots registered at run time.
- **Manifest:** `package.json` `{"wyrmhole":{"bundle":{"patch":"roster.patch.yml"},"client":{…}}}`, with rows `{id, name, config, disabled}`.
- **Pros:**
  - It is the most powerful.
  - One mechanism covers everything.
  - It is proven at scale in DSH.
  - Hot reload is clean.
- **Cons:**
  - You must run code to learn what a plugin does, so there is no static OK, validator or Glossary index.
  - A roster contradicts "a folder is a plugin".
  - Config expressions break data-only bots.
  - Service dependencies fail silently.
  - `ctx` services across a worker boundary need RPC proxies for every call.
  - Replacing core services is exactly what §1.1 forbids.

**The worked examples under A, B and D** (C is in section 3.9):

| Example | A | B | D |
|---|---|---|---|
| Alpha | Package of a `bot` and a `theme`. The tab UI must be declarative inside the bot, because a `ui` plugin would put code in a bot package | One plugin: bot, theme and layout | A row configuring a `bot-loader` plugin; the theme and tab are code registrations |
| opensky | `tool` plugin with a helper | `mcpServers` plus `helper` | A module registering tools and starting the helper |
| OpenRouter | `model` plugin; its sign-in screen needs core UI or a second `ui` plugin | `models` | `ctx.models.register` |
| mcp-github | Generated `tool` plugin | `mcpServers` | A row inserting the shipped MCP client with config |
| skill-pdf | `skill` plugin | `skills` | A row for a skills loader |
| computer-hetzner-1 | Needs a new `computer` kind | `computer` | A row for the provider service |
| Usage island tab | `ui` plugin into `island.tab` | `ui` into `island.tab` | `ctx.slots.register('island.tab')` |
| Composer only | `ui` plugin; precedence still undefined | `ui` into `composer` | A priority number |
| Plain theme | `theme` plugin | `themes` | Code registering tokens |
| Discord Waifus | `ui` plugin, or a package if it also has tools | Two `ui` entries | A client module |
| Our bundled tools | Reserved-prefix exception | `toolNamespace: "wyrm"` exception | Modules |

---

## 3. Recommended approach: contributions plus child plugins

### 3.1 Concepts
1. **Plugin:** a folder with `wyrmhole.json`. It is the unit of identity, OK, install, sync, update and removal.
2. **Contribution:** an entry under `contributes.<point>`. It is the unit of activation and of conflict resolution.
3. **Extension point:** a named place to plug into.
   - **Core points** are fixed; they are listed in 3.3.
   - **Other points** are declared by a contribution's `declares` field and exist only while that contribution is active. A UI spot exists while its component is rendered.
4. **Child plugin:** `plugins/<name>/wyrmhole.json`, one level deep. A child is a full plugin: its own contributions, toggle and worker. It travels with its parent for install, sync, update and the OK.

Derived, never declared:
- **class:** data, web or code (3.5)
- **label:** "Bot", "Model provider", "Tools", "Theme", "UI", "Cloud computer" or "Collection", shown in the app and in search
- **child ids, tool names and bot ids**

**Kinds are gone.** Your test becomes the rule for core points: *a core point exists only where the core itself reads or calls the contribution; everything else is declared by a plugin.* Applying it:
- `surface` becomes a UI contribution to `app.surface`, because the app core opens the window.
- `avatar-renderer` becomes a UI contribution to `app.avatar`, because the app core picks a renderer by file format.
- `webhook-ingress` becomes the plugin point `webhook.ingress`, declared by the webhook trigger, because the core never calls it.

So your folds were right, and they fall out of the rule. The one gap: the spec has no kind for a cloud computer folder; here it is the core point `computer`.

### 3.2 Ids and tool names
- **Plugin id:** matches `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, 2–40 characters, with no `_` and no `.`.
  - The folder name must equal the id. A mismatch is not loaded, and the app offers a one-click rename. No silent forks.
  - A child's id is `<parent>/<folder>`.
  - `wyrm` is valid only for the app's own resources.
  - Banning `_` makes `mcp__<ns>__<Tool>` always split cleanly. Winter already hit a collision from `__` in plugin ids (`packages/core/src/agent/plugin-manifest.ts`).
- **Tool names are `mcp__<namespace>__<Tool>`.** The namespace is the root plugin's optional `namespace` field, defaulting to the root id. Children share their root's namespace.
  - Only one enabled root may use a namespace.
  - `wyrm` is taken by the bundled root, which is why bundled tools read `mcp__wyrm__…` with no special rule.
  - Wrapped servers get the server's name: `mcp-blender` has namespace `blender`, so `mcp__blender__Render`. This resolves the spec's mismatch between the `mcp-github` wrapper names and its `mcp__blender__Render` example.
  - Tool names may not contain `__`. Names over 64 characters get a digest form, as in Winter.
- **Every plugin tool is an MCP tool.** A plugin's own host code serves an MCP server of type `host`, so instructions, preload or on-demand, the bridge to ACP agents and Glossary all work the same for every tool.
- **A bot's id is the id of the plugin that contributes it.** There is one bot per plugin; a pack of bots uses children (`pack/luna`).

### 3.3 Core points

Daemon core points (the daemon reads or calls them):

| Point | Shape | What the core does with it | Class | Ships with |
|---|---|---|---|---|
| `bot` | one per plugin | Builds `<bot-instructions>`, picks the default model, keys memory by the bot id | data, offline | Alpha [D] |
| `models` | list, unique `provider` | Calls the adapter or the declared endpoint for every turn; the welcome guide reads `auth` | code, or data for an endpoint only | every current provider [D] |
| `mcpServers` | named servers; tool names unique per root | Dispatches tool calls; builds the MCP block | code (`host`, `stdio`) or data (`http`) | web, computer use, browser tool [D] |
| `skills` | list | Indexes them in Glossary | data | — |
| `agents` | list | Offers them to `Agent` | data | — |
| `agentBackends` | list, unique `id` | Starts agents for `Agent` | code | Claude Code, Codex, Grok, Gemini CLI, DeepSeek, Winter's coding agent |
| `hooks` | list | Calls them in the turn loop, under time limits; they can't skip approvals [D] | code | — |
| `commands` | list, unique `name` | Runs them for any client, with no model turn | code | — |
| `triggers` | keyed by `type` | Arms them for routine files | code | schedule, webhook |
| `voices` | list, unique `id` | Runs the bot's voice choice on the device in use | code | Fish Audio [D] |
| `computerProviders` | keyed by `id` | Creates, resizes and deletes VMs | code | Google Cloud, Hetzner [D] |
| `computer` | one per plugin | A cloud computer the registry creates after the user's OK | data | — |
| `relays` | list | Routes links through it | code | cloud computer relay [D] |
| `notifiers` | list | Fans events out to it | code | waifucave push [D], desktop notifications |
| `companions` | list | Serves remote clients within the fixed remote-call list | code | iOS app [D], web companion |

App core points (the app's fixed plugin runtime reads or calls them):

| Point | Shape | What the app does with it | Class | Ships with |
|---|---|---|---|---|
| `themes` | list, unique `id` | Applies the user's global theme and each bot's theme in its tab | data | waifu theme |
| `app.root` (under `ui`) | single | Mounts the main window's root | code | default shell [D] |
| `app.surface` (under `ui`) | list | Opens top-level floating windows | code | island, Dispatch pill [D] |
| `app.avatar` (under `ui`) | keyed by format | Picks a renderer by the bot's avatar format | code | VRM [D] |

**Points other plugins declare** have dotted names. The SDK publishes the well-known ones; a new one should start with the declaring plugin's id.
- **UI spots** go under `contributes.ui` (3.4). They are declared by rendered components, and several instances can exist at once, for example two windows each with a `composer`.
- **Non-UI points** are top-level dotted keys, such as `webhook.ingress`, with one active declarer at a time.
- `"private": true` limits a point to the declaring plugin's own tree.

**Bots stay equal:** `when.bot` is allowed only on `ui` contributions, which are presentation. It is refused on `mcpServers`, `hooks` and everything else.

### 3.4 UI: granularity, scope, precedence and the whole shell
- **Spots and shapes:**
  - `single`: one entry renders.
  - `list`: every entry renders, ordered by `order` (default 500), then by plugin id. The user can hide or reorder entries per spot.
  - `keyed`: one entry renders per key.

  There is no `chain`; declarative `when` covers it (see "which entry renders" below).
- **The well-known spot tree** (the default shell implements all of it; a catalog in the SDK lists each spot's shape, fields, context and props):
  - `app.root` holds the Shell, which declares:
    - `sidebar` and `sidebar.bot` (single)
    - `sidebar.app` (list; data: `title`, `icon`, `opens`)
    - `main` (keyed by route: `bot`, `agent`, `settings`, `plugins`, `app`)
    - `panel` (keyed by app id), `panel.view` (list) and `settings.section` (list)
  - The bot tab (`main` key `bot`) declares `bot.tab` (single; its context is the bot), which holds:
    - `bot.header`, `bot.stage` (the avatar), `bot.side` (list)
    - `conversation` (single)
    - `composer` (single; context `bot` and `pending`) and `composer.action` (list)
  - `conversation` declares `conversation.message`, keyed by `user`, `bot`, `tool`, `approval`, `question`, `routine-result`, `task-notification`, `agent-report` or `note`. It also declares `tool.result`, keyed by tool name.
  - The island declares `island.tab` (list); the pill declares `pill.target` (list; data).
- **Replacing one part:** contribute to that spot, for example `{"spot":"composer","component":"X"}` or `{"spot":"conversation.message","key":"bot","component":"Bubble"}`. A replacement of a container should declare the container's child spots (for example `composer.action`); otherwise contributions to them wait, and Settings says why.
- **Scoping to one bot's tab:** add `"when": {"bot": ["alpha"]}`. The user can also assign any contribution to any spot for one bot in Settings.
- **Which entry renders** in a `single` spot or a `keyed` cell:
  1. the user's pick, for this bot first, then globally
  2. the bot layout's `prefer`
  3. the most specific `when` (matching more of the spot's context keys wins, so `{pending: approval}` beats no condition)
  4. a plugin the user installed over a bundled one
  5. the most recently enabled

  If step 5 decides, Settings shows a conflict badge on that spot with a picker. Authors never set priorities.
- **Whole-shell replacement:** contribute to `app.root` and declare the well-known spots you support. Part replacements keep working inside any shell that declares their spots. A shell that breaks the app is the reason for safe mode.
- **The bot tab is data.** A bot's `layout` file is a small tree interpreted by whatever fills `bot.tab`:
  - node types: `row`, `column`, `stack`, `tabs`, `spot` (with `prefer`), `image`, `text`, `markdown` and `spacer`
  - sizes, `hideBelow`, CSS classes, and the variables `{bot.name}` and `{bot.status}`
  - no events, scripts or URLs outside the folder

  The iOS app can honour layout and theme tokens too, because they are data.
- **Code UI for a bot** is a separate code plugin with `when.bot`, or one the bot's layout `prefer`s. It needs its own code OK and never rides inside the bot. I considered two alternatives and rejected both:
  - code children inside a bot, off by default: it makes shared bots a code-delivery channel with a "turn this on for the full experience" prompt aimed at 13+ users
  - sandboxed iframe widgets: a second UI model that can't join the theme
- **CSS from data plugins** (themes, layouts):
  - It is cleaned before use: no `@import`, and `url()` only for files inside the folder.
  - It is scoped: a bot theme's CSS applies only inside that bot's tab.
  - The renderer's security policy blocks remote fonts and images for plugin styles.

  Code UI plugins are unrestricted (§5.6).
- **Web content:** `{"web": {"url" | "entry", "partition"}}` renders an isolated `WebContentsView` with its own session, no Node, no Wyrmhole API and no access to sealed cards.
- **Approvals:**
  - Components receive approval fields and buttons as opaque, sealed handles; `AskUserQuestion` arrives as readable props.
  - Sealed frames take tokens from core defaults, the global theme and the user's overrides only, never from a bot's theme. A code UI plugin may pass tokens explicitly.
  - If no plugin puts the approve and deny buttons on screen within 2 s, the app core shows its own card.

### 3.5 Data, web or code (derived for the OK)
- **code:** the plugin has `host`, `client` or `helper`, or any of:
  - an `mcpServers` entry of type `host` or `stdio`
  - any `hooks`, `commands`, `triggers`, `voices`, `computerProviders`, `relays`, `notifiers`, `companions` or `agentBackends`
  - a `models` entry with an `adapter` or a `custom` sign-in
  - a `ui` entry with a `component`
- **web:** no code, but at least one `ui` entry with `web`.
- **data:** everything else: JSON, Markdown, images, audio, VRM and GLB files, fonts, cleaned CSS and layouts.

Network hosts are listed separately for every class. They come from `url`, `endpoint.baseUrl`, `web.url`, `auth` URLs and `network:` capabilities. Classification reads the manifest, not the files present. Scripts inside skills are not plugin code: a bot may run them with Bash under the computer's approval level, and the OK says so.

**Bot rule (enforced):** a plugin tree that contributes a `bot` may contribute only `bot`, `themes`, `skills` and `agents`. It must be data-only and offline: no `mcpServers`, no endpoints, no `web`, no remote URLs. Adding a bot therefore never runs code and never adds a network connection.

### 3.6 Child plugins
- **ids:** `<parent>/<folder>`, one level deep.
- **The OK** covers the whole tree: one card listing each child with its class and a checkbox (default `enabledByDefault`, which defaults to true). The bot rule applies to the whole tree.
- **Enable and disable:** per child. Disabling the parent disables all its children, which keep their own toggles for later.
- **Versions:** the root's `version` covers the tree. A code child has its own `engines`. The tree updates atomically.
- **Sync:** the tree is one unit (one tree hash); child toggles sync.
- **Relation to points:** separate concerns. Children don't plug into their parent automatically; they contribute like any plugin. A parent can ship the default guests of the points it declares, for example the island and its "Needs you" tab.
- **Secrets and workers:** each child has its own secret store and, if it has code, its own worker. Children don't share secrets.
- **Removal:** with the tree. A child of a managed plugin (bundled or from an index) can only be disabled.
- **Not in 1.111.1:** plugin-name dependencies (`requires`). Points are how plugins depend on each other: a contribution waits, visibly, for its point.

### 3.7 Manifest schema (`wyrmhole.json`, format 1; JSON with comments and trailing commas accepted)
```ts
type Path = string;   // relative to the plugin folder; must resolve inside it (real path, no symlinks out)
type Text = string | { en: string; [lang: string]: string };
type Os = "macos" | "windows" | "linux";
type Platform = "darwin-arm64" | "darwin-x64" | "windows-x64" | "linux-x64" | "linux-arm64";
type Placement = "each" | "main" | "added";
type Scope = "bots" | "agents" | "both";

interface Manifest {
  manifest: 1;                      // required
  id?: string;                      // required at top level; must equal the folder name. Children omit it
  name: Text;                       // required
  version?: string;                 // semver; default "0.0.0"; required to publish to an index; children inherit
  description?: Text; icon?: Path;  // icon: svg/png/webp ≤ 256 KiB
  author?: { name: string; url?: string }; license?: string; homepage?: string;
  namespace?: string;               // tool prefix (top level only); default = id; children inherit; "wyrm" reserved
  engines?: { wyrmhole: string };   // plugin-API semver range; required when the plugin has code
  platforms?: Platform[];           // code runs only on these; default all
  adult?: boolean;                  // whole tree; off until the user confirms they are 18+
  enabledByDefault?: boolean;       // children only; default true
  scope?: Scope;                    // default "both"; applies to mcpServers, skills, agents, hooks
  agentBackends?: string[];         // only these Agent backends receive it, e.g. ["claude-code"]
  host?: { entry: Path; runtime?: "bun" | "node" };  // bun = a worker in the plugin host; node = its own process
  client?: { entry: Path };         // React module loaded into the app
  helper?: { bin: Partial<Record<Platform, Path>>;   // a signed .app on macOS, started via LaunchServices
             permissions?: ("accessibility"|"screen-recording"|"input-monitoring"|"microphone"|"camera")[];
             ipc?: "socket" | "stdio" };
  capabilities?: string[];          // conversation.read, conversation.post, memory.read, bots.read, routines.read,
                                    // computers.read, files, browser, usage.read, notify, audio,
                                    // call:<plugin-id>, network:<host>. These gate the Wyrmhole API; they are not containment
  settings?: Record<string, Setting>;
  contributes?: Contributions;
  generated?: { from: "mcp-config"|"mcp-url"|"skill-folder"|"agent-file"|"winter"; by: "user"|"bot"|"migration"; at: string };
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
  hooks?: Hook[];                             commands?: { name: string; description: Text; args?: object; handler: string }[];
  triggers?: { type: string; title: Text; fields?: object; handler: string; declares?: Record<string, PointDecl> }[];
  voices?: { id: string; name: Text; speak?: boolean; listen?: boolean; auth?: Auth[]; handler: string }[];
  computerProviders?: { id: string; name: Text; auth: Auth[]; handler: string }[];
  computer?: { provider: string; name: string; size: string; region: string; image?: string;
               makeMain?: "ask" | "no"; onRemove?: "ask" | "keep" | "delete" };
  relays?: Service[];  notifiers?: Service[];  companions?: Service[];
  themes?: { id: string; file: Path }[];      // the file is theme format 1 (below)
  ui?: Ui[];
  [pluginPoint: `${string}.${string}`]: unknown;   // e.g. "webhook.ingress"
}
interface Service { id: string; name?: Text; handler: string; runsOn?: Placement }
interface PointDecl { shape: "single" | "list" | "keyed"; fields?: object; context?: string[]; private?: boolean; doc?: Text }

interface Bot {
  name: Text; instructions: Path;              // Markdown that becomes <bot-instructions>
  model?: { default: string; effort?: string }; // qualified catalog id; with no key for it, the user's default model
  avatar?: { file: Path; format: string; portrait?: Path };
  voice?: { provider: string; voice: string; model?: string };
  theme?: string; layout?: Path; greeting?: Path;
  memory?: Path;                               // starter memories, copied once into the bot's memory folder
}
interface Model {
  provider: string; name: Text; terms?: string; catalog: Path | object[];   // rows follow the SDK catalog schema
  auth: Auth[];
  endpoint?: { protocol: "openai-chat" | "openai-responses" | "anthropic-messages"; baseUrl: string };  // data, no code
  adapter?: string;                            // a handler in host code, instead of endpoint
}
type Auth = { method: "api-key"; secret: string; help?: string }
          | { method: "oauth-pkce"; authorizeUrl: string; tokenUrl: string; secret: string }
          | { method: "custom"; handler: string };
interface McpServer {
  type: "host" | "stdio" | "http";
  command?: string; args?: string[]; env?: Record<string, string>;   // stdio
  url?: string; headers?: Record<string, string>;                     // http
  tools?: Record<string, "preload" | "on-demand">;                    // "*" sets the default for the rest
  instructions?: Path;                       // extra text for the MCP block (capped at about 4 KB)
  runsOn?: Placement;                        // default: host "each", stdio "added", http "main"
  perComputer?: boolean;                     // the core adds a `computer` argument and routes each call there
  computers?: string[];                      // device ids for "added"; the wrapper writes these
  scope?: Scope; when?: { os?: Os[] };
}
interface Hook { id: string; on: ("tool.before"|"tool.after"|"message.in"|"message.out"|"turn.start"|"turn.end"|"compact.before"|"compact.after")[];
                 tools?: string[]; handler?: string; command?: string; args?: string[]; timeoutMs?: number; scope?: Scope }
interface AgentBackend { id: string; name: Text; protocol: "acp" | "cloud"; command?: string; args?: string[]; handler?: string }
interface AgentDef { id: string; name: Text; backend: string; model?: string; effort?: string; instructions?: Path;
                     computer?: string; root?: string; plugins?: { only?: string[]; except?: string[] } }
interface Ui {
  spot: string; id?: string;                 // id defaults to the spot; required if the plugin fills one spot twice
  key?: string; order?: number;
  when?: { bot?: string | string[]; surface?: string | string[]; os?: Os[]; setting?: Record<string, unknown>; [ctx: string]: unknown };
  component?: string;                        // an export of client.entry
  web?: { url?: string; entry?: Path; partition: string };
  window?: { type: "overlay" | "window"; alwaysOnTop?: boolean; transparent?: boolean; placement?: Partial<Record<Os, string>> };
  declares?: Record<string, PointDecl>;
  [field: string]: unknown;                  // fields the spot defines: title, icon, opens…
}
// Theme format 1:  { theme: 1, name, appearance?: "light"|"dark"|"both", tokens: {…}, dark?: { tokens }, css?: Path,
//                    fonts?: [{ family, src: Path }], icons?: { <name>: Path } }
// Layout format 1: { layout: 1, root: Node, background?: Path, css?: Path }
//                  Node = { row|column|stack: Node[] } | { tabs: [{ title, node }] } | { spot, prefer?: string[] }
//                       | { image: Path } | { text } | { markdown: Path } | { spacer: true },
//                  plus common size, min, max, grow, hideBelow, class, gap, padding, align
// Interpolation: ${plugin} (the folder path), ${setting:k}, ${secret:k}. Secrets may appear only in env and headers.
```

Validation:
- the folder name equals the id
- the bot rule (3.5)
- paths stay inside the folder
- tool names are unique per root, with no `__`
- no expressions anywhere

Contributions to points that are missing at run time are allowed; they wait and show the reason. `wyrmhole plugin validate` prints the class, label, contributions, declared points, network hosts, helper permissions, capabilities, tool names, settings and children, all without running anything.

### 3.8 Where it runs
| Point | Runs on |
|---|---|
| `bot`, `skills`, `agents`, `themes` | data, available everywhere |
| `models`, `hooks` | every computer that runs a turn (the main, the takeover device, a routine's computer); started lazily |
| `mcpServers` type `host` | `each`; `perComputer` routes a call to the named computer |
| `mcpServers` type `stdio` | `added`: the computer it was added on; other computers forward to it and get "computer offline" when it's off |
| `mcpServers` type `http` | `main`: the main computer, or the takeover device while the main is offline |
| `triggers`, `webhook.ingress` | each computer, started eagerly |
| `voices` | the device in use |
| `computerProviders`, `notifiers`, `companions`, `commands` | `main` (desktop notifications override this to `each`) |
| `relays` | `added` (the cloud computer) |
| `agentBackends` | the computer the agent is placed on |
| `ui` | every app instance |

A host half starts on a computer when one of its contributions is placed there. The user can pin any plugin to chosen computers in the user layer.

### 3.9 Worked examples

**Alpha** (top level, bundled, data). Bot id `alpha`.
```text
alpha/
├── wyrmhole.json
├── bot/instructions.md  greeting.md  memory/MEMORY.md …
├── layouts/tab.json
├── themes/waifu/theme.json  theme.css
└── assets/alpha.vrm  portrait.webp  bg.webp  fonts/Nunito.woff2
```
```json
{ "manifest": 1, "id": "alpha", "version": "1.111.1", "name": "Alpha", "icon": "assets/portrait.webp",
  "contributes": {
    "bot": { "name": "Alpha", "instructions": "bot/instructions.md", "greeting": "bot/greeting.md", "memory": "bot/memory",
             "model": { "default": "<qualified catalog id>", "effort": "medium" },
             "avatar": { "file": "assets/alpha.vrm", "format": "vrm", "portrait": "assets/portrait.webp" },
             "voice": { "provider": "fish-audio", "voice": "<fish voice id>", "model": "s2.1-pro-free" },
             "theme": "waifu", "layout": "layouts/tab.json" },
    "themes": [{ "id": "waifu", "file": "themes/waifu/theme.json" }] } }
```
```json
{ "layout": 1, "background": "assets/bg.webp",
  "root": { "row": [ { "spot": "bot.stage", "size": "38%", "min": 280, "hideBelow": 760 },
                     { "column": [ { "spot": "bot.header" }, { "spot": "conversation", "grow": 1 }, { "spot": "composer" } ], "grow": 1 } ] } }
```
```json
{ "theme": 1, "name": "Waifu", "tokens": { "color.bg": "#fff5fa", "color.accent": "#ff5fa2", "radius.card": "16px", "font.body": "Nunito" },
  "dark": { "tokens": { "color.bg": "#1d1420" } }, "css": "themes/waifu/theme.css",
  "fonts": [{ "family": "Nunito", "src": "assets/fonts/Nunito.woff2" }] }
```

**opensky** (code). Tools `mcp__opensky__Computer` and `mcp__opensky__Browser`.
```text
opensky/
├── wyrmhole.json
├── host/index.js  host/node_modules/…    # shipped ready to run; no install step
├── host/instructions.md
└── helper/darwin-arm64/Opensky Helper.app  helper/windows-x64/opensky-helper.exe  helper/linux-x64/opensky-helper
```
```json
{ "manifest": 1, "id": "opensky", "version": "0.4.0", "name": "opensky", "engines": { "wyrmhole": "^1.111.1" },
  "platforms": ["darwin-arm64", "windows-x64", "linux-x64"],
  "host": { "entry": "host/index.js", "runtime": "node" },
  "helper": { "bin": { "darwin-arm64": "helper/darwin-arm64/Opensky Helper.app",
                       "windows-x64": "helper/windows-x64/opensky-helper.exe",
                       "linux-x64": "helper/linux-x64/opensky-helper" },
              "permissions": ["accessibility", "screen-recording"] },
  "capabilities": ["browser", "computers.read"],
  "contributes": { "mcpServers": { "opensky": { "type": "host", "runsOn": "each", "perComputer": true,
      "tools": { "Computer": "preload", "Browser": "preload", "*": "on-demand" }, "instructions": "host/instructions.md" } } } }
```

**OpenRouter** (code; drop `host` and replace `adapter` with an `endpoint` to make it data).
```text
openrouter/
├── wyrmhole.json
├── catalog.json
├── host/index.ts       # adapter extras and a live catalog refresh
└── assets/icon.svg
```
```json
{ "manifest": 1, "id": "openrouter", "version": "1.2.0", "name": "OpenRouter", "icon": "assets/icon.svg",
  "engines": { "wyrmhole": "^1.111.1" }, "host": { "entry": "host/index.ts" },
  "settings": { "apiKey": { "type": "secret", "title": "API key", "required": true } },
  "contributes": { "models": [{ "provider": "openrouter", "name": "OpenRouter", "terms": "https://openrouter.ai/terms",
      "auth": [ { "method": "oauth-pkce", "authorizeUrl": "https://openrouter.ai/auth",
                  "tokenUrl": "https://openrouter.ai/api/v1/auth/keys", "secret": "apiKey" },
                { "method": "api-key", "secret": "apiKey", "help": "https://openrouter.ai/keys" } ],
      "catalog": "catalog.json", "adapter": "openrouter" }] } }
```

**mcp-github** (generated; data, connects to api.githubcopilot.com; runs on the main or the takeover device). Tools `mcp__github__…`.
```text
mcp-github/
└── wyrmhole.json
```
```json
{ "manifest": 1, "id": "mcp-github", "namespace": "github", "version": "1.0.0", "name": "GitHub",
  "generated": { "from": "mcp-url", "by": "user", "at": "2026-11-03T09:12:00Z" },
  "settings": { "token": { "type": "secret", "title": "GitHub token" } },
  "contributes": { "mcpServers": { "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${secret:token}" }, "tools": { "*": "on-demand" } } } } }
```
A stdio server, such as Blender's, is code: `"type": "stdio", "command": "uvx", "args": ["blender-mcp"], "runsOn": "added", "computers": ["<Desktop1 device id>"]`.

**skill-pdf** (generated; data).
```text
skill-pdf/
├── wyrmhole.json
└── skills/pdf/SKILL.md  reference.md  scripts/fill_form.py
```
```json
{ "manifest": 1, "id": "skill-pdf", "version": "1.0.0", "name": "PDF",
  "generated": { "from": "skill-folder", "by": "user", "at": "2026-11-03T09:20:00Z" },
  "contributes": { "skills": ["skills/pdf"] } }
```

**computer-hetzner-1** (data). The OK is the creation card ("Create a Hetzner cx32 in fsn1 for about €X a month?"), then "Make it your main computer?".
```text
computer-hetzner-1/
└── wyrmhole.json
```
```json
{ "manifest": 1, "id": "computer-hetzner-1", "version": "1.0.0", "name": "Hetzner 1",
  "contributes": { "computer": { "provider": "hetzner", "name": "Hetzner1", "size": "cx32", "region": "fsn1",
                                 "image": "wyrmhole-desktop", "makeMain": "ask", "onRemove": "ask" } } }
```
- `wyrm/hetzner` provides the `hetzner` entry of `computerProviders`; its API token is a secret setting.
- The VM's own state (server id, address, pairing) lives in the computer registry, not in the folder.
- Editing `size` asks before resizing; deleting the folder asks whether to delete the VM.

**Island tab (Usage), from another plugin.** The island (`wyrm/island`) declares the spot:
```json
{ "manifest": 1, "name": "Island", "client": { "entry": "client/index.tsx" },
  "contributes": { "ui": [
    { "spot": "app.surface", "id": "island", "component": "Island",
      "window": { "type": "overlay", "alwaysOnTop": true, "transparent": true,
                  "placement": { "macos": "notch", "windows": "top-center", "linux": "top-center" } },
      "declares": { "island.tab": { "shape": "list", "fields": { "title": "text", "icon": "path", "component": "component" },
                    "doc": "Collapsed at most 320×38, expanded at most 480×360; must have an idle state; may ask for attention." } } },
    { "spot": "island.tab", "id": "needs-you", "title": "Needs you", "component": "NeedsYouTab", "order": 100 } ] } }
```
The Usage tab (`wyrm/usage`; a third-party one differs only in its id):
```text
wyrm/plugins/usage/
├── wyrmhole.json
├── client/index.tsx
└── assets/gauge.svg
```
```json
{ "manifest": 1, "name": "Usage", "client": { "entry": "client/index.tsx" }, "capabilities": ["usage.read"],
  "contributes": { "ui": [
    { "spot": "island.tab", "id": "usage", "title": "Usage", "icon": "assets/gauge.svg", "component": "UsageTab", "order": 300 },
    { "spot": "settings.section", "id": "usage", "title": "Usage", "component": "UsageSettings" } ] } }
```
While no island is enabled, the tab shows "waiting: needs island.tab".

**Composer only** (code). It wins over `wyrm/composer` because a user-installed plugin beats a bundled one. Approvals and questions still take over the composer, because those contributions use `when.pending` and are more specific. To scope it, add `"when": {"bot": ["alpha"]}`.
```text
fancy-composer/
├── wyrmhole.json
└── client/index.tsx  composer.css
```
```json
{ "manifest": 1, "id": "fancy-composer", "version": "0.3.0", "name": "Fancy composer", "engines": { "wyrmhole": "^1.111.1" },
  "client": { "entry": "client/index.tsx" },
  "contributes": { "ui": [{ "spot": "composer", "component": "FancyComposer",
                            "declares": { "composer.action": { "shape": "list" } } }] } }
```

**Plain theme** (data).
```text
midnight/
├── wyrmhole.json
├── theme.json
└── theme.css
```
```json
{ "manifest": 1, "id": "midnight", "version": "1.0.0", "name": "Midnight",
  "contributes": { "themes": [{ "id": "midnight", "file": "theme.json" }] } }
```

**Discord Waifus** (web). The whole existing app is built as static files, shown in an isolated view. Use `"url"` instead to point at a hosted copy. Bridging to bots would need a client half, which makes it code.
```text
discord-waifus/
├── wyrmhole.json
├── app/index.html  app/assets/…
└── assets/icon.png
```
```json
{ "manifest": 1, "id": "discord-waifus", "version": "1.0.0", "name": "Discord Waifus",
  "contributes": { "ui": [
    { "spot": "sidebar.app", "id": "discord-waifus", "title": "Discord Waifus", "icon": "assets/icon.png", "opens": "discord-waifus" },
    { "spot": "panel", "key": "discord-waifus", "web": { "entry": "app/index.html", "partition": "discord-waifus" } } ] } }
```

**The bundled root and a non-UI plugin point.** The bundled root (in the app's resources; the user can't edit it):
```text
<app resources>/plugins/
├── alpha/
└── wyrm/
    ├── wyrmhole.json        { "manifest": 1, "id": "wyrm", "version": "1.111.1", "name": "Wyrmhole standard plugins" }
    └── plugins/
        ├── shell/  conversation/  composer/  panel/  browser-view/  settings/  bot-editor/  plugin-browser/  archive/
        ├── island/  pill/  usage/  devices/
        ├── web/  computer-use/  browser/          # mcp__wyrm__WebSearch, WebFetch, ComputerUse, Browser
        ├── anthropic/  openai/  codex/  …         # one model plugin per current provider
        ├── fish-audio/  vrm/  theme-waifu/
        ├── schedule/  webhook/  forwarder/  relay-cloud/ (off by default)  hetzner/  gcloud/
        ├── ios/  web-companion/  push/  desktop-notify/
        └── claude-code/  codex-acp/  grok/  gemini-cli/  deepseek/  winter-code/
```
The webhook trigger declares an ingress point:
```json
{ "manifest": 1, "name": "Webhook trigger", "host": { "entry": "host/index.ts" },
  "contributes": { "triggers": [{ "type": "webhook", "title": "Webhook", "handler": "webhook",
      "declares": { "webhook.ingress": { "shape": "single", "doc": "Gives each routine a public URL and delivers its payloads." } } }] } }
```
The forwarder fills it:
```json
{ "manifest": 1, "name": "waifucave forwarder", "host": { "entry": "host/index.ts" },
  "contributes": { "webhook.ingress": { "id": "waifucave", "handler": "forwarder", "runsOn": "each" } } }
```

### 3.10 Lifecycle rules
1. **Roots.**
   - The app's resources (`wyrm` and `alpha`): trusted and read-only.
   - `~/.wyrmhole/plugins/`: the user's, synced.
   - Development folders passed with `--plugin-dir`.

   A repo's own items stay non-plugins, as §5.1 already says.
2. **Discovery.**
   - The registry watches the user root. A new top-level folder is validated, then marked `invalid` (with reasons) or `found`.
   - A bare item at the top level (a `SKILL.md` folder, a `.mcp.json`, an `agents/*.md`) is moved into a generated wrapper (`skill-<name>/skills/<name>/`, one `mcp-<server>` per server, `agent-<name>`).
3. **The OK.**
   - One sealed card per top-level plugin. It shows the class (code > web > data), what the plugin adds, network hosts, helper permissions, children with checkboxes, and who wrote it (the user, bot X, or the migration).
   - Installs through the app or the CLI count as the OK.
   - Folders written by a bot always get the card.
   - A refused plugin stays ignored until its folder changes.
   - `adult` plugins stay off until the user confirms they are 18 or older.
   - The OK is account-wide and bound to the tree hash, so other devices don't ask again.
4. **Enable and disable.**
   - Per plugin and per child, account-wide, plus a per-device opt-out.
   - No opt-out for `bot` or `models` contributors on a device that can become main.
   - Disabled means its contributions and points vanish, and anything that depended on them waits.
5. **Load order.**
   1. Core points exist.
   2. The registry reads manifests only and builds the graph.
   3. Each contribution activates once its point exists. UI spots exist while the component that declares them is rendered.
   4. Host halves start lazily where needed, and eagerly only for triggers, relays, notifiers, companions and ingress.
   5. Dependents unload first.

   List order comes from `order`, then the plugin id, never from file order. A conflict on a unique point refuses the later contribution with a visible reason; UI conflicts follow 3.4.
6. **Hot reload.**
   - **Data edits** apply live: themes, layouts and CSS at once. Bot instructions apply at the next compaction, or immediately if the user chooses to pay the cache miss.
   - **Code edits** put the plugin in a `changed` state that waits for a new OK.
   - **"Trust my edits"** never covers changes made by a bot's tool call: the core re-hashes trusted-edit plugins after each bot Write, Edit or Bash call.
   - **On reload,** the worker is replaced. In-flight tool calls get a grace period, then are recorded as interrupted; model calls are retried. The client half is re-imported and remounted, and its component state is lost. Manifest changes are applied per contribution (point plus id).
7. **Updates.**
   - Index plugins update automatically unless pinned, and only forward.
   - An update asks again if it turns data into code, or adds capabilities, network hosts, helper permissions, code children or `adult`.
   - The previous version is kept until the new one activates, and restored if it fails.
   - Bundled plugins update with the app. Local plugins change only when their folder does.
8. **Sync.**
   - The unit is the top-level plugin.
   - The account list holds `{id, version, treeHash, source, enabled, childToggles, deviceOptOuts}`.
   - Index plugins are fetched by hash, staged, then swapped in.
   - Local plugins are copied from the main; edits on any device go through the main. If two devices change one file, the later write by the shared clock wins and the other is kept as `<file>.conflict-<device>`.
   - A host half runs only when its hash matches the main's.
   - A pull from the index's revocation list sets the plugin to `blocked` everywhere.
9. **Uninstall.**
   - Delete the folder, or press Remove; the removal syncs as a delete event.
   - Code stops and tool names are removed; old transcripts keep the names as text.
   - User data is never deleted with the plugin: a bot's memory and transcript stay under its id (a reinstall revives the bot), and settings stay. Deleting data and saved keys are separate choices.
   - Removing a computer folder asks whether to delete the VM.
   - Bundled plugins can only be disabled. Children of managed plugins can only be disabled.
10. **Safe mode:** only the app's own resources (`wyrm` and `alpha`) and the core plugin manager.

---

## 4. Spec edits

- **§3.1 diagram:** "client plugins (React, themes)" becomes "plugin UI (React components) and data (themes, layouts)".
- **§3.2, "Plugin registry" row:** "…loads, unloads, orders by dependency…" becomes "…activates each contribution when its extension point exists, unloads dependents first…".
- **§5.1:**
  - Replace the "Plugins and plugin packages" bullet and the folder shape with:
    - **[P] The manifest.** Every plugin folder holds `wyrmhole.json` (§5.9). It lists what the plugin *contributes* to extension points (§5.3).
    - **[P] Child plugins** (replaces the [D] on packages, pending the owner). A plugin may hold plugins in `plugins/`, one level deep. A child is a full plugin with the id `<parent>/<folder>`. The top-level folder is installed, synced, updated, approved and removed as one unit, and each child is enabled on its own.
    - The folder tree from 3.9 (Alpha) as the canonical shape.
  - Append to the [D] OK bullet: [P] one card per top-level plugin, as in 3.10 rule 3, and "trust my edits" never covers a bot's writes.
  - In the wrapping bullet, name wrappers `mcp-<server>` (namespace = the server name), `skill-<name>` and `agent-<name>`, one per server, with a `generated` record.
  - Scope bullet: scope applies to `mcpServers`, `skills`, `agents` and `hooks`.
  - Client-half bullet: replace with a pointer to §5.4–5.5.
- **§5.2:** add the placement table from 3.8, and add helper launching through LaunchServices on macOS.
- **§5.3:** rename it "Extension points". Replace the kinds table with the two core-point tables from 3.3, keeping the "ships with" [D]s. Then add:
  - **[P]** the core-point test.
  - **[P]** data, web or code, derived as in 3.5.
  - **[D]** bots are data only, stated as the tree rule from 3.5.
  - **[D]** computer use is an `mcpServers` contribution plus a helper.
  - A one-time mapping from the old kinds: surface → `app.surface`, avatar-renderer → `app.avatar`, webhook-ingress → `webhook.ingress`, cloud computer → `computer`, and every other kind → the point of the same name.
- **§5.4:** keep the [D]. Add **[P]**:
  - Points are declared by a contribution's `declares` and live while it is active; UI spots live while their component is rendered.
  - Hosting (points) and packaging (children) are separate concerns, and a host may ship its default guests as children.
  - The island, pill and `webhook.ingress` examples.
  - `private` points.
- **§5.5:** keep the styling precedence and add the 3.4 text:
  - spot shapes, the well-known spot catalog, replacing one part, `when.bot`, precedence steps 1–5 with the conflict badge, and whole-shell replacement
  - **[P]** bot tabs as declarative layouts
  - **[P]** cleaned and scoped CSS for data plugins
  - **[P]** isolated web views
  - **[P]** sealed frames never take a bot's theme, and the core fallback card after 2 s

  Remove "DeepSeek Harness's slot model".
- **§5.6:** add the three classes, the capability list, helper permissions in the OK, and the re-ask rules (3.10 rules 6–7).
- **§5.8:**
  - "the `hook` kind" becomes "the `hooks` point".
  - "the `command` kind" becomes "the `commands` point".
  - "a bundled `notifier` plugin" becomes "a bundled plugin contributing to `notifiers`".
  - Add to core: the app's plugin runtime (loading UI halves, the theme engine, sealed frames, and the core points `app.root`, `app.surface`, `app.avatar` and `themes`).
- **§5.9 (new), Manifest reference:** the schema from 3.7.
- **§6.1:**
  - "A bot plugin" becomes "[P] A bot is the `bot` contribution of a plugin: one per plugin, with the plugin's id as the bot's id. Its fields are listed in §5.9; the tab layout is data (§5.5)."
  - Delete "[P] Plugins too: a plugin with its own (non-MCP) tools can supply instructions": every tool is MCP now.
- **§6.7, naming bullet:** add **[P]**:
  - `<plugin>` is the root plugin's namespace (default: its id), and children share it.
  - Bundled plugins are children of the reserved root `wyrm`.
  - Ids can't contain `_`.
  - A plugin's own tools are an MCP server of type `host`.
  - Statically declared duplicate tool names refuse the plugin; a duplicate discovered at connect time refuses only that tool.
- **§6.8:** Glossary also returns extension points: shape, fields, current occupants, and whether filling one replaces shipped UI.
- **§7:** "the forwarder is itself a plugin (`webhook-ingress`)" becomes "the forwarder is a plugin contributing to `webhook.ingress`, a point the bundled webhook trigger declares". Do the same for "Other ways in".
- **§8.5, "Installed plugins" row:** replace with 3.10 rule 8.
- **§9.2:** add **[P]**: the folder contributes `computer`; a provider plugin contributes `computerProviders`; the VM's state lives in the computer registry; editing `size` asks before resizing.
- **§10:** "surface plugins" becomes "plugins contributing to `app.surface`"; the VRM renderer becomes "`app.avatar`, keyed by format".
- **§12, feature floor:** "the `hook` kind" becomes "the `hooks` point".
- **§13:**
  - W1 "plugin folders and packages" becomes "plugin folders, child plugins, the manifest and `wyrmhole plugin validate`".
  - W2 "UI spots" becomes "the spot catalog and precedence, declarative bot layouts and isolated web views".
- **§14.2:**
  - Q41 becomes "…bot plugins are data only; child plugins replace packages (§5.1)".
  - Add Q47: "Child plugins replace packages", rec yes.
  - Add Q48: "Sealed fields never take a bot's theme", rec yes.

---

## 5. [D] decisions I think should change

1. **Plugin packages** (§5.1 "Plugins and plugin packages", §5.3, Q41) → **child plugins.**
   - *Reason:* nesting gives a package's three properties (installed, synced and approved as one unit) with no second manifest. It keeps "a plugin is a folder" true for suites, and it is literally the owner's "plugins that host plugins".
2. **"A plugin does one job, of one kind"** (§5.1) → **a plugin contributes to any points.**
   - *Reason:* "one kind" is what forces packages. It already fails for voice, surfaces and model sign-in, it misses cloud computers, and everything a kind decided can be derived from contributions.
3. **Remote MCP servers "run on the main computer"** (inside the §5.1 [D] bullet) → **the main, or the takeover device while the main is offline.**
   - *Reason:* the takeover device is the one thinking and the one refreshing tokens. Taking a remote API offline because a desktop sleeps buys nothing.
4. **"The buttons themselves can be restyled, even without text"** (§5.5) → **keep it, but only code UI plugins and the user's own overrides may style sealed fields; bot themes never can.**
   - *Reason:* data-only bots pass a lighter OK and are what 13+ users share. Without this, a bot theme could swap how approve and deny look.

Kept but tightened: "bots are data only" now covers the whole folder tree and rules out network connections. `mcp__wyrm__…` "reserved for plugins we ship" is realized as the reserved root id `wyrm`.

No repo file was created or edited. The clone in the scratchpad's `plugin-model-review` folder is deleted, and the other scratchpad files are untouched.
