// Clover protocol area: agents (spec §9.3). Owner: lane K (the Agent tool, ACP backends, the bridge). Pinned by lane
// B at M0, from spike S5 (lane K's report of November 5, §8 "For the spine").
//
// A background agent is a session like any other (`session.*` in sessions.ts): `SendMessage` becomes its next
// prompt, `TaskStop` is `session.stop`, and its task notification is `agent_finished`. Bots start agents with the
// `Agent` tool, in-process; the user starts a coding session directly with `agent.start` (`clover code`). An ACP
// agent reaches Clover's plugins only through one bridge MCP server, whose connection (role `bridge`) is bound to
// that agent session by its token: its tools, `SendMessage` and `Glossary` (glossary.query, plugins.ts), nothing
// else. Everything handed to an agent counts as stored in plain text; the bridge token is the only secret, in the
// bridge entry's `env` (S5 edit 4).
import { z } from "zod";
import { utf16 } from "./strings";
import { AnyPluginId, ComputerName, Empty, Ok, SessionId, Text, TreePath } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

/** Facts Settings marks on a backend (S5 edit 4, edit 6; §9.3 "Settings marks it"). */
export const BackendMark = z.enum([
  /** It stores what it is given (env, headers, prompts) in plain text (Antigravity). */
  "stores-plain-text",
  /** It hands its whole environment to the servers it starts (Antigravity). */
  "passes-environment",
  /** It can't take the fenced set as a deny list in its own settings (§9.3). */
  "no-deny-list",
  /** It has no sandbox on this computer, so it starts only after the user's OK (§9.3). */
  "unsandboxed",
  /** Some of its actions never reach a card (Cursor: edits and allowlisted commands inside the root, S5 edit 6). */
  "unasked-actions",
  /** A delegation's model choice becomes the user's own selection (Cursor, S5 edit 11). */
  "persists-model-choice",
]);
export type BackendMark = z.infer<typeof BackendMark>;

export const AgentBackendView = z.object({
  id: utf16(128, 1),
  name: Text,
  pluginId: AnyPluginId,
  protocol: z.enum(["acp", "cloud"]),
  placement: z.enum(["local", "cloud"]),
  /** Per computer: installed, its version, sandboxed there, and the marks that apply there. */
  computers: z.array(z.object({
    computer: ComputerName,
    installed: z.boolean(),
    version: utf16(64).optional(),
    sandboxed: z.boolean().optional(),
    marks: z.array(BackendMark).max(16),
  })).max(256),
});
export type AgentBackendView = z.infer<typeof AgentBackendView>;

/** An agent definition from a plugin's `agents` (§5.3): a preset for `Agent`. */
export const AgentDefView = z.object({
  id: utf16(128, 1),
  name: Text,
  pluginId: AnyPluginId,
  backend: utf16(128),
  model: utf16(200).optional(),
  effort: utf16(32).optional(),
  computer: ComputerName.optional(),
  root: TreePath.optional(),
});
export type AgentDefView = z.infer<typeof AgentDefView>;

/** A bridge tool as the agent sees it: one of the plugin tools in its scope, with a description that stands on its
 *  own, since Cursor and Antigravity keep server instructions out of the prompt (S5 edit 3). */
export const BridgeTool = z.object({
  name: utf16(64, 1),
  description: utf16(10_000),
  inputSchema: z.record(z.string(), z.unknown()),
});

/** The longest ACP line `clover-core code-agent` relays either way (K-M3b): inside a JSON string on one NDJSON line it
 *  stays under the socket's 8 MiB (`NDJSON_MAX_LINE_BYTES`), however it is escaped. */
export const CODE_AGENT_MAX_LINE = 2 * 1024 * 1024;

/** The notification that carries one ACP line from the coding agent to `clover-core code-agent`, on its bound
 *  connection only (a notification, not a request: nothing answers it). */
export const CODE_AGENT_LINE_NOTIFICATION = "codeAgent.line";
export const CodeAgentLine = z.object({ line: utf16(CODE_AGENT_MAX_LINE, 1) });
export type CodeAgentLine = z.infer<typeof CodeAgentLine>;

export const AGENTS_METHODS = {
  agentBackends: defineMethod({
    name: "agent.backends", owner: "K", roles: ["app", "cli"],
    params: Empty, result: z.object({ backends: z.array(AgentBackendView) }),
    doc: "The agent backends plugins contribute, with what each computer has (§5.3, §9.3).",
  }),
  agentDefinitions: defineMethod({
    name: "agent.definitions", owner: "K", roles: ["app", "cli"],
    params: Empty, result: z.object({ definitions: z.array(AgentDefView) }),
    doc: "Agent definitions from plugins, the presets `Agent` offers.",
  }),
  agentStart: defineMethod({
    name: "agent.start", owner: "K", roles: ["app", "cli"], userOnly: true,
    params: z.object({
      backend: utf16(128, 1),
      computer: ComputerName,
      /** A folder in the tree; refused if it contains the Clover home (§9.3). */
      root: TreePath,
      model: utf16(200).optional(),
      effort: utf16(32).optional(),
      definition: utf16(128).optional(),
      prompt: utf16(1_000_000).optional(),
    }),
    result: z.object({ session: SessionId }),
    doc: "Starts a coding session the user drives directly, with no bot (`clover code`, §9.3).",
  }),

  // `clover-core code-agent` (K-M3b): an outside ACP client's (Zed's) relay to Clover's coding agent, on a `cli`
  // connection that counts as the user. `codeAgent.open` binds the connection to one session; after it the connection
  // takes only `codeAgent.send`, and the session ends when the connection does.
  codeAgentOpen: defineMethod({
    name: "codeAgent.open", owner: "K", roles: ["cli"], userOnly: true,
    params: z.object({
      /** The folder the client opened, as an absolute path: a folder of this computer's tree, under the fence. */
      cwd: utf16(4096, 1),
      model: utf16(200).optional(),
      effort: utf16(32).optional(),
    }),
    result: z.object({ session: SessionId }),
    doc: "Opens a coding session the user drives from an outside ACP client, bound to this connection (§9.3).",
  }),
  codeAgentSend: defineMethod({
    name: "codeAgent.send", owner: "K", roles: ["cli"], userOnly: true,
    params: z.object({ line: utf16(CODE_AGENT_MAX_LINE, 1) }), result: Ok,
    doc: "One ACP line from the outside client to the coding agent of this connection's session.",
  }),

  // The bridge (role `bridge`): bound to one agent session by its token.
  bridgeTools: defineMethod({
    name: "bridge.tools", owner: "K", roles: ["bridge"],
    params: Empty, result: z.object({ tools: z.array(BridgeTool), instructions: utf16(64_000) }),
    doc: "The plugin tools in this agent's scope, plus `SendMessage` and `Glossary`, and the instructions the bridge sends as its own.",
  }),
  bridgeCall: defineMethod({
    name: "bridge.call", owner: "K", roles: ["bridge"],
    params: z.object({ callId: utf16(128, 1), tool: utf16(64, 1), input: z.unknown() }),
    result: z.object({ content: z.array(z.unknown()), isError: z.boolean() }),
    doc: "Runs a bridged tool wherever it actually runs, under the same approval rules (§9.3).",
  }),
  bridgeSendMessage: defineMethod({
    name: "bridge.sendMessage", owner: "K", roles: ["bridge"],
    params: z.object({ text: utf16(1_000_000, 1), to: SessionId.optional() }),
    result: z.object({ ok: z.literal(true) }),
    doc: "The agent messages its bot (or another session); it folds in like any bot message (§9.3).",
  }),
} as const;

export const AgentBackendsChangedEvent = coreEvent("agent_backends_changed", {});

export const AGENTS_EVENTS = {
  agentBackendsChanged: defineEvent({
    type: "agent_backends_changed", owner: "K", roles: ["app", "cli"], schema: AgentBackendsChangedEvent,
    fixture: { type: "agent_backends_changed", ts: 1781270000000 },
    doc: "A backend was added, removed or detected anew; clients re-read `agent.backends`.",
  }),
} as const;
