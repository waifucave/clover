// The agent manager: what the `Agent`, `TaskStop` and `ListAgents` tools, the bridge and the `agent.*` methods do
// (spec §9.3, plan §4 K-M1). It owns no session state of its own beyond each agent's wiring; the session host keeps
// the sessions (a background agent is a session like any other), and its task notifications.
//
// `start` (the `Agent` tool, and `agent.start` for a coding session the user drives):
// 1. Local placement only in M1: the computer is this one, and the root folder must be on it. Another computer and
//    vendor clouds come with K-M3.
// 2. The root is a folder-tree path, resolved to a real path here; the fence refuses a root that holds the Clover home
//    or a development folder (`checkAgentRoot`, §9.3).
// 3. A new bridge token, the transcript folder, and a session opened in the host with an `AgentDriver`. The task is
//    delivered as the session's first input, so `start` returns at once and the agent starts in its first turn.
// 4. The agent's permission requests go to the ApprovalBroker (level, then card), answered `allow_once` or
//    `reject_once`; a request naming the session's bridge server and one of the bridge's own tools exactly is
//    answered at once (S5 edit 7), and one touching a fenced path is always a card (the broker's rules 2 and 3).
//
// The bridge's methods land here too: `SendMessage` from an agent folds into its bot's conversation (§9.3), and only
// into a session of the same bot.
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
import type { AgentWire } from "./backend";
import { BridgeTokens } from "./bridge/tokens";
import type { BridgeHandlers } from "./bridge/endpoint";
import { BRIDGE_ENV } from "./bridge/server";
import { BRIDGE_OWN_TOOLS, NO_PLUGIN_TOOLS, bridgeInstructions, type BridgeToolSource } from "./bridge/tools";
import { AgentDriver } from "./driver";
import { MemoryAgentOks, type AgentOks } from "./sandbox/oks";
import { NO_PARTS, type PluginParts, type PluginPartsSource } from "./placement";
import { AgentTranscript, type AgentRecordFile, transcriptPaths } from "./transcript";
import type { StallWatchdog } from "./watchdog";

export interface AgentManagerOptions {
  /** The Clover home: transcripts go under `<home>/bots/<bot>/agents/`. */
  home: string;
  /** This computer's name in the folder tree. */
  computer: string;
  host: SessionHost;
  approvals: ApprovalBroker;
  tree: Pick<Tree, "resolve">;
  fence: Pick<Fence, "checkAgentRoot" | "policy">;
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
  log?: (line: string) => void;
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
  bridgeTools: string[];
  unwatch?: () => void;
  record: AgentRecordFile;
  parts?: PluginParts;
}

export const BRIDGE_SERVER_NAME = "clover";
const MAX_CARD_CODE = 60_000;

export class AgentManager {
  readonly #o: AgentManagerOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #serverName: string;
  readonly #oks: AgentOks;

  constructor(opts: AgentManagerOptions) {
    this.#o = opts;
    this.#serverName = opts.bridge.serverName ?? BRIDGE_SERVER_NAME;
    this.#oks = opts.oks ?? new MemoryAgentOks();
  }

  /** A session's sandbox setup folder, inside the fenced run folder. */
  setupDir(sessionId: string): string {
    return join(this.#o.home, "run", "agents", sessionId);
  }

  /** The hooks an ACP backend takes for a session: its transcript, and the token's binding to the agent's pid. */
  wire(sessionId: string): AgentWire {
    const e = this.#entries.get(sessionId);
    if (!e) return {};
    return {
      tap: (dir, msg, replay) => e.transcript.wire(dir, msg, replay, this.#o.clock.now()),
      stderr: (chunk) => e.transcript.stderr(chunk),
      launched: (pid) => this.#o.tokens.bind(sessionId, pid),
      // A leaked copy of the token is useless once the agent is gone (S5 edit 4).
      exited: () => this.#o.tokens.revoke(sessionId),
      setupDir: this.setupDir(sessionId),
      ...(e.parts ? { parts: e.parts } : {}),
    };
  }

  async start(req: AgentRequest): Promise<{ sessionId: string; transcript: string }> {
    const backend = this.#o.backends().find((b) => b.id === req.backend);
    if (!backend) throw new ContractError("not_installed", `no agent backend named ${req.backend}`);
    if (backend.quirks.placement !== "local") throw new ContractError("refused", `${req.backend} runs in its vendor's cloud, which comes with K-M3`);
    const computer = req.computer ?? this.#o.computer;
    if (computer !== this.#o.computer) {
      throw new ContractError("refused", `placing an agent on ${computer} comes with K-M3; for now an agent runs on ${this.#o.computer}`);
    }
    const loc = this.#o.tree.resolve(req.root);
    if (loc.area !== "home") throw new ContractError("refused", "an agent's root folder is a folder in a computer's home (home/<Computer>/…)");
    if (loc.computer !== this.#o.computer) {
      throw new ContractError("refused", `${req.root} is on ${loc.computer}; an agent runs on the computer that holds its root, which comes with K-M3`);
    }
    const verdict = this.#o.fence.checkAgentRoot(loc.path);
    if (!verdict.allowed) throw new ContractError("fenced", `an agent's root may not hold Clover's own folders (${verdict.reason})`, { path: verdict.path });

    const id = `agent_${randomBytes(9).toString("base64url")}`;
    const bot = req.caller.kind === "bot" ? req.caller.bot : undefined;
    const parent = req.caller.kind === "bot" ? req.caller.session : undefined;
    const transcript = new AgentTranscript(this.#o.home, id, bot);
    const record: AgentRecordFile = {
      v: 1, sessionId: id, backend: backend.id, computer, root: req.root, rootPath: loc.path, startedAt: this.#o.clock.now(),
      ...(bot === undefined ? {} : { bot }), ...(parent === undefined ? {} : { parent }),
      ...(req.model === undefined ? {} : { model: req.model }), ...(req.effort === undefined ? {} : { effort: req.effort }),
      ...(req.caller.kind === "bot" && req.caller.level !== undefined ? { level: req.caller.level } : {}),
    };
    transcript.writeRecord(record);
    const entry = this.#entry(id, backend, transcript, record, req.caller.kind === "bot" ? req.caller.level : undefined);
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

  /** Reattaches a background agent after a daemon restart: the host restored the session dormant, and the agent
   *  resumes in its next turn, with an honest `resume` or a `load` whose replay is dropped, and a new token. */
  reattach(view: SessionView): boolean {
    if ((view.kind !== "agent" && view.kind !== "coding") || this.#entries.has(view.id)) return false;
    const dir = transcriptPaths(this.#o.home, view.id, view.bot).dir;
    const record = AgentTranscript.readRecord(dir);
    if (!record?.agentSessionId) return false;
    const backend = this.#o.backends().find((b) => b.id === record.backend);
    if (!backend) return false;
    const transcript = new AgentTranscript(this.#o.home, view.id, view.bot);
    const entry = this.#entry(view.id, backend, transcript, record, record.level as Level | undefined, { agentSessionId: record.agentSessionId });
    this.#o.host.open({
      id: view.id, kind: view.kind, computer: view.computer, backend: backend.id, root: record.root,
      ...(record.bot === undefined ? {} : { bot: record.bot }), ...(record.parent === undefined ? {} : { parent: record.parent }),
      ...(view.title === undefined ? {} : { title: view.title }),
      ...(record.model === undefined ? {} : { model: record.model }), ...(record.effort === undefined ? {} : { effort: record.effort }),
    }, entry.driver);
    return true;
  }

  #entry(id: string, backend: AgentBackend, transcript: AgentTranscript, record: AgentRecordFile, level?: Level, reattach?: { agentSessionId: string }): Entry {
    const token = this.#o.tokens.mint(id);
    transcript.redact(token);
    const entry = {
      id, backend, transcript, record, token, computer: record.computer, root: record.root, rootPath: record.rootPath, bridgeTools: BRIDGE_OWN_TOOLS.map((t) => t.name),
      ...(record.bot === undefined ? {} : { bot: record.bot }), ...(record.parent === undefined ? {} : { parent: record.parent }),
      ...(record.model === undefined ? {} : { model: record.model }), ...(record.effort === undefined ? {} : { effort: record.effort }),
      ...(level === undefined ? {} : { level }),
    } as Entry;
    entry.driver = new AgentDriver({
      start: () => this.#startAgent(entry, reattach),
      promptOf: (input) => promptOf(input),
      ended: () => {
        this.#o.tokens.revoke(id);
        entry.unwatch?.();
        rmSync(this.setupDir(id), { recursive: true, force: true });
        if (this.#entries.get(id) === entry) this.#entries.delete(id);
      },
    });
    this.#entries.set(id, entry);
    return entry;
  }

  async #startAgent(e: Entry, reattach?: { agentSessionId: string }): Promise<AgentSession> {
    // An agent whose own sandbox Clover can't count on starts only after the user's OK (§9.3).
    const d = await e.backend.detect();
    if (d.installed && d.identityOk && !d.sandboxed) await this.#requireOk(e, d.version ?? "unknown", d.reason);
    e.parts = (await this.#o.pluginParts?.parts(e.id).catch(() => NO_PARTS)) ?? NO_PARTS;
    const tools = await (this.#o.pluginTools ?? NO_PLUGIN_TOOLS).tools(e.id).catch(() => []);
    e.bridgeTools = [...BRIDGE_OWN_TOOLS.map((t) => t.name), ...tools.map((t) => t.name)];
    const session = await e.backend.start({
      sessionId: e.id,
      root: e.rootPath,
      ...(e.model === undefined ? {} : { model: e.model }),
      ...(e.effort === undefined ? {} : { effort: e.effort }),
      instructions: bridgeInstructions({ ...(e.bot === undefined ? {} : { bot: e.bot }), serverName: this.#serverName }),
      bridge: {
        name: this.#serverName,
        command: this.#o.bridge.command,
        args: [...this.#o.bridge.args],
        env: { [BRIDGE_ENV.token]: e.token, [BRIDGE_ENV.session]: e.id, [BRIDGE_ENV.socket]: this.#o.bridge.socketPath },
        tools: e.bridgeTools,
      },
      fence: this.#o.fence.policy(),
      ...(reattach ? { reattach } : {}),
    });
    const pid = (session as { pid?: number }).pid;
    if (pid) this.#o.tokens.bind(e.id, pid);
    e.record = { ...e.record, agentSessionId: session.agentSessionId };
    e.transcript.writeRecord(e.record);
    session.onPermission((ask) => this.#permission(e, ask));
    const calls = session as { openCalls?: () => { id: string; kind: string; startedAtWall: number }[] };
    e.unwatch = this.#o.watchdog.watch({
      pid: pid ?? 0,
      lastProgressAt: () => session.lastProgressAt(),
      busy: () => e.driver.busy(),
      runningCommands: () => (calls.openCalls?.() ?? []).filter((c) => c.kind === "execute"),
    }, () => {
      this.#o.log?.(`agents: ${e.id} made no progress for 10 minutes; stopping it`);
      void e.driver.stall();
    });
    return session;
  }

  /** The OK for an agent with no admitted sandbox: asked once per backend, version and computer, as a change card. */
  async #requireOk(e: Entry, version: string, reason: string | undefined): Promise<void> {
    const key = { backend: e.backend.id, version, computer: e.computer };
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
        title: { type: "text", text: "Start an agent without a sandbox?" },
        what: { type: "text", text: "This agent has no sandbox Clover can count on here. While it runs, it could read Clover's logins and approve its own cards." },
        computer: { type: "text", text: e.computer },
        source: { type: "rows", rows: [
          { label: "Agent", value: sealedText(e.backend.id, 4000) },
          { label: "Version", value: sealedText(version, 4000) },
          { label: "Started by", value: e.bot === undefined ? "You" : sealedText(e.bot, 4000) },
          { label: "Folder", value: sealedText(e.root, 4000) },
        ] },
        ...(reason ? { detail: { type: "rows" as const, rows: [{ label: "Why", value: sealedText(reason, 4000) }] } } : {}),
      },
    }, signal ? { signal } : {});
    if (!decision.allowed) {
      throw new ContractError("refused", `${e.backend.id} wasn't started: it has no sandbox here, and the OK to run it without one was ${decision.by === "expired" ? "not given in time" : decision.by === "card" ? "refused" : "withdrawn"}`);
    }
    this.#oks.grant(key, { ...(decision.cardId === undefined ? {} : { cardId: decision.cardId }), at: this.#o.clock.now() });
  }

  async #permission(e: Entry, ask: AgentPermissionAsk): Promise<AgentPermissionAnswer> {
    const origin = e.driver.currentOrigin() ?? "agent";
    const signal = e.driver.currentSignal();
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
        bridge: { server: this.#serverName, tools: e.bridgeTools },
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

  /** `ListAgents`: every session, with the caller's own agents first. Views carry no content. */
  list(by: { bot?: string } = {}): SessionView[] {
    const all = this.#o.host.list();
    const mine = (v: SessionView) => (by.bot !== undefined && v.bot === by.bot && v.kind === "agent" ? 0 : 1);
    return [...all].sort((a, b) => mine(a) - mine(b) || b.updatedAt - a.updatedAt);
  }

  /** A bot's message to one of its running agents: its next prompt, queued while a turn runs. */
  async send(sessionId: string, from: { bot: string; session: string }, text: string): Promise<void> {
    const view = this.#o.host.get(sessionId);
    if (!view || view.kind !== "agent") throw new ContractError("not_found", `no agent ${sessionId}`);
    if (view.bot !== from.bot) throw new ContractError("refused", "a bot may message only its own agents");
    await this.#o.host.deliver(sessionId, { from: "bot", bot: from.bot, session: from.session, text });
  }

  /** `session.setModel` on an agent or coding session (item 90's model picker). */
  async setModel(sessionId: string, model: string, effort?: string): Promise<void> {
    const e = this.#entries.get(sessionId);
    if (!e) throw new ContractError("not_found", `no agent ${sessionId} on this computer`);
    await e.driver.setModel(model, effort);
    e.record = { ...e.record, model, ...(effort === undefined ? {} : { effort }) };
    e.transcript.writeRecord(e.record);
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
        const essentials = bridgeInstructions({ ...(e?.bot === undefined ? {} : { bot: e.bot }), serverName: this.#serverName });
        return { tools: [...BRIDGE_OWN_TOOLS, ...plugin], instructions: own ? `${essentials}\n\n${own}` : essentials };
      },
      call: (id, c) => source.call(id, c),
      sendMessage: (id, m) => this.agentMessage(id, m.text, m.to),
      glossary: (id, q) => (this.#o.glossary ? this.#o.glossary(id, q) : Promise.resolve({ results: [], loaded: [] })),
    };
  }

  /** An agent's `SendMessage` (§9.3): it folds into its bot's conversation like any bot message. */
  async agentMessage(sessionId: string, text: string, to?: string): Promise<void> {
    const e = this.#entries.get(sessionId);
    if (!e) throw new ContractError("not_found", `no agent ${sessionId}`);
    const target = to ?? e.parent;
    if (!target) throw new ContractError("refused", "this session has no bot to message");
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

/** The key a card's "always" saves as Clover's own rule (S5 edit 5): a command exactly, or an MCP tool. */
export function ruleKeyOf(backend: string, ask: AgentPermissionAsk): string | undefined {
  if (ask.mcp) return `mcp__${ask.mcp.server}__${ask.mcp.tool}`;
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
  if (ask.paths.length > 0) fields["paths"] = { type: "list", items: ask.paths.slice(0, 200).map((p) => sealedText(p, 4000)) };
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
