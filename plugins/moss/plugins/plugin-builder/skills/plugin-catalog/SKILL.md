---
name: plugin-catalog
description: Everything a MOSS plugin can add or use, straight from the SDK's catalogs - the core's points, the UI spots, capabilities and the plugin-API calls each one opens (with the calls not served yet), hook events, design tokens. Look up a name here before you put it in a manifest.
---

# What a plugin can add or use (the catalogs)

Use this as a lookup table while writing `moss.json` (plugin-manifest) and code (plugin-ui, plugin-host). The block
below is generated from the SDK's catalogs; trust it over memory.

How to read it:

- A **point** is a top-level key under `contributes` (`"mcpServers": {…}`, `"triggers": […]`). Its shape says whether
  you give one entry (`single`), a list (`list`) or entries by key (`keyed`).
- A **spot** is a place in the app's UI. You never add a top-level key for a spot: you add an entry to
  `contributes.ui` with `"spot": "<name>"` and a `component` (a function your client exports), or for data spots the
  fields the spot lists. A spot a part declares appears only where that part is shown. "needs" is a capability your
  plugin must hold to fill it.
- A **capability** opens plugin-API calls. Ask only for what your code calls: each one is a line on the user's OK card.
  Calls marked NOT SERVED YET exist in the catalog but answer "isn't available yet": don't build on them.
- Names that end in `<plugin-id>` or `<host>` take your value: `call:alpha`, `network:api.example.com`.
- Your own points and spots are named `<your-id>.<name>` (plugin-examples shows one).

<!-- generated: the catalogs (bun run gen in plugins/moss/plugins/plugin-builder) -->

## The core's points (a top-level `contributes` key each)

| key | shape | data or code | what the core does with it |
| :- | :- | :- | :- |
| `bot` | single | data | Builds `<bot-instructions>`, picks the default model, keys memory by the bot's id (§6). |
| `models` | list | either | Calls the adapter, or the declared endpoint, for every turn; the welcome guide reads the sign-in methods (§3.3). |
| `mcpServers` | keyed | either | Dispatches tool calls, builds the MCP block and shows MCP Apps pages. |
| `skills` | list | data | Indexes them in `Glossary` (§6.8). |
| `agents` | list | data | Offers these presets to `Agent`: backend, model, effort, instructions, computer, root folder, plugins (§9.3). |
| `agentBackends` | list | code | Starts agents for `Agent`: an ACP agent or a vendor cloud agent (§9.3). |
| `hooks` | list | code | Calls them in the turn loop; a hook can block or adjust, never replace the runtime or skip approvals. |
| `commands` | list | code | Runs a plugin's public functions for any client at once, with no model turn (§5.4). |
| `triggers` | keyed | code | Arms them for routine files (§7). |
| `turns` | list | data | Names of the plugin's own one-at-a-time turns that another plugin may take (`<plugin id>/<name>`, §5.4 "Turns"); its own need no entry. |
| `computerProviders` | keyed | code | Creates, resizes and deletes the VMs that cloud computer folders describe (§9.2). |
| `computer` | single | data | A cloud computer, created after the user's OK (§9.2). |
| `relays` | list | code | Carries encrypted traffic when two devices can't connect directly, or holds encrypted sync mail (§8.3). |
| `notifiers` | list | code | Told when a bot needs the user or has answered (which bot and session, and whether a message, a card or a question waits; never the words), so it can notify th… |
| `companions` | list | code | Serves a remote client within the fixed list of remote calls (§10). |
| `themes` | list | data | Applies the base theme, the user's global theme and each bot's theme in its tab (§5.5). |
| `locales` | keyed | data | Supplies strings for the core's own text and each plugin's keys, in the user's language (§5.5). |

## Spots (fill one with a `contributes.ui` entry: `{ "spot": "<name>", … }`)

| spot | shape | declared by | needs | what it is |
| :- | :- | :- | :- | :- |
| `app.root` | single | app | — | The main window's root: the shell, which declares every other spot. |
| `app.surface` | list | app | — | Top-level floating windows, such as the island and the Dispatch pill; `window` says how they float. |
| `app.background` | list | app | — | A part with no place in the window: it runs in a hidden window of its own while MOSS is open and the plugin runs, outlives the main window, is never slept or slowed, and may play sound when the plugin holds `audio`. At… |
| `app.tray` | list | app | `tray` | A line in the menu-bar (tray) menu, with the `tray` capability: `toggles` names one of the plugin's own `app.surface` entries (the line hides and shows it, and the choice is kept), or `command` names a command of the pl… |
| `sidebar` | single | shell | — | The sidebar: the app's own, the same on every tab. A plugin may fill it for the whole app (its own component, in its own frame, reading and acting through `shell.*`); an entry tied to a bot's tab (`when.bot`, or inside… |
| `sidebar.app` | list | shell | — | App buttons in the sidebar; `opens` names the `main` and `panel` key it shows. |
| `main` | keyed | shell | — | The main area, keyed by route: agent, settings, plugins, app. |
| `panel` | keyed | shell | — | The panel host, keyed by panel: each stock panel (session, terminal, diff, files, browser, agent) is a plugin of its own, and replaceable. An entry whose key is not a stock one ADDS a panel of the plugin's own, with a b… |
| `panel.view` | keyed | shell | — | A spot inside each panel view, keyed by the view's id. |
| `settings.section` | list | settings | — | A section of the settings screen, which the settings part (`main` key `settings`) declares. |
| `status` | list | shell | — | The shell's status bar; the inherited `tile` becomes an entry here (§12). |
| `conversation` | single | session-tab | `sessions.read` | The conversation view. |
| `composer` | single | session-tab | `conversation.post` | The composer; a send counts as the user's only on a real key press or click (§5.5). Its entry also gets the host callbacks (`useComposerHost`): the models its session can switch to, a model switch, interrupt and stop; e… |
| `composer.action` | keyed | composer | — | The composer's buttons, keyed by action id: an entry keyed `attach`, `model`, `level`, `send` or `stop` draws that button another way (or hides it); one with any other key adds a button of its own, drawn among the butto… |
| `conversation.message` | keyed | conversation | `sessions.read` | One message, keyed by kind; the `approval` cell can't be hidden. The `tool` cell gets a run of calls. |
| `conversation.message.extra` | list | conversation | `sessions.read` | Add-ons under each message, with a UI of their own. A plugin outside MOSS's own tree draws in its own layer, so each one is a frame under every message: for a button, use `conversation.message.action`. |
| `conversation.message.action` | list | conversation | — | A small button the conversation draws itself in a message's row of actions (beside copy and speak), no frame and no component: `title` is its tooltip, `icon` a picture in the plugin's folder, `on` which messages carry i… |
| `tool.result` | keyed | conversation | `sessions.read` | A tool's result, keyed by tool name (`mcp__blender__*`); `item` is the one call. |
| `file.preview` | keyed | file-view | — | A file's preview wherever one shows, keyed by media type (`image/*`); in a bot's plugin, only inside its tab. |
| `island.tab` | list | island | — | A tab of the island, such as Needs you, Devices or Usage. The island labels a third-party tab with its plugin's name, and only the `moss` tree's tabs raise the strip's attention. |
| `pill.target` | list | pill | — | Something the Dispatch pill can message besides the bots: `handler` (a `PillTargetHandler`) gets the user's words. The pill names it with its plugin's name, and leaves out one titled as a bot. |

## Data points other plugins declared (a top-level `contributes` key each)

- `webhook.ingress` (list, code, declared by moss/trigger-webhook): Ways for webhooks to reach a device: the waifucave forwarder, the user's cloud computer, a tunnel (§7).
- `usage.sources` (list, code, declared by moss/usage): A tool of the user's installed on this computer whose usage MOSS reads: its plan windows (`plan`) and the token counts its own session files hold (`ingest`), through its own program and its own folders (`host.outside`),…
- `island.line` (list, code, declared by island): A line a plugin puts on the island: one line of plain text, an optional icon from the island's small named set and an optional progress bar, drawn in the island's own style with the plugin's name beside it. The island c…

## Capabilities (`capabilities` in the manifest; each is a line on the OK card)

| capability | what it lets | the OK card says | |
| :- | :- | :- | :- |
| `conversation.read` | Read every bot's conversations and follow them live (there is no per-bot grant yet); sealed card fields never reach it | reads your conversations with all your bots |  |
| `conversation.post` | Add a note to any bot's conversation, or send any bot a message (there is no per-bot grant yet); a turn it starts is the plugin's, never the user's | adds notes and sends messages to any of your bots |  |
| `memory.read` | Read bots' memories | reads your bots' memories |  |
| `bots.read` | Read the list of every bot and their settings (there is no per-bot grant yet) | sees all your bots and their settings |  |
| `routines.read` | Read the list of routines and their runs | sees your routines and their runs |  |
| `computers.read` | Read the computer registry: each computer's folders, level and state | sees your computers, their folders and levels |  |
| `computers.control` | Take and release holds and the user-working mark, learn where MOSS's windows are, and say when an action is running | controls the screen and input of your computers | a warning |
| `devices.read` | Read the user's devices: their names, kinds, links, which one is the main, and which are online | sees your devices |  |
| `approvals` | Hear which cards are pending, never their text, and place their sealed frames | restyles approval cards | a warning |
| `approvals.all` | Needs `approvals` too: hear the meta of every pending card, not only its own bots' (a plugin's OK card, a change from Settings), place their sealed frames in a surface of its own,… | shows all your approval cards, whichever bot or plugin asks, and takes your yes or no on them | a warning |
| `user.send` | Send text the part chooses to any bot, any session (coding sessions too) or any `pill.target` entry, as the user, on any real click or key press inside its own frames (`useUserSen… | sends messages to your bots and sessions as you, with text it chooses, when you click or press a key in its window, or press its own key anywhere in MOSS Code's window, or up to 30 seconds after you let go | a warning |
| `overlay` | Open surfaces (`app.surface` entries) that float above every other window on every desktop, over the menu bar and full-screen apps, as large as the screen (`alwaysOnTop`); without… | shows windows on top of everything else on your screen | a warning |
| `tray` | Add items to MOSS's menu-bar (tray) menu (`app.tray` entries): one that hides and shows a surface of its own, or runs a command of its own | adds items to the menu in your menu bar |  |
| `files` | Read and write files through the folder tree, inside the fence | reads and writes files on your computers |  |
| `project.write` | Let its hooks and stdio MCP servers change files in the session's project folders (never `.git/hooks`, `.git/config` or a credential file); without it, those folders are read-only… | changes files in your project folders | a warning |
| `browser` | Drive the MOSS Browser on this computer. A host half: only the session whose tool call it serves, while that call is open, on that session's own tab, out of sight. A component the… | drives the MOSS Browser: a bot's own tab as its tool; its page sees every MOSS Browser tab on this computer, its address, title and picture, ones you opened yourself included, with no asking, and opens, closes and acts in tabs when you press its controls, signed in wherever you signed in there | a warning |
| `terminal` | Open terminals on the user's computers from a component (never on one at read-only), and resize, read and close its own: what a terminal runs is only what the user types or pastes… | opens terminals on your computers that run what you type in them, as you, outside MOSS's sandbox, and sees what they show | a warning |
| `shell.read` | Read where the window is: the tab showing, the sidebar's and panels' state, the sidebar's app buttons and how far the native window controls reach | sees which tab and panels are showing |  |
| `shell.control` | Move the window's own parts when the user presses its controls: show a tab, a panel or the settings, fold the sidebar, open the bot's editor, drag the window; never a conversation… | lets its own buttons move around MOSS's window |  |
| `plugins.install` | Install plugins from the indexes and npm for the user to OK: each lands found, with its sealed OK card, and nothing it installs runs before that OK | downloads other plugins from the indexes and npm onto your computer, each waiting for your OK on its own card | a warning |
| `plugins.watch` | Hear which plugins appear, change state or go (their ids and states only), and why a yes on a plugin's change card couldn't be done; it can call nothing | sees every plugin you have, whether it's on, and when you add or remove one | a warning |
| `usage.read` | Read usage rows and plan readings | sees your usage and plan readings |  |
| `logs.read` | Read MOSS's logs and every plugin's | reads MOSS's logs and every plugin's logs |  |
| `notify` | Send the user a notification through the notifiers | sends you notifications |  |
| `audio` | Play sound with no press from the user, even from a part kept in the background, and take the device's speech turn (`device/speech`) so it never talks over another plugin | can play sound at any time, even while no window of it shows | a warning |
| `microphone` | Open the user's microphone from its own frames (`getUserMedia({ audio: true })`), whenever its parts run, including a part kept in the background; the system's own permission stil… | hears your microphone, also while no window of it shows | a warning |
| `app.settings` | Read MOSS's own settings (its look, theme, language, layout lists, and which plugin is active for each one-at-a-time job) and, on the user's own press in its frame, change the loo… | reads MOSS Code's settings, and changes its window's look, language and which plugin does each job when you press its controls | a warning |
| `bots.edit` | On the user's own press in its frame: change a bot's settings (its name, instructions, model, voice, and whether its browser may reach the home network), its tab's layout switches… | changes your bots' settings when you press its controls: their names, instructions, models, voices and keys, and whether a bot's browser may reach your home network | a warning |
| `plugins.read` | Read every plugin's record and manifest, its settings (a secret only as set or not), sign-ins, development folders, granted files, commands and notification mutes, and the plugin… | sees every plugin you have, its settings and what it may do | a warning |
| `plugins.manage` | On the user's own press in its frame: install (each landing behind its own OK card), remove, update, pin, restart and switch plugins on and off; add and remove indexes and develop… | installs, removes, switches on and off and changes the settings and sign-ins of your plugins when you press its controls | a warning |
| `tools.permissions` | Read and, on the user's own press in its frame, change what each plugin tool may do (always allow, ask, always block): every installed plugin's tools, MOSS's own bundled plugins'… | shows and changes, for each plugin tool, whether it may be used and whether it asks first, and can set any plugin's tools, MOSS's own plugins' included, to act without asking you, with no card (not MOSS's built-in shell and file tools) | a warning |
| `account.read` | Read whether MOSS is signed in to an account, with which provider, and the account's id, name and email | sees the name and email of your MOSS account | a warning |
| `commands.run` | From the composer it fills: list every running plugin's commands and, on the user's own press, run one as the user, with that plugin's own powers (a carded action still raises its… | runs your plugins' commands as you when you press a key in it | a warning |
| `sessions.read` | Read the user's code sessions and follow them live, and nothing of bots' conversations; sealed card fields never reach it | reads your code sessions |  |
| `sessions.start` | Start a session with a coding agent, on the user's own press, in a folder the user picked in the app's own dialog (never a path the plugin names), with no words of the plugin's | starts sessions with a coding agent in a folder you pick | a warning |
| `activity.read.sessions` | Read the activity feed of the user's code sessions: each one's state (idle, listening, thinking, working, asking, stuck, done, asleep), its title (which a bot or the person wrote,… | follows what your code sessions are doing: their titles, their states and which tool they are using |  |
| `activity.read.bots` | Read the activity feed of every bot: each one's state (idle, listening, thinking, working, asking, stuck, done, asleep), its name and the tool it works with; never what was said,… | follows what all your bots are doing: their names, their states and which tool they are using, never their words |  |
| `picture.read.sessions` | Show the live pictures tools publish of their work in the user's code sessions (inert pixels, with the publisher's id): a computer-use tool's can show the user's own screen, a bro… | shows live pictures of what tools are doing in your code sessions, which can include your own screen and pages you are signed in to | a warning |
| `picture.read.bots` | Show the live pictures tools publish of every bot's work (inert pixels, with the publisher's id): a computer-use tool's can show the user's own screen, a browser tool's a page the… | shows live pictures of what all your bots' tools are doing, which can include your own screen and pages you are signed in to | a warning |
| `call:<plugin-id>` | Run that plugin's commands | runs commands of {plugin} |  |
| `network:public` | Reach any public host through the core's fetch, with its web floors: public addresses only (a private address is refused, with no card to allow it), the dangerous-domain list, siz… | connects to any public website, through MOSS's web safeguards, so what you or your bots give it can leave your computer | a warning |
| `network:<host>` | Reach that host through the core's fetch, which adds the plugin's own keys and tokens, and from the plugin's components, which reach no other host | connects to {host} |  |

## The plugin API's calls (`api.<path>`), by capability

`where`: `host` a host half, `ui` a component, `both` either, `own` a host half in a process of its own (`host.process: "own"`), `moss` MOSS's own process only.

- **(none: every plugin)**: `commands.list` (both), `confirm` (both), `confirmCard` (both), `desktop.close` (moss), `desktop.show` (moss), `host.call` (ui), `host.on` (ui), `keys.delete` (moss), `keys.open` (moss), `keys.publicKey` (moss), `logs.follow` (both), `logs.read` (both), `memory.list` (both), `memory.read` (both), `outside.run` (host), `pictures.publish` (host), `points.active` (both), `points.call` (both), `points.entries` (both), `points.onActive` (both), `points.onMessage` (both), `points.send` (both), `points.stream` (both), `points.watch` (both), `routines.fire` (host), `routines.list` (both), `routines.runs` (both), `secrets.get` (own), `settings.get` (both), `settings.set` (both), `settings.watch` (both), `storage.synced.delete` (host), `storage.synced.get` (both), `storage.synced.keys` (both), `storage.synced.set` (host), `storage.synced.watch` (host), `streams.accept` (both), `streams.ack` (both), `streams.cancel` (both), `streams.end` (both), `streams.open` (both), `streams.write` (both), `t` (ui), `turns.done` (both), `turns.extend` (both), `turns.state` (both), `turns.take` (both), `turns.watch` (both), `ui.send` (host)
- **call:***: `commands.run` (both)
- **network:***: `net.fetch` (both)
- **conversation.read**: `conversation.follow` (both), `conversation.get` (both), `conversation.history` (both), `conversation.list` (both), `conversation.watch` (both)
- **conversation.post**: `conversation.answer` (ui), `conversation.note` (both), `conversation.send` (both)
- **bots.read**: `bots.get` (both), `bots.list` (both), `bots.watch` (both)
- **computers.read**: `computers.get` (both), `computers.list` (both), `computers.watch` (both)
- **computers.control**: `computers.holds` (both), `computers.mossWindows` (host), `computers.releaseHold` (host), `computers.setActionRunning` (host), `computers.setUserWorking` (host), `computers.takeHold` (host)
- **devices.read**: `devices.list` (both), `devices.watch` (both)
- **approvals**: `approvals.pending` (ui), `approvals.watch` (ui)
- **files**: `files.glob` (both), `files.grep` (both), `files.list` (both), `files.move` (both), `files.onDrop` (ui), `files.path` (host), `files.pickFolder` (ui), `files.pickOpen` (ui), `files.pickSave` (ui), `files.readBytes` (both), `files.readText` (both), `files.remove` (both), `files.stat` (both), `files.url` (ui), `files.watch` (both), `files.write` (both)
- **browser**: `browser.cdp` (both), `browser.close` (both), `browser.hide` (both), `browser.navigate` (both), `browser.onCdpEvent` (ui), `browser.open` (both), `browser.screenshot` (both), `browser.show` (both), `browser.tabs` (both), `browser.toolCaller` (host), `browser.watch` (ui)
- **terminal**: `terminal.close` (ui), `terminal.input` (ui), `terminal.onData` (ui), `terminal.open` (ui), `terminal.resize` (ui)
- **shell.read**: `shell.account` (ui), `shell.apps` (ui), `shell.state` (ui), `shell.watch` (ui)
- **shell.control**: `shell.closePanel` (ui), `shell.dragWindow` (ui), `shell.go` (ui), `shell.openBotEditor` (ui), `shell.openPanel` (ui), `shell.openSettings` (ui), `shell.provide` (ui), `shell.setSidebar` (ui), `shell.togglePanel` (ui), `shell.toggleSidebar` (ui)
- **plugins.install**: `plugins.install` (ui)
- **usage.read**: `usage.plans` (both), `usage.rows` (both), `usage.summary` (both), `usage.watch` (both)
- **notify**: `notify.send` (both)
- **sessions.read**: `sessions.follow` (both), `sessions.get` (both), `sessions.history` (both), `sessions.list` (both), `sessions.watch` (both)
- **activity.read.***: `activity.list` (both), `activity.watch` (both)
- **picture.read.***: `pictures.list` (both), `pictures.open` (both), `pictures.watch` (both)

## Hook events (`contributes.hooks[].on`) and what a hook may return on each

- `tool.before`: `deny`, `ask`, `input`
- `tool.after`: `result`
- `message.in`: `text`
- `message.out`: `text`
- `turn.start`: `note`
- `turn.end`: nothing (it only observes)
- `compact.before`: nothing (it only observes)
- `compact.after`: nothing (it only observes)

## Design tokens (a theme's `tokens`; a component reads them as CSS variables)

Each token is the CSS variable `--moss-color-accent` for `color.accent`: its dots become dashes, after `--moss-`.

- **color**: `color.canvas` (color), `color.surface` (color), `color.raised` (color), `color.control` (color), `color.float` (color), `color.hairline` (color), `color.hairline.raised` (color), `color.hover` (color), `color.selected` (color), `color.text` (color), `color.text.secondary` (color), `color.text.muted` (color), `color.text.placeholder` (color), `color.text.inverse` (color), `color.accent` (color), `color.accent.fill` (color), `color.accent.text` (color), `color.accent.soft` (color), `color.accent.contrast` (color), `color.accent.glyph` (color), `color.accent.ink` (color), `color.attention` (color), `color.attention.text` (color), `color.danger` (color), `color.success` (color), `color.diff.added` (color), `color.diff.removed` (color), `color.diff.added.soft` (color), `color.diff.removed.soft` (color), `color.branch` (color), `color.unread` (color), `color.brand` (color), `color.scrim` (color), `color.focus` (color)
- **sidebar**: `sidebar.tint` (color), `sidebar.solid` (color)
- **titlebar**: `titlebar.tint` (color), `titlebar.blur` (dimension), `titlebar.height` (dimension)
- **bubble**: `bubble.user.background` (color), `bubble.user.text` (color), `bubble.bot.background` (color), `bubble.bot.rim` (color), `bubble.bot.text` (color), `bubble.radius` (dimension)
- **composer**: `composer.background` (color), `composer.rim` (color), `composer.text` (color), `composer.placeholder` (color), `composer.radius` (dimension), `composer.controls.inside` (number)
- **conversation**: `conversation.extra.inline` (number)
- **card**: `card.background` (color), `card.text` (color), `card.muted` (color), `card.rim` (color), `card.radius` (dimension), `card.padding` (dimension), `card.approve.background` (color), `card.approve.text` (color), `card.deny.background` (color), `card.deny.text` (color), `card.button.radius` (dimension), `card.font.family` (fontFamily), `card.font.size` (dimension)
- **font**: `font.sans` (fontFamily), `font.serif` (fontFamily), `font.mono` (fontFamily), `font.display` (fontFamily), `font.size.tiny` (dimension), `font.size.caption` (dimension), `font.size.label` (dimension), `font.size.control` (dimension), `font.size.body` (dimension), `font.size.code` (dimension), `font.size.large` (dimension), `font.size.heading` (dimension), `font.size.title` (dimension), `font.size.display` (dimension), `font.weight.regular` (fontWeight), `font.weight.medium` (fontWeight), `font.weight.semibold` (fontWeight), `font.weight.bold` (fontWeight), `font.line.body` (number), `font.line.tight` (number), `font.line.code` (number)
- **radius**: `radius.small` (dimension), `radius.medium` (dimension), `radius.large` (dimension), `radius.huge` (dimension), `radius.round` (dimension)
- **space**: `space.xs` (dimension), `space.s` (dimension), `space.m` (dimension), `space.l` (dimension), `space.xl` (dimension), `space.xxl` (dimension)
- **shadow**: `shadow.raised` (shadow), `shadow.float` (shadow)
- **motion**: `motion.fast` (duration), `motion.medium` (duration), `motion.slow` (duration), `motion.easing` (easing), `motion.spring.response` (number), `motion.spring.damping` (number)
- **island**: `island.surface` (color), `island.rim` (color), `island.text` (color), `island.muted` (color), `island.faint` (color), `island.attention` (color), `island.accept` (color), `island.accept.text` (color), `island.refuse` (color), `island.refuse.text` (color), `island.working` (color), `island.success` (color), `island.danger` (color), `island.option` (color), `island.option.hover` (color), `island.card` (color), `island.card.rim` (color), `island.shadow` (shadow)
- **pill**: `pill.surface` (color), `pill.rim` (color), `pill.text` (color), `pill.muted` (color), `pill.placeholder` (color), `pill.placeholder.typing` (color), `pill.send` (color), `pill.send.glyph` (color), `pill.accessory` (color), `pill.attention` (color), `pill.accept` (color), `pill.accept.text` (color), `pill.success` (color), `pill.danger` (color), `pill.option` (color), `pill.option.hover` (color), `pill.shadow` (shadow), `pill.plume.tail` (color), `pill.plume.body` (color), `pill.plume.hot` (color)

<!-- end generated -->
