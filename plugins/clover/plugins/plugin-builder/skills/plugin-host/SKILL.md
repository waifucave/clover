---
name: plugin-host
description: The host half of a Clover plugin - what host/index.ts exports (start, stop, MCP servers, handlers, the ui table), the plugin API it may call, storage, settings, secrets, the network, logs, and the fence it runs in. Read it before writing a plugin's tools, hooks, commands, triggers, a model adapter or an app's back end.
---

# The host half

`host.entry` is a TypeScript module that Clover's plugin host runs under Bun (a worker, or a process of its own with
`host.process: "own"` or `runtime: "node"`). It starts when something needs it (a tool call, a component's
`host.call`, a hook) unless `host.start` says to start at once.

## What it exports

```ts
import type { HandlerContext, HostModule, HostPluginApi, McpServerTransport } from "@waifucave/clover-plugin-sdk";

let api: HostPluginApi;

export function start(a: HostPluginApi) { api = a; }          // optional: once, before anything else
export function stop(reason: "reload" | "stop" | "removed") {} // optional: let go of timers and files

// MCP servers, by the key under contributes.mcpServers whose type is "host".
export const mcp: HostModule["mcp"] = {
  tools: (transport: McpServerTransport, api: HostPluginApi) => serve(transport),
};

// What the plugin's own components may call (api.host.call("save", …)): nothing else here is reachable from a page.
export const ui = {
  async save(args: unknown, ctx: HandlerContext) { /* … */ return { saved: true }; },
};

// Handlers: any other export a manifest entry names (a hook's, a command's, a trigger's `handler`, a model's
// `adapter`). Each is called with (args, ctx).
export async function beforeTool(input: { tool?: { name: string }; input?: unknown }, ctx: HandlerContext) {
  return {}; // nothing changes
}
```

- `start`, `stop`, `mcp` and `ui` are the host's own names; never name a handler one of them.
- An MCP server speaks MCP's JSON-RPC on the transport it gets: answer `initialize`, `tools/list`, `tools/call` and
  `ping` (the tool example in plugin-examples has a complete one with no dependency). A tool result is
  `{ content: [{ type: "text", text }], structuredContent?, isError? }`. Inside a `tools/call`, the `api` calls you
  await act for that call's session (the core's checks apply to the session); work started outside one (a timer,
  `start`) acts as the plugin.
- `ctx` (`HandlerContext`) holds `caller`, `session` (when the call is for one), `computer`, `signal` (aborted when
  the call is cancelled or times out: stop work then), `deadline`, and `api` bound to the call.

### Hooks

`contributes.hooks` names a handler and the events it runs on. It gets `{ event, session, bot, computer, tool,
input, result, text, outcome }` (the fields of its event) and returns what its event allows, or nothing:

- `tool.before`: `{ deny: { reason } }`, `{ ask: { reason } }` (the user gets a card), or `{ input }` (changed input);
- `tool.after`: `{ result }`; `message.in` / `message.out`: `{ text }`; `turn.start`: `{ note: { label, text } }`;
- `turn.end`, `compact.before`, `compact.after`: observe only.

Hooks on one event run one after another. Keep them fast and narrow (`tools` filter, `scope: "own-bot"` for a bot's
plugin). Hook events are on the OK card, and a new one asks again.

### Commands and triggers

A command handler gets the args its `args` schema describes, from the user in the composer. A trigger's handler is an
object with `arm({ routine, type, fields })` and `disarm({ routine, type })`: a routine file that uses the trigger arms
it, and the plugin then calls `api.routines.fire(routine, type, payload?)` when the routine should run, with the API
its `start(api)` was given (a call's own `ctx.api` ends with the call). Clover arms each routine again whenever the
host half starts, so `arm` replaces what it had. A plugin with triggers runs in the background on every computer, and
its OK card says so. The trigger example in plugin-examples is complete.

### Tools that drive a page

One host module may serve the plugin's page (`ui`) and an MCP server (`mcp`) over the same state, so a bot's tool call
and the user's click change one project: keep the state in the module (or its data folder), change it in one place,
and after each change `api.ui.send("changed", …)` so an open page redraws. Every bot gets the tools (the plugin's
`scope` says bots, agents or both; default both), and a tool serving a bot's call reaches what that bot can reach: the
`api` calls it awaits act for that call's session, under that bot's checks. List the tools that only read in
`readOnly` (no card); the ones that change the project raise the usual card at the default level.

## The plugin API in the host half

`api` (from `start`, an MCP server's second argument, or `ctx.api`) has what plugin-catalog lists as `host`, `both` or
`own`, and what the plugin's capabilities open:

- `api.plugin`: `{ id, namespace, version, computer }`.
- `api.storage.dataFolder`: `<home>/plugin-data/<id>/` on this computer (a string), the plugin's own folder for files
  (read and write with Bun's own `node:fs` / `Bun.file`); it exists before `start` runs, never synced, kept when the
  plugin is removed. Put an app's documents, caches and anything large here (a video editor's project and renders).
- `api.storage.synced`: a small store (1 MB) synced across the user's computers: `get`, `set`, `delete`, `keys`,
  `watch`. Components read it; only the host half writes it.
- `api.settings.get(key)`, `watch`, `set`: the manifest's `settings`.
- `api.ui.send(event, data)`: to the plugin's components (`api.host.on` there).
- `api.points.entries(name)` / `watch` / `call`: entries of a point the plugin declared, and their handlers
  (plugin-ui, "Points": which entries show, and how `call` runs a contributor's export).
- `api.net.fetch(url, init, { auth })`: HTTPS to the hosts the plugin holds as `network:<host>`; the core adds the
  key from the plugin's `auth` (the code never sees it). Every other host fails. Use it rather than a plain `fetch`: it is the door the fence keeps open.
- `api.secrets.get(name)`: only with `host.process: "own"`. Most plugins never need it: let `net.fetch` add the key.
- `api.confirm(text)`: a sealed card from the plugin; `true` only when the user says yes (plugin-cards).
- `api.notify.send({ title, body })` with `notify`; `api.conversation.*` with `conversation.read` /
  `conversation.post`; `api.files.*` with `files`; `api.bots.*` with `bots.read`; `api.avatar.*` with the `avatar.*`
  capabilities of a bot's own plugin.

Calls marked NOT SERVED YET in plugin-catalog fail with "isn't available yet": don't use them.

## Picked files

The page hands the host half the tokens the user's picks gave it (plugin-ui, "Files and media"); with the `files`
capability the host half uses a token as the path:

- `api.files.stat(token)`, `readText(token, { offset?, length? })`, `readBytes(token, …)`, `list(token)` (a folder),
  and `write(token, data)` for a save pick or under an export folder. Inside a picked folder the path is
  `grant:<uuid>/<relative path>` (`grant:<uuid>/clips/a.mp4`). `remove`, `move`, `glob` and `grep` don't take a token.
- An open pick is read-only; a save pick writes that one file (and reads it); a folder picked for writing reads and
  writes everything under it. Another plugin's token, or one the user removed, is refused.
- `api.files.path(token)` (host half only) gives the real path, for a program that takes paths (plugin-host,
  "Programs"). The plugin's own processes (its host, its `stdio` servers, its hook commands) may read the open picks
  and read and write the save picks and export folders, nothing else of the user's.

## Programs

A host half starts no program unless its plugin says so: in a worker, or in a process of its own, it is Bun and its
fence lets it run nothing else. A top-level plugin lets its host half run programs (an encoder such as ffmpeg, a
converter) with

```json
"host": { "entry": "host/index.ts", "process": "own", "programs": true }
```

(a child plugin's `programs` is refused, and so is one without `process: "own"`). Its OK card says "It runs programs on
this computer, limited to its own folder and the files you pick."; adding `programs` to a plugin already OK'd pauses
it until the user OKs that. The host half then starts the program itself, on the real paths of the user's picks:

```ts
const input = await api.files!.path(clipToken);   // an open pick: read
const output = await api.files!.path(saveToken);  // a save pick, or a file in a folder picked for writing
const ffmpeg = Bun.spawn(["ffmpeg", "-y", "-i", input, output], { stdout: "ignore", stderr: "pipe" });
if ((await ffmpeg.exited) !== 0) throw new Error((await new Response(ffmpeg.stderr).text()).trim().split("\n").pop());
```

- It reads the open picks, and writes only a save pick or under a folder picked for writing (and its data and temp
  folders). Nothing else of the user's, and no other place, whatever the program tries.
- A new process takes up the user's picks, since a fence is fixed when its process starts. A pick the user adds while
  a call is running (an export) waits: the process is replaced once no call is in flight, so the running job finishes
  and the next call sees the pick (after 10 minutes of calls it is replaced anyway, with 5 seconds' grace). A pick the
  user takes back replaces it after 5 seconds, running call or not. So have the user pick the input and the output
  before a job starts, and keep the project's state where a new process finds it (the synced store or the data
  folder), never in memory alone. The plugin's `stdio` servers follow picks the same way.
- A program the computer lacks fails to start: check with `Bun.which("ffmpeg")` and tell the user what to install.

Without `programs`, a program runs from the plugin's `stdio` MCP server or a hook's `command` instead (a bot's tool):
those are fenced the same way and may run programs on the user's picks, but have no plugin API to turn a `grant:` token
into a path.

## The fence

On macOS every process of a plugin runs fenced to the plugin. A host half can read its plugin's folder, read and write
its data folder and its temp folder (its `TMPDIR`), and reach only its granted hosts through Clover's proxy. It can't
read the Clover home (other plugins, bots, sessions, settings, logs), the user's home folders, the keychain or the
clipboard; it can't start any program but its own Bun unless it declares `programs` ("Programs"). A `stdio` MCP
server or a hook's `command` is fenced the same way, except that it may run programs (a package runner's server works).
So:

- a tool that needs the user's files uses `api.files` (with `files`) on the files the user picked, never a path it
  guesses;
- a program (an encoder, a converter) runs from a host half that declares `programs`, a `stdio` server or a hook
  command ("Programs");
- write only under `api.storage.dataFolder` or the temp folder.

## Logs and errors

What the host half writes to `console.log` / `console.error` lands in its log; the status tool shows the last lines,
and a thrown error in a handler comes back to its caller as an error. Log what helps you fix it (never a key). The
host half is restarted when its files change (plugin-loop), and `stop("reload")` runs first.
