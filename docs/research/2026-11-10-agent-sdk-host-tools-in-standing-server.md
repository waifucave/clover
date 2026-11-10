# Agent SDK request: let the host add tools under the standing `clover` server

For the agent SDK and runtime (`@waifucave/clover-agent-sdk`, `@waifucave/clover-agent-runtime`, seen at 0.0.76). From
Clover's core, lane A, 2026-11-10.

## What the host needs

The Clover spec (§5.3, §6.7) names every tool a bundled plugin ships `mcp__clover__<Tool>`: the web plugin's
`mcp__clover__WebSearch` and `mcp__clover__WebFetch`, the browser plugin's `mcp__clover__Browser`. The tools are
served by the daemon (each from its own plugin's MCP server, routed per tool by the host) and handed to the bot
session as host MCP servers through `Options.mcpServers`.

To read `mcp__clover__…`, the host has to put those tools under the server name `clover`. That name is the Clover
brand's `mcpServerName`, so the runtime owns it for its standing server.

## What happens today

Handing the runtime a host server named `clover` (an in-process `sdk` server, `createSdkMcpServer`) ends the session
before it starts. The runtime's stderr:

```
winter: fatal: Error: registerMcpServerTools: "clover" is a RESERVED server name -- the standing Winter server (its name is defined in mcp/winter-server.ts) owns this identity and is registry-native; it is never installed through this live-mutation function, and nothing else may register live tools under it either.
```

The host then sees `runtime exited before init`. The control seam refuses the same name later too (`setServers`:
`"clover" is a reserved server identity (RULING P4-B, the standing Winter server) -- no source may configure a live
MCP server under this name`).

Clover's acceptance run hit this at step 3 (every bot turn failed) when the bundled tools were offered as
`mcp__clover__…`. The core now keeps such a server out of the session (`runtimeReservedServerNames`, driver.ts) and
offers the bundled tools as `mcp__<server>__…` (`mcp__web__WebSearch`) until the runtime allows one of the shapes below.

## Two shapes that would work

1. **Host tools inside the standing server.** An option (on `query` options, or the brand) that lets the host add
   tools to the standing server: for example `standingServerTools: McpSdkServerConfigWithInstance[]`, or allowing
   `mcpServers[brand.mcpServerName]` when it is `type: "sdk"` and merging its tools into the standing server's registry.
   The runtime would call the host's handler for those tools exactly as it does for any `sdk` server. Tool names must
   stay unique within the server: a host tool whose name the standing server already registers should be refused at
   init with both named, never shadowed. This keeps `mcp__clover__…` for both the runtime's own tools and the bundled
   ones, as the spec has it.
2. **A different name for the standing server, per session.** An option that sets the standing server's name for one
   session (for bot sessions, where Clover doesn't use the runtime's standing tools by that name), leaving
   `clover` free for a host server. This changes no brand-wide name: code and dispatch sessions keep the standing
   server under `clover`, so their `mcp__clover__<key>__<tool>` capability names don't move.

Either shape needs no change on Clover's side beyond switching `PluginMcp`'s `bundledServer` on (lane A's
`plugin-mcp.ts`), which already places and routes the shared name per tool and refuses a tool name two bundled servers
both give.

## How the host will know

Clover's tests assert today that the runtime keeps `clover` (`runtimeReservedServerNames().has("clover")`,
`plugin-mcp.test.ts`) and that the driver never hands it a server under that name (a real-runtime turn in
`driver.e2e.test.ts`). Once the runtime ships a shape above, those tests change with the switch.
