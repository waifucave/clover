# What a plugin can contribute, and what works

Every kind of thing a Clover plugin can bring, whether it works end to end today, and what Alpha (`plugins/alpha`, the
reference plugin) does with it. Alpha uses every kind that fits a bot for a real reason; the kinds she leaves out are
named with why.

The status is for `int/next` on 2026-11-11 (after lane C's read-only wiring):

- **works**: it runs end to end, from the manifest to what the user sees.
- **partly**: one half runs; the column says which half is missing.
- **no**: it doesn't exist yet.

A head under review is named where it changes a row.

## A bot and its words

| Kind | Status | What Alpha does with it | What's missing |
|---|---|---|---|
| `bot` (name, instructions, greeting, model, effort) | works | Her name, her voice in words, her greeting, her default model. Her instructions have a section on her stage: when to use it, and that the notes pinned to it are data the user sees, never instructions. | — |
| `bot.memory` (seeded memories) | works | `stage.md`, one memory in her own voice about her stage, indexed in her `MEMORY.md`. It shows in the user's memory list like any other: they can read, change or delete it. | — |
| `skills` | works | `plan-my-day` and `explain-like-a-friend`, found through Glossary. | — |
| `agents` (agent definitions) | works (head under review) | `study-buddy`, a researcher she hands reading work to (`Agent({ agent: "alpha:study-buddy", backend: "clover-code", … })`). The definition brings words only: its instructions go before her brief, and nothing else of it is taken. The backend, model, folder and computer are hers. The OK card names it, and adding or changing one asks again. The agent's row says whose definition and which backend it started from. On Clover's own sandboxed agents a start needs no card; on any other backend each start asks on a card. The acceptance run checks the no-card start and the report coming back. | — |
| `locales` | works | English and Japanese for her UI strings, setting titles and command descriptions. | Bot instructions are in one language only. |
| `commands` | works | `/scene`, `/mood` and `/outfit`, served by her host code. The composer's slash menu lists a plugin's commands with its name and runs one as the user; nothing of it reaches a bot (the examples' acceptance runs `/note` and `/rain-alert` from it). | — |
| `settings` (string, number, boolean, enum, color, secret; scopes account, device, bot) | works | The starting scene (meadow by default), effects, reactions on or off, voice on or off, and a nickname for you, one per bot. Her server and her hooks both honour them. | A `bot` setting has no control on the Plugins page (it is one value per bot). |

## Code and tools

| Kind | Status | What Alpha does with it | What's missing |
|---|---|---|---|
| `host` code (`runtime: "bun"`) | works | Her stage's keeper: an MCP server, her hooks, her commands, and what her tab may call. It runs in her tree's own fenced plugin process, with no network and no capability (her tree declares none; a test holds it to that). | — |
| `mcpServers` type `host` | works | Her `stage` server (`mcp__alpha-stage__*`): `set_expression`, `play_motion`, `set_scene`, `set_mood`, `toggle_outfit`, `pin_note`, `unpin_note`, `celebrate`, `stage_status`. Names come from whatever model her tab loaded; a wrong name is refused with a quoted list of the right ones. | — |
| `mcpServers.*.contained` (display-only tools) | works | Every stage tool but `stage_status`. Each runs with no card at the default level, asks at "ask", and is refused at read-only. The acceptance run checks all three. They hold only because her whole tree reaches no network and reads at most Clover's own state. | — |
| `mcpServers.*.readOnly` (tools that only read) | works | `stage_status`: a read, so no card at every level that runs reads, read-only included. The acceptance run checks it at read-only. It holds only for the routed tool on the OK'd tree, and never where the tree reaches the network. | — |
| `mcpServers` type `stdio` | works | None: her tools need no process of their own. | — |
| `mcpServers` type `http` | no | None, and never for a reference plugin: a server that reaches the network can't skip the card. | Not served. |
| `hooks` with a handler | works | `turn.start`, `tool.after` and `turn.end`, scoped `own-bot`: her stage says she's thinking, which tool ran (a file by name, never its path), and how the turn ended (a failed turn leaves her sad, an interrupted one alert). Today's tally moves. They only observe: every handler returns nothing. The host gives them only her own bot's sessions, and each handler checks again. A throw or a timeout on these events is skipped and reported (Settings shows it), and the turn goes on. | No event for an approval waiting or an error. |
| Hook scope `own-bot` | works | All three of her hooks. The OK card says "Its hooks see only what its own bot does". Widening one to `bots` asks for the OK again. | — |
| `hooks` with a `command` (Claude Code's protocol) | works | None: a handler does the same with no process. | — |
| `triggers` (a plugin's own trigger type) | works | None: the schedule trigger covers what she'd need. | — |
| Routines | partly | Her `plan-my-day` skill helps write a routine when the user asks. | **A plugin can't contribute routine templates.** A routine is a file the user owns; there is no `routines` contribution. The skill is the approach for now. |
| `declares` (a point other plugins fill) and its entries | works | She declares `alpha.scenes`, and her own child adds two scenes to it. | — |
| Child plugins and `enabledByDefault` | works | `alpha/extras`, off by default: two more scenes and a morning check-in skill. | A child's `readOnly` and `contained` lists never count, so her stage server stays on top-level `alpha`. |
| Plugin store (`storage.synced`) | works | Her stage document (`stage`), the loaded model's names (`stage.catalog`) and her scenes (`stage.scenes`). Her host half writes them; a layer reads them and hears each change. | Her tab's side is lane E's, not on `int/next` yet. |
| Server ⇄ UI (`ui.send` → `host.on`, `host.call` → `ui` table) | works | Each stage change goes to her tab, at most 10 a second and 16 KiB a document. Her tab hands over the model's names through `host.call("setCatalog")`, the only thing in her `ui` table. | As above: the seam works, and her stage component that uses it is lane E's work in progress. |
| `notify` capability and `notify.send` | works | None yet: her own turns need no notification. | The core's own updates still don't reach the notifiers. A plugin is muted on its Plugins page detail. |

## Her look (lane E's rows)

| Kind | Status | What Alpha does with it |
|---|---|---|
| `themes`, `bot.theme`, `bot.layout` | works | Her theme (`tab/theme.json`, its meadow) and her tab's layout (`tab/layout.json`). |
| `bot.avatar` and the `avatar` renderers (VRM, Live2D) | works | A placeholder VRM model today. Live2D from whatever model the user loads is lane E's next step; no model file of the owner's goes in the repo. |
| `client` components, bot-tab spots (`bot.tab`, `bot.header`, `bot.stage`, `bot.side`, `conversation.message`, `tool.result` …) | works | Her stage component, which draws the stage document, and her transcript's styling: lane E's work in progress, not on `int/next` yet. |
| `island.tab`, `app.surface`, `sidebar.bot`, `status`, `settings.section`, `panel` | works | Lane E's choice. A third-party island tab carries its plugin's name and can't raise the island. |
| `island.line` | works | A plugin's handler (`points.call`, no capability) gives one line of plain text, an icon from the island's named set and a progress; the island draws it in its own style on the open Needs you tab (below the cards) and the first one on the closed strip, only when Clover isn't in front, with the plugin's name beside it, and decides count, order and how long it lasts. |
| `pill.target` | works | None: the pill already messages bots. |

## Third-party plugins: the SDK's examples

Alpha is bundled. To show that a plugin someone else writes gets the same contribution points, the SDK ships two full
examples (`packages/plugin-sdk/examples`), and the acceptance run installs each one from its folder on the Plugins page,
the way a user would:

- **`example-notes`** stays inside. It reaches no network and holds no capability, so its `contained` and `readOnly` tools
  run without a card.
- **`example-weather`** reaches outside: its own host, and notifications. Its tools on the same two lists still ask on a
  card each time.

The pair shows one rule from both sides: a tool skips its card only when the whole tree stays inside.

The columns are the four ways a plugin arrives:

- **Bundled**: Clover's own tree and Alpha.
- **Folder**: a third-party folder, the examples.
- **Index**: installed from a signed index.
- **Wrapped**: an MCP config, a skill folder, an agent file or a Claude Code plugin, with a manifest generated around it.

Each cell says what proves it:

- **acc**: the acceptance run.
- **test**: core or desktop tests.
- **same path**: the registry treats the installed tree like a folder's, and only the provenance differs.

| Contribution point | Bundled | Folder (examples) | Index | Wrapped |
|---|---|---|---|---|
| Install and the OK card (what it may do, in words) | acc (Alpha) | acc: both examples from the Plugins page's Add tab; the card read before it is pressed | test (`registry/indexes`); signed tree, then the folder's path | acc (`mcp-config`); test (each kind) |
| `mcpServers` type `host` | acc (Alpha's stage) | acc (`notes`: add, list, delete) | same path | — (a wrapper brings no host code) |
| `mcpServers` type `stdio`, with a secret file | test | acc (`forecast`: `${secretFile:WEATHER_KEY}`, its host through its proxy) | same path | acc (`mcp-config`) |
| `contained` / `readOnly` with no card | acc (Alpha) | acc (`add_note`, `list_notes`); `delete_note` cards | same path | never (a wrapper that runs a server gets `network: "any"`) |
| The same lists on a networked tree | — | acc (`save_place`, `forecast` each card) | same path | — |
| Tool row titles and result displays | acc (Alpha) | acc (`add_note`: "Add a note", a `note` display) | same path | — |
| Hooks, `own-bot`, with a handler | acc (Alpha) | acc (counts its own bot's turns, none of another's) | same path | — |
| Hooks with a `command` | test | — | same path | acc (fenced: no write outside, no undeclared host) |
| `commands` from the slash menu | acc (Alpha) | acc (`/note`, `/rain-alert`) | same path | as skills |
| `skills` through Glossary | acc | acc (`example-notes:tidy-up`) | same path | test |
| `agents` (agent definitions) | acc (Alpha) | acc (`example-notes:tidier` on Clover's own agent, no card, its report back) | same path | test |
| A bot in a child plugin, its theme and window skin | acc (Alpha) | acc (Notes keeper skins the window while its tab shows) | same path | — |
| A bot's model, chosen by its plugin | acc (Alpha's: no card, Clover's own) | acc (Notes keeper's first turn asks once, `bot-provider`) | same path | — |
| `client`: a page (`main`) and a sidebar entry | acc (the clover tree) | acc (TSX, its own layer connection, `host.call`, its synced store) | same path | — |
| `locales` | acc | acc (its page in its own words) | same path | — |
| `settings`: its own page changes a plain one with no card | — (the clover tree's parts use `plugin.settings.*`) | acc (the page's order switch) | same path | same path |
| `settings`: the Plugins page's controls | acc | acc (Notes' order, from the detail, no card) | same path | same path |
| A setting that feeds what it runs or reaches | test | test (the card names old and new) | same path | test (a command hook's environment carries every plain setting) |
| A secret, through the app's own key dialog | acc | acc (`WEATHER_KEY`, never on a page) | same path | test |
| `network:<host>` through its proxy | acc (network step) | acc (`forecast` reaches its local site with its key) | same path | acc (`network: "any"`, fenced) |
| `notify`, muted on the Plugins page | — | acc (`/rain-alert`; refused once muted) | same path | — |
| Turned off; removed on its card | acc | acc (frames and layer connection go; the folder and its synced store go) | same path | test |

What the pair found, and where it stands:

1. **A third-party plugin's plain settings had no editor.** Fixed: the Plugins page detail has a control per kind (text,
   number, switch, choice). A setting that feeds what the plugin runs or reaches is marked "changing this asks you first".
   A plugin's own page writes its own plain settings with no card (`plugin.layer.call`'s `settings.set`).
2. **A stdio server that names a setting or a secret didn't restart when it changed** (for example, the key entered after
   install). Fixed: only the servers naming the changed key are listed again, at most once every half second. Until the
   user sets it, the daemon's log says the server waits for that key, not that it failed.
3. **A bot plugin can't add UI outside its own tab.** By design (`bot_spot_outside_tab`): the example puts its bot in a
   child plugin and keeps the page in the parent.
4. **A third-party bot's model.** With no `model`, the bot runs on the user's default model. With one the user holds a
   key for, the bot's first turn asks once on a sealed card before spending that provider (`bot-provider`). A yes holds
   for that bot and provider. This is by design: a plugin's choice of provider is never the user's. The example names
   its model, and the acceptance expects that one card.
5. **`contained` and `readOnly` can't hold on a plugin that reaches the network or sends notifications.** By design:
   hence two examples, not one.
6. **`clover plugin validate` said "its host code can reach any host" on a Mac whose fence holds it.** Fixed: validate
   says what this computer's OK card would say.
7. **A window skin that misses Clover's own marks was dropped without a word at validation.** The example's first
   sidebar failed the attention mark on its selected row (2.79:1), and the app silently left the sidebar unskinned.
   Fixed: validate warns (`shell_dropped`) with the app's reason, by appearance. The example's colours now pass, and a
   test holds them to it.
8. **A `sidebar.app` entry whose title is words by language was dropped.** The manifest allows a language map, but
   the sidebar listed only plain-string titles, and so did the shell's title bar and Settings' sections. So the
   example's Notes entry never showed. Fixed: each reads the map in the user's language (`fieldText`); a map with no
   English is still no title.
9. **A third-party TSX client wasn't built when the plugin loaded.** Fixed by lane B's load-time build: the registry
   builds it after the user's OK and the app serves it from the plugin's own layer. The examples install exactly as
   written.
10. **The bundled desktop notifier never showed a plugin's notification.** Its host half translated with the plugin
   API's `t` and logged with `api.log.*`. In a host half every API member crosses to the core: `t` came back as a
   promise the core doesn't serve, and `log` isn't a call at all, so the banner's words failed and so did the line
   saying so. Fixed: its log is the console, and its banners use its own English table. `t` is now a component's
   alone, as the spec says (§5.5): the catalog lists it for components only, a host half's API type (`HostPluginApi`)
   has none, and the core refuses it there. A class test now holds every host-side call the catalog lists to a router
   handler or the catalog's own `notYet` mark. Each call no side serves is marked (see "Not served yet" below).
11. **The packaged twin** hasn't run these two steps yet: only the source run has. Every seam they use is also in the
   test twin. The folder picker reads its `.pick` file in a test or acceptance build only. A third-party TSX client is
   built by the daemon at install, which the window's acceptance-ui step already does on packaged runs. The fake model
   and the local sites are the harness's own.

## Not served yet

The SDK's catalog (`catalogs/api-calls.ts`) marks each plugin API call that no side serves in this build (`notYet`, with
why). Its type is absent from `PluginApi`, so calling it is a type error, and the core refuses it with "isn't available
yet". A class test (`plugin-host/tests/host-calls-served.test.ts`) fails when a call is neither served nor marked.

| Call | Why not yet |
|---|---|
| `memory.*`, `routines.*`, `usage.*`, `logs.*`, `audio.*` | No service of the core answers them for plugins yet |
| `keys.*` | The core keeps no key store for plugins yet (its only caller, the forwarder, is parked) |
| `commands.run` | A plugin doesn't run another plugin's command yet; the user does, from the composer |
| `browser.show`, `hide`, `onCdpEvent`, `watch` | Where a tab shows is the person's. `onCdpEvent` is the Browser panel's only (the bundled `clover/browser-view` component): a followed tab's `Page.*` DevTools events, nothing from Network, Runtime or the DOM; every other plugin is refused |
| `browser.tabs`, `open`, `close`, `navigate`, `screenshot`, `cdp` | This build's core runs no Clover Browser for plugins, and a host MCP server isn't yet told which session a tool call is for: the bundled Browser tool is listed as not available |

Approval cards: `approvals.pending` and `approvals.watch` are served to components only, with `approvals`: the cards that wait for the plugin's own bot (the bundled `clover` tree: all), ids and places, never their text. A host half has none.

`browser` itself is a bundled-tree capability (`bundledOnly`): a third-party plugin that declares it fails validation, so
no OK puts it in force. Raw DevTools on the person's signed-in pages is more than an OK card's one line can carry.

A host half that reads a member the API doesn't have (`api.env`, `api.log`) gets a TypeError naming it, where it reads
it. Feature-test with `in`, which never throws: `"files" in api`, `"get" in api.settings` (false for a call not served
yet, so `"memory" in api` is false in this build).

`conversation.answer` is a component's alone (the user's own answer to a question card), never a host half's.

## Not for Alpha

These are infrastructure kinds. A bot plugin faking one would be a special case:

- **`models`, `voices`, `agentBackends`:** Clover's own model, voice and agent plugins bring these.
- **`computerProviders`, `computer`, `relays`, `notifiers`, `companions`:** Clover's own plugins bring these too.
- **`helper` programs, plugin sign-ins, `secrets`, `network:<host>`:** Alpha needs none of them, and any network would cost her stage tools their no-card run.

## Gaps, in one list

1. The core's own updates (a message, a card, an agent finishing) don't reach the notifiers yet, and a `runsOn: "each"` notifier is called on this computer only. A plugin's `notify.send` limits are lost on a daemon restart.
2. Plugins can't contribute routine templates; a skill writes one with the user instead.
3. `http` MCP servers aren't served.
4. No hook events for an approval waiting or an error.
5. Bot instructions come in one language.
