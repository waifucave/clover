// Contract: AgentBackend (spec §5.3 `agentBackends`, §9.3 "The Agent tool and its placement"; spike S5 §7 and §8).
// Owner: lane K.
//
// One AgentBackend per `agentBackends` entry: an ACP agent started on the computer the agent is placed on, or a vendor
// cloud agent. Agents bend the protocol in different ways, so each backend carries a quirks descriptor with one field
// per row of S5 §8, and the client reads the descriptor instead of branching on the backend's name. Lane K's real
// client lives in clover-sdk's ACP package and `packages/core/src/agents/`; this contract is what the rest of the core
// (the SessionHost, the ApprovalBroker, the bridge, Settings) relies on.
//
// What the contract promises:
// * `detect` resolves the binary to its real path and checks it is that vendor's before anything starts it: Clover
//   never trusts a command name on PATH (`agent` is both Cursor's and Grok's; S5 edit 1).
// * `start` launches one agent process for one delegation, contained as a group, in the translated root, with the
//   environment from an allow-list, the bridge MCP server, and the fence as the backend's own deny rules (§9.3).
//   A signed-out agent fails `sign_in`: the user signs in to that agent themselves; Clover never runs a browser login.
// * Permission requests go to the handler the host sets (the ApprovalBroker); the session answers the agent with
//   `allow_once` or `reject_once`, never an "always" (S5 edit 5), and answers pending requests `cancelled` on cancel.
// * Replays (updates between a `load` or `resume` request and its response) are dropped, never shown again (S5 edit 8).
// * When a cancel leaves tool calls open, the session closes them itself; refused calls are recorded as refused
//   whatever the agent reports (S5 edit 5).
import type { BackendMark, Os } from "@waifucave/clover-protocol";
import type { AgentPermissionOption } from "./approval-broker";
import type { Unsubscribe } from "./common";
import type { SandboxPolicy } from "./fence";

/** What a backend does, per S5 §8. Each fake can play every row. */
export interface AgentQuirks {
  launch: {
    /** Command and args per OS (`gemini --acp`, `grok agent stdio`, `cursor-agent acp`, `agy acp`). */
    command: Partial<Record<Os, readonly string[]>>;
    /** How to check the binary is the vendor's: its version output, and the signer where the OS has one. */
    identity: { versionArgs: readonly string[]; versionPattern: string; signer?: string };
    /** Environment variables passed through, and ones the backend needs (`AGY_CLI_DISABLE_AUTO_UPDATE`, `CODEX_PATH`,
     *  `NO_BROWSER`). */
    envAllow: readonly string[];
    envSet: Readonly<Record<string, string>>;
    /** The tested version range. */
    versions: string;
  };
  capabilities: {
    /** snake_case duplicates (`load_session`) read as their camelCase twins. */
    snakeCaseDuplicates: boolean;
    /** HTTP MCP works though `mcpCapabilities` doesn't say so. */
    httpMcpUnadvertised: boolean;
  };
  mcp: {
    transports: readonly ("stdio" | "http" | "sse")[];
    /** It writes what it is given (env, headers, prompts) to disk in plain text (Antigravity). */
    storesPlainText: boolean;
    /** It hands its whole environment to the servers it starts. */
    passesEnvironment: boolean;
    /** Whether MCP server instructions reach the model's prompt (Cursor and Antigravity file them as documents). */
    instructionsReachPrompt: boolean | "unknown";
    /** Where a client adds to the system prompt (S5 edit 3), or null: the essentials go in the first prompt. */
    systemPromptChannel: "_meta.antigravity.systemPrompt.append" | "acp.systemPrompt" | "_meta.systemPrompt" | null;
    /** It tells MCP servers its conversation id (Antigravity's `_meta`). */
    tellsConversationId: boolean;
  };
  sessions: {
    load: { supported: boolean; replays: boolean };
    /** Antigravity's `resume` replays, so it counts as a `load`. */
    resume: { supported: boolean; replays: boolean };
    /** Cursor renames replayed tool calls `replay-0-N`; Antigravity keeps the live ids. */
    replayKeepsToolCallIds: boolean;
    /** Cursor lists only the caller's session; Antigravity ignores the folder filter. Clover keeps its own record. */
    listFiltersHonestly: boolean;
    close: boolean;
  };
  turns: {
    /** How a refused card ends: the turn ends with no reply (Antigravity), or the call is reported completed (Cursor). */
    refusal: "ends-turn" | "reported-completed" | "reported-failed" | "unknown";
    cancelLeavesToolCallsOpen: boolean;
    reportsUsage: boolean;
    /** Plan and quota refusals arrive as ordinary text with `end_turn` (Cursor). */
    quotaErrorsAsText: boolean;
  };
  permissions: {
    optionKinds: readonly AgentPermissionOption["kind"][];
    /** What it never asks about (Cursor: edits inside the root and commands on the user's own allowlist). */
    neverAsks: readonly string[];
    /** Where an MCP request names its server and tool, in the tool call's structured input. */
    mcpNames: { server: string; tool: string } | null;
  };
  config: {
    /** `session/set_config_option` ids for model and effort (categories `model` and `thought_level`). */
    modelOption: string | null;
    effortOption: string | null;
    /** Cursor folds effort into its model values. */
    effortInModel: boolean;
    /** A delegation's choice becomes the user's own selection (Cursor), so Clover restores it after. */
    choicePersists: boolean;
  };
  auth: {
    methods: readonly { id: string; headless: boolean }[];
    /** How a signed-out agent answers `session/new`: `-32000` (Antigravity's docs), or an error naming its login. */
    requiredError: { code?: number; messagePattern?: string };
  };
  progress: {
    /** The stall watchdog may count new processes in the agent's group while an `execute` call runs (S5 §7). */
    countsChildProcesses: boolean;
  };
  placement: "local" | "cloud";
  /** What Settings marks for this backend (§9.3). */
  marks: readonly BackendMark[];
}

export interface AgentDetection {
  installed: boolean;
  /** The resolved real path. */
  path?: string;
  version?: string;
  /** The binary is the vendor's (version output, signer). */
  identityOk: boolean;
  /** The version is in the tested range. */
  versionOk: boolean;
  /** Its own sandbox works on this computer; without it, it starts only after the user's OK (§9.3). */
  sandboxed: boolean;
  reason?: string;
}

/** The bridge MCP server handed to the agent at `session/new` (§9.3, S5 edit 4): its token is the only secret
 *  handed over, only in this entry's `env`. */
export interface BridgeServer {
  name: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** The bridge's own tools, for the ApprovalBroker's exact-match rule (S5 edit 7). */
  tools: readonly string[];
}

export interface AgentStartSpec {
  /** Clover's session id for this delegation. */
  sessionId: string;
  /** The root folder's real path on this computer; `Agent` already refused one holding the Clover home. */
  root: string;
  model?: string;
  effort?: string;
  /** The bridge's essentials, for `systemPromptChannel` or the first prompt (S5 edit 3). */
  instructions?: string;
  bridge: BridgeServer;
  /** The fence, which lane K writes in the backend's own format. */
  fence: SandboxPolicy;
  /** Reattach after a daemon restart: an honest `resume`, otherwise `load` with the replay dropped. */
  reattach?: { agentSessionId: string };
}

export type AgentSessionState = "starting" | "ready" | "prompting" | "cancelling" | "idle" | "stopped" | "failed";

/** A permission request, as the session hands it to the host (which asks the ApprovalBroker). */
export interface AgentPermissionAsk {
  toolCallId: string;
  toolKind: string;
  title: string;
  rawInput?: unknown;
  mcp?: { server: string; tool: string };
  options: readonly AgentPermissionOption[];
  paths: readonly string[];
}

export type AgentPermissionAnswer = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; id: string; kind: string; title: string; status: "pending" | "in_progress" | "completed" | "failed"; rawInput?: unknown }
  | { type: "tool_call_update"; id: string; status: "pending" | "in_progress" | "completed" | "failed"; refused?: boolean; closedByClover?: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "progress" };

export interface AgentTurnEnd {
  stopReason: "end_turn" | "refusal" | "cancelled" | "max_tokens" | "error";
  /** The turn's final text, unchanged. */
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AgentSession {
  readonly agentSessionId: string;
  state(): AgentSessionState;
  prompt(input: { text: string; images?: { mimeType: string; data: string }[] }): Promise<AgentTurnEnd>;
  /** ACP's `session/cancel`: waits up to 5 seconds for the turn to end `cancelled`. */
  cancel(): Promise<void>;
  setConfig(option: "model" | "effort", value: string): Promise<void>;
  /** Cancel, then end the process group (§9.3 "Stopping"). */
  stop(): Promise<void>;
  /** The host's permission handler; until one is set, requests are answered `cancelled`. */
  onPermission(fn: (ask: AgentPermissionAsk) => Promise<AgentPermissionAnswer>): void;
  onEvent(fn: (event: AgentEvent) => void): Unsubscribe;
  /** When the agent last made progress, for the 10-minute stall watchdog (S5 §7). */
  lastProgressAt(): number;
}

export interface AgentBackend {
  /** Its `agentBackends` entry's id. */
  readonly id: string;
  readonly pluginId: string;
  readonly quirks: AgentQuirks;
  detect(): Promise<AgentDetection>;
  start(spec: AgentStartSpec): Promise<AgentSession>;
}

/** The stall watchdog's limit (§9.3 "Stalled agents"). */
export const AGENT_STALL_MS = 10 * 60_000;
/** How long a cancel waits for the agent's `cancelled` before ending its group (S5 §7). */
export const AGENT_CANCEL_WAIT_MS = 5_000;
