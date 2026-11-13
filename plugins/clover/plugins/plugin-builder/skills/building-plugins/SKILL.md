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
  app (a sidebar button and its own page), an app whose tools let a bot drive its open page, a theme, a bot, a bot with its own tab, a model provider, a trigger, a
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

- A bot's plugin adds UI only in its own tab; UI anywhere else goes in a child plugin of it (plugin-manifest,
  "Children").
- `commands[].key` shortcuts aren't bound yet.
- There is no point for an app page's own menu or context menu.
- `helper` programs aren't started; `http` MCP servers aren't served (use a `host` or `stdio` server).
- These API calls are listed but answer "isn't available yet": `memory.*`, `routines.*`, `usage.*`, `logs.*`,
  `audio.*`, `keys.*`, `commands.run`, `browser.*` (plugin-catalog marks them NOT SERVED YET).
