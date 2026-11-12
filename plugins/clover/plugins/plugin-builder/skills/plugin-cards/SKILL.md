---
name: plugin-cards
description: What makes Clover ask the user about a plugin - the OK card at install, what an edit or update asks again for, tool calls and the read-only and display-only lists, a plugin's own confirm card, the model and voice cards - and how to design a plugin that asks for the least. Read it before choosing a plugin's capabilities, hosts or hooks.
---

# Cards: what asks the user, and how to ask for the least

Cards are how the user stays in charge. They are sealed: no plugin can read, draw over or answer one. A plugin that
asks for little gets one short OK card and then just works; one that asks for much gets a long card and the user's
doubt. Design for the short card.

## The OK card (install)

Every plugin waits for the user's OK before anything in it runs. The card shows the plugin's name, description and
builder, and one line for each thing it may do:

- each capability, in the words plugin-catalog's "the OK card says" column gives (some with a warning:
  `computers.control`, `approvals`, `project.write`, `audio`);
- each network host (`network:<host>`, and the hosts of its model endpoints, `web` entries and `auth` URLs);
- that it runs code (a host half, a client half, a `stdio` server, a hook command), its hook events, its add-ons;
- its tools that skip the card (below), named one by one;
- adult content, and that it restyles approval cards (a theme setting `card.*` tokens).

A theme, a locale, skills and a bot's instructions are data: the card is short and says so.

## What asks again

A change to an OK'd plugin (a reinstall of your folder, or an edit in place) applies at once, code included, while it
asks for nothing beyond what the card listed. It asks again when it adds to that: more capabilities, more network
hosts, a program it runs (a `stdio` server's or a hook's command), a tool that skips the card, a setting's default
it runs with, a window skin, a changed name or author, adult content, or a grant dropped and added back. A change to
how it styles approval cards waits for its own OK, and in a plugin holding `approvals` every code change waits.
Themes, layouts, CSS, Markdown and assets always apply at once. While a card waits, the plugin keeps running as it
was.

So: get the capability list and hosts right before the install, and tell the user before a change that will ask.

## Tool calls

A call to a plugin's tool is checked like any tool call, at the user's permission level: at the default level it gets
a card unless the tool is on one of the server's lists, as the OK card showed them (put the server in the top-level
plugin: a child plugin's lists don't count):

- `readOnly`: tools that only read. Their calls run without a card, but only while nothing in the tree can reach the
  network (no `network:` capability, no `http` server) and the plugin is running as OK'd.
- `contained`: tools whose only effect is the plugin's own display (a scene, a pin, the avatar's expression). Same
  conditions, and besides, the tree holds no capability beyond reading Clover's own state: `conversation.read`,
  `memory.read`, `bots.read`, `routines.read`, `computers.read`, `devices.read`, `usage.read`, `shell.read`,
  `shell.control`, `avatar.read`, `avatar.control`.

Never put a tool that changes anything outside the plugin's display on either list. A tool can't be on both.

## Cards a plugin raises itself

- `api.confirm(text)`: a sealed card saying it comes from this plugin, with your text; it returns only `true` or
  `false` (denied after 10 minutes). Use it before something the user would want to know about (deleting their
  project, sending something), not for routine steps.
- A hook returning `{ ask: { reason } }` on `tool.before` gives that tool call a card.

## Other cards a plugin can cause

- A bot plugin that picks its own model (`bot.model.default`): the user gets a card before the bot first uses that
  provider. Leave `model` out to use the user's default model and skip it.
- A bot plugin with a `voice`: a card before that voice first speaks.
- `required` settings and sign-ins (`auth`): not cards, but the plugin waits until the user fills them in.

## Asking for the least

1. Prefer data to code: a theme, skills, a bot's instructions and a model endpoint need no code at all.
2. Take only the capabilities your code calls. A component that only shows things it keeps needs none.
3. Keep files the plugin makes in its data folder (no capability). When it needs the user's own files, ask for
   `files` and work on what the user picks (plugin-ui, "Files and media"), not on paths it chooses itself.
4. One network host, named exactly, rather than several; none if the plugin can work offline.
5. A bot's plugin: `scope: "own-bot"` on hooks, and no `model` unless the bot needs a particular one.
6. Mark read-only tools `readOnly` and display-only tools `contained`, honestly; the card names them.
7. Say all of it to the user before the install, in plain words, so the card holds no surprise.
