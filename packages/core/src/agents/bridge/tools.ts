// What the bridge offers an agent (spec §9.3 "How plugins reach an ACP agent"): `SendMessage`, `Glossary`, and the
// plugin tools in the agent's scope. Cursor and Antigravity keep MCP server instructions out of the model's prompt
// (S5 edit 3), so every description here stands on its own, and the bridge's essentials also go into the agent's
// system prompt or first prompt (`bridgeInstructions`).
//
// Plugin tools come from lane B's registry (B-M2: the plugins scoped to `agents` or `both`); until then the source
// is empty, and `BridgeToolSource` is the seam it plugs into.

export interface BridgeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The plugin tools one agent session may use, and how a call runs: wherever the tool really runs, under the same
 *  approval rules as a bot's call (§9.3). */
export interface BridgeToolSource {
  tools(sessionId: string): Promise<BridgeToolDef[]>;
  call(sessionId: string, call: { callId: string; tool: string; input: unknown }): Promise<{ content: unknown[]; isError: boolean }>;
  /** The plugins' own instructions, which the bridge sends as its server instructions and `Glossary` also serves. */
  instructions?(sessionId: string): Promise<string>;
}

export const NO_PLUGIN_TOOLS: BridgeToolSource = {
  tools: async () => [],
  call: async (_s, c) => ({ content: [{ type: "text", text: `No tool named ${c.tool} is available to this agent.` }], isError: true }),
};

export const SEND_MESSAGE: BridgeToolDef = {
  name: "SendMessage",
  description: [
    "Send a message to the bot that started you (or, with `to`, to another of its sessions) while you keep working.",
    "Use it for progress the bot should know now, or a question it must answer before you can go on; the message",
    "reaches the bot's conversation like any message. Your final reply is delivered to the bot automatically when you",
    "finish, so don't send it twice.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The message, in plain words." },
      to: { type: "string", description: "Another session's id; leave it out to message the bot that started you." },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

export const GLOSSARY: BridgeToolDef = {
  name: "Glossary",
  description: [
    "Look up the skills, tools and agents Clover's plugins offer you, and load one by name.",
    "`query` searches by words and returns names with one-line descriptions; `load` returns a skill's full",
    "instructions or a tool's input schema. Use it before a task a skill may cover.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      query: { description: "Words to search for, or a list of searches.", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      load: { description: "A name to load, or a list of names.", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    },
    additionalProperties: false,
  },
};

/** The bridge's own tools, always present. */
export const BRIDGE_OWN_TOOLS: readonly BridgeToolDef[] = [SEND_MESSAGE, GLOSSARY];

/** The essentials an agent must know (S5 edit 3): who sent the work, how to report, where skills are. */
export function bridgeInstructions(a: { bot?: string; serverName: string }): string {
  const who = a.bot ? `the bot "${a.bot}"` : "the user";
  return [
    `You are working on a task from ${who} in Clover, as a background agent.`,
    `Your final reply is delivered to ${who} when you finish, together with this session's transcript.`,
    `The MCP server "${a.serverName}" gives you SendMessage, to send ${who} progress or a question while you work, and`,
    "Glossary, to look up and load the skills and tools Clover's plugins offer you.",
  ].join(" ");
}
