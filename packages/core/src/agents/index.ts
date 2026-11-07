// The Agent tool (spec §9.3; plan §4 lane K, M1): bots delegate to ACP agents running as local processes, through
// one bridge MCP server per agent session. Owner: lane K.
//
// | Module              | What                                                                                   |
// | :------------------ | :------------------------------------------------------------------------------------- |
// | `acp/`              | the ACP client: a tolerant JSON-RPC peer, the wire shapes, one agent session, and the  |
// |                     | record of the user's own selections an agent saves (`selections.ts`)                  |
// | `process/`          | launching an agent contained as a group, its environment allow-list, the process table |
// | `quirks.ts`         | the quirks table: how each measured backend bends ACP (spike S5)                        |
// | `backend.ts`        | `AcpAgentBackend`, the spine's `AgentBackend` for a local ACP agent                     |
// | `bridge/`           | the bridge MCP server (its own process), its token, and its parts for C's Clover server |
// | `driver.ts`         | the session driver: the host runs an agent's turns through it                           |
// | `manager.ts`        | `Agent`, `TaskStop`, lane D's hooks, the bridge's methods, reattaching after a restart |
// | `transcript.ts`     | `bots/<bot>/agents/<session>/`: the wire minus replays, Clover's own record, stderr    |
// | `records.ts`        | the daemon's own record of each session, in the fenced run folder, for a reattach      |
// | `paths.ts`          | a permission request's paths, resolved and real, for the fence                         |
// | `watchdog.ts`       | the 10-minute stall watchdog                                                            |
// | `sandbox/`          | which agents' own sandboxes hold the fence (S8), their writers, the OK for the rest     |
// | `claude-code/`      | skills, agent definitions and shimmed hooks placed in Claude Code; the hook shim         |
// | `tools.ts`, `rpc.ts`| the bot's tools and the `agent.*` methods, for lane A's runtime and lane C's server     |
// | `testing/`          | the scripted ACP agent and the conformance harness                                       |
//
// The protocol layer (`acp/`) imports nothing from the daemon but the spine's contract types, so it can move into
// clover-sdk's ACP package (plan §4 K) once that package exists; K-M3 adds the agent side there for the inherited
// coding agent.
import { join } from "node:path";
import type { Level } from "@waifucave/clover-protocol";
import type { AgentBackend } from "../contracts/agent-backend";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import type { Fence } from "../contracts/fence";
import type { SessionHost } from "../contracts/session-host";
import type { Tree } from "../contracts/tree";
import { UserSelections } from "./acp/selections";
import { AcpAgentBackend } from "./backend";
import { bridgeCloverParts, type BridgeCloverParts } from "./bridge/handlers";
import { bridgeCommand } from "./bridge/main";
import { BridgeTokens } from "./bridge/tokens";
import type { BridgeToolSource } from "./bridge/tools";
import { AgentManager, type AgentPauseGate } from "./manager";
import { FileAgentOks } from "./sandbox/oks";
import { hookShimCommand } from "./claude-code/hook-shim";
import { placeInClaudeCode } from "./claude-code/placement";
import type { PluginPartsSource } from "./placement";
import { QUIRKS, READ_ONLY_MODES } from "./quirks";
import { CloverCodeBackend, type CloverCodeDeps } from "./clover-code/backend";
import { StallWatchdog } from "./watchdog";

export { AcpAgentSession, onceOnly, type WireTap } from "./acp/session";
export { RpcPeer, RpcError } from "@waifucave/clover-agent-sdk/acp";
export { AcpAgentBackend, versionSatisfies, type AcpStartSpec, type AgentWire, type BackendCommand } from "./backend";
export { bridgeCloverParts, type BridgeCloverParts, type BridgeHandlers } from "./bridge/handlers";
export { bridgeCommand, BRIDGE_MAIN_PATH } from "./bridge/main";
export { peerPidOf } from "./bridge/peer";
export { BRIDGE_ENV, runBridge } from "./bridge/server";
export { BridgeTokens } from "./bridge/tokens";
export { BRIDGE_OWN_TOOLS, GLOSSARY, SEND_MESSAGE, bridgeInstructions, type BridgeCallContext, type BridgeToolDef, type BridgeToolSource } from "./bridge/tools";
export { AgentDriver, type AgentLogEvent } from "./driver";
export { AgentManager, BRIDGE_SERVER_PREFIX, effectOf, promptOf, ruleKeyOf, type AgentCaller, type AgentPauseGate, type AgentRequest, type AgentSessionHooks } from "./manager";
export { agentPaths } from "./paths";
export { agentRecordPath, readAgentRecord, type DaemonAgentRecord } from "./records";
export { buildAgentEnv, launchContained } from "./process/launch";
export { ANTIGRAVITY_QUIRKS, CURSOR_QUIRKS, QUIRKS, READ_ONLY_MODES } from "./quirks";
export { CLOVER_CODE_ID, CLOVER_CODE_QUIRKS, CLOVER_CODE_TOOLS, CloverCodeBackend, type CloverCodeDeps } from "./clover-code/backend";
export { inProcessBridgeServer } from "./bridge/in-process";
export { UserSelections } from "./acp/selections";
export { agentMethods, BACKEND_NAMES } from "./rpc";
export { agentToolDefs, type CoreToolDef } from "./tools";
export { AgentTranscript, botSegment, redactDeep, TRANSCRIPT_CAPS, transcriptPaths } from "./transcript";
export { NO_PARTS, type HookEvent, type PluginParts, type PluginPartsSource } from "./placement";
export { placeInClaudeCode, matcherOf, shellQuote } from "./claude-code/placement";
export { dropAllow, hookShimCommand, hookShimMain, runHook } from "./claude-code/hook-shim";
export { AGENT_COMMAND_MAX_MS, StallWatchdog } from "./watchdog";
export { ADMISSIONS, admissionFor, type SandboxAdmission, type SandboxSetup, type SandboxWriter } from "./sandbox/admission";
export { FileAgentOks, MemoryAgentOks, agentOksPath, type AgentOks, type AgentOkKey } from "./sandbox/oks";

export interface AgentsOptions {
  home: string;
  computer: string;
  /** The daemon's own endpoint (`<home>/run/core.sock`, or the Windows pipe), where the bridge says hello. */
  socketPath: string;
  host: SessionHost;
  approvals: ApprovalBroker;
  tree: Pick<Tree, "resolve">;
  fence: Pick<Fence, "checkAgentRoot" | "policy" | "touches">;
  clock: Clock;
  /** The backends to offer; the quirks table's by default. B-M2's registry feeds `agentBackends` here. */
  backends?: (wire: AgentManager["wire"]) => AgentBackend[];
  pluginTools?: BridgeToolSource;
  pluginParts?: PluginPartsSource;
  /** A computer's level, for the read-only mode of an agent that acts without asking; read-only when unknown. */
  levelOf?: (computer: string) => Level | undefined;
  /** The pause switch (lane D's gate): paused, delegated agents are held. */
  pause?: AgentPauseGate;
  /** Clover's own coding agent (`clover-code`) on the embedded runtime: lane A's embedded-session seam
   *  (`embeddedSessionOptions`, `fillProvider`) and the user's default model. Without it the backend isn't offered. */
  cloverCode?: Pick<CloverCodeDeps, "baseOptions" | "fillProvider" | "defaultModel" | "query">;
  log?: (line: string) => void;
}

/** Wires the Agent tool for one daemon: the tokens, the bridge's parts for lane C's Clover server (`clover`: pass
 *  them to `createCloverServer` as its `bridge`, and its `handlers` among the server's), the watchdog,
 *  the backends and the manager. `close` ends every agent's process (the sessions stay to be reattached), revokes
 *  every token. */
export function createAgents(o: AgentsOptions): { manager: AgentManager; clover: BridgeCloverParts; tokens: BridgeTokens; backends: () => AgentBackend[]; close(): Promise<void> } {
  const tokens = new BridgeTokens();
  // The bridge connects to the daemon's own endpoint, where lane C serves the `bridge` role.
  const socketPath = o.socketPath;
  let backends: AgentBackend[] = [];
  const manager: AgentManager = new AgentManager({
    home: o.home, computer: o.computer, host: o.host, approvals: o.approvals, tree: o.tree, fence: o.fence, clock: o.clock, tokens,
    backends: () => backends,
    bridge: { ...bridgeCommand(), socketPath },
    watchdog: new StallWatchdog({ clock: o.clock }),
    oks: new FileAgentOks(o.home),
    ...(o.pluginTools ? { pluginTools: o.pluginTools } : {}),
    ...(o.pluginParts ? { pluginParts: o.pluginParts } : {}),
    ...(o.levelOf ? { levelOf: o.levelOf } : {}),
    ...(o.pause ? { pause: o.pause } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  const wire = (id: string) => manager.wire(id);
  // Claude Code reads its own skills, agents and hooks folders: the plugins' parts are placed there (§9.3).
  const place = { "claude-code": (parts: Parameters<typeof placeInClaudeCode>[0], ctx: { dir: string }) => placeInClaudeCode(parts, { dir: ctx.dir, shim: hookShimCommand() }) } as const;
  // One record of the user's own selections for every backend, in the daemon's fenced run folder.
  const selections = new UserSelections(join(o.home, "run", "agents", "selections"));
  backends = o.backends?.(wire) ?? [
    ...Object.entries(QUIRKS).map(([id, quirks]) => new AcpAgentBackend({
      id, pluginId: `clover/agent-${id}`, quirks, clock: o.clock, wire, selections, ...(id in place ? { place: place[id as keyof typeof place] } : {}),
      ...(READ_ONLY_MODES[id] ? { readOnlyMode: READ_ONLY_MODES[id] } : {}),
    })),
    ...(o.cloverCode ? [new CloverCodeBackend({ ...o.cloverCode, clock: o.clock, wire, selections, ...(o.pause ? { pause: o.pause } : {}), ...(o.log ? { log: o.log } : {}) })] : []),
  ];
  const clover = bridgeCloverParts(tokens, manager.bridgeHandlers());
  return {
    manager, clover, tokens, backends: () => backends,
    close: async () => {
      await manager.close();
      tokens.revokeAll();
    },
  };
}
