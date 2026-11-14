---
name: plugin-ui
description: The client half of a Clover plugin - React components in a spot, a whole app page, drawing your own spot with Spot, the plugin API and hooks a component uses, design tokens, talking to the host half, what a component's layer can and can't do, and files and media. Read it before writing client/index.ts or client/index.tsx.
---

# The client half: components

`client.entry` is a module whose exports are components; a `ui` entry names one by `component`. Clover draws each in
the plugin's own layer (a sandboxed page of its own), where the spot is: a Settings section, the status bar, the app's
main area, a bot's tab, a spot another plugin declared.

## Writing a component

- Import only from `@waifucave/clover-plugin-sdk/ui` (and `react` / `react-dom`, which are the same React 19). The
  layer provides them; anything else must be your own code in the plugin folder. Don't plan on npm packages.
- `client/index.ts` with `createElement as h`, or `client/index.tsx` with JSX (no React import needed). Clover builds
  the entry when it loads; a build failure shows in the status tool.
- A component gets `{ props, tokens, entry }`: `props` as the spot hands them (plugin-catalog lists each spot's),
  `tokens` the theme's values, `entry` its own `{ pluginId, id, spot, key }`.
- Styles: inline `style`, or stylesheets listed in `client.css` (a CSS import in a `.tsx` entry is moved there).
  Use the design tokens as CSS variables so the plugin follows the user's theme: `var(--clover-color-text)`,
  `var(--clover-color-accent)`, `var(--clover-space-m)`, `var(--clover-radius-medium)`… (plugin-catalog, "Design
  tokens": a token `a.b.c` is `--clover-a-b-c`).

## What the UI SDK gives a component

| export | what it does |
| :- | :- |
| `createElement`, `Fragment`, `useState`, `useEffect`, `useMemo`, `useRef` | React's. |
| `usePluginApi()` | The plugin API (`api.settings`, `api.storage.synced`, `api.points`, `api.host`, `api.net`, and what its capabilities open: plugin-catalog's calls marked `ui` or `both`). |
| `Spot` | Draws a spot your component declared: `h(Spot, { name: "<id>.<spot>", props: {…}, spotKey?, fallback? })`. |
| `useSpotEntries(name, key?)` | The entries filling a spot, to draw one at a time (`h(Spot, { name, entry })`). |
| `useTokens()` | The theme's token values. |
| `useT()` | `t("key", params)`: the plugin's strings in the user's language (`contributes.locales`). |
| `useMountContext()` | `{ bot, surface, session, os, safeMode, … }`: where this component is drawn. |
| `useKept(key, initial)` | State that survives the window reloading (the user's place, an unsent draft); not storage. |
| `useEntry()` | This component's own entry. |
| `useMenu()` | Shows a context menu at a point and gives back the item chosen. |

## A whole app

An app is a page under the `main` spot, keyed by your plugin's id, plus a `sidebar.app` button whose `opens` is that
key (plugin-examples, "A whole app"). The page is an ordinary React tree: its own state, lists, forms, a canvas.
Keep what the user makes in the host half (its data folder or the synced store), and draw it here; Settings for the
app go in a `settings.section` entry or in `settings` in the manifest (Clover draws those).

An app that takes plugins of its own declares a spot (`declares` with `props` on its page's `ui` entry) and draws it
with `Spot`, or a data point (no `props`) that other plugins fill with entries it reads through `api.points`.
plugin-examples, "A UI spot of your own", shows the pair. Name what its add-ons may do in the spot's `doc`, and pass
them only the props they need.

## An app a bot can work in

An app's host half can serve an MCP server too, so a bot edits the same project the user sees: the tools change the
state the host half holds, and the host half tells the page (`api.ui.send("changed", …)`), which redraws from
`api.host.on("changed", …)` whoever made the change. plugin-examples, "An app whose tools drive its open page", is the
whole thing; plugin-host, "Tools that drive a page", says what the tools may do.

## Talking to the host half

- `api.host.call("<name>", args)` calls an entry of the host module's `ui` table (`export const ui = { save }`); it
  runs as the plugin, and nothing else the host module exports is reachable from here.
- `api.host.on("<event>", (data) => …)` hears what the host half sends with `api.ui.send("<event>", data)`.
- `api.storage.synced.get` / `keys` read the synced store from a component; only the host half writes it.

## Points: what other plugins add to yours, and calling their handlers

A plugin that takes plugins of its own (a video editor's effects, a board's widgets) declares a point, and other plugins
fill it from their own manifests. A UI spot (`declares` with `props`) is drawn with `Spot`; a data point (`declares`
with `fields`, no `props`) is read with `api.points`, from a component or the host half alike:

- `api.points.entries("<your-id>.<point>")` gives `[{ pluginId, entryId, key?, value }]`; `api.points.watch(name, fn)`
  hears every change (an add-on installed, turned off, removed) and returns the function that stops it.
- What an entry shows: only the fields your declaration names in `fields.properties`; a field with `"format": "path"`
  comes as a URL to that file in the contributor's folder.
- Which entries are there: those of contributors that are on and running, so OK'd by the user. One waiting for its
  OK, turned off or stopped has none. Only your plugin (and your own children) reads your point.
- A field with `"format": "handler"` names an export of the contributor's host half. `api.points.call(name, { pluginId,
  entryId }, "<field>", args)` runs that export in the contributor's own host, with its own capabilities, and gives
  back what it returns. Any other field is refused. A contributor with no host half has nothing to call.

```json
"declares": {
  "ex-editor.effects": {
    "shape": "list",
    "fields": { "type": "object", "required": ["id", "title", "apply"], "properties": {
      "id": { "type": "string" }, "title": { "type": "string" },
      "apply": { "type": "string", "format": "handler", "description": "Takes { frame } and returns { frame }." }
    } },
    "doc": "Effects the editor lists: a title, and the host export that applies one."
  }
}
```

An effect plugin's manifest then holds `"ex-editor.effects": [{ "id": "sepia", "title": "Sepia", "apply": "sepia" }]`,
and its host module `export async function sepia(args, ctx) { … }`. The editor calls it with
`await api.points.call("ex-editor.effects", { pluginId: e.pluginId, entryId: e.entryId }, "apply", { frame })`.

## Putting a line on the island

The island takes small items from any plugin and draws them itself. Fill its point `island.line` with an entry and give
it a handler; the island calls the handler when Clover isn't in front and draws what it returns: the first line on its closed strip,
the lines on its open Needs you tab.

```json
"contributes": { "island.line": [{ "id": "render", "handler": "islandLine" }] }
```

```ts
// host/index.ts: no arguments; return a line, or nothing when there is nothing to show
export async function islandLine() {
  return job ? { text: `Rendering frame ${job.done} of ${job.total}`, icon: "sync", progress: job.done / job.total } : undefined;
}
```

- A line is `{ text, icon?, progress?, bot? }`. `text` is plain text, one line: no markup (it is drawn as text), control
  characters become spaces, at most 80 characters. `icon` is one of `bolt`, `check`, `clock`, `info`, `sync`, `link`; any
  other name draws no icon. `progress` is a number from 0 to 1 (a bar; anything else draws none). `bot` is the id of the
  bot the line is about. The island writes your plugin's id, and the bot's name, beside the words: you never set those.
- The island decides everything else: its style and size, how many lines show (at most four, two from one plugin, in
  the order plugins were installed; the rest are counted), how often it asks (every two seconds on the open tab, about every six on the closed strip, never while Clover is in
  front or when no plugin fills the point; a handler that returns nothing a few times is left alone until plugins change or a bot starts work), and how long a line lasts: exactly as long as your handler returns it. Return nothing to remove
  it; a plugin that is turned off, stopped or removed has no line. A handler that takes more than 1.5 seconds or throws
  shows nothing that time, and one that fails three times running is left alone for 30 seconds.
- A line never opens the island or raises it over the user's work: it is drawn on the closed strip (small, below it, only when
  no card is waiting and Clover isn't in front) or on the open Needs you tab, below the cards. The bot's name is written only
  when your plugin is that bot's own (your id is the bot's id). Your handler runs as your plugin with your own capabilities and needs no `call:` and no capability of
  its own; keep it quick and read your state, don't start work in it. A plugin whose handler needs a host half has one.
- Your OK card says the plugin puts a line of text on the island, so the user has seen that before it shows.
- Not here: a picture of your own (only the named icons), colours, sizes, links or buttons, and anything about another
  plugin's lines.

## Asking the user

`api.confirm("Delete the whole project?")` (a component or the host half; no capability) shows a sealed card that
says it comes from your plugin, and answers `true` only on the user's yes (`false` on a no, or after 10 minutes).
Use it before something the user would want to know about, not for routine steps; plugin-cards has the rest.

## An app like a video editor: where each piece goes

- Its page: a `main` entry keyed by your plugin's id, and a `sidebar.app` button (plugin-examples, `ex-app`).
- The user's media: `files` and the pickers below; play and preview with `api.files.url(token)`; take drops with
  `api.files.onDrop`. The project file and caches: the host half's data folder (plugin-host).
- Export: `api.files.pickSave` for the output, then either the host half runs an encoder installed on the computer
  (ffmpeg) on the picks' real paths, with `"programs": true` (plugin-host, "Programs"), or the page encodes (WebCodecs,
  or a WebAssembly encoder such as ffmpeg.wasm, multi-threaded with `isolated`, below) and writes the bytes with
  `api.files.write(token, bytes)` on the save token.
- Tools a bot drives the open project with: an MCP server in the same host half (plugin-examples, `ex-timeline`).
- Effects or add-ons other plugins provide: a point of your own (above).
- Asking before something big: `api.confirm` (above).

## Fitting the space you get

A plugin's component runs in a frame: its own document, inside the place its spot puts it. What it can measure is that
frame and nothing else. `innerWidth`, CSS media queries (`@media (max-width: 600px)`), container queries on your own
elements, and a `ResizeObserver` on `document.documentElement` all see your frame's box: not the window, not the
screen, not the parts around you.

- **Width** is the place's: the frame is as wide as the column or slot its spot gives it, and changes when that does
  (the main area as the window or the sidebar changes, a Settings section's column, an equal share of the status bar's
  row with its other entries).
- **Height in the main area and a panel** (`main`, `panel`) is the column's: your frame fills it, and your page
  scrolls inside itself (Clover makes your document's body scroll there). So an app's page can be laid out like an
  editor: `height: 100vh` for its root, a toolbar and a pinned footer, and the middle scrolling on its own.
- **Height everywhere else** is your content's: Clover measures the bottom of your page's top elements as they change
  and sizes the frame to it (up to 100,000 px). So in a Settings section, the status bar or another plugin's spot,
  never size your root by `100vh` or `height: 100%`: those mean your frame, which is as tall as you say, and it stays
  at its first 150 px. Let your content decide.
- **A fixed box**, set by the host, in a few places: the sidebar card a bot's child plugin fills (`sidebar`, with
  `when.bot`) is the card's whole height; a `sidebar.app` badge is 48 x 18; and a plugin that hosts others may size the
  frames in its own spot from its own stylesheet (`.slot > iframe { height: 72px !important }`: a `Spot` adds no
  element of its own, so the frame is a direct child of what holds it). Alpha's tab does so for her figure and room.
  In a fixed box, `100%` is that box, and short boxes are real: draw less, not smaller.
- **A narrow window** (the main window under 900 px) rests a floating sidebar as a narrow rail, so the main area keeps
  most of its width. `useMountContext().window.narrow` says so, and changes live: fold your layout the way the shell
  folds its own (your own box may barely change).
- **What a host passes a nested part**: props (plain data, through `Spot`'s `props`) and the size of the frame (its
  stylesheet). CSS variables don't cross into another plugin's frame, so a host reads them and passes the values. The
  stage does so for an avatar renderer: its frame fills the stage, and its props hold `{ bot, file, format, name,
  speaking }` and `framing: { mode?, crop?, headroom? }`, the layout's `--clover-avatar-framing` (`full`, `bust`,
  `waist`), `--clover-avatar-crop` and `--clover-avatar-headroom`, read again as the stage resizes. A renderer frames
  the figure by its own box and that `framing`.

plugin-examples, "A page that fits its space" (`ex-fit`, `ex-fit-tile`): an editor-shaped page that fills the main
area, pins its footer, scrolls its middle and folds when the window is narrow, and a tile that hides a secondary line
when its box is short.

## What a layer can and can't do

- It can't reach the user's files or Clover's home directly; it uses the plugin API (`files` with that capability)
  or its host half.
- It reaches the network only to hosts the plugin holds as `network:<host>` capabilities (a plain `fetch` there
  works); every other host is blocked.
- It can't read another plugin's layer or Clover's own (each layer is its own origin), open windows, or take focus.
- A bot's own plugin draws only in that bot's tab (plugin-manifest, "Children").
- A `web` entry (`{ "web": { "url": "https://…", "partition": "main" } }`) shows a web page in a frame instead of a
  component; its host is one of the plugin's network hosts.

## Files and media

A plugin holding the `files` capability lets the user hand its page their own files. Each pick takes the user's own
click or key press in the page (one pick per press), opens the app's own dialog, and gives the page tokens, never
paths:

- `api.files.pickOpen({ multiple?, filters?: [{ name: "Video", extensions: ["mp4", "webm"] }] })`: files to read.
- `api.files.pickFolder({ forWriting? })`: a folder; read, or read and write with `forWriting: true` (an export folder).
- `api.files.pickSave({ suggestedName?, filters? })`: one file to write (it may not exist yet); it reads too.
- Each answers `{ grants: [{ token, name, kind: "file" | "folder", access, size? }] }`, or `{ cancelled: true }`. A
  token is `grant:<uuid>`, bound to this plugin: another plugin's use of it fetches nothing. The grant lasts until the
  user removes it in Settings or removes the plugin, so keep tokens (in the synced store, through the host half) for a
  project's recent files.
- `api.files.onDrop((grants, refused) => …)`: files or folders the user drops on the page, as tokens like an open
  pick's (read only; a dropped folder is a folder to read). The page takes drops by cancelling `dragover`
  (`window.addEventListener("dragover", (e) => e.preventDefault())`); items Clover refuses are left out, and `refused`
  says why. It returns the function that stops listening.
- `api.files.url(token)`: a URL on the page's own origin that a `<video>`, `<audio>` or `<img>` plays directly, served
  in ranges, so a large file never passes through the page's memory. It works for a file the plugin may read.
- Everything else with a picked file happens in the host half: pass the token with `api.host.call` (plugin-host,
  "Picked files").
- Places no plugin may hold (the whole disk, the home folder itself, Clover's own folder, secret places) are refused
  at the pick, with a reason.

What else a third-party page can run: WebAssembly from the plugin's own folder
(`WebAssembly.instantiateStreaming(fetch("/_p/<plugin-id>/client/codec.wasm"))`; strings never become code), Web
Workers (`new Worker(url)` from the plugin's files or a blob), WebCodecs (`VideoDecoder`, `VideoEncoder`), WebGL 2 and
canvas.

`SharedArrayBuffer` (a multi-threaded WebAssembly build such as ffmpeg.wasm's) needs a cross-origin isolated page:
opt in with `"client": { "entry": "…", "isolated": true }` in the manifest. It grants no reach (no network, no files)
and adds no line to the OK card; only that plugin's own pages are isolated. What it costs: a cross-origin image from one of the plugin's hosts
loads without credentials (every page of Clover's is served that way, isolated or not), so a host that needs cookies or
a login for its images won't serve them into the page; fetch those through the host half instead. In an isolated page Clover's own tests check `SharedArrayBuffer`, WebAssembly from the plugin's
folder, a worker, the media URL, approval cards and the app around it; WebCodecs and WebGL are checked in a plain page
only, so test them in yours. Without `isolated`, use a single-threaded build, or a program the host half runs
(plugin-host, "Programs").
