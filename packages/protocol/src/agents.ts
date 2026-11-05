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
import { AnyPluginId, ComputerName, Empty, SessionId, Text, TreePath } from "./common";
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
  id: z.string().min(1).max(128),
  name: Text,
  pluginId: AnyPluginId,
  protocol: z.enum(["acp", "cloud"]),
  placement: z.enum(["local", "cloud"]),
  /** Per computer: installed, its version, sandboxed there, and the marks that apply there. */
  computers: z.array(z.object({
    computer: ComputerName,
    installed: z.boolean(),
    version: z.string().max(64).optional(),
    sandboxed: z.boolean().optional(),
    marks: z.array(BackendMark).max(16),
  })).max(256),
});
export type AgentBackendView = z.infer<typeof AgentBackendView>;

/** An agent definition from a plugin's `agents` (§5.3): a preset for `Agent`. */
export const AgentDefView = z.object({
  id: z.string().min(1).max(128),
  name: Text,
  pluginId: AnyPluginId,
  backend: z.string().max(128),
  model: z.string().max(200).optional(),
  effort: z.string().max(32).optional(),
  computer: ComputerName.optional(),
  root: TreePath.optional(),
});
export type AgentDefView = z.infer<typeof AgentDefView>;

/** A bridge tool as the agent sees it: one of the plugin tools in its scope, with a description that stands on its
 *  own, since Cursor and Antigravity keep server instructions out of the prompt (S5 edit 3). */
export const BridgeTool = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(10_000),
  inputSchema: z.record(z.string(), z.unknown()),
});

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
      backend: z.string().min(1).max(128),
      computer: ComputerName,
      /** A folder in the tree; refused if it contains the Clover home (§9.3). */
      root: TreePath,
      model: z.string().max(200).optional(),
      effort: z.string().max(32).optional(),
      definition: z.string().max(128).optional(),
      prompt: z.string().max(1_000_000).optional(),
    }),
    result: z.object({ session: SessionId }),
    doc: "Starts a coding session the user drives directly, with no bot (`clover code`, §9.3).",
  }),

  // The bridge (role `bridge`): bound to one agent session by its token.
  bridgeTools: defineMethod({
    name: "bridge.tools", owner: "K", roles: ["bridge"],
    params: Empty, result: z.object({ tools: z.array(BridgeTool), instructions: z.string().max(64_000) }),
    doc: "The plugin tools in this agent's scope, plus `SendMessage` and `Glossary`, and the instructions the bridge sends as its own.",
  }),
  bridgeCall: defineMethod({
    name: "bridge.call", owner: "K", roles: ["bridge"],
    params: z.object({ callId: z.string().min(1).max(128), tool: z.string().min(1).max(64), input: z.unknown() }),
    result: z.object({ content: z.array(z.unknown()), isError: z.boolean() }),
    doc: "Runs a bridged tool wherever it actually runs, under the same approval rules (§9.3).",
  }),
  bridgeSendMessage: defineMethod({
    name: "bridge.sendMessage", owner: "K", roles: ["bridge"],
    params: z.object({ text: z.string().min(1).max(1_000_000), to: SessionId.optional() }),
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
