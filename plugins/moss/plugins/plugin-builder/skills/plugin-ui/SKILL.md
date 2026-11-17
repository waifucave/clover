---
name: plugin-ui
description: The client half of a MOSS plugin - React components in a spot, a whole app page, drawing your own spot with Spot, the plugin API and hooks a component uses, design tokens, talking to the host half, what a component's layer can and can't do, and files and media. Read it before writing client/index.ts or client/index.tsx.
---

# The client half: components

`client.entry` is a module whose exports are components; a `ui` entry names one by `component`. MOSS draws each in
the plugin's own layer (a sandboxed page of its own), where the spot is: a Settings section, the status bar, the app's
main area, a bot's tab, a spot another plugin declared.

## Writing a component

- Import only from `@waifucave/moss-plugin-sdk/ui` (and `react` / `react-dom`, which are the same React 19). The
  layer provides them; anything else must be your own code in the plugin folder. Don't plan on npm packages.
- `client/index.ts` with `createElement as h`, or `client/index.tsx` with JSX (no React import needed). MOSS builds
  the entry when it loads; a build failure shows in the status tool.
- A component gets `{ props, tokens, entry }`: `props` as the spot hands them (plugin-catalog lists each spot's),
  `tokens` the theme's values, `entry` its own `{ pluginId, id, spot, key }`.
- Styles: inline `style`, or stylesheets listed in `client.css` (a CSS import in a `.tsx` entry is moved there).
  Use the design tokens as CSS variables so the plugin follows the user's theme: `var(--moss-color-text)`,
  `var(--moss-color-accent)`, `var(--moss-space-m)`, `var(--moss-radius-medium)`… (plugin-catalog, "Design
  tokens": a token `a.b.c` is `--moss-a-b-c`).

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
app go in a `settings.section` entry or in `settings` in the manifest (MOSS draws those).

An app that takes plugins of its own declares a spot (`declares` with `props` on its page's `ui` entry) and draws it
with `Spot`, or a data point (no `props`) that other plugins fill with entries it reads through `api.points`.
plugin-examples, "A UI spot of your own", shows the pair. Name what its add-ons may do in the spot's `doc`, and pass
them only the props they need.

## A panel of your own on the right

The right side of a tab holds panels, each with a button in the tab's bar (the stock ones are keyed `session`,
`terminal`, `diff`, `files`, `browser` and `agent`). A `panel` entry whose `key` is not one of those ADDS a panel of
your own, with a button of its own:

```json
{ "spot": "panel", "key": "sheets", "title": "Sheets", "component": "SheetsPanel", "when": { "session": ["coding"] } }
```

- **`title` is required**: it names the button (plain text or `{ "en": … }`). `moss plugin validate` refuses a panel
  without one. `icon` is optional, and a file path given there is not drawn yet: the button shows the stock panel
  glyph. The `key` is lowercase letters,
  digits and hyphens, starting with a letter, 32 at most. What draws it is a `component` or a `web` page.
- **Where it shows.** In a plugin with no bot, and beside a bot (`"app": true`): on every tab of the kinds
  `when.session` names (`bot`, `agent`, `coding`; every tab when absent). Inside a bot's plugin (no `app`): on that
  bot's tab only, whatever `when.session` says.
- **The button** comes after the stock ones. Past three plugin panels on a tab, the rest go into one "Other panels"
  menu. Pressing it opens your component in the panel; two panels are open at most, so a third pushes the oldest out.
- **Space**: your frame fills the panel's column and scrolls inside itself, like a `main` page ("Fitting the space you
  get"). The column is narrower than the main area: lay it out for a narrow width first.
- **From your own frames** you can open, close or toggle it by its bare key, with the `shell.control` capability:
  `const api = usePluginApi(); await api.shell.openPanel("sheets")` (`closePanel`, `togglePanel`). `shell.state()`
  lists it in `panels.available` and `panels.open` as `<your plugin id>#sheets`.
- **Two panels in one plugin** each need their own `id`.
- The OK card says it ("It adds a panel, "Sheets", …"), and the Plugins page labels the plugin "Panel".

A panel is for something the user keeps beside the conversation (a document, a sheet, a preview, a board). A whole
page of your own is `main` with a `sidebar.app` button ("A whole app"); a part inside a stock panel is `panel.view`.

## The microphone

With the `microphone` capability, `navigator.mediaDevices.getUserMedia({ audio: true })` works in your plugin's own frames: a
`composer.action` button, a panel, a `main` page, and a part kept in the background (a voice mode that listens for a wake word
needs exactly that). No other plugin's frame gets it. The system's own permission still applies (a Mac asks the first time;
without it the call is refused), and the OK card says "It hears your microphone, also while no window of it shows" with a warning. Open it when your part needs it and
stop the track (`track.stop()`) when it doesn't, and take the device's microphone turn (`device/microphone`) while you record, so
two plugins never record at once (plugin-host, "Turns"). MOSS Voice's hold-to-talk button is built this way: a `composer.action`
entry under a key of its own (`voice`; any key that isn't one of the composer's buttons, `attach`, `model`, `level`, `send`
or `stop`, adds a button, drawn among the others plugins add in the spot's order) that records while it is held, streams the audio to its host half (`streams.open`) and sends the words as the
user's message (`useUserSend`, with `user.send`).

## A part that keeps running in the background

A `ui` entry at `app.background` has no place in any window: `{ "spot": "app.background", "id": "player", "component":
"Player" }`. MOSS mounts the component while the app is open and your plugin runs, in a hidden window of its own, so it
keeps going when the main window is closed and reopened, is never put to sleep, and its timers (and sound) aren't slowed
while nothing is on screen. It goes when your plugin stops, is turned off or is removed, and it reloads when your files
change. The component draws nothing the user sees; it listens (a timer, `api.events`, a connection) and acts.

- **At most two** per plugin, each with its own `id`. It takes no `when.bot`. In a plugin with a bot it needs
  `"app": true` and sits under the plugin's app-parts switch.
- **Sound**: with the `audio` capability it may play sound with no press from the user (a `new Audio()` or an
  `AudioContext` that starts on its own). Without `audio` the page still needs a press, and there is none, so nothing
  plays. The app has one mute over all plugin sound (the tray's "Mute Sound from Plugins"); play through the page's own
  audio and it is covered.
- The OK card says "It keeps a part running in the background while MOSS is open", and the Plugins page labels the
  plugin "Background".
- **Speaking** (MOSS Voice's way, a pattern any plugin can copy): the background part is the player. Its host half
  streams it the audio (`api.streams.open("speech", { meta })` in the host, `api.streams.accept("speech", …)` in the
  part); before it sounds, the part takes the device's speech turn (`api.turns.take("device/speech", { note })`), so it
  never talks over another plugin's speech, and lets it go (`turn.done()`) when it has played; it tells the plugins that
  fill its own point `moss.voice.speech` how loud each bot speaks (`api.points.send`), never the words.
  Its controls (stop a bot, hold for push-to-talk) are `api.ui.send` messages that carry the whole state (the held
  utterances, each bot's stop count): within one tick a part gets only the newest message of each name. A background
  part's frame loads after its plugin starts, so the part tells its host half when it is listening
  (`api.host.call("ready")`) and gets the state so far back.

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
- `api.turns.take(name, opts)` works in a component too (plugin-host, "Turns"): the same queue as the host halves'.
  A component's turn ends when its frame goes (the part removed, its page reloaded or asleep), so a part that must
  keep a turn while it is out of sight takes it in its host half.
- `api.streams.open(name, opts)` and `api.streams.accept(name, (stream, meta) => …)` work in a component too
  (plugin-host, "Streams"): a Web `WritableStream<Uint8Array>` to your host half and a `ReadableStream<Uint8Array>` from
  it, for audio, frames and files, with back-pressure. A component opens to its host half and accepts what it opens;
  a stream ends when the frame goes. `api.points.stream(...)` reads a stream another plugin's point handler answers with.

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
it a handler; the island calls the handler when MOSS isn't in front and draws what it returns: the first line on its closed strip,
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
  the order plugins were installed; the rest are counted), how often it asks (every two seconds on the open tab, about every six on the closed strip, never while MOSS is in
  front or when no plugin fills the point; a handler that returns nothing a few times is left alone until plugins change or a bot starts work), and how long a line lasts: exactly as long as your handler returns it. Return nothing to remove
  it; a plugin that is turned off, stopped or removed has no line. A handler that takes more than 1.5 seconds or throws
  shows nothing that time, and one that fails three times running is left alone for 30 seconds.
- A line never opens the island or raises it over the user's work: it is drawn on the closed strip (small, below it, only when
  no card is waiting and MOSS isn't in front) or on the open Needs you tab, below the cards. The bot's name is written only
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
  scrolls inside itself (MOSS makes your document's body scroll there). So an app's page can be laid out like an
  editor: `height: 100vh` for its root, a toolbar and a pinned footer, and the middle scrolling on its own.
- **Height everywhere else** is your content's: MOSS measures the bottom of your page's top elements as they change
  and sizes the frame to it (up to 100,000 px). So in a Settings section, the status bar or another plugin's spot,
  never size your root by `100vh` or `height: 100%`: those mean your frame, which is as tall as you say, and it stays
  at its first 150 px. Let your content decide.
- **A fixed box**, set by the host, in a few places: a sidebar a plugin draws in place of the stock one (`sidebar`, an
  app-wide part: it looks the same on every tab, so no entry there is tied to a bot) is the sidebar's whole height; a `sidebar.app` badge is 48 x 18; and a plugin that hosts others may size the
  frames in its own spot from its own stylesheet (`.slot > iframe { height: 72px !important }`: a `Spot` adds no
  element of its own, so the frame is a direct child of what holds it). 
  In a fixed box, `100%` is that box, and short boxes are real: draw less, not smaller.
- **A narrow window** (the main window under 900 px): `useMountContext().window.narrow` says so, and changes live: fold
  your layout the way the shell folds its own. A bot's tab is the window less the sidebar beside it, open or folded, so
  size a tab's parts by the tab's own width (a container query on your layout's root, or `shell.state().sidebar.width`
  in a frame), not the window's.
- **What a host passes a nested part**: props (plain data, through `Spot`'s `props`) and the size of the frame (its
  stylesheet). CSS variables don't cross into another plugin's frame, so a host reads them and passes the values. The
  avatar plugin does so for its renderers: a renderer's frame fills the figure's place, and its props hold `{ mount,
  src, file, format, name, portrait? }` and `framing: { mode?, crop?, headroom? }`, the theme's
  `--moss-avatar-framing` (`full`, `bust`, `waist`), `--moss-avatar-crop` and `--moss-avatar-headroom`, read again as
  the place resizes. A renderer frames the figure by its own box and that `framing`.
- **A renderer's mouth**: it fills MOSS Voice's point `moss.voice.speech` (an entry, `{ "id": "mouth" }`) and hears
  `{ bot, frames: [{ t, rms, centroid? }], cut? }` with `api.points.onMessage("moss.voice.speech", …)`: levels stamped in
  epoch milliseconds a little ahead of when they sound, `rms` loudness 0 to 1, `centroid` brightness in Hz; `cut` drops
  what isn't due yet. The SDK's `TimedSpeech` keeps them by time as a speech feed (`feed.subscribe(listener)` hears the
  frames a moment before each is due, `feed.now()` is its clock). A renderer never plays audio or hears a microphone.

plugin-examples, "A page that fits its space" (`ex-fit`, `ex-fit-tile`): an editor-shaped page that fills the main
area, pins its footer, scrolls its middle and folds when the window is narrow, and a tile that hides a secondary line
when its box is short.

## What a layer can and can't do

- It can't reach the user's files or MOSS's home directly; it uses the plugin API (`files` with that capability)
  or its host half.
- It reaches the network only to hosts the plugin holds as `network:<host>` capabilities (a plain `fetch` there
  works); every other host is blocked.
- It can't read another plugin's layer or MOSS's own (each layer is its own origin), open windows, or take focus.
- What a plugin draws inside its bot shows only on that bot's tab, in what Bots offers there; an entry marked
  `"app": true` is beside the bot and follows the app's rules (building-plugins, "What a plugin brings").
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
  (`window.addEventListener("dragover", (e) => e.preventDefault())`); items MOSS refuses are left out, and `refused`
  says why. It returns the function that stops listening.
- `api.files.url(token)`: a URL on the page's own origin that a `<video>`, `<audio>` or `<img>` plays directly, served
  in ranges, so a large file never passes through the page's memory. It works for a file the plugin may read.
- Everything else with a picked file happens in the host half: pass the token with `api.host.call` (plugin-host,
  "Picked files").
- Places no plugin may hold (the whole disk, the home folder itself, MOSS's own folder, secret places) are refused
  at the pick, with a reason.

What else a third-party page can run: WebAssembly from the plugin's own folder
(`WebAssembly.instantiateStreaming(fetch("/_p/<plugin-id>/client/codec.wasm"))`; strings never become code), Web
Workers (`new Worker(url)` from the plugin's files or a blob), WebCodecs (`VideoDecoder`, `VideoEncoder`), WebGL 2 and
canvas.

`SharedArrayBuffer` (a multi-threaded WebAssembly build such as ffmpeg.wasm's) needs a cross-origin isolated page:
opt in with `"client": { "entry": "…", "isolated": true }` in the manifest. It grants no reach (no network, no files)
and adds no line to the OK card; only that plugin's own pages are isolated. What it costs: a cross-origin image from one of the plugin's hosts
loads without credentials (every page of MOSS's is served that way, isolated or not), so a host that needs cookies or
a login for its images won't serve them into the page; fetch those through the host half instead. In an isolated page MOSS's own tests check `SharedArrayBuffer`, WebAssembly from the plugin's
folder, a worker, the media URL, approval cards and the app around it; WebCodecs and WebGL are checked in a plain page
only, so test them in yours. Without `isolated`, use a single-threaded build, or a program the host half runs
(plugin-host, "Programs").

## A renderer for the avatar plugin

MOSS has no avatar of its own; the bundled avatar plugin (`moss/character`) shows one figure at a time and declares its
own points. A renderer fills its UI spot `moss.character.renderer` keyed by a format of its own, and declares the format
in `moss.character.formats` (`{ id, format, name, capabilities: ["lipsync", "expressions", …] }`); a pack fills
`moss.character.packs` (`{ id, name, file, format, portrait?, license? }`, the model's files beside `file` coming along by
the kinds the point declares). The avatar plugin sends `{ mount, cue }` on the renderer spot for the drawing whose `mount`
prop it is, and the renderer sends back `{ mount, names }` (what its model answers to) and `{ mount, box }` (where the
figure stands) with `api.points.send`. The helpers MOSS's own renderers use are in `@waifucave/moss-plugin-sdk/ui`, the one
SDK module a page is served (import nothing from a subpath of it): `TimedSpeech` for the mouth's levels, `SpeechRing` and
`frameSource` read the frame that sounds now, and `LipSync` turns it into five eased vowel weights (`aa`, `ih`, `ou`, `ee`,
`oh`, summing to at most 1; `SHUT` is a closed mouth). Map the weights onto your format's own mouth. The SDK's example
`example-pngtuber` is a whole one in one file.

## Testing a part

`@waifucave/moss-plugin-sdk/ui/testing` runs your part on the UI SDK's own runtime, over a fake layer that answers
from what your test gives: render it with `@testing-library/react` (happy-dom) or in a gallery page of your own.

```tsx
import { act, render, screen } from "@testing-library/react";
import { catalogSpot, fakeApi, fakeCore, runtimeWith, settle, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import { MyPanel } from "../client";

const core = fakeCore({ "session.get": () => ({ session: { id: "s1" } }) });
const api = fakeApi({ settings: { compact: true } }); // a plugin API: in-memory settings, the rest stubs
render(
  <TestLayer runtime={runtimeWith({ api: () => api, core: () => core, spot: catalogSpot, entries: [], component: () => undefined })} pluginId="my-plugin">
    <MyPanel props={{ session: "s1" }} tokens={{}} entry={{ pluginId: "my-plugin", id: "panel", spot: "panel" }} />
  </TestLayer>,
);
await act(() => settle()); // spots and calls answer a moment later, as in MOSS
expect(core.calls.map((c) => c.method)).toEqual(["session.get"]);
```

- `runtimeWith({...})`: which spots exist (`spot`, `catalogSpot` for MOSS's own), the entries that fill them and their
  components (a `<Spot>` in your part mounts them inline), `api(pluginId)` (what `usePluginApi()` returns),
  `core(pluginId)` (what `useCore()` reaches), `userSend`, `composerHost` (with `spot="composer"` on `TestLayer`),
  `approvals` (`fakeApprovals`, the pending cards `useApprovals()` and `<Card>` see), `sealedText` (what a card's sealed
  frames show; `sealedTextOf(frame)` reads it back), `t` (your strings), `tokens`, `context` (the mount context).
- `fakeCore(handlers)` records each call (`calls`) and `emit`s core events to `useCore().on` listeners;
  `bridgeCalls(kind)` lists what reached the app (`viewFrame`, `open`, `menu`, `userSend`…).
- Builders for the core's views (`botView`, `sessionView`, `computerView`, `pluginSummary`, `card`…), and
  `resolveSpot` to check which entries a spot would show.
- What a part keeps across a reload (`useKept`) is the window's session storage: clear it between tests.
- A card's sealed frames are iframes, as in MOSS: check which frames your part placed, never their words.
