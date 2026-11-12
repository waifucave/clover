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

## Talking to the host half

- `api.host.call("<name>", args)` calls an entry of the host module's `ui` table (`export const ui = { save }`); it
  runs as the plugin, and nothing else the host module exports is reachable from here.
- `api.host.on("<event>", (data) => …)` hears what the host half sends with `api.ui.send("<event>", data)`.
- `api.storage.synced.get` / `keys` read the synced store from a component; only the host half writes it.

## What a layer can and can't do

- It can't reach the user's files or Clover's home directly; it uses the plugin API (`files` with that capability)
  or its host half.
- It reaches the network only to hosts the plugin holds as `network:<host>` capabilities (a plain `fetch` there
  works); every other host is blocked.
- It can't read another plugin's layer or Clover's own (each layer is its own origin), open windows, or take focus.
- A bot's own plugin draws only in that bot's tab (plugin-manifest, "Children").
- A `web` entry (`{ "web": { "url": "https://…", "partition": "main" } }`) shows a web page in a frame instead of a
  component; its host is one of the plugin's network hosts.

## Files and media (NOT IN THIS BUILD YET)

<!-- pending: lane G (lane/g-plugin-media) and lane A (lane/a-workshop-fence); a test fails once their calls are in the catalog and this section still says "NOT IN THIS BUILD YET" -->

In this build a plugin can't open the user's own files from a picker, save through a save dialog, play a large file
it was given in `<video>` or `<audio>`, or run WebAssembly in its page. These are coming, in this shape:

- **Pickers**: a component asks for a file or a folder through the plugin API; the user picks it in the system's
  dialog, and the plugin gets a token for that file or folder, never a free path. The same for a save dialog.
- **Media**: a picked file gets a URL a `<video>` or `<audio>` element plays directly, served in ranges, so a large
  file never passes through the plugin's memory.
- **WebAssembly** in the plugin's layer, for decoders and effects written for the web.
- **Processing a picked file**: a `stdio` MCP server of the plugin (a program such as a video encoder) reading and
  writing the files the user picked.

Until then, an app like a video editor can be built with everything else (its page, its timeline, its own add-on
spot, its settings) and work on what the plugin keeps in its own data; tell the user that opening their files waits on
an update of Clover.
