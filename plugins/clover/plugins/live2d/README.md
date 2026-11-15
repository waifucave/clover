# Live2D avatar

Shows a bot's Live2D model on its stage and answers its stage's cues (an expression, a motion, an outfit part, a celebration,
"a turn is running") by plain names.

## How a model's names are found

1. Expressions and motions the model's settings list (`.exp3.json` files, motion groups) answer to their own names.
2. Many models made for VTuber apps have no `.exp3.json` at all: the maker put switches in the model's parameters (a `key7`
   that shows a blush, a `Clothes3` that changes the top) and named them in the display info (`.cdi3.json`), in their own
   language. A small word list (Chinese, Japanese, English) turns those names into plain ones: `blush`, `cry`, `love`,
   `smile`, `angry`, `glasses`, `skirt`, `shoes`, `tail`, `hat`, `wave` and so on. Nothing is edited in the model.
3. If a name is missed or wrong, the avatar's own folder can carry a table, below. It wins for the names it lists.

## `stage-map.json`

Put it beside the model file, in the user's avatar folder (never in the plugin or the repository):

```json
{
  "expressions": { "blush": "key7", "wink": "Exp_Wink" },
  "motions": { "wave": "Movement2", "hello": "Idle" },
  "outfit": { "glasses": "Clothes1", "coat": "Clothes4" }
}
```

- Each section maps a plain name (letters, digits, `_`, `.`, `-`, at most 32 characters; up to 128 names per section) to
  one thing in the model: a parameter id, or a settings expression name or motion group.
- Names are Unicode letters, so `脸红` works as well as `blush`.
- It is read only when the model is loaded from a plain file or folder (not from a zip), is at most 256 KiB, and only names
  are taken from it: no paths, no URLs, nothing that is run.
- Without the file, or with a bad one, the automatic names above are used.

## What she does on her own

- A glance at the composer while the user types, at the conversation while a turn runs, never at the pointer.
- Breathing, blinking and idle sway, off under reduced motion. At most 30 frames a second at rest, 60 while speech plays;
  stopped while hidden or off screen.
- Textures stay inside a 256 MiB budget (all scaled down by one factor when a model is larger), no side over 4096.
