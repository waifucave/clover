---
name: plugin-manifest
description: Clover's plugin manifest, clover.json, field by field - every top-level field, every contributes key with its entry fields, settings, sign-ins, child plugins and your own points. Read it while writing or fixing a clover.json.
---

# `clover.json`, field by field

The manifest is JSON (comments and trailing commas are allowed). Every object is strict: a field not listed here is
an error, so check spelling against this page and the check tool's findings. Paths are relative to the plugin folder,
written with `/`, and must stay inside it. `Text` (a name, a description, a title) is a string, or translations
`{ "en": "…", "ja": "…" }` with `en` required.

## Top level

| field | needed | what it is |
| :- | :- | :- |
| `$schema` | no | An editor's hint; ignored. |
| `manifest` | yes | Always `1`. |
| `id` | yes (top level) | Lowercase letters, digits and single hyphens, starting with a letter; equal to the folder's name. A child leaves it out. |
| `name` | yes | `Text`: what people see. |
| `version` | no | Semver, default `0.0.0`. A child inherits it. |
| `description` | no | `Text`: one or two sentences; the OK card shows it. |
| `icon` | no | Path to an svg, png or webp, at most 256 KiB. |
| `author` | no | `{ "name": "…", "url": "https://…" }`. |
| `license`, `homepage` | no | A license id; a link opened in the user's browser (not a network host). |
| `namespace` | no | The prefix of its tools' names; default the id; `clover` is reserved. Top level only. |
| `engines` | when there is code | `{ "clover": "^1.0.0" }`: the plugin-API range it was written for. |
| `platforms` | no | Where its code runs: some of `darwin-arm64`, `windows-x64`, `linux-x64`, `linux-arm64`; default all. |
| `adult` | no | `true` keeps the whole tree off until the user confirms they are 18+. |
| `enabledByDefault` | no | Children only (default `true`): `false` ships it off until the user turns it on. |
| `scope` | no | Who gets its tools, skills, agents and hooks: `bots`, `agents` or `both` (default). |
| `onlyBackends` | no | Only these agent backends receive it, e.g. `["claude-code"]`. Rarely needed. |
| `host` | for host code | `{ "entry": "host/index.ts", "runtime": "bun" }`; see below. |
| `client` | for components | `{ "entry": "client/index.ts", "css": ["client/style.css"], "isolated": true }`: `isolated` (default false) makes its pages cross-origin isolated, for `SharedArrayBuffer`; see plugin-ui. |
| `helper` | no | Refused by the check: don't use it. A host half with `programs: true` runs a program instead (plugin-host). |
| `capabilities` | no | Strings from plugin-catalog ("Capabilities"); each is a line on the OK card. |
| `settings` | no | The plugin's settings, by key; see below. |
| `auth` | no | Sign-ins for the plugin's own service; see below. |
| `addons` | no | `{ "description": "…" }`: the plugin runs add-ons of its own, in a format it chooses (a video editor's effects). The OK card says so. |
| `contributes` | almost always | What it adds; see below. |
| `availability`, `built`, `generated` | never | Clover writes these for its own plugins; a plugin of yours carrying one is refused. |

### `host`

- `entry`: the module (TypeScript is fine). `runtime`: `bun`, the only one (a worker in the shared plugin host, the
  default); the check refuses `node`: use `process: "own"` for a process of its own.
- `process: "own"`: a process of its own under Bun too. Needed for `secrets.get` (plugin-host).
- `programs: true` (with `process: "own"`, in a top-level plugin only): the host half may run programs on the computer,
  such as ffmpeg, within its own folders and the files the user picks (plugin-host, "Programs"). The OK card says so.
- `start`: `each`, `main` or `chosen`: start at once on those computers; without it the host half starts when
  something needs it (a tool call, a component's `host.call`).
- `declares`: points the host half serves (a data point other plugins fill, read with `points.*`), as below.

### `settings`

`"settings": { "<key>": { "type": "…", "title": "…" } }`. A key is a letter, then letters, digits, `_`, `.`, `-`.

- `type`: `string`, `number`, `boolean`, `enum` (with `options`: strings or `{ "value", "title" }`), `color`, or
  `secret` (kept in the keychain, never in a file; read only from a process of its own).
- `title` (required), `description`, `default`, `min`, `max`.
- `scope`: `account` (default, synced), `device` (this computer only), `bot` (one value per bot).
- `required: true`: the plugin waits until the user sets it. Avoid it unless the plugin can't work at all without it.

Clover draws the settings form itself. Code reads a value with `api.settings.get("<key>")` and hears changes with
`api.settings.watch`. A changed `default` asks the OK again (plugin-cards).

### `auth`

A list, one entry per sign-in; `secret` names where the key or token is kept:

- `{ "method": "api-key", "secret": "apiKey", "help": "Where to get a key" }`
- `{ "method": "oauth-pkce", "authorizeUrl": "https://…", "tokenUrl": "https://…", "clientId": "…", "scopes": [], "secret": "token" }`
- `{ "method": "custom", "handler": "signIn" }`: an export of the host half runs the sign-in.

Each may add `"placement": { "header": "authorization", "scheme": "Bearer" }` (or `{ "header": "x-api-key" }`,
`api-key`, `x-goog-api-key`): where `api.net.fetch` puts the key. Your code never handles the key: the fetch adds it.
`method: "core"` is Clover's own plugins' only.

### Interpolation

In a `stdio` server's `command`, `args` and `env`, an `http` server's `url` and `headers`, and a hook's `command` and
`args`, a value may hold `${plugin}` (the plugin's folder), `${data}` (its data folder), `${setting:k}`,
`${secret:k}` (only in `env` and `headers`) and `${secretFile:k}` (a 0600 file holding it; in a stdio server's `env`
and `args`). A `network:` capability's host and a model's `endpoint.baseUrl` may name a setting, never a secret.
Nothing else in a manifest is an expression.

## `contributes`

Each key below is one of the core's points. A key with a dot (`alpha.scenes`) is another plugin's data point; a UI
spot is never a key here, it goes in `ui`. plugin-catalog lists every point and spot.

- **`bot`** (one): `name`, `instructions` (a Markdown file), and optionally `model: { default: "<qualified id>",
  effort }`, `avatar: { file, format: "vrm" | "live2d" | a renderer plugin's format, portrait }`, `voice: { provider,
  voice, model, listen }`, `theme` (one of this plugin's theme ids), `layout` (a layout file for its tab), `greeting`
  (Markdown), `memory` (a folder of starter memories).
- **`models`** (list): `provider` (an entry id), `name`, `terms`, `catalog` (a path to rows, or the rows), `auth`
  (sign-ins, may be `[]`), and either `endpoint: { protocol: "openai-chat" | "openai-responses" |
  "anthropic-messages", baseUrl }` (no code) or `adapter` (a host export).
- **`mcpServers`** (by name: letters, digits, `_`, `-`): `type` `host` (the host half's `mcp.<name>` export) or
  `stdio` (`command`, `args`, `env`); `http` isn't served yet. `tools`: per tool `preload` or `on-demand`, `"*"` the
  default (on-demand when unsaid). `readOnly` / `contained`: tools that skip the card (plugin-cards). `instructions`
  (a Markdown file, about 4 KB at most), `perComputer`, `scope`, `when: { os }`. A session sees a tool as
  `mcp__<server>__<tool>`.
- **`skills`** (list of paths or globs): `skills/*/SKILL.md`. Each file starts with `---` frontmatter holding `name`
  and `description`; the description is what a bot searches, so say when to use it.
- **`agents`** (list): a Markdown file path, or `{ id, name, backend, model, effort, instructions, computer, root,
  plugins: { only, except } }`.
- **`hooks`** (list): `{ id, on: [<events>], tools: ["Bash", "mcp__*"], handler | command + args, timeoutMs,
  scope: "bots" | "agents" | "both" | "own-bot" }`. Events and what each may return: plugin-catalog. `own-bot`
  limits it to the sessions of this tree's own bots (and the OK card says so).
- **`commands`** (list): `{ name, description, args (JSON Schema), handler, runsOn }`: the user runs them from the
  composer. `key` is accepted but not bound yet.
- **`triggers`** (list): `{ type, title, fields (JSON Schema), handler }`: a new kind of routine trigger.
- **`voices`** (list): `{ id, name, speak, listen, auth, handler }`.
- **`computerProviders`**, **`computer`**, **`agentBackends`**, **`relays`**, **`notifiers`**, **`companions`**:
  Clover's own services use these; a bot building a plugin for a user rarely needs them. Their fields are in the SDK's
  schema (`ServiceSchema`: `{ id, name, handler, runsOn }`).
- **`themes`** (list): `{ id, file }`, a theme file (plugin-examples has one; tokens in plugin-catalog).
- **`locales`** (list): `{ lang, file }`: a JSON file of the plugin's strings in that language, read with `t`.
- **`ui`** (list): the plugin's UI; next section.

Every entry above may also carry `declares` (below).

### `ui` entries

`{ "spot": "<spot>", "id": "<entry id>", "component": "<client export>" }` plus:

- exactly one of `component` (a client export), `web` (`{ url | entry, partition }`: a web page in a frame of its
  own), `style` (a theme-format file restyling what fills that spot) or `hide: true` (hides that spot, or with
  `target: "<plugin-id>#<entry-id>"` one entry of a list spot);
- `id`: needed when the plugin fills one spot twice; `key`: the key in a keyed spot (`main`, `panel`, `bot.tab`);
  `order`: position in a list spot (default 500);
- `when`: `{ bot, surface, os, setting: { "<key>": <value> }, session }`: show only there or then;
- the spot's own fields: plugin-catalog lists them (`title` and `icon` for `sidebar.app`, `opens` naming a `main`
  key, `title` for `settings.section`…);
- `layout` (on `bot.tab` only), `window` (`{ type: "overlay" | "window", alwaysOnTop, transparent }` for a window spot).

### Your own points and spots (`declares`)

On a `ui` entry with a `component` (a UI spot that component draws) or under `host.declares` / any entry (a data
point): `"declares": { "<your-id>.<name>": { "shape": "single" | "list" | "keyed", … } }` with

- `props` (a JSON Schema; `{}` for nothing): makes it a **UI spot**; the component draws its entries with `Spot`;
- `fields` (a JSON Schema): what each entry carries (a data point's entries are its fields);
- `doc`: one sentence for the plugins that fill it; `needs`: capabilities a filler must hold; `context`: the keys it
  offers to `when`; `private: true`: only your own tree may fill it; `deprecated`: a note that it is going;
- rarely: `gates` (props that reach only a filler holding a capability, by dotted path) and `keep` (keys that can't be
  hidden).

Other plugins fill a UI spot with a `ui` entry (`"spot": "<your-id>.<name>"`) and a data point with a top-level
`contributes` key (`"<your-id>.<name>": [ … ]`). plugin-examples shows both.

## Children

A plugin may hold child plugins one level down, at `plugins/<folder>/clover.json`. A child has no `id` (it is
`<parent-id>/<folder>`), no `namespace`, `version` or `adult` of its own, and may set `enabledByDefault: false`. One OK
covers the whole tree, and a child that fails is off alone. A child with code (a `host` or a `client`) needs its own
`engines` (`{ "clover": "^1.0.0" }`): it doesn't take its parent's, and without it the child is invalid. Use a child for an optional part, and for a bot's UI
outside its own tab: a bot's plugin may put UI only in its tab's spots (`bot.header`, `bot.side`, `bot.stage`,
`bot.controls`, `conversation`, `composer`…), with `when.bot` naming only itself.
