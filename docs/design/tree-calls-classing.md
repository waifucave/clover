# The tree door by capability: classing table (F2)

F2 of the general-capabilities contract (rule R1: no door checks a plugin's id). Today the app's door for the bundled
tree's calls (`apps/desktop/src/main/ui/tree-calls.ts`) lets a call through when the caller is a bundled part in the
`moss` layer (`runtime.treePart`) and its part id is on the call's list. A part of any other plugin never reaches
the table at all: its call falls to the `layer` door, which refuses these methods. This file classes every call the
table allows today by the capability that will gate it instead.

Base: `origin/lane-int/try15` at a203f3705. Lane G's capabilities (`user.send`, `approvals.all`, `overlay`, `tray`) are
on `origin/lane/g-surface-rules`, not yet on try15; they are marked "(G)".

Legend: **existing** = in `catalogs/capabilities.ts` now; **NEW** = proposed here, with its `lets`, OK line and `warns`;
**none** = no capability (why given); "gesture" = the call counts only inside the user's own key press or click (the
SendGate), and keeps that rule for every holder.

## 1. Calls in `TREE_CALLS`

| Call | Held today by | Gated by | Gesture today → after | Notes |
|---|---|---|---|---|
| `ui.settings` | any tree part (settings, bot-editor, voice, shell…) | NEW `app.settings` | no → no | Returns the whole UI settings record: look, theme, language, the layout lists and overrides. Not display state of the caller's own window. |
| `ui.set`, shape "look" (`settingsParams`: `appearance`, `globalTheme`, `language`) | moss/settings | NEW `app.settings` | yes → yes | Shape decided from the params, not the part. |
| `ui.set`, shape "a bot's tab lists" (`editorListParams`: layout patches off, plugins' hides off, for one bot) | moss/bot-editor | NEW `bots.edit` | yes → yes | |
| `ui.set`, shape "speak replies" (`voiceMuteParams`) | moss/character, moss/voice | `audio` (existing) until lane A deletes it | yes → yes | Deleted by `lane/a-voice-refound` (speakReplies leaves the core for the Voice plugin's own settings). |
| `voice.stop` | moss/character | `audio` until deleted | yes → yes | Deleted by `lane/a-voice-refound`. |
| `voice.played` | moss/shell | `audio` until deleted | no → no | Deleted by `lane/a-voice-refound`. |
| `voice.speak` | moss/conversation | `audio` until deleted | yes → yes | Deleted by `lane/a-voice-refound` (the speak button becomes the Voice plugin's own `conversation.message.action`). |
| `voice.listen` (held) | moss/shell | `audio` until deleted | held → held | The shell's pieces of a push-to-talk recording. Deleted by F1's listening half. |
| `plugin.settings.get` / `.set`, own plugin | moss/settings, moss/voice | **none**: the component's own `settings.get`/`settings.set` (item 5b below) | set: voice yes → own-settings path has no gesture (as the host half) | These entries go: the part uses `api.settings` like any plugin. |
| `plugin.settings.get` / `.set`, the edited bot's own plugin (bot scope) | moss/bot-editor | NEW `bots.edit` | set: yes → yes | Main checks the id is a bot's (from `bot.list`), never the page's word. |
| `plugin.settings.get` / `.set`, any plugin's id | moss/plugin-index (`anyId`) | NEW `plugins.manage` | set: yes → yes | A secret never through a page (`noSecret`); a host move still carded by the core. |
| `bot.setUserLayer`, every field but the avatar | moss/bot-editor | NEW `bots.edit` | yes → yes | `userLayerWhy` keeps the field split, decided by capability: `bots.edit` writes every field but `avatar`/`avatarCredit`. |
| `bot.setUserLayer`, `avatar` and `avatarCredit` only | moss/character | NEW `bots.avatar` | yes → yes | |
| `bot.importAvatar` | moss/character | NEW `bots.avatar` | yes → yes | Token from `ui.pick` for this use. |
| `session.resend` | moss/conversation | `user.send` (G) | yes → yes | Sends the user's own earlier message again, as the user: strictly less than `user.send` (no text of the part's). |
| `conversation.messageAction` | moss/conversation | **none**: the caller must declare the spot `conversation.message.action` (main finds the entry among the spots the calling part declares) | yes → yes | The handler runs in the plugin that chose to contribute the action, with `{session, seq}` only. |
| `session.diff` | moss/panel-diff | `conversation.read` (existing) | no → no | A session's changes. |
| `session.outputs`, `session.context`, `session.connectors` | moss/panel | `conversation.read` (existing) | no → no | |
| `account.status` | any tree part (shell, sidebar, settings) | NEW `account.read` | no → no | Returns signed in or not, provider, the user's id, email and name. `shell.account` is different: it is what the shell reports, a name and a detail. |
| `archive.list`, `archive.history` | any tree part (archive, conversation) | `conversation.read` (existing) | no → no | Archived conversations. |
| `plugin.list`, `plugin.get`, `plugin.ui` | any tree part (bot-editor, character, plugin-index, settings) | NEW `plugins.read` | no → no | Every plugin's record and manifest. `plugins.watch` stays events-only ("it can call nothing"). |
| `plugin.index.list`, `plugin.index.search` | any tree part (plugin-index) | NEW `plugins.read` | no → no | |
| `plugin.auth.list`, `plugin.dev.list`, `plugin.grant.list`, `command.list`, `notify.mutes` | moss/plugin-index | NEW `plugins.read` | no → no | |
| `plugin.logs` | moss/settings, moss/plugin-index | `logs.read` (existing) | no → no | Line cap kept (`PART_LOG_LINES_MAX`). |
| `models.list` | moss/bot-editor | `bots.read` (existing) | no → no | Which models a bot can be set to, with whether each provider is signed in. The composer gets it through its spot, not here. Alternative: under `bots.edit`. |
| `plugin.setEnabled` | moss/settings, moss/plugin-index | NEW `plugins.manage` | yes → yes | |
| `tool.permissions` | moss/settings | NEW `tools.permissions` | no → no | |
| `tool.setPermission`, `tool.takeBackRule` | moss/settings | NEW `tools.permissions` | yes → yes | Decides whether a card is raised at all. |
| `point.active.list` | moss/settings | NEW `app.settings` | no → no | Contract P4: "Only the user changes it: Settings draws one picker". |
| `point.active.set` | moss/settings | NEW `app.settings` | yes → yes | |
| `computer.list` | plugin-index, settings, shell, sidebar, composer, panel | `computers.read` (existing) | no → no | |
| `ui.pick`, use `plugin.install` / `plugin.dev.add` | moss/plugin-index | NEW `plugins.manage` | yes → yes | `PICK_USES` keyed by capability, not part. |
| `ui.pick`, use `bot.importAvatar` | moss/character | NEW `bots.avatar` | yes → yes | |
| `ui.secret`, any plugin's key or `api-key` sign-in | moss/plugin-index | NEW `plugins.manage` | yes → yes | Opens the app's own key dialog; the key never passes the page. |
| `ui.secret`, the edited bot's own keys | moss/bot-editor | NEW `bots.edit` | yes → yes | |
| `plugin.install`, `.remove`, `.update`, `.pin`, `.restart` | moss/plugin-index | NEW `plugins.manage` | yes → yes (an update's `list: true` is a read) | `plugin.remove` and `.update` always on a sealed card (main sets `card`); an install still lands with its OK card. |
| `plugin.index.add`, `plugin.index.remove` | moss/plugin-index | NEW `plugins.manage` | yes → yes | |
| `plugin.auth.signIn`, `plugin.auth.signOut` | moss/plugin-index | NEW `plugins.manage` | yes → yes | A key only in the app's key dialog; sign-out on a card. |
| `plugin.dev.add`, `.remove`, `.renew` | moss/plugin-index | NEW `plugins.manage` | yes → yes | Renew on a card. |
| `plugin.grant.remove`, `plugin.setScope`, `plugin.setComputers`, `plugin.confirmAdult` | moss/plugin-index | NEW `plugins.manage` | yes → yes | `setScope` and `setComputers` have no bundled caller today (backlog). |
| `notify.setMuted` | moss/plugin-index | NEW `plugins.manage` | yes → yes | MOSS's own notices are never muted (kept). |
| `computer.setLevel`, `device.revoke`, `main.set` | nobody (`card`) | unchanged: never on this route, for every holder | — | |
| `models.catalog`, `session.changes`, `session.createPr`, `session.setModel`, `session.interrupt`, `session.stop` | nobody (`unserved`) | unchanged | — | |
| `card.answer`, `card.confirm` (`NEVER`), `session.send` (`SEND_ONLY`) | nobody | unchanged | — | |

## 2. Other doors in the app's main process that decide a call by id

| Where | What it checks today | Gate or name | Proposed |
|---|---|---|---|
| `runtime.treePart` (bundled, top id `moss`, layer `moss`) | who reaches the table at all | gate | Gone: every part's call goes through the table, the caller's capabilities (`runtime.capabilitiesOf`) decide. |
| SDK `useCore()` (`plugin-sdk/src/ui/index.tsx`) | returns undefined unless the plugin id is `moss` or `moss/…` | gate (client side) | Any part gets it; the door decides each call. Its events already go by area and capability in the core. |
| `PICK_USES` (by part) | which pick uses a part may ask for | gate | By capability (above). |
| `userLayerWhy`, `editorSetting`, `pageParams`' bot branch, `secret`'s bot branch (by `CHARACTER_PART` / `BOT_EDITOR_PART`) | which fields, which ids | gate | By capability and params shape (above). |
| `composer-calls.ts` `c.tree` | `commands`, `runCommand` and the three listen ops only for the bundled composer; a bundled composer's `setModel` on the app's connection, another's as a carded layer call | gate | `commands`/`runCommand` → NEW `commands.run`; listen ops → `audio` until F1's listening half deletes them; `setModel` on a bot's main conversation → app connection with `bots.edit`, else the carded layer call as today. |
| `runtime.composerOf` (the declaring document must be the bundled tree's) | whether a composer mount's session is trusted | gate | Kept for now as a fact of where it is drawn: the session comes from the declaring document's props, and only the shell (or a bot tab it draws) declares `composer`. A folder copy of the COMPOSER passes (its declaring document is still the shell's). A third-party shell or conversation that declares `composer` would need a rule; out of F2 unless the controller wants it. |
| `runtime.userSender` (else `treePart`) | who sends the user's words | gate | Lane G turns it into `user.send` (G). |
| `runtime.mainShell` (`"moss/shell"`) | who may drag the window | gate | The part in `app.root` (whichever plugin fills it). |
| `electron.ts` `moss:active-session` (top id `moss`) | who says what the window shows | gate | The part in `app.root`, or `shell.control`. |
| `electron.ts` `moss:shell` (refuses `moss/…`) | the shell API refused to the tree's parts | gate | Dropped: the tree's parts are held to `shell.read`/`shell.control` like anyone's. |
| `runtime.readsQuestions` (top id `moss`) | which documents hear pending questions | gate on data | The `moss` layer's document hears them when a part of it holds `conversation.read` (kept: it is a shared document); any other by its own capability, as today. |
| `runtime.shellFrames`, `shellMessage` | the shell document for the voice player's activation | names | Deleted with F1 (the player goes). |
| `layer/moss/ids.ts` `modules` | which bundled children the layer's bundle binds | names | Stays (it names what the bundle contains; it gates nothing). |
| `spots.ts` "stock" (`topId === "moss"`, bundled) | which entry fills a spot | resolution, not a call | Not F2; an installed entry already wins over a bundled one (rule 6), so a folder copy fills the spot. |

## 3. Proposed new capabilities (for the controller's ruling)

| Name | `lets` | OK line | warns | Category |
|---|---|---|---|---|
| `app.settings` | Read MOSS's own settings (look, theme, language, layout lists, which filler of each one-at-a-time point is active) and, on the user's own press in its frame, change the look, the theme, the language and the active filler | "reads MOSS's settings and changes its look, language and which plugin does each job when you press its controls" | false | (c) |
| `bots.edit` | Change a bot's settings on the user's own press: every field of its user layer but the avatar, its tab's layout switches, its own plugin's bot settings and keys (in MOSS's key dialog); read the model list | "changes your bots' settings, models and keys when you press its controls" | true | (c) |
| `bots.avatar` | Set a bot's avatar on the user's own press: import a model file the user picks in MOSS's own dialog and write the avatar and its credit note | "changes your bots' avatars to files you pick" | false | (c) — or deferred to F6 |
| `plugins.read` | Read every plugin's record, manifest, settings view, sign-ins, development folders, granted files, commands, notification mutes and the indexes | "sees every plugin you have, its settings and what it may do" | false | (b) — or folded into `plugins.manage` |
| `plugins.manage` | On the user's own press: install, remove, update, pin, restart, switch on and off; add and remove indexes and development folders; sign plugins in and out (a key only in MOSS's key dialog); change any plugin's settings; take back picked files; mute notifications. Removal, update, sign-out and renew stay on sealed cards | "installs, removes, switches on and off and changes the settings and sign-ins of your plugins when you press its controls" | true | (c) |
| `tools.permissions` | Read and, on the user's own press, change what each plugin tool may do (always allow, ask, always block), MOSS's own bundled plugins' tools included, not the built-in shell and file tools; and take back saved card rules | "sets any plugin's tools, MOSS's own plugins' included, to act without asking you, with no card (not MOSS's built-in shell and file tools)" | true | (c) |
| `account.read` | Read whether MOSS is signed in to an account, with which provider, and the account's name and email | "sees the name and email of your MOSS account" | false | (b-ish, personal data) |
| `commands.run` | From a composer the user picked: list every running plugin's commands and run one as the user, on the user's own press, with that plugin's own powers | "runs your plugins' commands as you when you press a key in it" | true | (a) |

Alternatives for the controller: one `plugins.manage` holding the reads too (no `plugins.read`); `tools.permissions`
folded into `app.settings`; `bots.avatar` left out until F6; `account.read` folded into `shell.read`.

## 4. Calls reachable with no capability after F2

- `conversation.messageAction`: only from a part that declares `conversation.message.action`, only with the user's
  press, and it runs the contributing plugin's own handler with `{session, seq}`.
- A component's own plugin's settings (item 5b): `settings.get`/`set` at account, device and bot scope, by the host
  half's rules (any valid bot id; never a secret's value, never a setting written into what the plugin runs, the
  layer's size and rate caps). Never another plugin's.

## 5. Item 5b: a component's own settings at every scope

`packages/core/src/plugin-host/api/settings.ts`: `layerView` and `layerSet` refuse bot scope today ("a page names no
bot"). They take `{ bot }` as the host half's `settings.get(key, { bot })` / `set(key, value, { bot })` do (`#slot`:
a valid bot id), keeping the layer's limits. Then `VOICE_PART` and `BOT_EDITOR_PART`'s own-settings entries leave the
tree door, which `lane/a-voice-refound` waits for.

## 6. Ruled and built (the controller, 2026-11-15)

All eight new capabilities as proposed, with these words: `app.settings` warns ("reads MOSS's settings, and changes its
look, language and which plugin does each job when you press its controls"); `plugins.read` warns ("sees every plugin you
have, its settings and what it may do"), separate; `plugins.manage` carries `plugins.read` (`IMPLIED_CAPABILITIES`);
`account.read` warns; `bots.avatar` now, no warning. Fix round (read 52): `bots.edit`'s OK line names what it changes ("changes your bots' settings when you press its controls: their names, instructions, models, voices and keys, and whether a bot's browser may reach your home network"); `plugin.confirmAdult` always on a sealed card; `active-session` from the `app.root` part only; opening a place needs the press. Section 2 as proposed; `runtime.composerOf` stays (backlog).

What the build changed against the table above:
- `ui.settings` is `app.settings` OR `bots.edit` (the bot editor merges a bot's tab lists into the stored lists).
- `plugin.settings.*` naming a bot is `bots.edit` (the edited bot's own plugin) or, for a holder of `plugins.read` /
  `plugins.manage` without `bots.edit`, the Plugins page's path (the bot dropped).
- `ui.set`'s shape is decided by its one key: `lists` alone is `bots.edit`, `voice` alone is `audio`, anything else the
  look (`app.settings`, unknown keys dropped).
- The composer holds `bots.edit` (its model picker on a bot's main conversation goes on the app's connection), `commands.run`
  and `audio` (push-to-talk until F1's listening half).
- A part without the capability: a method the `layer` role has goes to the layer door (the core's own rules and cards);
  any other is refused, naming the capability.
- Opening a place in the main window (`moss:open`) is `shell.control`'s; the window's shell (`shell-report`, the drag,
  `active-session`) is the part the core mounted in `app.root`.
- After the re-founded Voice (F1's speaking half) landed: `voice.stop`, `voice.speak`, `voice.played` and the speak-replies
  shape of `ui.set` are gone from the door; the Voice plugin reads and writes its own settings through the plugin API and
  holds no door capability; the character and conversation parts no longer hold `audio`, the shell no `app.settings`.
  `voice.listen` stays behind `audio` until the listening half.
