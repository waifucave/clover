# What a plugin can contribute, and what works

Every kind of thing a Clover plugin can bring, whether it works end to end today, and what Alpha (`plugins/alpha`, the
reference plugin) does with it. Alpha uses every kind that fits a bot for a real reason; the kinds she leaves out are
named with why.

The status is for `int/next` at 3542d0f0f (2026-11-11):

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
| `agents` (agent definitions) | partly | `study-buddy`, a researcher she can hand reading work to (`Agent({ agent: "alpha:study-buddy", … })`). The definition brings words only. Its instructions go before her brief, and its backend, model and effort fill only what she leaves out, under the same checks. The folder and the computer are always hers. The OK card names it, and adding or changing one asks again. The agent's row says whose definition it started from. | **The bot's Agent tool isn't wired in the daemon** (`botCoreTools` gets no `agents`), so no bot can start an agent in the shipped app yet. The manager runs; the coordinator rules on wiring it. |
| `locales` | works | English and Japanese for her UI strings, setting titles and command descriptions. | Bot instructions are in one language only. |
| `commands` | partly | `/scene`, `/mood` and `/outfit`, served by her host code. | There is no slash menu in the composer yet (lane A's). `command.list` and `command.run` work, and so does a menu entry that runs one. |
| `settings` (string, number, boolean, enum, color, secret; scopes account, device, bot) | works | The starting scene (meadow by default), effects, reactions on or off, voice on or off, and a nickname for you, one per bot. Her server and her hooks both honour them. | — |

## Code and tools

| Kind | Status | What Alpha does with it | What's missing |
|---|---|---|---|
| `host` code (`runtime: "bun"`) | works | Her stage's keeper: an MCP server, her hooks, her commands, and what her tab may call. It runs in her tree's own fenced plugin process, with no network and no capability (her tree declares none; a test holds it to that). | — |
| `mcpServers` type `host` | works | Her `stage` server (`mcp__alpha-stage__*`): `set_expression`, `play_motion`, `set_scene`, `set_mood`, `toggle_outfit`, `pin_note`, `unpin_note`, `celebrate`, `stage_status`. Names come from whatever model her tab loaded; a wrong name is refused with a quoted list of the right ones. | — |
| `mcpServers.*.contained` (display-only tools) | works | Every stage tool but `stage_status`. Each runs with no card at the default level, asks at "ask", and is refused at read-only. The acceptance run checks all three. They hold only because her whole tree reaches no network and reads at most Clover's own state. | — |
| `mcpServers.*.readOnly` (tools that only read) | partly | `stage_status`. | The bot approval check doesn't read the list yet: lane C's wiring (`lane/c-readonly-tools`) is under review. Until it lands, `stage_status` asks like any plugin tool. Once it does, it runs with no card at every level that runs reads, read-only included. |
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
| `notify` capability and `notify.send` | partly | None yet: her own turns need no notification. | The core path is a head under review: the mute, the rate, never over a card, the plugin's name always shown. Until it merges, `notify.send` is refused as not served. The core's own updates (a message, a card, an agent finishing) still don't reach the notifiers. |

## Her look (lane E's rows)

| Kind | Status | What Alpha does with it |
|---|---|---|
| `themes`, `bot.theme`, `bot.layout` | works | Her theme (`tab/theme.json`, its meadow) and her tab's layout (`tab/layout.json`). |
| `bot.avatar` and the `avatar` renderers (VRM, Live2D) | works | A placeholder VRM model today. Live2D from whatever model the user loads is lane E's next step; no model file of the owner's goes in the repo. |
| `client` components, bot-tab spots (`bot.tab`, `bot.header`, `bot.stage`, `bot.side`, `conversation.message`, `tool.result` …) | works | Her stage component, which draws the stage document, and her transcript's styling: lane E's work in progress, not on `int/next` yet. |
| `island.tab`, `app.surface`, `sidebar.bot`, `status`, `settings.section`, `panel` | works | Lane E's choice. A third-party island tab carries its plugin's name and can't raise the island. |
| `pill.target` | works | None: the pill already messages bots. |

## Not for Alpha

These are infrastructure kinds. A bot plugin faking one would be a special case:

- **`models`, `voices`, `agentBackends`:** Clover's own model, voice and agent plugins bring these.
- **`computerProviders`, `computer`, `relays`, `notifiers`, `companions`:** Clover's own plugins bring these too.
- **`helper` programs, plugin sign-ins, `secrets`, `network:<host>`:** Alpha needs none of them, and any network would cost her stage tools their no-card run.

## Gaps, in one list

1. The bot's Agent tool isn't wired in the daemon, so plugin agent definitions can't be used by a bot yet.
2. `mcpServers.*.readOnly` doesn't skip the card until lane C's wiring merges.
3. `notify.send` until its head merges. After that, the core's own updates still don't reach the notifiers, and a `runsOn: "each"` notifier is called on this computer only.
4. No slash menu for plugin commands in the composer (lane A).
5. Plugins can't contribute routine templates; a skill writes one with the user instead.
6. `http` MCP servers aren't served.
7. No hook events for an approval waiting or an error.
8. Bot instructions come in one language.
