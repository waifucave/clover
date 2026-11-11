# Picture-swap avatar, a character renderer

The smallest useful character renderer: it draws a bot as three pictures swapped in turn (rest, talking, blink), with no engine
and no network. It shows what a plugin declares to teach Clover a new avatar format, so that a bot using it shows its character,
the avatar picker can import it, and its mouth moves with the bot's voice.

| Part | Where | What it shows |
|---|---|---|
| The format | `contributes["avatar.formats"]` in `clover.json` | its name (`pngtuber`), the extension that picks it (`.pngtuber.json`), the file kinds the app may serve to the bot's stage (`json`, `image`; each with a size cap), how the model is found (`folder`), how it is imported (`folder`) and what it can do (`lipsync`) |
| The renderer | `contributes.ui` (`spot: "avatar"`, `key: "pngtuber"`) and `client/index.tsx` | the entry the app draws when a bot's avatar format is `pngtuber`: it reads the model's JSON, swaps pictures, blinks, and opens the mouth on the speech feed |
| A sample model | `sample-model/` | `sunny.pngtuber.json` and three plain-shape pictures made for this example; copy the folder into a bot plugin to try it |

## Use it with a bot

1. Install this folder from the Plugins page (Add, Choose a folder…) and press OK on its card.
2. In a bot plugin, put your model in a folder and name it in the manifest: `"avatar": { "file": "model/sunny.pngtuber.json", "format": "pngtuber" }`.
   The app serves that bot only the files this renderer declared (JSON up to 64 KiB, pictures up to 4 MiB), from the model's own folder.
3. Or pick the model's folder in the bot editor (Choose avatar…): the `.pngtuber.json` in it picks this renderer.

## The model file

```json
{ "pngtuber": 1, "name": "Sunny", "idle": "idle.png", "talk": "talk.png", "blink": "blink.png" }
```

Picture paths are relative to the JSON file.

## The speech feed

The `avatar` spot passes `speech` when the app is describing the bot's speech to the frame: `subscribe(listener)` hands batches of
`{ t, rms, centroid }` frames (loudness and brightness on the audio clock) and `now()` is that clock. This renderer opens the mouth
for a frame louder than 0.04. A renderer never hears the audio itself.

Check it with `clover plugin validate`, try it with `clover plugin dev .`.
