// The Agent tool (spec §9.3; plan §4 lane K, M1): bots delegate to ACP agents running as local processes, through
// one bridge MCP server per agent session. Owner: lane K.
//
// | Module              | What                                                                                   |
// | :------------------ | :------------------------------------------------------------------------------------- |
// | `acp/`              | the ACP client: a tolerant JSON-RPC peer, the wire shapes, one agent session            |
// | `process/`          | launching an agent contained as a group, its environment allow-list, the process table |
// | `quirks.ts`         | the quirks table: how each measured backend bends ACP (spike S5)                        |
// | `backend.ts`        | `AcpAgentBackend`, the spine's `AgentBackend` for a local ACP agent                     |
// | `bridge/`           | the bridge MCP server (its own process), its token, and the daemon's end of it          |
// | `driver.ts`         | the session driver: the host runs an agent's turns through it                           |
// | `manager.ts`        | `Agent`, `TaskStop`, `ListAgents`, the bridge's methods, reattaching after a restart   |
// | `transcript.ts`     | `bots/<bot>/agents/<session>/`: the wire minus replays, Clover's own record, stderr    |
// | `watchdog.ts`       | the 10-minute stall watchdog                                                            |
// | `sandbox/`          | which agents' own sandboxes hold the fence (S8), their writers, the OK for the rest     |
// | `tools.ts`, `rpc.ts`| the bot's tools and the `agent.*` methods, for lane A's runtime and lane C's server     |
// | `testing/`          | the scripted ACP agent and the conformance harness                                       |
//
// The protocol layer (`acp/`) imports nothing from the daemon but the spine's contract types, so it can move into
// clover-sdk's ACP package (plan §4 K) once that package exists; K-M3 adds the agent side there for the inherited
// coding agent.
import { join } from "node:path";
import type { AgentBackend } from "../contracts/agent-backend";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import type { Fence } from "../contracts/fence";
import type { SessionHost } from "../contracts/session-host";
import type { Tree } from "../contracts/tree";
import { AcpAgentBackend } from "./backend";
import { BridgeEndpoint } from "./bridge/endpoint";
import { bridgeCommand } from "./bridge/main";
import { BridgeTokens } from "./bridge/tokens";
import type { BridgeToolSource } from "./bridge/tools";
import { AgentManager } from "./manager";
import { FileAgentOks } from "./sandbox/oks";
import { QUIRKS } from "./quirks";
import { StallWatchdog } from "./watchdog";

export { AcpAgentSession, onceOnly, type WireTap } from "./acp/session";
export { RpcPeer, RpcError } from "./acp/jsonrpc";
export { AcpAgentBackend, versionSatisfies, type AgentWire, type BackendCommand } from "./backend";
export { BridgeEndpoint, type BridgeHandlers } from "./bridge/endpoint";
export { bridgeCommand, BRIDGE_MAIN_PATH } from "./bridge/main";
export { peerPidOf } from "./bridge/peer";
export { BRIDGE_ENV, runBridge } from "./bridge/server";
export { BridgeTokens } from "./bridge/tokens";
export { BRIDGE_OWN_TOOLS, GLOSSARY, SEND_MESSAGE, bridgeInstructions, type BridgeToolDef, type BridgeToolSource } from "./bridge/tools";
export { AgentDriver, type AgentLogEvent } from "./driver";
export { AgentManager, effectOf, promptOf, ruleKeyOf, type AgentCaller, type AgentRequest } from "./manager";
export { buildAgentEnv, launchContained } from "./process/launch";
export { ANTIGRAVITY_QUIRKS, CURSOR_QUIRKS, QUIRKS } from "./quirks";
export { agentMethods, BACKEND_NAMES } from "./rpc";
export { agentToolDefs, describeSession, type CoreToolDef } from "./tools";
export { AgentTranscript, botSegment, transcriptPaths } from "./transcript";
export { AGENT_COMMAND_MAX_MS, StallWatchdog } from "./watchdog";
export { ADMISSIONS, admissionFor, type SandboxAdmission, type SandboxSetup, type SandboxWriter } from "./sandbox/admission";
export { FileAgentOks, MemoryAgentOks, agentOksPath, type AgentOks, type AgentOkKey } from "./sandbox/oks";

export interface AgentsOptions {
  home: string;
  computer: string;
  device: string;
  serverVersion: string;
  host: SessionHost;
  approvals: ApprovalBroker;
  tree: Pick<Tree, "resolve">;
  fence: Pick<Fence, "checkAgentRoot" | "policy">;
  clock: Clock;
  /** The backends to offer; the quirks table's by default. B-M2's registry feeds `agentBackends` here. */
  backends?: (wire: AgentManager["wire"]) => AgentBackend[];
  pluginTools?: BridgeToolSource;
  log?: (line: string) => void;
}

/** Wires the Agent tool for one daemon: the tokens, the bridge's endpoint at `<home>/run/bridge.sock`, the watchdog,
 *  the backends and the manager. `close` revokes every token and closes the endpoint. */
export function createAgents(o: AgentsOptions): { manager: AgentManager; endpoint: BridgeEndpoint; tokens: BridgeTokens; backends: () => AgentBackend[]; close(): void } {
  const tokens = new BridgeTokens();
  const socketPath = join(o.home, "run", "bridge.sock");
  let backends: AgentBackend[] = [];
  const manager: AgentManager = new AgentManager({
    home: o.home, computer: o.computer, host: o.host, approvals: o.approvals, tree: o.tree, fence: o.fence, clock: o.clock, tokens,
    backends: () => backends,
    bridge: { ...bridgeCommand(), socketPath },
    watchdog: new StallWatchdog({ clock: o.clock }),
    oks: new FileAgentOks(o.home),
    ...(o.pluginTools ? { pluginTools: o.pluginTools } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  const wire = (id: string) => manager.wire(id);
  backends = o.backends?.(wire) ?? Object.entries(QUIRKS).map(([id, quirks]) => new AcpAgentBackend({ id, pluginId: `clover/agent-${id}`, quirks, clock: o.clock, wire }));
  const endpoint = new BridgeEndpoint({ socketPath, tokens, handlers: manager.bridgeHandlers(), device: o.device, serverVersion: o.serverVersion, ...(o.log ? { log: o.log } : {}) });
  endpoint.listen();
  return {
    manager, endpoint, tokens, backends: () => backends,
    close: () => {
      tokens.revokeAll();
      endpoint.close();
    },
  };
}
