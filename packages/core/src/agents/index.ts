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
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Level } from "@waifucave/clover-protocol";
import type { AgentBackend } from "../contracts/agent-backend";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import type { Fence } from "../contracts/fence";
import type { SessionHost } from "../contracts/session-host";
import type { Tree } from "../contracts/tree";
import { UserSelections } from "./acp/selections";
import { AcpAgentBackend, type AcpStartSpec } from "./backend";
import { bridgeCloverParts, type BridgeCloverParts } from "./bridge/handlers";
import { bridgeCommand } from "./bridge/main";
import { BridgeTokens } from "./bridge/tokens";
import type { BridgeToolSource } from "./bridge/tools";
import { AgentManager, type AgentPauseGate } from "./manager";
import { FileAgentOks } from "./sandbox/oks";
import { hookShimCommand } from "./claude-code/hook-shim";
import { placeInClaudeCode } from "./claude-code/placement";
import type { PluginPartsSource } from "./placement";
import { ContributedBackendCache, type ContributedBackend } from "./plugin-backends";
import { ADMISSIONS } from "./sandbox/admission";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { CloverCodeBackend, type CloverCodeDeps } from "./clover-code/backend";
import { StallWatchdog } from "./watchdog";
import { AgentPeers, type AgentPeersOptions } from "./remote";
import { inProcessAgentBackend, type InProcessBackendDeps } from "../runtime-sdk/turn-loop/subagent-backend";

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
export { AgentQuirksSchema, QuirksFileSchema, bundledAgentPluginId, contributedBackends, quirksWithCommand, readQuirksFile, type ContributedBackend, type FileQuirks, type QuirksFile } from "./plugin-backends";
export { CLOVER_CODE_ID, CLOVER_CODE_QUIRKS, CLOVER_CODE_TOOLS, CloverCodeBackend, type CloverCodeDeps } from "./clover-code/backend";
export { inProcessBridgeServer } from "./bridge/in-process";
export { AgentPeers, MAX_STREAM_LINE, MAX_STREAM_TURN, RemoteAgentDriver, peerLevel, type AgentPeersOptions } from "./remote";
export { UserSelections } from "./acp/selections";
export { agentMethods } from "./rpc";
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
  /** The plugins' `agentBackends` entries (the bundled `clover/agent-<id>` plugins and any other), read at each start. */
  registry?: Pick<PluginRegistry, "entries" | "get">;
  /** The backends to offer in place of the registry's (tests). */
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
  /** Agents on other computers (K-M3, remote.ts), over lane J's link: the transport, the computers' devices, who may
   *  call, and this computer's lease fence (#237). Without it, an agent runs only here. */
  peers?: Pick<AgentPeersOptions, "transport" | "computer" | "mayCall" | "fence">;
  /** Lane A's in-process subagents (`clover`, A-M3) on the embedded runtime: its embedded-session seam and the user's
   *  default model. The pause and the folders it may never reach are the core's (`inProcessBackend`). Without it the
   *  backend isn't offered. */
  inProcess?: Omit<InProcessBackendDeps, "pauseGateFor" | "privateFoldersFor">;
  log?: (line: string) => void;
}

/** A gate that never holds, for a delegation no pause switch covers. */
export const OPEN_PAUSE_GATE: AgentPauseGate = { mayAct: () => true };

/** The Clover home as written and as it really is: the folders no agent may read or write (#208's default-deny). */
export function homeFoldersOf(home: string): string[] {
  let real = home;
  try {
    real = realpathSync(home);
  } catch {
    // Not made yet: the written path is all there is.
  }
  return real === home ? [home] : [home, real];
}

/** Lane A's in-process backend as the core registers it: every delegation gets the pause gate (an open one when there
 *  is no switch, so the required form of lane A's seam is met), and the whole Clover home is a private folder, which
 *  the backend denies to its file tools by rule and to its Bash sandbox, on top of the manager's fence. */
export function inProcessBackend(deps: Omit<InProcessBackendDeps, "pauseGateFor" | "privateFoldersFor">, o: { home: string; pause?: AgentPauseGate; sandboxReady?: () => boolean }): AgentBackend {
  const gate = o.pause ?? OPEN_PAUSE_GATE;
  // The session's own pause when the manager hands one (for an agent run for another computer, that computer's
  // forwarded switch too), else this computer's.
  // Its sandbox is the embedded runtime's, which only macOS has for now: the backend's own `detect` says it isn't
  // available elsewhere, with the reason (`sandboxReady`, the check it reads, passed through).
  const b = inProcessAgentBackend({
    ...deps, pauseGateFor: (spec) => (spec as AcpStartSpec).pause ?? gate, privateFoldersFor: () => homeFoldersOf(o.home),
    ...(o.sandboxReady !== undefined ? { sandboxReady: o.sandboxReady } : {}),
  });
  return { ...b, start: (spec) => b.start(spec) };
}

/** Wires the Agent tool for one daemon: the tokens, the bridge's parts for lane C's Clover server (`clover`: pass
 *  them to `createCloverServer` as its `bridge`, and its `handlers` among the server's), the watchdog,
 *  the backends and the manager. `close` ends every agent's process (the sessions stay to be reattached), revokes
 *  every token. */
export function createAgents(o: AgentsOptions): { manager: AgentManager; clover: BridgeCloverParts; tokens: BridgeTokens; backends: () => AgentBackend[]; close(): Promise<void> } {
  const tokens = new BridgeTokens();
  // The bridge connects to the daemon's own endpoint, where lane C serves the `bridge` role.
  const socketPath = o.socketPath;
  let backends: () => AgentBackend[] = () => [];
  const manager: AgentManager = new AgentManager({
    home: o.home, computer: o.computer, host: o.host, approvals: o.approvals, tree: o.tree, fence: o.fence, clock: o.clock, tokens,
    backends: () => backends(),
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
  // Every ACP backend is a plugin's entry; what the core grants by backend id (an admitted sandbox, Claude Code's
  // placement) applies only to Clover's own `clover/agent-<id>`.
  const build = (c: ContributedBackend) => new AcpAgentBackend({
    id: c.id, pluginId: c.pluginId, bundled: c.bundled, name: c.name, quirks: c.quirks, clock: o.clock, wire, selections,
    admissions: c.bundled ? ADMISSIONS : {},
    ...(c.bundled && c.id in place ? { place: place[c.id as keyof typeof place] } : {}),
    ...(c.file.readOnlyMode ? { readOnlyMode: c.file.readOnlyMode } : {}),
  });
  const cache = new ContributedBackendCache(build);
  // Core backends: Clover's own coding agent and lane A's in-process subagents.
  const core: AgentBackend[] = [
    ...(o.cloverCode ? [new CloverCodeBackend({ ...o.cloverCode, clock: o.clock, wire, selections, ...(o.pause ? { pause: o.pause } : {}), ...(o.log ? { log: o.log } : {}) })] : []),
    ...(o.inProcess ? [inProcessBackend({ ...(o.log ? { log: o.log } : {}), ...o.inProcess }, { home: o.home, ...(o.pause ? { pause: o.pause } : {}) })] : []),
  ];
  if (o.backends) {
    const fixed = o.backends(wire);
    backends = () => fixed;
  } else {
    const registry = o.registry;
    backends = () => [...(registry ? cache.backends(registry, o.log) : []), ...core];
  }
  const clover = bridgeCloverParts(tokens, manager.bridgeHandlers());
  const peers = o.peers
    ? new AgentPeers(manager, { ...o.peers, home: o.home, clock: o.clock, ...(o.pause ? { pause: o.pause } : {}), ...(o.log ? { log: o.log } : {}) })
    : undefined;
  return {
    manager, clover, tokens, backends: () => backends(),
    close: async () => {
      peers?.close();
      await manager.close();
      tokens.revokeAll();
    },
  };
}
