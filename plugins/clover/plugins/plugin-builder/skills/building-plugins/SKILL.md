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
| check | `PluginValidate` (Clover's) | `{ folder }` (inside your scratch or outputs) → valid, or each finding with its file, place and message. |
| install | `PluginInstall` (Clover's) | `{ folder }` → the plugin lands as *found* and the user gets the sealed OK card, naming you as its builder. Reinstalling the same id updates your own plugin. |
| look | `PluginStatus` (Clover's) | `{ id }` → its state and why, a client build's failure text, validation findings, its last log lines. |

The other skills say "the scaffold tool", "the check tool", "the install tool" and "the status tool" for these.

## Which skill for what

- **plugin-loop**: the whole loop, step by step: scaffold, check, install, edit in place, reload, read errors. Read it
  before your first tool call.
- **plugin-examples**: minimal working plugins to start from: a tool, a settings section, a status-bar entry, a whole
  app (a sidebar button and its own page), a theme, a bot, a bot with its own tab, a model provider, a trigger, a
  point other plugins fill, and a UI spot of your own that another plugin fills.
- **plugin-manifest**: `clover.json` field by field.
- **plugin-catalog**: everything a plugin can add or use, from the SDK's catalogs: points, spots, capabilities and the
  API calls each opens (and the ones not served yet), hook events, design tokens.
- **plugin-ui**: the client half: components, `Spot`, the plugin API in a component, design tokens, what a layer may
  and may not do, media and files.
- **plugin-host**: the host half: what it exports, what it may call, storage, settings, secrets, the network.
- **plugin-cards**: what makes Clover ask the user, and how to ask for the least.

## Before you start

1. Say back to the user, in a sentence or two, what the plugin will do and what it will need (any capability, any
   network host). Ask only if something decides the design. Ask for the least the plugin needs (plugin-cards).
2. Pick the closest example in plugin-examples and the template it comes from.
3. Follow plugin-loop. Check after every change; read findings and errors with the status tool rather than guessing.

## Limits today (don't build on these)

- A bot's plugin adds UI only in its own tab; UI anywhere else goes in a child plugin of it (plugin-manifest,
  "Children").
- `commands[].key` shortcuts aren't bound yet.
- There is no point for an app page's own menu or context menu.
- `helper` programs aren't started; `http` MCP servers aren't served (use a `host` or `stdio` server).
- These API calls are listed but answer "isn't available yet": `memory.*`, `routines.*`, `usage.*`, `logs.*`,
  `audio.*`, `keys.*`, `commands.run`, `browser.*` (plugin-catalog marks them NOT SERVED YET).
- Opening the user's own files, saving through a dialog, playing a large picked file in `<video>`, and WASM in a page
  are coming (plugin-ui, "Files and media").
