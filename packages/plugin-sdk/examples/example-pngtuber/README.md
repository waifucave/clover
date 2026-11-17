# Picture-swap avatar, a renderer for the avatar plugin

The smallest useful renderer for MOSS Code's bundled avatar plugin (`moss/character`): it draws the figure as three pictures
swapped in turn (rest, talking, blink), with no engine and no network. MOSS itself has no avatar; the avatar plugin shows one
figure at a time and declares its own points, and this plugin plugs into them. It shows what a plugin declares to teach the
avatar plugin a new model format, bring a figure in it, and move that figure's mouth with what MOSS Voice says.

| Part | Where | What it shows |
|---|---|---|
| The format | `contributes["moss.character.formats"]` in `moss.json` | its id (`pngtuber`), its name and what it can do (`lipsync`, `expressions`) |
| The renderer | `contributes.ui` (`spot: "moss.character.renderer"`, `key: "pngtuber"`) and `client/index.tsx` | the entry the avatar plugin draws when its figure's format is `pngtuber`: it reads the model's JSON, swaps pictures, blinks, and opens the mouth on the speech feed |
| A figure | `contributes["moss.character.packs"]` and `sample-model/` | Sunny: `sunny.pngtuber.json` and three plain-shape pictures made for this example. The pack point declares which kinds of file come along with an entry's file (JSON, pictures, capped), so the app serves the figure's folder to its renderer |
| The mouth | `contributes["moss.voice.speech"]` | an entry in MOSS Voice's own point: MOSS Voice sends each filler its mouth levels |

Each point it fills is a line on its OK card, in the words of the plugin that declares it: what a renderer is handed, what a
pack offers, what MOSS Voice tells it. Nothing else gates it, and nothing in the platform names it.

## Use it

1. Install this folder from the Plugins page (Add, Choose a folder…) and press OK on its card.
2. In Settings › Avatar, pick Sunny.

## The model file

```json
{ "pngtuber": 1, "name": "Sunny", "idle": "idle.png", "talk": "talk.png", "blink": "blink.png" }
```

Picture paths are relative to the JSON file.

## The speech feed

MOSS Voice sends every plugin with an entry in `moss.voice.speech` a point message as it speaks: `{ bot, frames: [{ t, rms,
centroid? }], cut? }`, levels stamped in epoch milliseconds a little ahead of when they sound. The SDK's `TimedSpeech` keeps
them by time as a speech feed (`feed.subscribe(listener)`, `feed.now()`, `feed.onSpeaking(listener)`), handing each level
over a moment before it is due; `cut` drops what was not yet due. This renderer shows its talking picture while the feed says
the bot is speaking (from its first level to a moment after its last), so it runs no timer of its own; a renderer that moves a
real mouth reads the levels themselves (the SDK's `LipSync`). It never hears the audio itself.

## The framing

The avatar plugin says how the theme frames the figure in the `framing` prop (`{ mode?, crop?, headroom? }`: the theme's
`--moss-avatar-framing`, `--moss-avatar-crop` and `--moss-avatar-headroom`, read live; CSS variables do not cross into a
plugin's frame, so they come as data). This renderer shows `crop` of the picture's height from the top, with `headroom` of it
empty above (`framePicture`); with no `framing` it fits the whole picture.

## The cues

The avatar plugin sends `{ mount, cue }` for this drawing's `mount` prop (point messages on its renderer spot) and hears
`{ mount, names }` and `{ mount, box }` back; when it sends `{ mount, ask: "report" }` (it may have started listening after the renderer spoke), the renderer says them again. This renderer says `names: { expressions: ["happy"], … }`, and on
`{ type: "expression", name: "happy" }` swaps to a second picture set drawn by code (an inline SVG, so no files) for a few
seconds; it says the picture's box as it shows and resizes. A plugin that moves the figure fills the avatar plugin's
`moss.character.figure` point and sends its cues there; the avatar plugin answers a cue this renderer doesn't list plainly,
and never plays it.

Check it with `moss plugin validate`, try it with `moss plugin dev .`.
