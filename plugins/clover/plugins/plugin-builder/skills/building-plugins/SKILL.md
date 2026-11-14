---
name: building-plugins
description: Start here whenever the user asks you to build, extend, fix or change a Clover plugin (a tool, an app inside Clover, a bot, a theme, a model provider, a trigger, a part of the app's UI, or a plugin that takes plugins of its own). It says which skill to read for each step and which tools to use.
---

# Building a Clover plugin

A Clover plugin is a folder: a manifest (`clover.json`) plus the files it names. Data (a theme, a bot's instructions,
skills) needs no code. Code comes in two halves: a **host half** (`host.entry`, TypeScript run by Bun in Clover's plugin
host: tools, hooks, commands, triggers, a model adapter) and a **client half** (`client.entry`, React components the app
draws in the plugin's own layer: pages, sections, buttons). Clover checks the folder, the user OKs it on a card, and
from then on it runs.

## What a plugin brings, and where each thing may show

Whoever owns a plug sets the rules for what plugs into it. There is no kind of plugin to pick: a plugin is a box of
things, and each thing follows the rules of what it plugs into. A bot follows the rules of Bots (the app's own part that
holds bots), a tool or a skill goes to bots and coding agents, an island tab or a line on the island follows the
island's rules, and a part of the window follows the app's.

A plugin that brings a bot (a `bot` entry) holds two kinds of things:

| | inside the bot | beside the bot |
| :- | :- | :- |
| what makes it so | a `ui` entry (or a `locales` table) with no mark; a tool server, skill, agent definition, hook or command whose scope is `own-bot` (its own `scope`, else the plugin's) | a `ui` or `locales` entry with `"app": true`; a tool server, skill, agent definition, hook or command with any other scope; an entry on another plugin's point (`island.line`) |
| where it goes | only that bot's tab, and only what Bots offers (below) | anywhere a plugin with no bot may put it: every bot's tab, the window's parts, Settings, the island |
| who it serves | that bot alone: its conversation, its side threads and the agents it starts | every bot and coding agent its scope says |
| how the user turns it off | with the bot (the plugin's own switch) | one switch for all of them ("its parts beyond the bot's tab"), so the user can keep the bot and turn the rest off |

**What Bots offers a bot, on its own tab only:** everything inside the tab (`bot.tab`, `bot.header`,
`bot.header.action`, `bot.stage`, `bot.side`, `bot.controls`, `conversation`, `conversation.message`,
`conversation.message.extra`, `conversation.message.action`, `tool.result`, `composer`, `composer.action`, `avatar`,
`file.preview`); the top bar, which it may restyle or replace (`bar`, `chrome.title`, `chrome.action`,
`chrome.actions`, `chrome.sidebar`, `chrome.drag`); and the right panels (`panel` keyed `browser` or `agent`,
`chrome.panels`). Its own settings (the manifest's `settings`) are drawn by the app, not by the bot.

**What Bots never offers**, to a bot or to any entry tied to a bot's tab with `when.bot`: the left sidebar (`sidebar`,
`sidebar.bot`, `sidebar.app`), Settings (`settings.section`) and the bots' Edit page (`bot.editor.section`). They look
the same on every tab. The check refuses each case by name: `bot_spot_not_offered` (an unmarked entry on a spot Bots
doesn't offer), `bot_panel_not_offered` (a panel other than `browser` or `agent`), `bot_when_other_bot` (an inside
entry whose `when.bot` names another bot), `bot_tied_not_offered` (any plugin's entry on one of those five with
`when.bot`) and `bot_editor_stock` (a bot's own `bot.editor.section`). Each message says the fix: mark the entry
`"app": true` to show it everywhere, with a switch of its own. A bot's theme gets the same treatment: its `shell` block
may shape the top bar and the panels (`bar`, `accent`, `bar.*`, `panel.*`); a sidebar name there is ignored, with the
warning `shell_not_offered`.

**More scoped wins.** On a bot's tab, what is limited to that bot (its own entries, an entry whose `when.bot` names it,
or one the user ticked for it) beats what dresses every bot's tab, so a plugin that styles all bots' composers never
takes the look a bot gives its own.

**The island takes two things** from any plugin: a line (`island.line`: `{ id, handler }`, and the island asks the
handler for a line of text, an icon and a progress, and draws it in its own style when Clover isn't in front;
plugin-ui, "Putting a line on the island") and a whole tab (`island.tab`, a component; in a plugin with a bot, mark it
`"app": true`).

The OK card says what a plugin with a bot brings beside it, in one line ("Everywhere, with a switch of its own: …"),
with a checkbox the user may untick. A child plugin in the folder (`plugins/<name>/clover.json`, plugin-manifest
"Children") is still a way to bring an optional part with a switch of its own; it is no longer the only way.

## The tools (the only place the skills name them)

| step | tool | what it does |
| :- | :- | :- |
| start | `mcp__builder__PluginNew` (this plugin's, on demand: `Glossary` with `load: "mcp__builder__PluginNew"` makes it callable) | `{ template, id, name }` → the template's files, which you write into `<your scratch>/<id>/`. The same files as `clover plugin new <bot\|theme\|tool\|ui\|model\|trigger\|point> <folder> --name "<name>"` in Bash, when that command is at hand. |
| check | `PluginValidate` (Clover's) | `{ folder }` → `clover plugin validate`'s report: the plugin's class, contributions, hosts, capabilities, tools, each finding, "The OK will say: …", then "valid" or "invalid: N errors". For a plugin of yours already installed, its last line says whether installing this folder updates it at once or asks the user again, and why. A read: no card, nothing installed. |
| install | `PluginInstall` (Clover's) | `{ folder }`: a path relative to your scratch folder, or absolute, inside your scratch or the conversation's outputs, and named exactly as the manifest's `id`. A new plugin waits for the user's OK on its card, which says it was built by you and that you can change its code later without asking, within what the card lists. The same id again updates your plugin: at once if it adds nothing, otherwise the user is asked again. An id you didn't build is refused: pick another. No approval card for the call itself; the OK card is the gate. |
| look | `PluginStatus` (Clover's) | `{ id }`, for your own plugins: its state in words (waiting for the user's OK, running, invalid, stopped, refused) and why (a client build's error is the reason), what it is waiting for, its findings, and its log's last 50 lines. |
| see | `AppScreenshot` (Clover's) | `{ target, size? }`: a picture of a place in the app, drawn in a window the user never sees (their own stays where it is): `app:<plugin id or page key>`, `bot:<id>`, `plugins`, `archive`, `code`, or `window` (the user's own window as it is now, not while Settings shows); `size` is `"wide"` (1280x820, the default), `"narrow"` (860x820) or `{ width, height }` up to 2560x1640. The picture comes back as an image and is saved under `shots/` in your scratch, with the place's frames and the console errors and warnings of a plugin you built. A read: no card. Settings is never drawn, and a card waiting there shows as a plain placeholder. |

Moving the folder works as well as the install tool: `mv` or `cp -R` your scratch folder to `<clover home>/plugins/<id>/`
in one shell call (or write it there with your file tools). Once it has been quiet for about 2 seconds with a valid
`clover.json`, Clover finds it and puts the same OK card ("Built by you…") in front of the user; nothing in it runs
before the OK, and after it you edit it in place as with the install tool. Only a new folder: one already there that
isn't yours stays refused. The move must finish inside the shell call itself; one left running in the background
(`… &`) isn't counted as yours, so the plugin gets an ordinary card and you get no edit rights. A change to the folder
while its card waits replaces the card with one for the new files.

These are in a bot's own sessions (its conversation and side threads), not in an agent's: build plugins from
there. Use them, not Clover's command line in your shell: your shell is fenced, and a `clover plugin install`, `dev`
or `status` there can't reach Clover as the user (its token isn't readable from inside the fence).

The other skills say "the scaffold tool", "the check tool", "the install tool", "the status tool" and "the screenshot
tool" for these.

## Which skill for what

- **plugin-loop**: the whole loop, step by step: scaffold, check, install, edit in place, reload, read errors. Read it
  before your first tool call.
- **plugin-examples**: minimal working plugins to start from: a tool, a settings section, a status-bar entry, a whole
  app (a sidebar button and its own page), an app whose tools let a bot drive its open page, a theme, a bot, a bot with its own tab and parts beside it, a model provider, a trigger, a
  point other plugins fill, a UI spot of your own that another plugin fills, and a page that fits the space it gets.
- **plugin-manifest**: `clover.json` field by field.
- **plugin-catalog**: everything a plugin can add or use, from the SDK's catalogs: points, spots, capabilities and the
  API calls each opens (and the ones not served yet), hook events, design tokens.
- **plugin-ui**: the client half: components, `Spot`, the plugin API in a component, design tokens, what a layer may
  and may not do, media and files.
- **plugin-host**: the host half: what it exports, what it may call, storage, settings, secrets, the network.
- **plugin-cards**: what makes Clover ask the user, and how to ask for the least.

An app (a page of its own in the main area, such as a video editor) needs plugin-ui, plugin-host and plugin-cards as
well as the examples: plugin-ui's "An app like a video editor" says which skill holds each piece (its page, the user's
files, export, a bot's tools, add-ons from other plugins, asking the user).

## Where the answers are

Everything a plugin may use is in these skills and in plugin-catalog's tables, checked against Clover's code by their
own tests. Don't read Clover's app bundle, its compiled daemon or other binaries for answers (`points.call`, a
`confirm` door, how an entry shows): the names inside them are internal and change between builds, and listing or
grepping them costs many calls for less than the skill says. Load the skill named here instead (`Glossary` with
`load: "clover/plugin-builder:plugin-ui"`, and so on for each name above); if it isn't there, check the folder (the check tool) and read what the status tool says, or ask
the user.

## Before you start

1. Say back to the user, in a sentence or two, what the plugin will do and what it will need (any capability, any
   network host). Ask only if something decides the design. Ask for the least the plugin needs (plugin-cards).
2. Pick the closest example in plugin-examples and the template it comes from.
3. Follow plugin-loop. Check after every change; read findings and errors with the status tool rather than guessing.
4. Change files with Write and Edit. If you changed one with a shell command (`sed -i`, a script), read it again
   before you Edit it: an Edit on a file changed since your last read is refused.

## Limits today (don't build on these)

- A bot's own `panel` entry for `browser` or `agent` passes the check, but this build doesn't draw a replacement panel
  yet; a bot's settings show on the Plugins page until its Edit page has their section; and the switch for a plugin's
  parts beside its bot is the OK card's checkbox, with no toggle on the Plugins page yet.
- A command's `key` (`mod+shift+k`) is a default shortcut while the Clover window has the focus; one that clashes with
  the app's own or another plugin's stays unbound.
- There is no point for an app page's own menu or context menu.
- `helper` and `host.runtime: "node"` are refused by the check (run a program from the host half, and use
  `process: "own"` for a process of its own).
- Every API call in plugin-catalog is served in this build. `memory.*`, `routines.*`, `usage.*`, `logs.*`, `audio.*`,
  `keys.*` (the clover tree's only) and `commands.run` among them: a plugin's own data (its logs, its own bot's memory
  and routines, its own commands) needs no capability. `browser.onCdpEvent` is the Clover Browser panel's alone.
