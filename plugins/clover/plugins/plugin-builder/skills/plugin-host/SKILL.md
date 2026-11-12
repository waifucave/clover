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
object with `check({ fields })`, `next({ fields, after })` and `missed({ fields, after, until })`: the trigger example
in plugin-examples is complete.

## The plugin API in the host half

`api` (from `start`, an MCP server's second argument, or `ctx.api`) has what plugin-catalog lists as `host`, `both` or
`own`, and what the plugin's capabilities open:

- `api.plugin`: `{ id, namespace, version, computer }`.
- `api.storage.dataFolder`: `<home>/plugin-data/<id>/` on this computer, the plugin's own folder for files (read and
  write with Bun's own `node:fs` / `Bun.file`); never synced, kept when the plugin is removed. Put an app's documents,
  caches and anything large here.
- `api.storage.synced`: a small store (1 MB) synced across the user's computers: `get`, `set`, `delete`, `keys`,
  `watch`. Components read it; only the host half writes it.
- `api.settings.get(key)`, `watch`, `set`: the manifest's `settings`.
- `api.ui.send(event, data)`: to the plugin's components (`api.host.on` there).
- `api.points.entries(name)` / `watch` / `call`: entries of a point the plugin declared, and their handlers.
- `api.net.fetch(url, init, { auth })`: HTTPS to the hosts the plugin holds as `network:<host>`; the core adds the
  key from the plugin's `auth` (the code never sees it). Every other host fails. Use it rather than a plain `fetch`: it is the door the fence keeps open.
- `api.secrets.get(name)`: only with `host.process: "own"`. Most plugins never need it: let `net.fetch` add the key.
- `api.confirm(text)`: a sealed card from the plugin; `true` only when the user says yes (plugin-cards).
- `api.notify.send({ title, body })` with `notify`; `api.conversation.*` with `conversation.read` /
  `conversation.post`; `api.files.*` with `files`; `api.bots.*` with `bots.read`; `api.avatar.*` with the `avatar.*`
  capabilities of a bot's own plugin.

Calls marked NOT SERVED YET in plugin-catalog fail with "isn't available yet": don't use them.

## The fence

On macOS every process of a plugin runs fenced to the plugin. A host half can read its plugin's folder, read and write
its data folder and its temp folder (its `TMPDIR`), and reach only its granted hosts through Clover's proxy. It can't
read the Clover home (other plugins, bots, sessions, settings, logs), the user's home folders, the keychain or the
clipboard; it can't start any program but its own Bun. A `stdio` MCP server or a hook's `command` is fenced the same
way, except that it may run programs (a package runner's server works). So:

- a tool that needs the user's files uses `api.files` (with `files`), never a path it guesses;
- a tool that needs a program (an encoder, a converter) is a `stdio` server or a hook command, not the host half;
- write only under `api.storage.dataFolder` or the temp folder.

## Logs and errors

What the host half writes to `console.log` / `console.error` lands in its log; the status tool shows the last lines,
and a thrown error in a handler comes back to its caller as an error. Log what helps you fix it (never a key). The
host half is restarted when its files change (plugin-loop), and `stop("reload")` runs first.
