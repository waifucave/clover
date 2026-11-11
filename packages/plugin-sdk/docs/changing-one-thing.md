# Changing one thing

You don't copy a page to change one part of it. Each change below is one entry in your plugin's `clover.json` under
`contributes`, or, for moving parts of a bot's tab, a few lines of layout. Spots and their shapes are in the SDK's
catalog (`catalogs/spots.ts`); an entry's `spot` names one, and `key` names one cell of a keyed spot.

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

The user can bring the part back in Settings. A bot plugin's entries apply in its own tab only; any other plugin's
apply in every tab. Limits:

* **Not in a list spot.** `bot.header.action`, `status`, `sidebar.app` and the other list spots show every entry; a
  plugin's `hide` there hides nothing. Only the user hides one entry of a list (Settings). To take out one of the
  window's own header buttons you need its keyed spot (the tab's `chrome.action` keys, when they ship).
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

## Replace one button

A `component` on one key of a keyed spot takes that cell; the rest stay as they are.

```json
"client": { "entry": "client/index.tsx" },
"contributes": { "ui": [
  { "spot": "composer.action", "key": "attach", "id": "my-attach", "component": "MyAttach" }
] }
```

The composer's keys are `attach`, `model`, `level`, `voice`, `send` and `stop`. When two plugins fill the same key,
the usual rules pick one and Settings shows the choice. The window's own header buttons get keys of their own
(`chrome.action`) in a later release; until then they can't be replaced one by one.

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
and your CSS can style the stock tab's boxes by their names (`.stage { … }`). A plugin that isn't the bot's can't move
parts of that bot's tab.

## Where a bot's model shows

The bot names its model in its manifest; the stage draws it with the renderer installed for that format.

```json
"bot": {
  "name": "Luna", "instructions": "bot/instructions.md",
  "avatar": { "file": "assets/luna.model3.json", "format": "live2d" }
}
```

Clover draws `vrm` and `live2d`; a renderer plugin adds a format (`avatar.formats`, and an `avatar` entry keyed by
it; see `examples/example-pngtuber`). The stage (`bot.stage`) stands at the top of the stock tab, above the
conversation, and only when the bot has an avatar. A layout moves it like any part (the example above puts it on the
left). With no renderer installed for the format, the stage shows the bot's portrait if it has one.
