---
name: plugin-host
description: The host half of a Clover plugin - what host/index.ts exports (start, stop, MCP servers, handlers, the ui table), the plugin API it may call, storage, settings, secrets, the network, logs, and the fence it runs in. Read it before writing a plugin's tools, hooks, commands, triggers, a model adapter or an app's back end.
---

# The host half

`host.entry` is a TypeScript module that Clover's plugin host runs under Bun (a worker, or a process of its own with
`host.process: "own"`; Bun is the only runtime, and the check refuses `runtime: "node"`). It starts when something needs it (a tool call, a component's
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
- `api.points.active(name)` / `onActive(name, listener)`: for a point that takes one filler at a time
  (`oneAtATime`, plugin-manifest), which entry is active (`{ pluginId, entryId }`, or undefined with none running):
  the user's pick in Settings, else the default. Your tree reads it, and so does a plugin that fills it (to know
  whether it is the one). No call changes it: only the user does, in Settings.
- `api.net.fetch(url, init, { auth })`: HTTPS to the hosts the plugin holds as `network:<host>`; the core adds the
  key from the plugin's `auth` (the code never sees it). Every other host fails. Use it rather than a plain `fetch`: it is the door the fence keeps open.
- `api.secrets.get(name)`: only with `host.process: "own"`. Most plugins never need it: let `net.fetch` add the key.
- `api.confirm(text)`: a sealed card from the plugin; `true` only when the user says yes (plugin-cards).
- `api.notify.send({ title, body })` with `notify`; `api.conversation.*` with `conversation.read` /
  `conversation.post`; `api.files.*` with `files`; `api.bots.*` with `bots.read`; `api.avatar.*` with the `avatar.*`
  capabilities of a bot's own plugin.
- `api.avatar.cue(cue, { bot? })` moves a bot's figure: `{ type: "expression" | "motion", name }`, `{ type: "outfit", part,
  on }`, `{ type: "pace", calm }`, `{ type: "lookAt", point }`, and **the mouth**: `{ type: "speech", frames: [{ t, rms,
  centroid? }] }`, where `t` is epoch milliseconds (`Date.now()`'s clock), `rms` loudness 0 to 1 and `centroid` brightness
  in Hz. Send speech in batches ahead of the clock: at most 128 levels a batch, stamps strictly rising, none more than two
  minutes ahead, at most 20 speech cues and 2000 levels a second; a level lasts until the next (at most 50 ms), so 20 ms
  hops suit. `{ type: "speech", frames: [], cut: true }` forgets every level not yet due (the speech was stopped or
  replaced). It resolves `{ ok: true }` or `{ ok: false, reason, message }` (`no-renderer`, `unsupported`: the renderer
  declares no `lipsync`, `unknown-name`, `invalid`); a rate or permission refusal throws. A plugin cues its own bot with
  `avatar.control`; `{ bot: "<bot id>" }` names another and needs `avatar.control.all` (the OK says it "moves any of your
  bots' figures"; holding it carries `avatar.control`); without it the call is refused, saying so.

Calls marked NOT SERVED YET in plugin-catalog fail with "isn't available yet": don't use them.

### Turns: one at a time

When two plugins or two bots must not do a thing at once (speak, move one figure, drive one tab), take a turn first.
The platform runs the queue, first come first served, one holder per name, the same queue for host halves and
components of every plugin:

```ts
const turn = await api.turns.take("my-plugin/deck", { limitMs: 30_000, note: "a reading" });
try {
  // ...the work, one at a time...
} finally {
  await turn.done();
}
```

- Names: `<your plugin id>/<name>` is yours (no declaration). Another plugin can take it only if your manifest lists
  `<name>` in `contributes.turns` (plugin-manifest). `device/speech` is one voice at a time on this device, behind the
  `audio` capability.
- The turn ends when you call `done()`, when its limit passes (default 60 s, `turn.extend(ms)` up to 10 minutes from the
  grant), or when its holder goes (its host process exits, its plugin stops, a component's frame goes). `turn.lost`
  resolves `"limit"` or `"stopped"` when the platform ended it: stop the work then. Never hold a turn across a wait for
  the user.
- `api.turns.state(name)` and `api.turns.watch(name, listener)`: who holds it and how many wait. A take still waiting
  leaves the queue with an `AbortSignal` (`{ signal }`), or when its holder goes.
- A plugin may have 64 takes of one name and 256 over all its names held or waiting at once (4,096 on the computer);
  one more is refused with why. A note is for the log and `state`: control characters in it become spaces.

### Streams: bytes between your halves

`ui.send` carries messages (64 KB, 50 a second). For audio, video frames or a file, open a stream between your plugin's
own halves, in order, with back-pressure. No capability. One half accepts a name, the other opens it:

```ts
// host half: take what the page sends
api.streams.accept("mic", async (stream, meta) => {
  for await (const chunk of stream) transcribe(chunk, meta); // a ReadableStream<Uint8Array>
});
// host half: send audio to the page (which accepts "speech" the same way)
const out = (await api.streams.open("speech", { meta: { rate: 24000 } })).getWriter();
await out.write(bytes); // waits while the page isn't keeping up
await out.close();      // out.abort("why") cancels it
```

- A component opens to its host half and a host half to one of its components. Wait for `accept(...).opened` before you
  tell the other half you are ready; an open with no acceptor on the other side is refused, with why.
- A write waits until the daemon has room, so a slow reader slows the writer instead of filling memory. The daemon
  buffers 256 KiB a stream and sends in chunks of at most 32 KiB; the SDK cuts bigger writes for you. At most 8 streams
  open at once per plugin, 16 accepted names.
- Either side can cancel (`abort(reason)` on the writable, `cancel(reason)` on the readable) and the other hears why
  (its stream errors). A stream also ends when a frame goes, a host process exits, the plugin stops or the app quits.
  Close the writable when you are done: the reader's stream ends after the last chunk.
- A point handler may answer another plugin with a stream: return a `Uint8Array`, an async iterable or a
  `ReadableStream` of bytes from the handler, and the declarer calls it with
  `await api.points.stream("ex-editor.sources", { pluginId, entryId }, "<field>", args)`, which gives a
  `ReadableStream` (the same checks as `points.call`; a failing handler errors the stream; leaving it cancels the
  handler).

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
