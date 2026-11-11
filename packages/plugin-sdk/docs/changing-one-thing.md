# Changing one thing

You don't copy a page to change one part of it. Each change below is one entry in your plugin's `clover.json` under
`contributes`, or, for moving parts of a bot's tab, a few lines of layout. Spots and their shapes are in the SDK's
catalog (`catalogs/spots.ts`); an entry's `spot` names one, and `key` names one cell of a keyed spot.

A spot is not a fixed place on the screen. Where a bot's tab shows each of its parts is that tab's layout: the bot's
own, changed by other plugins' patches and by the user. Two limits hold everywhere below. A layout arranges only the
parts it places itself: `bot.stage`, `conversation`, `composer`, `bot.header`, `bot.side`, the window's top-bar parts
(`chrome.title`, and each button as `chrome.action` keyed `edit`, `session` or `browser`) and the boxes around them. A
button drawn inside another part, such as the composer's, is not a layout node: its keyed spot (`composer.action`) lets
you replace or hide it by key, not move it. And a layout's CSS dresses the layout's own boxes and stops at every part
inside them, so it can move or offset a part's box but not restyle what the part draws.

## Restyle one part

A `style` entry dresses whatever fills that spot (or that key), inside the part only. The file is a theme file: tokens
and CSS, cleaned like any theme's.

```json
"ui": [
  { "spot": "composer", "id": "rounder", "style": "look/composer.json" }
]
```

`look/composer.json` is `{ "theme": 1, "name": "Rounder composer", "tokens": {}, "css": "look/composer.css" }`. Add
`"key"` to dress one cell of a keyed spot (`"spot": "composer.action", "key": "send"`). A style never replaces the part
and never competes with other entries; several apply one after another.

## Remove one part

A `hide` entry shows nothing where it wins: a single spot, or one key of a keyed spot.

```json
"ui": [
  { "spot": "composer.action", "key": "model", "id": "no-model-button", "hide": true }
]
```

In a list spot (`bot.header.action`, `status`, `sidebar.app`…), a `hide` names the one entry it takes out with
`target`: `<plugin-id>#<entry-id>`, or `<plugin-id>` for every entry that plugin has there.

```json
"ui": [
  { "spot": "bot.header.action", "id": "no-pin", "hide": true, "target": "acme-tools#pin" }
]
```

A bot plugin's entries apply in its own tab only; any other plugin's apply in every tab. The user's own choices win.
The bot editor's "Hidden by plugins" lists each part a plugin's hide takes out of that bot's tab, which plugin hid it,
and a switch that shows it again (in the user's UI settings, the spot's `shown` list names the hide they switched off).
Limits:

* A list-spot `hide` without `target` hides nothing (the validator warns).
* A key its spot keeps can't be hidden (`conversation.message` `approval`).
* Hiding the `composer` itself needs the `conversation.post` capability, as filling it does.

## Add one button

A `component` in a list spot adds itself beside the others. `order` places it (lower first; 500 when left out).

```json
"client": { "entry": "client/index.tsx" },
"contributes": { "ui": [
  { "spot": "bot.header.action", "id": "dice", "component": "DiceButton", "title": "Roll a die", "order": 100 }
] }
```

`bot.header.action` entries need a `title`. Your component runs in your plugin's own frame and gets the spot's props
(here, the bot).

A small button under messages is a `conversation.message.action` data entry, not a `conversation.message.extra`
component (which costs a frame per message for a plugin Clover doesn't ship). The conversation draws it in the reply's
icon row; a press calls a handler in your host's `ui` table with `{ session, seq }`, which answers `{ ok: true }` or
`{ note }`.

```json
"contributes": { "ui": [
  { "spot": "conversation.message.action", "id": "save", "title": "Save to notes", "icon": "assets/save.svg", "call": "saveMessage", "on": "assistant" }
] }
```

`on` is `assistant`, `user` or `both`; `when` and `order` work as for any entry.

## Replace one button

A `component` on one key of a keyed spot takes that cell; the rest stay as they are.

```json
"client": { "entry": "client/index.tsx" },
"contributes": { "ui": [
  { "spot": "composer.action", "key": "attach", "id": "my-attach", "component": "MyAttach" }
] }
```

The composer's keys are `attach`, `model`, `level`, `voice`, `send` and `stop`. When two plugins fill the same key,
the usual rules pick one and Settings shows the choice. The window's top-bar buttons are cells of their own too
(`chrome.action`, keyed `edit`, `session`, `browser`); a bot's tab can place them (below).

## Move or resize one part

Only for a bot's own tab: a bot plugin's `tab/layout.json` may start from the stock tab and say only what changes.

```json
{ "layout": 1, "extends": "default", "changes": [
  { "set": ".tab", "as": "row" },
  { "set": "bot.stage", "size": "42%", "min": 280 }
] }
```

That turns the tab into a row, so the stage stands to the left of the transcript, at 42% of the tab. The stock tab
(`DEFAULT_TAB_LAYOUT`) is a column named `.tab` holding `bot.stage` (named `.stage`) and a column named `.talk` with
`conversation` over `composer`.

Each change names a node by spot (`"bot.stage"`, or `{ "spot": "panel.view", "key": "files" }`) or by class
(`".talk"`). The changes are:

* `{ "set": node, …attributes }`: `size`, `min`, `max`, `grow`, `hideBelow`, `class`, `gap`, `padding`, `align`, and
  `as` (`row`, `column` or `stack`) to turn a box into another kind.
* `{ "move": node, "before": node }`, or `"after"`, or `"into": box` with `"at": "start"`, `"end"` or an index.
* `{ "remove": node }`.
* `{ "add": { …any layout node }, "before" | "after" | "into": … }`.
* `{ "wrap": node, "in": "row" }` (or `column`, `stack`), with attributes for the new box.

A change whose node isn't there is skipped and noted in the app's log, never an error: the stock tab may gain or lose
parts over time. What the changes make is checked like any layout. `css` and `background` work as in a whole layout,
and your CSS can style the stock tab's boxes by their names (`.stage { … }`). The cleaner prefixes your classes and
drops what loads from outside your folder; it doesn't limit properties, so `transform`, `margin` or `position` can
offset a box you name by exact pixels.

## Move one part of someone else's bot tab

Any plugin can rearrange a bot's tab with a patch: a `ui` entry on `bot.tab` with `layout`, for the bots its
`when.bot` names (one, several, or with no `when.bot` every bot your plugin dresses).

```json
"contributes": { "ui": [
  { "spot": "bot.tab", "id": "move", "layout": "tab/move.json", "when": { "bot": "luna" } }
] }
```

`tab/move.json` holds changes only, and your own CSS:

```json
{ "layout": 1, "changes": [
  { "move": "bot.header", "before": "composer" },
  { "wrap": "bot.header", "in": "row", "class": "nudge" }
], "css": "tab/move.css" }
```

with `.nudge { transform: translateY(-6px); margin: 0 12px }` in `tab/move.css`. That moves the bot's header bar (its
name, its model and its header buttons) from wherever the tab has it to just above the composer, and nudges it 6 px up.

One top-bar button works the same way, on any bot, a bot with no layout of its own included (its tab is then the stock
one, changed):

```json
{ "layout": 1, "changes": [
  { "add": { "spot": "chrome.action", "key": "edit" }, "before": "composer" },
  { "wrap": { "spot": "chrome.action", "key": "edit" }, "in": "row", "class": "nudge" }
], "css": "tab/move.css" }
```

The bot editor's button now sits just above the composer. A part the tab places leaves the standard bar, so it moves:
the window shows it once. The shell still draws it and a press on it is the app's own.

* **Turns.** The tab is made from the stock tab, or the bot's own layout; then each plugin's patch, by `order` (lower
  first, 500 when left out), then plugin id; then the user's own layout. Your changes see the tab as it stands at your
  turn, so a patch has no `extends`.
* **Names.** A class a change names (`".talk"`) is the bot's. The classes you give (on a node you add, on a box you
  `wrap` around a part) are yours, prefixed with your plugin's id, and your CSS reaches only them. You can't `set` a
  class on the bot's nodes (wrap them instead), and a node you add has no `prefer`, image or markdown (the tab's files
  are its bot's). It may place the tab's spots or spots your own entries declare: to put your own component somewhere,
  fill a spot with it (`bot.side`, say) and add `{ "spot": "bot.side" }` where you want it.
* **The user decides.** The bot editor's "Rearranged by" lists every plugin that rearranges that bot's tab, each with a
  switch; off undoes its changes there at once, even in a tab a patch broke (reach the editor from the tab's Edit button
  wherever the tab has it, or from Settings' Bots). Turning your plugin off removes its patch too. A bot whose tab is
  another plugin's own component isn't rearranged (the patches wait).
* **What can move.** Only what the tab's layout places (see the top of this page): never a button inside the composer.

## Where a bot's model shows

The bot names its model in its manifest; the stage draws it with the renderer installed for that format.

```json
"bot": {
  "name": "Luna", "instructions": "bot/instructions.md",
  "avatar": { "file": "assets/luna.model3.json", "format": "live2d" }
}
```

Clover draws `vrm` and `live2d`; a renderer plugin adds a format (`avatar.formats`, and an `avatar` entry keyed by
it; see `examples/example-pngtuber`). A bot with no layout of its own gets the shell's stock tab: the stage
(`bot.stage`) on top, only when the bot has an avatar, and the conversation over the composer below it. That tab is
drawn as `DEFAULT_TAB_LAYOUT` (the same parts in the same order) once anything rearranges it: the bot's own patch,
another plugin's, or the user's. A layout moves the stage like any part (the example above puts it on the left). With
no renderer installed for the format, the stage shows the bot's portrait if it has one.
