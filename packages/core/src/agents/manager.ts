// The agent manager: what the `Agent` and `TaskStop` tools, lane D's session hooks, the bridge and the `agent.*` methods do
// (spec §9.3, plan §4 K-M1). It owns no session state of its own beyond each agent's wiring; the session host keeps
// the sessions (a background agent is a session like any other), and its task notifications.
//
// `start` (the `Agent` tool, and `agent.start` for a coding session the user drives):
// 1. Local placement only in M1: the computer is this one, and the root folder must be on it. Another computer and
//    vendor clouds come with K-M3.
// 2. The root is a folder-tree path, resolved to a real path here; the fence refuses a root that holds the Clover home
//    or a development folder (`checkAgentRoot`, §9.3).
// 3. A new bridge token, the transcript folder, the daemon's own record (records.ts), and a session opened in the
//    host with an `AgentDriver`. The task is delivered as the session's first input, so `start` returns at once and
//    the agent starts in its first turn.
// 4. In that first turn, before anything launches: an agent that isn't sandboxed, or is outside its tested versions,
//    needs the user's OK, which comes with K-M2's card; until then it isn't started (review 2, §9.3 [D] "Clover never
//    quietly runs an unsandboxed agent"). At read-only, an agent that acts without asking starts in its read-only
//    mode or not at all (§9.3 [P], item 78).
// 5. The agent's permission requests go to the ApprovalBroker (level, then card), answered `allow_once` or
//    `reject_once`; a request naming the session's bridge server and one of the bridge's own tools exactly is
//    answered at once (S5 edit 7), and one touching a fenced path is always a card (the broker's rules 2 and 3). Its
//    paths are resolved against the root, with their real paths, before the broker sees them (review 8).
// 6. A reattach after a restart trusts the host's view and the daemon's own record, never the bot's folder, and
//    checks the root again (review 1).
//
// The bridge's server name is `clover_` and a random suffix, new for each session (review 14), so no MCP server of
// the user's own can share it. The bridge's methods land here too: `SendMessage` from an agent folds into its bot's
// conversation (§9.3), and only into another session of the same bot.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import type { Level, SealedValue, SessionView, TurnOrigin } from "@waifucave/clover-protocol";
import type { AgentBackend, AgentPermissionAnswer, AgentPermissionAsk, AgentSession } from "../contracts/agent-backend";
import { type ActionEffect, type ApprovalBroker, type ApprovalRequest, acpOutcomeFor } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import type { Fence } from "../contracts/fence";
import type { SessionHost, TurnInput } from "../contracts/session-host";
import type { Tree } from "../contracts/tree";
import type { AcpStartSpec, AgentWire } from "./backend";
import { BridgeTokens } from "./bridge/tokens";
import type { BridgeHandlers } from "./bridge/handlers";
import { BRIDGE_ENV } from "./bridge/server";
import { NO_PLUGIN_TOOLS, bridgeInstructions, bridgeOwnTools, type BridgeToolSource } from "./bridge/tools";
import { AgentDriver } from "./driver";
import { MemoryAgentOks, programHash, type AgentOks } from "./sandbox/oks";
import { NO_PARTS, type PluginParts, type PluginPartsSource } from "./placement";
import { inProcessBridgeServer } from "./bridge/in-process";
import { agentPaths } from "./paths";
import { agentPolicyOf, homeReach, withHomeDenied } from "./memory";
import { type DaemonAgentRecord, readAgentRecord, removeAgentRecord, writeAgentRecord } from "./records";
import { AgentTranscript, type AgentRecordFile } from "./transcript";
import type { StallWatchdog } from "./watchdog";

export interface AgentManagerOptions {
  /** The Clover home: transcripts go under `<home>/bots/<bot>/agents/`. */
  home: string;
  /** This computer's name in the folder tree. */
  computer: string;
  host: SessionHost;
  approvals: ApprovalBroker;
  tree: Pick<Tree, "resolve">;
  fence: Pick<Fence, "checkAgentRoot" | "policy" | "touches">;
  /** The backends the plugins contribute (`agentBackends`); read at each start. */
  backends: () => readonly AgentBackend[];
  tokens: BridgeTokens;
  /** How an agent starts the bridge (`bridgeCommand()`), and where it finds the daemon. */
  bridge: { command: string; args: readonly string[]; socketPath: string; serverName?: string };
  watchdog: StallWatchdog;
  clock: Clock;
  pluginTools?: BridgeToolSource;
  glossary?: BridgeHandlers["glossary"];
  /** The user's OKs for agents with no admitted sandbox (sandbox/oks.ts): `FileAgentOks` in the daemon. */
  oks?: AgentOks;
  /** The plugins' skills, agent definitions and hooks per session (B-M2's registry); none until then. */
  pluginParts?: PluginPartsSource;
  /** A computer's level (§9.1), for an agent that acts without asking; read-only when it isn't known. */
  levelOf?: (computer: string) => Level | undefined;
  /** The pause switch (lane D's gate, `mayAct()`): while it says no, a delegated agent is held (`#hold`). */
  pause?: AgentPauseGate;
  /** Tests only: start an agent that isn't sandboxed, or is outside its tested versions, without the user's OK. */
  startUnsandboxedForTests?: boolean;
  log?: (line: string) => void;
}

/** The pause switch as lane K reads it (the owner's ruling: it pauses everything, background agents included). `watch`
 *  says when it may have moved; without it, a held agent looks again every second. */
export interface AgentPauseGate {
  mayAct(): boolean;
  watch?(fn: () => void): () => void;
}

/** A bridge token this close to its expiry is renewed at the next turn. */
const TOKEN_RENEW_MARGIN_MS = 60 * 60_000;

/** How often a held agent looks at the switch when the gate can't say it moved. */
const PAUSE_POLL_MS = 1_000;

/** Lane K's side of lane D's hooks, in #176's shapes: `BotToolsDeps.agents`, `SessionsMethodsDeps.setAgentModel` and
 *  `BotServiceOptions.reattach`. */
export interface AgentSessionHooks {
  agents: { list(): SessionView[] };
  setAgentModel(id: string, model: string, effort?: string): Promise<void>;
  reattach(views: SessionView[]): void;
}

/** Who asks for an agent: a bot from one of its sessions, or the user (a coding session, `clover code`). */
export type AgentCaller =
  | { kind: "bot"; bot: string; session: string; origin: TurnOrigin; level?: Level }
  | { kind: "user"; device: string; sentAt?: number; clientMessageId: string };

export interface AgentRequest {
  caller: AgentCaller;
  backend: string;
  /** The task: the agent's first prompt. A coding session may start without one. */
  prompt: string;
  /** A short title for the tab and `ListAgents`. */
  title?: string;
  model?: string;
  effort?: string;
  /** The computer to run on; this one by default. */
  computer?: string;
  /** The root folder, as a folder-tree path (`home/<Computer>/…`). */
  root: string;
}

interface Entry {
  id: string;
  backend: AgentBackend;
  bot?: string;
  parent?: string;
  computer: string;
  root: string;
  rootPath: string;
  model?: string;
  effort?: string;
  level?: Level;
  transcript: AgentTranscript;
  driver: AgentDriver;
  token: string;
  serverName: string;
  bridgeTools: string[];
  unwatch?: () => void;
  /** The bot's copy (`agent.json`) and the daemon's own (records.ts). */
  record: AgentRecordFile;
  parts?: PluginParts;
  daemon: DaemonAgentRecord;
  session?: AgentSession;
  /** Holds waiting for the pause switch. */
  held: number;
  /** Aborted when the session ends or the daemon closes: a held call never runs after that. */
  gone: AbortController;
  resumedAt?: number;
}

/** The bridge's server name starts with this; a random suffix follows, new for each session. */
export const BRIDGE_SERVER_PREFIX = "clover_";
const MAX_CARD_CODE = 60_000;

export class AgentManager {
  readonly #o: AgentManagerOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #oks: AgentOks;

  readonly #unpause: (() => void) | undefined;

  constructor(opts: AgentManagerOptions) {
    this.#o = opts;
    this.#oks = opts.oks ?? new MemoryAgentOks();
    // The ruling (K-M2 review 4): the moment the switch says paused, a busy agent that acts without asking is cancelled,
    // since Clover can't hold what it isn't asked about. Without `watch`, it is cancelled at its next tool call.
    this.#unpause = opts.pause?.watch?.(() => {
      if (opts.pause!.mayAct()) return;
      for (const e of this.#entries.values()) this.#cancelForPause(e);
    });
  }

  #cancelForPause(e: Entry, toolCallId?: string): void {
    if (!e.backend.quirks.marks.includes("unasked-actions") || !e.session || !e.driver.busy()) return;
    e.transcript.call({ ts: this.#o.clock.now(), type: "paused", cancelled: true, ...(toolCallId ? { toolCallId } : {}) });
    void e.session.cancel();
  }

  /** A session's sandbox setup folder, inside the fenced run folder. */
  setupDir(sessionId: string): string {
    return join(this.#o.home, "run", "agents", sessionId);
  }

  #serverNameFor(): string {
    return this.#o.bridge.serverName ?? `${BRIDGE_SERVER_PREFIX}${randomBytes(8).toString("hex")}`;
  }

  /** A root's real path: a folder in this computer's home that holds none of Clover's own folders. */
  #rootPath(root: string): string {
    const loc = this.#o.tree.resolve(root);
    if (loc.area !== "home") throw new ContractError("refused", "an agent's root folder is a folder in a computer's home (home/<Computer>/…)");
    if (loc.computer !== this.#o.computer) {
      throw new ContractError("refused", `${root} is on ${loc.computer}; an agent runs on the computer that holds its root, which comes with K-M3`);
    }
    const verdict = this.#o.fence.checkAgentRoot(loc.path);
    if (!verdict.allowed) throw new ContractError("fenced", `an agent's root may not hold Clover's own folders (${verdict.reason})`, { path: verdict.path });
    return loc.path;
  }

  /** The hooks an ACP backend takes for a session: its transcript, and the token's binding to the agent's pid. */
  wire(sessionId: string): AgentWire {
    const e = this.#entries.get(sessionId);
    if (!e) return {};
    return {
      tap: (dir, msg, replay) => e.transcript.wire(dir, msg, replay, this.#o.clock.now()),
      stderr: (chunk) => e.transcript.stderr(chunk),
      launched: (pid, contains) => this.#o.tokens.bind(sessionId, pid, contains),
      // A leaked copy of the token is useless once the agent is gone (S5 edit 4).
      // Only the token bound to this process: a renewed one (a restart under a new token) stays.
      exited: (pid) => this.#o.tokens.revokeBoundTo(sessionId, pid),
      setupDir: this.setupDir(sessionId),
      ...(e.parts ? { parts: e.parts } : {}),
    };
  }

  async start(req: AgentRequest): Promise<{ sessionId: string; transcript: string }> {
    const backend = this.#o.backends().find((b) => b.id === req.backend);
    if (!backend) throw new ContractError("not_installed", `no agent backend named ${req.backend}`);
    // Spec §9.3 "Cloud placement": whether the stdio bridge reaches a cloud session, and what the root folder means
    // there, are settled before a cloud backend ships, by the agent suite's live gates. Until then it is listed, never
    // started.
    if (backend.quirks.placement !== "local") {
      throw new ContractError("refused", `${req.backend} runs in its vendor's cloud, which doesn't start yet: whether Clover's bridge reaches a cloud session, and what the root folder means there, are still to be settled`);
    }
    const computer = req.computer ?? this.#o.computer;
    if (computer !== this.#o.computer) {
      throw new ContractError("refused", `placing an agent on ${computer} comes with K-M3; for now an agent runs on ${this.#o.computer}`);
    }
    const rootPath = this.#rootPath(req.root);

    const id = `agent_${randomBytes(9).toString("base64url")}`;
    const bot = req.caller.kind === "bot" ? req.caller.bot : undefined;
    const parent = req.caller.kind === "bot" ? req.caller.session : undefined;
    const level = req.caller.kind === "bot" ? req.caller.level : undefined;
    const transcript = new AgentTranscript(this.#o.home, id, bot);
    const startedAt = this.#o.clock.now();
    const who = { ...(bot === undefined ? {} : { bot }), ...(parent === undefined ? {} : { parent }) };
    const daemon: DaemonAgentRecord = { v: 1, sessionId: id, backend: backend.id, computer, root: req.root, startedAt, ...who, ...(level === undefined ? {} : { level }) };
    writeAgentRecord(this.#o.home, daemon);
    const record: AgentRecordFile = {
      v: 1, sessionId: id, backend: backend.id, computer, root: req.root, startedAt, ...who,
      ...(req.model === undefined ? {} : { model: req.model }), ...(req.effort === undefined ? {} : { effort: req.effort }),
    };
    transcript.writeRecord(record);
    const entry = this.#entry(id, backend, transcript, record, daemon, rootPath);
    this.#o.host.open({
      id, kind: bot === undefined ? "coding" : "agent", computer, backend: backend.id, root: req.root,
      ...(bot === undefined ? {} : { bot }), ...(parent === undefined ? {} : { parent }),
      ...(req.title === undefined ? {} : { title: req.title }),
      ...(req.model === undefined ? {} : { model: req.model }), ...(req.effort === undefined ? {} : { effort: req.effort }),
    }, entry.driver);
    try {
      // A coding session the user opens with no prompt waits for their first message; the agent starts with it.
      if (req.caller.kind === "bot") await this.#o.host.deliver(id, { from: "bot", bot: req.caller.bot, session: req.caller.session, text: req.prompt });
      else if (req.prompt.length > 0) await this.#o.host.sendUser(id, { text: req.prompt, device: req.caller.device, clientMessageId: req.caller.clientMessageId, sentAt: req.caller.sentAt ?? this.#o.clock.now() });
    } catch (err) {
      await this.#o.host.stop(id, "failed to start").catch(() => {});
      throw err;
    }
    return { sessionId: id, transcript: transcript.treeWirePath };
  }

  /** Reattaches a background agent or a coding session after a daemon restart: the host restored the session dormant,
   *  and the agent resumes in its next turn, with an honest `resume` or a `load` whose replay is dropped, and a new
   *  token. Who the session is comes from the host's view; the daemon's own record must agree with it and adds only
   *  the agent's session id and a routine's raised level; the root is checked again (review 1). False, and logged,
   *  when any of that fails: the session stays as the host left it. */
  reattach(view: SessionView): boolean {
    if ((view.kind !== "agent" && view.kind !== "coding") || this.#entries.has(view.id)) return false;
    const refuse = (why: string) => {
      this.#o.log?.(`agents: not reattaching ${view.id}: ${why}`);
      return false;
    };
    if (view.status === "stopped" || view.status === "failed") return refuse("it has ended");
    if (view.computer !== this.#o.computer) return refuse(`it runs on ${view.computer}`);
    if (!view.backend || !view.root) return refuse("the host's view names no backend or root");
    if ((view.kind === "agent") !== (view.bot !== undefined)) return refuse("its kind and its bot disagree");
    const daemon = readAgentRecord(this.#o.home, view.id);
    if (!daemon?.agentSessionId) return refuse("the daemon's record of it is missing");
    if (daemon.backend !== view.backend || daemon.root !== view.root || daemon.computer !== view.computer || daemon.bot !== view.bot || daemon.parent !== view.parent) {
      return refuse("the daemon's record doesn't match the session");
    }
    const backend = this.#o.backends().find((b) => b.id === view.backend);
    if (!backend) return refuse(`no backend named ${view.backend}`);
    let rootPath: string;
    try {
      rootPath = this.#rootPath(view.root);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    const transcript = new AgentTranscript(this.#o.home, view.id, view.bot);
    const record: AgentRecordFile = {
      v: 1, sessionId: view.id, backend: backend.id, computer: view.computer, root: view.root, startedAt: daemon.startedAt, agentSessionId: daemon.agentSessionId,
      ...(view.bot === undefined ? {} : { bot: view.bot }), ...(view.parent === undefined ? {} : { parent: view.parent }),
      ...(view.model === undefined ? {} : { model: view.model }), ...(view.effort === undefined ? {} : { effort: view.effort }),
    };
    const entry = this.#entry(view.id, backend, transcript, record, daemon, rootPath, { agentSessionId: daemon.agentSessionId });
    this.#o.host.open({
      id: view.id, kind: view.kind, computer: view.computer, backend: backend.id, root: view.root,
      ...(view.bot === undefined ? {} : { bot: view.bot }), ...(view.parent === undefined ? {} : { parent: view.parent }),
      ...(view.title === undefined ? {} : { title: view.title }),
      ...(view.model === undefined ? {} : { model: view.model }), ...(view.effort === undefined ? {} : { effort: view.effort }),
    }, entry.driver);
    return true;
  }

  #entry(id: string, backend: AgentBackend, transcript: AgentTranscript, record: AgentRecordFile, daemon: DaemonAgentRecord, rootPath: string, reattach?: { agentSessionId: string }): Entry {
    const token = this.#o.tokens.mint(id);
    transcript.redact(token);
    const entry = {
      id, backend, transcript, record, daemon, token, rootPath, computer: daemon.computer, root: daemon.root,
      held: 0, gone: new AbortController(), serverName: this.#serverNameFor(), bridgeTools: bridgeOwnTools(daemon.bot).map((t) => t.name),
      ...(daemon.bot === undefined ? {} : { bot: daemon.bot }), ...(daemon.parent === undefined ? {} : { parent: daemon.parent }),
      ...(record.model === undefined ? {} : { model: record.model }), ...(record.effort === undefined ? {} : { effort: record.effort }),
      ...(daemon.level === undefined ? {} : { level: daemon.level }),
    } as Entry;
    entry.driver = new AgentDriver({
      start: () => this.#startAgent(entry, reattach),
      promptOf: (input) => promptOf(input),
      redact: (v) => transcript.redacted(v),
      // A paused agent is sent no new prompt until the switch is back.
      beforeTurn: async (session) => {
        // A turn withdrawn while held ends `interrupted` (the driver checks its signal next).
        await this.#hold(entry).catch(() => {});
        const renewed = await this.#renewIfOld(entry, session);
        await this.#applyLevel(entry, renewed ?? session);
        return renewed;
      },
      ended: () => {
        entry.gone.abort();
        this.#o.tokens.revoke(id);
        entry.unwatch?.();
        rmSync(this.setupDir(id), { recursive: true, force: true });
        // Every way a session ends takes its cards with it (rule 7, review 3).
        this.#o.approvals.cancelSession(id);
        if (this.#entries.get(id) === entry) {
          this.#entries.delete(id);
          removeAgentRecord(this.#o.home, id);
        }
      },
    });
    this.#entries.set(id, entry);
    return entry;
  }

  /** The level the session's permission requests are judged at: a routine's raised level, or its computer's. */
  #levelOf(e: Entry): Level {
    return e.level ?? this.#o.levelOf?.(e.computer) ?? "read-only";
  }

  /** While paused (the owner's ruling), waits until the switch is back, or the turn is withdrawn. A held agent isn't
   *  stalled. */
  async #hold(e: Entry): Promise<void> {
    const gate = this.#o.pause;
    if (e.gone.signal.aborted) throw new ContractError("closed", "this agent's session has ended");
    if (!gate || gate.mayAct()) return;
    const signals = [e.driver.currentSignal(), e.gone.signal].filter((x): x is AbortSignal => x !== undefined);
    e.held++;
    try {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<Clock["setTimeout"]> | undefined;
        const done = () => {
          off?.();
          if (timer !== undefined) this.#o.clock.clearTimeout(timer);
          for (const sig of signals) sig.removeEventListener("abort", done);
          resolve();
        };
        const check = () => {
          if (gate.mayAct()) done();
          else if (!gate.watch) timer = this.#o.clock.setTimeout(check, PAUSE_POLL_MS);
        };
        const off = gate.watch?.(check);
        for (const sig of signals) sig.addEventListener("abort", done, { once: true });
        if (signals.some((sig) => sig.aborted)) return done();
        check();
      });
    } finally {
      e.held--;
      // The stall window starts again from the resume.
      e.resumedAt = this.#o.clock.now();
    }
    if (signals.some((sig) => sig.aborted)) throw new ContractError("cancelled", "withdrawn while the bots were paused");
  }

  /** A held bridge call goes on only if its session and token are still live after the hold (review 1). */
  async #holdForBridge(id: string): Promise<Entry> {
    const e = this.#entries.get(id);
    if (!e) throw new ContractError("closed", "this agent's session has ended");
    await this.#hold(e);
    if (this.#entries.get(id) !== e || !this.#o.tokens.has(id)) throw new ContractError("closed", "this agent's session has ended");
    return e;
  }

  /** A session that outlives its bridge token (12 hours) would lose its bridge: at the turn boundary before the
   *  token's last hour, the agent is restarted under a new token, with an honest `resume` or a `load` whose replay is
   *  dropped (K-M2 review 12). An agent that can't reattach keeps its token until it expires. */
  async #renewIfOld(e: Entry, session: AgentSession): Promise<AgentSession | undefined> {
    const age = this.#o.tokens.ageOf(e.id);
    if (age === undefined || age < this.#o.tokens.ttlMs - TOKEN_RENEW_MARGIN_MS) return undefined;
    const q = e.backend.quirks.sessions;
    if (!q.load.supported && !(q.resume.supported && !q.resume.replays)) return undefined;
    const agentSessionId = e.daemon.agentSessionId ?? session.agentSessionId;
    e.unwatch?.();
    await session.stop();
    // The old process's exit revokes the old token; the new one is minted after it.
    await new Promise((r) => setTimeout(r, 0));
    e.token = this.#o.tokens.mint(e.id);
    e.transcript.redact(e.token);
    e.transcript.call({ ts: this.#o.clock.now(), type: "token-renewed" });
    return this.#startAgent(e, { agentSessionId });
  }

  /** At each turn, the computer's level as it is now (check 2's minor 5): an agent that acts without asking goes into
   *  its read-only mode when the level dropped to read-only since it started, and back when it rose again. */
  async #applyLevel(e: Entry, session: AgentSession): Promise<void> {
    if (!e.backend.quirks.marks.includes("unasked-actions")) return;
    const readOnly = this.#levelOf(e) === "read-only";
    const s = session as { setReadOnly?: (on: boolean) => Promise<void> };
    if (s.setReadOnly) return s.setReadOnly(readOnly);
    if (readOnly) throw new ContractError("refused", `${e.backend.id} acts without asking and can't be held at read-only, so this turn wasn't sent`);
  }

  /** Before an agent launches: an agent that isn't sandboxed, or is outside its tested versions, needs the user's OK. */
  async #admit(e: Entry): Promise<NonNullable<AcpStartSpec["admitted"]>> {
    const d = await e.backend.detect();
    if (!d.installed) throw new ContractError("not_installed", d.reason ?? `${e.backend.id} isn't installed on this computer`);
    if (!d.identityOk) throw new ContractError("refused", d.reason ?? `${e.backend.id}'s program isn't its publisher's`);
    const why: string[] = [];
    if (!d.sandboxed) {
      const detail = d.versionOk ? d.reason?.replace(/^no sandbox: /, "") : undefined;
      why.push(`it has no sandbox Clover can count on here${detail ? ` (${detail})` : ""}`);
    }
    if (!d.versionOk) why.push(`its version ${d.version ?? "(unknown)"} is outside the versions Clover was tested with`);
    const admitted = { path: d.path ?? "", ...(d.version === undefined ? {} : { version: d.version }) };
    if (why.length === 0) return admitted;
    // The OK is for this program: its real path and its file's hash (K-M2 review 5).
    const sha256 = (await programHash(admitted.path)) ?? "";
    await this.#requireOk(e, { version: d.version ?? "unknown", path: admitted.path, sha256 }, why.join("; "), d.sandboxed);
    return { ...admitted, ...(sha256 ? { sha256 } : {}) };
  }

  async #startAgent(e: Entry, reattach?: { agentSessionId: string }): Promise<AgentSession> {
    const admitted = await this.#admit(e);
    e.parts = (await this.#o.pluginParts?.parts(e.id).catch(() => NO_PARTS)) ?? NO_PARTS;
    const tools = await (this.#o.pluginTools ?? NO_PLUGIN_TOOLS).tools(e.id).catch(() => []);
    e.bridgeTools = [...bridgeOwnTools(e.bot).map((t) => t.name), ...tools.map((t) => t.name)];
    const spec: AcpStartSpec = {
      sessionId: e.id,
      root: e.rootPath,
      ...(e.model === undefined ? {} : { model: e.model }),
      ...(e.effort === undefined ? {} : { effort: e.effort }),
      instructions: bridgeInstructions({ ...(e.bot === undefined ? {} : { bot: e.bot }), serverName: e.serverName }),
      bridge: {
        name: e.serverName,
        command: this.#o.bridge.command,
        args: [...this.#o.bridge.args],
        env: { [BRIDGE_ENV.token]: e.token, [BRIDGE_ENV.session]: e.id, [BRIDGE_ENV.socket]: this.#o.bridge.socketPath },
        tools: e.bridgeTools,
      },
      // The Clover home is out of every agent's reach (the owner's decision, #208's check 2): denied to its sandbox
      // whole, for reads and writes.
      fence: withHomeDenied(agentPolicyOf(this.#o.fence.policy()), this.#o.home),
      ...(reattach ? { reattach } : {}),
      ...(this.#levelOf(e) === "read-only" ? { readOnly: true } : {}),
      admitted,
      // A backend inside the daemon (Clover's coding agent) gets the bridge in-process: its calls check the session's
      // token is still live, as the socket's do.
      ...((e.backend as { inProcess?: boolean }).inProcess === true
        ? { inProcessBridge: await inProcessBridgeServer(this.bridgeHandlers(), { name: e.serverName, sessionId: e.id, live: () => this.#o.tokens.has(e.id) }) }
        : {}),
    };
    const session = await e.backend.start(spec);
    e.session = session;
    const pid = (session as { pid?: number }).pid;
    if (pid) this.#o.tokens.bind(e.id, pid);
    e.daemon = { ...e.daemon, agentSessionId: session.agentSessionId };
    writeAgentRecord(this.#o.home, e.daemon);
    e.record = { ...e.record, agentSessionId: session.agentSessionId };
    e.transcript.writeRecord(e.record);
    session.onPermission((ask) => this.#permission(e, ask));
    // An agent that acts without asking can't be held at a call it never asks about: paused, its turn is cancelled at
    // its next tool call instead, and the next turn waits for the switch.
    if (e.backend.quirks.marks.includes("unasked-actions")) {
      session.onEvent((ev) => {
        if (ev.type !== "tool_call" || !this.#o.pause || this.#o.pause.mayAct()) return;
        this.#cancelForPause(e, ev.id);
      });
    }
    const s = session as { openCalls?: () => { id: string; kind: string; startedAtWall: number }[]; waitingOnUser?: () => boolean };
    e.unwatch = this.#o.watchdog.watch({
      pid: pid ?? 0,
      lastProgressAt: () => Math.max(session.lastProgressAt(), e.resumedAt ?? 0),
      busy: () => e.driver.busy(),
      waitingOnUser: () => e.held > 0 || (s.waitingOnUser?.() ?? false),
      runningCommands: () => (s.openCalls?.() ?? []).filter((c) => c.kind === "execute"),
    }, () => {
      this.#o.log?.(`agents: ${e.id} made no progress for 10 minutes; stopping it`);
      void e.driver.stall();
    });
    return session;
  }

  /** The OK for an agent `#admit` doesn't let through (no admitted sandbox, or a version outside the tested ones):
   *  asked once per backend, version and computer, as a change card. Tests may skip it. */
  async #requireOk(e: Entry, program: { version: string; path: string; sha256: string }, reason: string, sandboxed: boolean): Promise<void> {
    if (this.#o.startUnsandboxedForTests === true) return;
    const { version } = program;
    const key = { backend: e.backend.id, computer: e.computer, ...program };
    if (this.#oks.has(key)) return;
    const signal = e.driver.currentSignal();
    const decision = await this.#o.approvals.request({
      kind: "change",
      change: "agent-unsandboxed",
      session: e.id,
      ...(e.bot === undefined ? {} : { bot: e.bot }),
      origin: e.driver.currentOrigin() ?? "agent",
      computers: [e.computer],
      effect: "other",
      fields: {
        title: { type: "text", text: sandboxed ? "Start an agent Clover hasn't tested?" : "Start an agent without a sandbox?" },
        what: { type: "text", text: sandboxed
          ? "This version of the agent is outside the ones Clover was tested with, so its sandbox may not hold. While it runs, it could read Clover's logins and approve its own cards."
          : "This agent has no sandbox Clover can count on here. While it runs, it could read Clover's logins and approve its own cards." },
        computer: { type: "text", text: e.computer },
        source: { type: "rows", rows: [
          { label: "Agent", value: sealedText(e.backend.id, 4000) },
          { label: "Version", value: sealedText(version, 4000) },
          { label: "Program", value: sealedText(program.path, 4000) },
          { label: "Started by", value: e.bot === undefined ? "You" : sealedText(e.bot, 4000) },
          { label: "Folder", value: sealedText(e.root, 4000) },
        ] },
        detail: { type: "rows", rows: [{ label: "Why", value: sealedText(reason, 4000) }] },
      },
    }, signal ? { signal } : {});
    if (!decision.allowed) {
      throw new ContractError("refused", `${e.backend.id} wasn't started: ${reason}, and the OK to run it that way was ${decision.by === "expired" ? "not given in time" : decision.by === "card" ? "refused" : "withdrawn"}`);
    }
    this.#oks.grant(key, { ...(decision.cardId === undefined ? {} : { cardId: decision.cardId }), at: this.#o.clock.now() });
  }

  async #permission(e: Entry, raw: AgentPermissionAsk): Promise<AgentPermissionAnswer> {
    const origin = e.driver.currentOrigin() ?? "agent";
    const signal = e.driver.currentSignal();
    // Paused: the agent waits here, its call unanswered, until the switch is back (a withdrawn turn cancels it).
    try {
      await this.#hold(e);
    } catch {
      return { outcome: "cancelled" };
    }
    // The token never reaches a card, and the fence sees each path as it really is (reviews 8 and 9).
    const resolved = agentPaths(raw.paths, e.rootPath);
    if (resolved.over) {
      // More paths than Clover checks: refused without a card, never let through unchecked (check 2's minor 1).
      e.transcript.call({ ts: this.#o.clock.now(), type: "permission", toolCallId: raw.toolCallId, toolKind: raw.toolKind, allowed: false, by: "too-many-paths", paths: raw.paths.length });
      const reject = raw.options.find((o) => o.kind === "reject_once");
      return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
    }
    // Anything in the Clover home (a bot's memory, its conversations, the runtime's state), as written or through a link:
    // refused without a card, at every level (the owner's decision, #208's check 2).
    if (resolved.paths.some((p) => homeReach(this.#o.home, p, e.rootPath) === "inside")) {
      e.transcript.call({ ts: this.#o.clock.now(), type: "permission", toolCallId: raw.toolCallId, toolKind: raw.toolKind, allowed: false, by: "clover-home" });
      const reject = raw.options.find((o) => o.kind === "reject_once");
      return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
    }
    // Every path goes to the broker; the card lists the fenced ones first.
    const fenced = resolved.paths.filter((p) => this.#o.fence.touches([p]) !== null);
    const paths = fenced.length === 0 ? resolved.paths : [...fenced, ...resolved.paths.filter((p) => !fenced.includes(p))];
    const ask: AgentPermissionAsk = { ...e.transcript.redacted(raw), options: raw.options, paths };
    const req: ApprovalRequest = {
      kind: "agent-permission",
      session: e.id,
      ...(e.bot === undefined ? {} : { bot: e.bot }),
      origin,
      computers: [e.computer],
      ...(e.level === undefined ? {} : { level: e.level }),
      effect: effectOf(ask.toolKind),
      paths: ask.paths,
      ...(ruleKeyOf(e.backend.id, ask) === undefined ? {} : { ruleKey: ruleKeyOf(e.backend.id, ask)! }),
      fields: cardFields(e, ask),
      agent: {
        backend: e.backend.id,
        toolCallId: ask.toolCallId,
        toolKind: ask.toolKind,
        title: ask.title,
        ...(ask.rawInput === undefined ? {} : { rawInput: ask.rawInput }),
        ...(ask.mcp === undefined ? {} : { mcp: ask.mcp }),
        bridge: { server: e.serverName, tools: e.bridgeTools },
        options: ask.options,
      },
    };
    const decision = await this.#o.approvals.request(req, signal ? { signal } : {});
    e.transcript.call({
      ts: this.#o.clock.now(), type: "permission", toolCallId: ask.toolCallId, toolKind: ask.toolKind,
      allowed: decision.allowed, by: decision.by, ...(decision.cardId ? { cardId: decision.cardId } : {}), ...(decision.remembered ? { remembered: true } : {}),
    });
    return acpOutcomeFor(decision, ask.options);
  }

  // ---------------------------------------------------------------------------------------------
  // The bot's tools
  // ---------------------------------------------------------------------------------------------

  /** `TaskStop`: a bot stops one of its own agents (the user may stop any). */
  async stop(sessionId: string, by: { bot?: string } = {}): Promise<void> {
    const view = this.#o.host.get(sessionId);
    if (!view || (view.kind !== "agent" && view.kind !== "coding")) throw new ContractError("not_found", `no agent ${sessionId}`);
    if (by.bot !== undefined && view.bot !== by.bot) throw new ContractError("refused", "a bot may stop only its own agents");
    await this.#o.host.stop(sessionId, "stopped");
  }

  /** The background agents, as lane D's `ListAgents` lists them (in place of the host's own `agent` rows). The user's
   *  coding sessions stay the host's rows. Views carry no content. */
  list(): SessionView[] {
    return this.#o.host.list().filter((v) => v.kind === "agent");
  }

  /** Reattaches every agent and coding session a restart left dormant (lane D's `reattach` hook). */
  reattachAll(views: readonly SessionView[]): void {
    for (const v of views) {
      try {
        this.reattach(v);
      } catch (err) {
        this.#o.log?.(`agents: reattaching ${v.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Lane K's side of lane D's hooks (#176): `agents` for `botToolDefs`' `ListAgents`, `setAgentModel` for
   *  `sessionsMethods`' `session.setModel`, and `reattach` for `BotService`'s dormant agent sessions. */
  sessionHooks(): AgentSessionHooks {
    return {
      agents: { list: () => this.list() },
      setAgentModel: (id, model, effort) => this.setModel(id, model, effort),
      reattach: (views) => this.reattachAll(views),
    };
  }

  /** `session.setModel` on an agent or coding session (item 90's model picker). */
  async setModel(sessionId: string, model: string, effort?: string): Promise<void> {
    const e = this.#entries.get(sessionId);
    if (!e) throw new ContractError("not_found", `no agent ${sessionId} on this computer`);
    await e.driver.setModel(model, effort);
    e.record = { ...e.record, model, ...(effort === undefined ? {} : { effort }) };
    e.transcript.writeRecord(e.record);
  }

  /** The daemon is closing: every agent's process ends and its token goes, and the daemon's records stay, so the
   *  next daemon reattaches the sessions the host restores. */
  async close(): Promise<void> {
    this.#unpause?.();
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(async (e) => {
      e.gone.abort();
      e.unwatch?.();
      this.#o.tokens.revoke(e.id);
      this.#o.approvals.cancelSession(e.id);
      await e.driver.detach();
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // The bridge
  // ---------------------------------------------------------------------------------------------

  /** The bridge's methods, for the endpoint. */
  bridgeHandlers(): BridgeHandlers {
    const source = this.#o.pluginTools ?? NO_PLUGIN_TOOLS;
    return {
      sessionInfo: (id) => {
        const e = this.#entries.get(id);
        return e ? { ...(e.bot === undefined ? {} : { bot: e.bot }) } : undefined;
      },
      tools: async (id) => {
        const e = this.#entries.get(id);
        const plugin = await source.tools(id).catch(() => []);
        const own = await source.instructions?.(id).catch(() => "");
        const essentials = bridgeInstructions({ ...(e?.bot === undefined ? {} : { bot: e.bot }), serverName: e?.serverName ?? BRIDGE_SERVER_PREFIX });
        return { tools: [...bridgeOwnTools(e?.bot), ...plugin], instructions: own ? `${essentials}\n\n${own}` : essentials };
      },
      call: async (id, c) => {
        let e: Entry;
        try {
          e = await this.#holdForBridge(id);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Not run: ${why}.` }], isError: true };
        }
        const signal = e.driver.currentSignal();
        return source.call(id, c, {
          computer: e.computer, origin: e.driver.currentOrigin() ?? "agent",
          ...(e.bot === undefined ? {} : { bot: e.bot }), ...(e.level === undefined ? {} : { level: e.level }), ...(signal ? { signal } : {}),
        });
      },
      sendMessage: async (id, m) => {
        await this.#holdForBridge(id);
        return this.agentMessage(id, m.text, m.to);
      },
      glossary: (id, q) => (this.#o.glossary ? this.#o.glossary(id, q) : Promise.resolve({ results: [], loaded: [] })),
    };
  }

  /** An agent's `SendMessage` (§9.3): it folds into its bot's conversation like any bot message. */
  async agentMessage(sessionId: string, text: string, to?: string): Promise<void> {
    const e = this.#entries.get(sessionId);
    if (!e) throw new ContractError("not_found", `no agent ${sessionId}`);
    const target = to ?? e.parent;
    if (!target) throw new ContractError("refused", "this session has no bot to message");
    if (target === sessionId) throw new ContractError("refused", "that is this agent's own session; SendMessage reaches another one");
    const view = this.#o.host.get(target);
    if (!view || view.bot === undefined || view.bot !== e.bot) throw new ContractError("refused", "an agent may message only its own bot's sessions");
    await this.#o.host.deliver(target, { from: "agent", agent: sessionId, text });
  }
}

const EFFECTS: Record<string, ActionEffect> = {
  read: "read", edit: "edit", delete: "delete", move: "move", search: "search", execute: "execute", think: "think", fetch: "fetch",
};

/** ACP's tool kind as the level table's effect; anything else is `other` (the reviewer judges it at ask-risky). */
export function effectOf(toolKind: string): ActionEffect {
  return EFFECTS[toolKind] ?? "other";
}

/** The key a card's "always" saves as Clover's own rule (S5 edit 5): a command exactly, or an MCP tool, each under the
 *  agent's backend, so an agent's rule never covers a bot's own tool of the same name, or the reverse (review 4), and
 *  each written so no two calls share a key (check 2's minor 2). */
export function ruleKeyOf(backend: string, ask: AgentPermissionAsk): string | undefined {
  // The server and tool as a JSON pair: `mcp__a__b__c` could be server `a__b` and tool `c`, or `a` and `b__c`.
  if (ask.mcp) return `Agent(${backend}):mcp(${JSON.stringify([ask.mcp.server, ask.mcp.tool])})`;
  const command = (ask.rawInput as { command?: unknown } | undefined)?.command;
  if (ask.toolKind === "execute" && typeof command === "string" && command.length > 0 && command.length <= 2000) return `Agent(${backend}):Bash(${command})`;
  return undefined;
}

const TITLES: Record<ActionEffect, string> = {
  read: "An agent wants to read files", search: "An agent wants to search files", think: "An agent wants to think",
  fetch: "An agent wants to fetch from the web", edit: "An agent wants to edit files", move: "An agent wants to move files",
  delete: "An agent wants to delete files", execute: "An agent wants to run a command", screen: "An agent wants to control the screen",
  purchase: "An agent wants to buy something", other: "An agent wants to use a tool",
};

function sealedText(s: string, max: number): string {
  const w = s.toWellFormed();
  return w.length > max ? w.slice(0, max) : w;
}

/** The card's sealed fields: headings from this table, the agent's own words only as code or row values. */
function cardFields(e: Entry, ask: AgentPermissionAsk): ApprovalRequest["fields"] {
  const effect = effectOf(ask.toolKind);
  const raw = ask.rawInput as { command?: unknown } | undefined;
  const code = typeof raw?.command === "string" ? raw.command : ask.rawInput === undefined ? ask.title : JSON.stringify(ask.rawInput, null, 2);
  const fields: Partial<Record<string, SealedValue>> = {
    title: { type: "text", text: TITLES[effect] },
    what: { type: "text", text: "Allow it this once?" },
    command: { type: "code", code: sealedText(code, MAX_CARD_CODE) },
    computer: { type: "text", text: e.computer },
    source: { type: "rows", rows: [
      { label: "Agent", value: sealedText(e.backend.id, 4000) },
      { label: "Started by", value: e.bot === undefined ? "You" : sealedText(e.bot, 4000) },
      { label: "Folder", value: sealedText(e.root, 4000) },
    ] },
    detail: { type: "rows", rows: [{ label: "The agent's title", value: sealedText(ask.title, 4000) }] },
  };
  if (ask.paths.length > 0) {
    const shown = ask.paths.slice(0, 200).map((p) => sealedText(p, 4000));
    if (ask.paths.length > shown.length) shown.push(`… and ${ask.paths.length - shown.length} more`);
    fields["paths"] = { type: "list", items: shown };
  }
  return fields as ApprovalRequest["fields"];
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** What a session input says to the agent: a message from its bot is its next prompt as written (§9.3). */
export async function promptOf(input: TurnInput): Promise<{ text: string; images?: { mimeType: string; data: string }[] }> {
  switch (input.from) {
    case "user": {
      const images = (input.images ?? []).flatMap((img) => {
        const mimeType = IMAGE_TYPES[extname(img.path).toLowerCase()];
        if (!mimeType) return [];
        try {
          return [{ mimeType, data: readFileSync(img.path).toString("base64") }];
        } catch {
          return [];
        }
      });
      const files = (input.files ?? []).map((f) => `[File #${f.n}: ${f.path}]`).join("\n");
      return { text: files ? `${input.text}\n\n${files}` : input.text, ...(images.length ? { images } : {}) };
    }
    case "bot":
      return { text: input.text };
    case "agent":
      return { text: `Message from agent ${input.agent}:\n\n${input.text}` };
    case "task-notification":
      return { text: `Agent ${input.agent} (${input.backend}) finished: ${input.stopReason}. Transcript: ${input.transcript}\n\n${input.text}` };
    case "routine":
      return { text: `From the routine "${input.name}":\n\n${input.text}` };
    case "plugin":
      return { text: `Message from the plugin ${input.pluginId}:\n\n${input.text}` };
    case "note":
      return { text: `[${input.label}] ${input.text}` };
  }
}
