// The quirks table (spike S5 §7, §8): one descriptor per backend, one field per way an agent bends ACP, so the
// client reads the descriptor instead of branching on a backend's name. This file is the source of truth for the two
// backends S5 measured (Cursor's CLI and Antigravity CLI, November 5, on macOS); lane B's contract fakes carry copies
// of the same values (`S5_CURSOR_QUIRKS`, `S5_ANTIGRAVITY_QUIRKS`), and a test pins that they agree.
//
// K-M2 adds Claude Code, Codex, Grok, Gemini CLI and DeepSeek, measured by the agent suite, and moves each backend's
// row into its own `plugins/clover/agent-<id>` plugin once its manifest entry can name a quirks file (a question for
// lane B: `agentBackends` entries are strict and have no field for it yet).
import type { AgentQuirks } from "../contracts/agent-backend";

/** Cursor's CLI (`cursor-agent acp`, hidden from its help), 2026.10.22. S5 §1, edits 6 and 11; owner's item 78. */
export const CURSOR_QUIRKS: AgentQuirks = {
  launch: {
    command: { macos: ["cursor-agent", "acp"], linux: ["cursor-agent", "acp"], windows: ["cursor-agent.exe", "acp"] },
    // A shell script running a bundled node: no code signature to check, so the version output is the identity.
    identity: { versionArgs: ["--version"], versionPattern: "^(\\d{4}\\.\\d{1,2}\\.\\d{1,2})-[0-9a-f]{6,}\\s*$" },
    envAllow: [],
    // Its sign-in would open a browser; nothing a delegation does may (S5 §6).
    envSet: { NO_OPEN_BROWSER: "1" },
    versions: ">=2026.10.22",
  },
  capabilities: { snakeCaseDuplicates: false, httpMcpUnadvertised: false },
  mcp: {
    transports: ["stdio", "http", "sse"], storesPlainText: false, passesEnvironment: false,
    // It files MCP instructions as INSTRUCTIONS.md for the model to open on demand.
    instructionsReachPrompt: false, systemPromptChannel: null, tellsConversationId: false,
  },
  sessions: { load: { supported: true, replays: true }, resume: { supported: false, replays: false }, replayKeepsToolCallIds: false, listFiltersHonestly: false, close: false },
  turns: { refusal: "reported-completed", cancelLeavesToolCallsOpen: true, reportsUsage: false, quotaErrorsAsText: true },
  permissions: {
    optionKinds: ["allow_once", "allow_always", "reject_once"],
    neverAsks: ["edit inside the root", "commands on the user's own allowlist", "delete inside the root (by its code, untested)"],
    mcpNames: { server: "rawInput.providerIdentifier", tool: "rawInput.toolName" },
  },
  config: { modelOption: "model", effortOption: null, effortInModel: true, choicePersists: true },
  auth: { methods: [{ id: "cursor_login", headless: false }], requiredError: { messagePattern: "(cursor-)?agent login|authentication required" } },
  progress: { countsChildProcesses: true },
  placement: "local",
  // Owner's item 78: accepted with its folder and deny rules as the boundary; Settings says "edits inside its folder
  // without asking".
  marks: ["unasked-actions", "persists-model-choice"],
};

/** Antigravity CLI (`agy acp`, missing from its top-level help), 1.4.12. S5 §2, edits 3, 4 and 8. */
export const ANTIGRAVITY_QUIRKS: AgentQuirks = {
  launch: {
    command: { macos: ["agy", "acp", "--disable-telemetry"], linux: ["agy", "acp", "--disable-telemetry"], windows: ["agy.exe", "acp", "--disable-telemetry"] },
    // Signed by Google's Developer ID on macOS (TeamIdentifier).
    identity: { versionArgs: ["--version"], versionPattern: "^(\\d+\\.\\d+\\.\\d+)\\s*$", signer: "EQHXZ8M8AV" },
    envAllow: [],
    envSet: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
    versions: ">=1.4.12 <1.5.0",
  },
  // It answers `server/discover` probes and HTTP MCP with no `mcpCapabilities` advertised.
  capabilities: { snakeCaseDuplicates: true, httpMcpUnadvertised: true },
  mcp: {
    transports: ["stdio", "http"], storesPlainText: true, passesEnvironment: true,
    instructionsReachPrompt: "unknown", systemPromptChannel: "_meta.antigravity.systemPrompt.append", tellsConversationId: true,
  },
  // Its `resume` replays history, so Clover reattaches with `load` and drops the replay (S5 edit 8).
  sessions: { load: { supported: true, replays: true }, resume: { supported: true, replays: true }, replayKeepsToolCallIds: true, listFiltersHonestly: false, close: true },
  turns: { refusal: "ends-turn", cancelLeavesToolCallsOpen: true, reportsUsage: true, quotaErrorsAsText: false },
  permissions: { optionKinds: ["allow_once", "reject_once"], neverAsks: ["read-only MCP calls"], mcpNames: null },
  config: { modelOption: "model", effortOption: "thought_level", effortInModel: false, choicePersists: false },
  auth: { methods: [{ id: "oauth-personal", headless: false }, { id: "oauth-business", headless: false }], requiredError: { code: -32000 } },
  progress: { countsChildProcesses: true },
  placement: "local",
  marks: ["stores-plain-text", "passes-environment"],
};

/** The table, by backend id (an `agentBackends` entry's id). */
export const QUIRKS: Readonly<Record<string, AgentQuirks>> = {
  cursor: CURSOR_QUIRKS,
  antigravity: ANTIGRAVITY_QUIRKS,
};

/** The read-only mode of each agent that acts without asking (`unasked-actions`), by backend id: the config option
 *  and its values in order of preference. Spec §9.3's [P] under item 78: at read-only, Cursor starts in its `ask`
 *  mode ("no edits or command execution"), else `plan` ("read-only mode for planning"), both from S5's
 *  `configOptions`. Kept beside the quirks, not in them, since lane B's fakes pin the quirks' shape. */
export const READ_ONLY_MODES: Readonly<Record<string, { option: string; values: readonly string[] }>> = {
  cursor: { option: "mode", values: ["ask", "plan"] },
};
