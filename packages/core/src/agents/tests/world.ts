// A small world for the Agent tool's end-to-end tests: one computer ("Studio") with a temp home, lane B's fakes for
// everything that isn't lane K's (the session host, the approval broker, the tree, the fence, the clock), and lane
// K's real parts: the manager, the ACP backend launching the scripted agent, the bridge's tokens, lane C's Clover server
// serving the bridge role (testing/clover-endpoint.ts), the
// real bridge process, the watchdog. A bot "alpha" has its main session `s_alpha` to delegate from.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, AgentEvent, AgentQuirks } from "../../contracts/agent-backend";
import type { Level } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import { FakeSessionDriver, FakeSessionHost } from "../../contracts/fakes/session-host";
import { FakeTree } from "../../contracts/fakes/tree";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import type { SessionRecord } from "../../contracts/session-host";
import { UserSelections } from "../acp/selections";
import { AcpAgentBackend, type AcpBackendOptions } from "../backend";
import type { PluginPartsSource } from "../placement";
import { bridgeCloverParts } from "../bridge/handlers";
import { serveClover, type TestCloverEndpoint } from "../testing/clover-endpoint";
import { bridgeCommand } from "../bridge/main";
import { BridgeTokens } from "../bridge/tokens";
import type { BridgeToolSource } from "../bridge/tools";
import { AgentManager, type AgentPauseGate } from "../manager";
import type { ProcessTableReader } from "../process/table";
import { FAKE_AGENT_PATH, fakeLaunch, readReport, writeFakeAgent, type FakeAgentRun } from "../testing/harness";
import type { FakeAcpStep } from "../testing/fake-acp-agent";
import { StallWatchdog } from "../watchdog";
import type { SandboxAdmission, SandboxWriter } from "../sandbox/admission";
import type { ModeFloor } from "../acp/session";
import type { AgentOks } from "../sandbox/oks";

/** The scripted agent's "own sandbox", admitted for the tests: the fenced set written as a file its env names. */
export const FAKE_PROTECTED: SandboxAdmission = {
  status: "protected", versions: ">=1.0.0", evidence: "the scripted agent's sandbox (tests)",
  writer: (policy, ctx) => ({
    files: [{ name: "policy.json", content: JSON.stringify(policy) }],
    env: { FAKE_SANDBOX_POLICY: join(ctx.dir, "policy.json") },
    args: ["--sandboxed"],
    meta: { fakeSandbox: { policy: join(ctx.dir, "policy.json") } },
  }),
};

/** The scripted agent's admission on every OS. */
export function fakeAdmissions(sandbox: "protected" | "none", modeFloor?: (level: Level | undefined) => ModeFloor) {
  const writer: SandboxWriter = (policy, ctx) => ({ ...(FAKE_PROTECTED as { writer: SandboxWriter }).writer(policy, ctx), modeFloor: modeFloor! });
  const row: SandboxAdmission = sandbox === "none" ? { status: "unsupported", reason: "the test's agent has none" } : modeFloor ? { ...FAKE_PROTECTED, writer } as SandboxAdmission : FAKE_PROTECTED;
  return { fake: { macos: row, linux: row, windows: row } };
}

export interface WorldOptions {
  /** The manager's log lines. */
  log?: (line: string) => void;
  quirks?: AgentQuirks;
  script?: FakeAcpStep[][];
  history?: AgentEvent[];
  level?: Level;
  pluginTools?: BridgeToolSource;
  /** The watchdog's wall clock, to age a running command past its limit. */
  wallNow?: () => number;
  table?: ProcessTableReader;
  /** The scripted agent's sandbox: admitted by default, or one Clover can't count on (so it needs the OK). */
  sandbox?: "protected" | "none";
  oks?: AgentOks;
  /** The plugins' parts for every session, and the backend's placement of them (Claude Code's). */
  pluginParts?: PluginPartsSource;
  place?: AcpBackendOptions["place"];
  /** The scripted agent's `mode` option values (the first is current at the start), and the backend's read-only mode. */
  modes?: string[];
  /** The scripted agent's writer's mode floor, by level. */
  modeFloor?: (level: Level | undefined) => ModeFloor;
  /** The scripted agent's ACP session modes, whether its `session/set_mode` stays unconfirmed, whether its edits ask
   *  by mode (as Claude Code's), and how long the session waits for a mode's confirmation. */
  acpModes?: string[];
  silentSetMode?: boolean;
  editsFollowMode?: boolean;
  modeConfirmMs?: number;
  readOnlyMode?: { option: string; values: readonly string[] };
  askDuringReplay?: boolean;
  selections?: UserSelections;
  pause?: AgentPauseGate;
  /** The bridge tokens' life, on the world's clock. */
  tokenTtlMs?: number;
  /** More backends beside the scripted one (Clover's coding agent), given the manager's wire. */
  extraBackends?: (wire: (sessionId: string) => ReturnType<AgentManager["wire"]>, world: World) => AgentBackend[];
  /** A fixed bridge server name, for an agent whose script names the bridge's tools. */
  bridgeServerName?: string;
  /** This computer's name ("Studio" by default), and the other computers' homes its tree knows (agents placed there). */
  computer?: string;
  otherComputers?: Record<string, string>;
}

/** A Unix socket path short enough for macOS's 104-byte limit. */
function socketPath(root: string): string {
  const p = join(root, "b.sock");
  return p.length < 100 ? p : join("/tmp", `ck-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export class World {
  readonly root: string;
  readonly userHome: string;
  readonly cloverHome: string;
  readonly project: string;
  readonly clock = new FakeClock();
  readonly fence: FakeFence;
  readonly tree: FakeTree;
  readonly approvals: FakeApprovalBroker;
  readonly host: FakeSessionHost;
  readonly parentDriver = new FakeSessionDriver();
  readonly tokens: BridgeTokens;
  readonly watchdog: StallWatchdog;
  readonly manager: AgentManager;
  readonly endpoint: TestCloverEndpoint;
  readonly backend: AcpAgentBackend;
  readonly agent: FakeAgentRun;
  level: Level;
  readonly computer: string;
  readonly #levelWatchers = new Set<() => void>();

  /** Changes the computer's level and tells the manager, as the registry's watch does. */
  changeLevel(level: Level): void {
    this.level = level;
    for (const fn of [...this.#levelWatchers]) fn();
  }

  constructor(o: WorldOptions = {}) {
    this.computer = o.computer ?? "Studio";
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "clover-k-")));
    this.userHome = join(this.root, "home");
    this.cloverHome = join(this.userHome, ".clover");
    this.project = join(this.userHome, "project1");
    mkdirSync(this.project, { recursive: true });
    mkdirSync(this.cloverHome, { recursive: true });
    this.level = o.level ?? "automatic";
    this.fence = new FakeFence({ home: this.userHome, cloverHome: this.cloverHome });
    const others = Object.fromEntries(Object.entries(o.otherComputers ?? {}).map(([name, home]) => [name, { home }]));
    this.tree = new FakeTree({ clock: this.clock, computers: { ...others, [this.computer]: { home: this.userHome } }, botComputer: () => "Studio" });
    this.approvals = new FakeApprovalBroker({ clock: this.clock, levels: () => this.level, fence: () => this.fence });
    this.host = new FakeSessionHost({ clock: this.clock, approvals: this.approvals });
    this.host.open({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, this.parentDriver);
    this.tokens = new BridgeTokens({ ...(o.table ? { table: o.table } : {}), ...(o.tokenTtlMs ? { ttlMs: o.tokenTtlMs, now: () => this.clock.now() } : {}) });
    this.watchdog = new StallWatchdog({ clock: this.clock, ...(o.wallNow ? { wallNow: o.wallNow } : {}), ...(o.table ? { table: o.table } : {}) });
    const quirks = fakeLaunch(o.quirks ?? WELL_BEHAVED_QUIRKS);
    this.agent = writeFakeAgent(join(this.root, "agent"), {
      quirks, script: o.script ?? [], ...(o.history ? { history: o.history } : {}), version: "fake-agent 1.0.0",
      ...(o.modes ? { modes: o.modes } : {}), ...(o.askDuringReplay ? { askDuringReplay: true } : {}),
      ...(o.acpModes ? { acpModes: o.acpModes } : {}), ...(o.silentSetMode ? { silentSetMode: true } : {}), ...(o.editsFollowMode ? { editsFollowMode: true } : {}),
    });
    const sock = socketPath(this.root);
    let manager!: AgentManager;
    this.backend = new AcpAgentBackend({
      id: "fake", pluginId: "clover/agent-fake", quirks, clock: this.clock,
      command: { program: process.execPath, prefixArgs: [FAKE_AGENT_PATH, this.agent.config], acpArgs: ["acp"] },
      wire: (id) => manager.wire(id),
      admissions: fakeAdmissions(o.sandbox ?? "protected", o.modeFloor),
      ...(o.modeConfirmMs === undefined ? {} : { modeConfirmMs: o.modeConfirmMs }),
      ...(o.place ? { place: o.place } : {}),
      ...(o.readOnlyMode ? { readOnlyMode: o.readOnlyMode } : {}), ...(o.selections ? { selections: o.selections } : {}),
    });
    const extra = o.extraBackends?.((id) => manager.wire(id), this) ?? [];
    manager = new AgentManager({
      home: this.cloverHome, computer: this.computer, host: this.host, approvals: this.approvals, tree: this.tree, fence: this.fence,
      backends: () => [this.backend, ...extra], tokens: this.tokens, bridge: { ...bridgeCommand(), socketPath: sock, ...(o.bridgeServerName ? { serverName: o.bridgeServerName } : {}) }, watchdog: this.watchdog, clock: this.clock,
      ...(o.pluginTools ? { pluginTools: o.pluginTools } : {}),
      ...(o.oks ? { oks: o.oks } : {}),
      ...(o.pluginParts ? { pluginParts: o.pluginParts } : {}),
      ...(o.log ? { log: o.log } : {}),
      levelOf: () => this.level,
      watchLevels: (fn) => {
        this.#levelWatchers.add(fn);
        return () => void this.#levelWatchers.delete(fn);
      },
      ...(o.pause ? { pause: o.pause } : {}),
    });
    this.manager = manager;
    this.endpoint = serveClover(sock, bridgeCloverParts(this.tokens, manager.bridgeHandlers()));
  }

  /** What the scripted agent process reported. */
  report(type?: string) {
    return readReport(this.agent.report).filter((r) => type === undefined || r.type === type);
  }

  /** The parent's inputs, by where they came from. */
  parentInputs(from?: string) {
    return this.host.history("s_alpha").filter((r): r is SessionRecord & { type: "input" } => r.type === "input" && (from === undefined || r.input.from === from));
  }

  async delegate(prompt = "Fix the tests.", extra: { root?: string; backend?: string; computer?: string; model?: string } = {}) {
    return this.manager.start({
      caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" },
      backend: extra.backend ?? "fake", prompt, root: extra.root ?? "home/Studio/project1", title: "Fix the tests",
      ...(extra.computer ? { computer: extra.computer } : {}), ...(extra.model ? { model: extra.model } : {}),
    });
  }

  async close(): Promise<void> {
    for (const v of this.host.list()) if (v.kind === "agent" || v.kind === "coding") await this.host.stop(v.id).catch(() => {});
    this.endpoint.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
