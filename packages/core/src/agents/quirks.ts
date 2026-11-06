// The quirks table (spike S5 §7, §8): one descriptor per backend, one field per way an agent bends ACP, so the
// client reads the descriptor instead of branching on a backend's name. This file is the source of truth for the two
// backends S5 measured (Cursor's CLI and Antigravity CLI, November 5, on macOS); lane B's contract fakes carry copies
// of the same values (`S5_CURSOR_QUIRKS`, `S5_ANTIGRAVITY_QUIRKS`), and a test pins that they agree.
//
// K-M2 adds Claude Code, Codex, Grok, Gemini CLI and DeepSeek from docs and code (below), to be measured by the
// agent suite, and moves each backend's row into its own `plugins/clover/agent-<id>` plugin once its manifest entry
// can name a quirks file (a question for lane B: `agentBackends` entries are strict and have no field for it yet).
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

// K-M2's backends, from docs, `--help` and the shipped code (S5 §3), not yet from runs: none of these agents has been
// started by Clover, since Claude Code may never be run by an agent here and the others only for `--help` and
// `--version`. Where a row isn't known it takes the cautious value: a reattach uses `load` (whose replay is dropped
// either way), MCP names are unread (so bridge calls go to the level instead of the exact-match rule), calls a cancel
// leaves open are closed by Clover, and none is admitted as sandboxed (sandbox/admission.ts), so each asks for the
// user's OK. The agent suite's live gates (plan §10) measure each row and admit each sandbox.

const UNMEASURED = {
  capabilities: { snakeCaseDuplicates: false, httpMcpUnadvertised: false },
  turns: { refusal: "unknown", cancelLeavesToolCallsOpen: true, reportsUsage: true, quotaErrorsAsText: false },
  progress: { countsChildProcesses: true },
  placement: "local",
  // They load the user's own settings (Claude Code's `permissions.allow` and `defaultMode`, Codex's `approval_policy`,
  // the others' approval modes), so they may act without asking: held as such until the live gates measure them (K-M2
  // review 2). At read-only each starts in its read-only mode (`READ_ONLY_MODES`), or not at all.
  marks: ["unasked-actions"],
} as const satisfies Partial<AgentQuirks>;

/** Claude Code, through `@agentclientprotocol/claude-agent-acp` 0.100.0 (the Claude Agent SDK underneath). Its fence
 *  goes in `_meta.claudeCode.options` (`settings`, `sandbox`, `disallowedTools`), written once its gates pass. */
export const CLAUDE_CODE_QUIRKS: AgentQuirks = {
  ...UNMEASURED,
  launch: {
    command: { macos: ["claude-agent-acp"], linux: ["claude-agent-acp"], windows: ["claude-agent-acp.cmd"] },
    identity: { versionArgs: ["--version"], versionPattern: "^(?:claude-agent-acp\\s+)?v?(\\d+\\.\\d+\\.\\d+)\\s*$" },
    envAllow: [], envSet: {}, versions: ">=0.100.0 <0.200.0",
  },
  mcp: { transports: ["stdio", "http", "sse"], storesPlainText: false, passesEnvironment: false, instructionsReachPrompt: "unknown", systemPromptChannel: "_meta.systemPrompt", tellsConversationId: false },
  sessions: { load: { supported: true, replays: true }, resume: { supported: true, replays: true }, replayKeepsToolCallIds: true, listFiltersHonestly: false, close: true },
  permissions: { optionKinds: ["allow_once", "allow_always", "reject_once"], neverAsks: [], mcpNames: null },
  config: { modelOption: "model", effortOption: null, effortInModel: false, choicePersists: false },
  auth: { methods: [], requiredError: { code: -32000 } },
};

/** Codex, through `@agentclientprotocol/codex-acp` 2.5.0, which drives the user's own `codex app-server`
 *  (`CODEX_PATH`); its fence is `CODEX_CONFIG`, and `NO_BROWSER` keeps its sign-in from opening a browser. */
export const CODEX_QUIRKS: AgentQuirks = {
  ...UNMEASURED,
  launch: {
    command: { macos: ["codex-acp"], linux: ["codex-acp"], windows: ["codex-acp.cmd"] },
    identity: { versionArgs: ["--version"], versionPattern: "^(?:codex-acp\\s+)?v?(\\d+\\.\\d+\\.\\d+)\\s*$" },
    envAllow: ["CODEX_PATH", "CODEX_HOME"], envSet: { NO_BROWSER: "1" }, versions: ">=2.5.0 <3.0.0",
  },
  mcp: { transports: ["stdio", "http"], storesPlainText: false, passesEnvironment: false, instructionsReachPrompt: "unknown", systemPromptChannel: null, tellsConversationId: false },
  sessions: { load: { supported: true, replays: true }, resume: { supported: false, replays: false }, replayKeepsToolCallIds: true, listFiltersHonestly: false, close: false },
  permissions: { optionKinds: ["allow_once", "allow_always", "reject_once"], neverAsks: [], mcpNames: null },
  config: { modelOption: "model", effortOption: "thought_level", effortInModel: false, choicePersists: false },
  auth: { methods: [], requiredError: { code: -32000 } },
};

/** Grok CLI 1.0.70, native (`grok agent stdio`). Its CLI also installs as `agent`, which is Cursor's name too, so
 *  Clover resolves `grok` and checks its version line. */
export const GROK_QUIRKS: AgentQuirks = {
  ...UNMEASURED,
  launch: {
    command: { macos: ["grok", "agent", "stdio"], linux: ["grok", "agent", "stdio"], windows: ["grok.exe", "agent", "stdio"] },
    identity: { versionArgs: ["--version"], versionPattern: "^grok (\\d+\\.\\d+\\.\\d+) \\([0-9a-f]+\\)" },
    envAllow: [], envSet: {}, versions: ">=1.0.70 <2.0.0",
  },
  mcp: { transports: ["stdio"], storesPlainText: false, passesEnvironment: false, instructionsReachPrompt: "unknown", systemPromptChannel: null, tellsConversationId: false },
  sessions: { load: { supported: false, replays: false }, resume: { supported: false, replays: false }, replayKeepsToolCallIds: true, listFiltersHonestly: false, close: false },
  permissions: { optionKinds: ["allow_once", "reject_once"], neverAsks: [], mcpNames: null },
  config: { modelOption: "model", effortOption: "thought_level", effortInModel: false, choicePersists: false },
  auth: { methods: [], requiredError: { code: -32000 } },
};

/** Gemini CLI 0.46.0, native (`gemini --acp`). Since June 18, 2026 it needs a Gemini API key or Vertex AI. It is the
 *  one agent that uses the client's `fs` when offered; Clover offers none yet, so it uses its own tools. */
export const GEMINI_QUIRKS: AgentQuirks = {
  ...UNMEASURED,
  launch: {
    command: { macos: ["gemini", "--acp"], linux: ["gemini", "--acp"], windows: ["gemini.cmd", "--acp"] },
    identity: { versionArgs: ["--version"], versionPattern: "^(\\d+\\.\\d+\\.\\d+)\\s*$" },
    envAllow: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_GENAI_USE_VERTEXAI"], envSet: {}, versions: ">=0.46.0 <1.0.0",
  },
  mcp: { transports: ["stdio", "http", "sse"], storesPlainText: false, passesEnvironment: false, instructionsReachPrompt: "unknown", systemPromptChannel: null, tellsConversationId: false },
  sessions: { load: { supported: true, replays: true }, resume: { supported: false, replays: false }, replayKeepsToolCallIds: true, listFiltersHonestly: false, close: false },
  permissions: { optionKinds: ["allow_once", "allow_always", "reject_once"], neverAsks: [], mcpNames: null },
  config: { modelOption: "model", effortOption: null, effortInModel: false, choicePersists: false },
  auth: { methods: [], requiredError: { code: -32000 } },
};

/** DeepSeek Harness (`dsh --profile acp`), with `@deepseek-ai/dsh-acp` 0.1.2 or later: earlier builds, npm's `latest`
 *  among them, refuse every MCP server, so the bridge can't reach them. One workspace; an honest `resume`, no `load`. */
export const DEEPSEEK_QUIRKS: AgentQuirks = {
  ...UNMEASURED,
  launch: {
    command: { macos: ["dsh", "--profile", "acp"], linux: ["dsh", "--profile", "acp"], windows: ["dsh.cmd", "--profile", "acp"] },
    identity: { versionArgs: ["--version"], versionPattern: "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)" },
    envAllow: ["DEEPSEEK_API_KEY"], envSet: {}, versions: ">=0.1.2 <1.0.0",
  },
  mcp: { transports: ["stdio", "http"], storesPlainText: false, passesEnvironment: false, instructionsReachPrompt: "unknown", systemPromptChannel: null, tellsConversationId: false },
  sessions: { load: { supported: false, replays: false }, resume: { supported: true, replays: false }, replayKeepsToolCallIds: true, listFiltersHonestly: false, close: true },
  permissions: { optionKinds: ["allow_once", "reject_once"], neverAsks: [], mcpNames: null },
  config: { modelOption: "model", effortOption: null, effortInModel: false, choicePersists: false },
  auth: { methods: [], requiredError: { code: -32000 } },
};

/** The table, by backend id (an `agentBackends` entry's id). */
export const QUIRKS: Readonly<Record<string, AgentQuirks>> = {
  cursor: CURSOR_QUIRKS,
  antigravity: ANTIGRAVITY_QUIRKS,
  "claude-code": CLAUDE_CODE_QUIRKS,
  codex: CODEX_QUIRKS,
  grok: GROK_QUIRKS,
  gemini: GEMINI_QUIRKS,
  deepseek: DEEPSEEK_QUIRKS,
};

/** Where each row comes from: measured by spike S5, or read from docs, `--help` and code (S5 §3) and still to be
 *  measured by the agent suite's live gates. */
export const QUIRK_SOURCES: Readonly<Record<string, "measured (S5)" | "docs and code (S5 §3)">> = {
  cursor: "measured (S5)",
  antigravity: "measured (S5)",
  "claude-code": "docs and code (S5 §3)",
  codex: "docs and code (S5 §3)",
  grok: "docs and code (S5 §3)",
  gemini: "docs and code (S5 §3)",
  deepseek: "docs and code (S5 §3)",
};

/** The read-only mode of each agent that acts without asking (`unasked-actions`), by backend id: the config option
 *  and its values in order of preference. Spec §9.3's [P] under item 78: at read-only, Cursor starts in its `ask`
 *  mode ("no edits or command execution"), else `plan` ("read-only mode for planning"), both from S5's
 *  `configOptions`. Kept beside the quirks, not in them, since lane B's fakes pin the quirks' shape. */
export const READ_ONLY_MODES: Readonly<Record<string, { option: string; values: readonly string[] }>> = {
  cursor: { option: "mode", values: ["ask", "plan"] },
  // From their docs, unmeasured: a `mode` option or ACP session mode with one of these values, confirmed by the
  // agent's answer, or the agent doesn't start at read-only. Grok and DeepSeek have none known: refused there.
  "claude-code": { option: "mode", values: ["plan"] },
  codex: { option: "mode", values: ["read-only"] },
  gemini: { option: "mode", values: ["plan", "default"] },
};
