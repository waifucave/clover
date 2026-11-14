// How Clover's plugins reach an agent session (spec §9.3 "How plugins reach an ACP agent", [D]): a coding session the
// user started, or a bot's delegation, on any backend.
//
// * **Tools.** The bridge serves the plugins' MCP tools in the session's scope: a plugin whose `scope` covers the
//   session's kind (`agents` or `both`) and whose `onlyBackends` names its backend (`clover` for Clover's own runtime),
//   listed by this computer's PluginMcp as a bot's are. Each is named `<server>__<tool>` on the bridge (so two servers'
//   tools never share a name); one past `BRIDGE_TOOL_NAME_MAX` takes a short form (`bridgeShortName`) whose
//   description starts with its plugin's and tool's real names, and a name that would be ambiguous or has characters
//   MCP clients refuse is left out. A call is resolved against
//   the live listing at the moment it is made, so a plugin turned off, stopped, refused or not for this computer since
//   the session started answers "no tool named …". It meets the plugins' `tool.before` and `tool.after` hooks under
//   its own name (`mcp__<server>__<tool>`, as a bot's call), then it is judged exactly as the same call would be in the session that owns it
//   (`judge`, the daemon's bot approval check: the user's coding session by its own level and saved rules, a bot's
//   agent by that bot's level and rules, never more than its parent), and runs where its server runs (J's router), as
//   the agent's own session.
// * **Skills and agent definitions.** The parts source gives a session the plugins' skill folders and agent files in the
//   same scope (`partsServe`), for the backends that read their own folders (Claude Code's session
//   plugin, claude-code/placement.ts); `Glossary` on the bridge serves them to every agent. Command hooks are never
//   given: an outside agent can't run one under its plugin's fence.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { CanUseTool } from "@waifucave/clover-agent-sdk";
import type { Caller, TurnOrigin } from "@waifucave/clover-protocol";
import type { BotSessionContext } from "../bots/service";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { glossaryIndex, parseFrontmatter, searchGlossary, SKILL_BODY_MAX_CHARS, type GlossaryItem } from "../runtime-sdk/turn-loop/glossary";
import type { HookSession, HookSource } from "../runtime-sdk/turn-loop/hooks";
import { partsServe } from "../runtime-sdk/turn-loop/only-backends";
import type { BotMcpServer, McpRunner } from "../runtime-sdk/turn-loop/servers";
import type { AgentSessionFacts, BridgeCallContext, BridgeToolDef, BridgeToolSource } from "./bridge/tools";
import { NO_PARTS, type PluginParts, type PluginPartsSource } from "./placement";

/** The longest bridge tool name: the agent sees `mcp__<bridge server>__<name>`, many clients refuse a full name past
 *  64 characters, and the bridge server's name is `clover_` and 16 hex digits (`BRIDGE_SERVER_PREFIX`): 64 − 30. */
export const BRIDGE_TOOL_NAME_MAX = 34;
/** The largest agent file placed (a definition's words are cut at 20,000 characters anyway). */
const AGENT_FILE_MAX = 256 * 1024;
/** The characters MCP clients take in a tool name. */
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/** What judging a plugin tool's call gives: run it with this input, or the refusal the agent is told. */
export type AgentToolVerdict = { allowed: true; input: Record<string, unknown> } | { allowed: false; message: string };

/** A plugin tool's call judged as the same call in the session that owns it (the daemon's bot approval check): `served`
 *  is the tool's name as a bot sees it (`mcp__<server>__<tool>`). */
export type AgentToolJudge = (session: AgentSessionFacts, ctx: BridgeCallContext, call: { served: string; input: Record<string, unknown>; callId: string }) => Promise<AgentToolVerdict>;

export interface AgentPluginReachDeps {
  /** This computer's PluginMcp: the servers a session of `kind` on `backend`, delegated by `bot` (none: the user's own),
   *  gets (scope, `onlyBackends`, placement). */
  servers(kind: "agent" | "coding", backend: string, bot?: string): readonly BotMcpServer[];
  /** J's router: runs a call where its server is. */
  runner: McpRunner;
  judge: AgentToolJudge;
  /** The plugins' hooks, read at each call (the bots' `agentHookSource`). Absent: none. */
  hooks?: HookSource;
  registry: Pick<PluginRegistry, "entries" | "get" | "list" | "points">;
  /** Tells `fn` when the plugins changed (`registry.watch`), for the parts placed in running sessions. */
  watch?(fn: () => void): () => void;
  /** Where a tool left off the bridge is said (its name shared, or with characters MCP clients refuse), so its author can find out why. */
  log?: (line: string) => void;
}

/** The session's caller: the agent's own session, its bot named. */
export function agentCallerOf(s: AgentSessionFacts): Extract<Caller, { kind: "session" }> {
  return { kind: "session", sessionId: s.id, sessionKind: s.kind, ...(s.bot === undefined ? {} : { bot: s.bot }) } as Extract<Caller, { kind: "session" }>;
}

/** The session the bots' approval check judges an agent's plugin-tool call in: the agent's own session (so its card
 *  names it, with the agent and who started it: `agentAsking`), its bot (whose level and saved rules answer, never more than the bot's), the delegation's level (a
 *  routine's) or its computer's, its working folder for the call's paths, its backend for the tool's routing. A bot's
 *  agent's card offers no "always" (`offersAlways`), as its own permission cards don't. */
export function agentCheckContext(s: AgentSessionFacts, level: BridgeCallContext["level"]): BotSessionContext {
  return {
    botId: s.bot, sessionId: s.id, kind: s.kind, computer: s.computer, ...(level === undefined ? {} : { level }),
    paths: { scratch: s.root, root: s.root }, caller: agentCallerOf(s), backend: s.backend, offersAlways: s.bot === undefined,
    // Which agent asks and who started it, on the card (the bots' approval check): a bot's agent asks as itself.
    agentAsking: { backend: s.backend, ...(s.bot === undefined ? {} : { bot: s.bot }), folder: s.root },
  } as unknown as BotSessionContext;
}

/** The judge over the bots' approval check (`botApprovalCheck`, the daemon's one): the call as `agentCheckContext`
 *  makes its session, at the turn's origin. Without a check (no broker here) every call is refused. */
export function agentToolJudge(check: ((ctx: BotSessionContext, origin: () => TurnOrigin | undefined) => CanUseTool) | undefined): AgentToolJudge {
  return async (session, call, c) => {
    if (check === undefined) return { allowed: false, message: `${c.served} was refused: this computer has no approvals to judge it.` };
    const decide = check(agentCheckContext(session, call.level), () => call.origin);
    const r = await decide(c.served, c.input, { signal: call.signal ?? new AbortController().signal, toolUseID: c.callId } as Parameters<CanUseTool>[2]);
    if (r?.behavior === "allow") return { allowed: true, input: (r.updatedInput ?? c.input) as Record<string, unknown> };
    return { allowed: false, message: r?.behavior === "deny" ? r.message : `${c.served} was refused.` };
  };
}

/** The backend of a context `agentCheckContext` made (undefined for a bot's own session). */
export function agentBackendOf(ctx: object): string | undefined {
  const b = (ctx as { backend?: unknown }).backend;
  return typeof b === "string" ? b : undefined;
}

interface BridgeTool { server: BotMcpServer; tool: BotMcpServer["tools"][number]; name: string; full: string }

/** A bridge name's short form, for `<server>__<tool>` past `BRIDGE_TOOL_NAME_MAX`: the server's name cut so the tool's
 *  own name fits whole (`<server cut>__<tool>`), or with no room for it the tool's name cut, then `_` and `digits` hex
 *  digits of the full name's SHA-256, so two names cut to the same start stay apart. The same full name always gives
 *  the same short form. */
export function bridgeShortName(server: string, tool: string, digits = 6): string {
  const suffix = `_${createHash("sha256").update(`${server}__${tool}`).digest("hex").slice(0, digits)}`;
  const room = BRIDGE_TOOL_NAME_MAX - suffix.length;
  if (tool.length + 3 <= room) return `${server.slice(0, room - tool.length - 2)}__${tool}${suffix}`;
  return `${tool.slice(0, room)}${suffix}`;
}

/** The bridge's names for the servers' tools: `<server>__<tool>`, each once; one past `BRIDGE_TOOL_NAME_MAX` takes its
 *  short form (`bridgeShortName`, more hex digits while it would take a name already given); a full name two tools
 *  would share, or one with characters MCP clients refuse, is left out. */
export function bridgeToolsOf(servers: readonly BotMcpServer[], left?: (name: string, why: string) => void): Map<string, BridgeTool> {
  const byFull = new Map<string, BridgeTool>();
  const twice = new Set<string>();
  for (const server of servers) {
    for (const tool of server.tools) {
      const full = `${server.server}__${tool.name}`;
      if (!TOOL_NAME.test(full)) { left?.(full, "a character MCP clients refuse"); continue; }
      if (byFull.has(full)) twice.add(full);
      else byFull.set(full, { server, tool, name: full, full });
    }
  }
  for (const n of twice) {
    byFull.delete(n);
    left?.(n, "two tools would share the name");
  }
  // The names that fit stay as they are; the long ones take short forms none of those (or each other) has.
  const out = new Map<string, BridgeTool>();
  const long: BridgeTool[] = [];
  for (const t of byFull.values()) {
    if (t.full.length <= BRIDGE_TOOL_NAME_MAX) out.set(t.full, t);
    else long.push(t);
  }
  for (const t of long) {
    let name: string | undefined;
    for (let digits = 6; digits <= 16 && name === undefined; digits += 2) {
      const short = bridgeShortName(t.server.server, t.tool.name, digits);
      if (!out.has(short)) name = short;
    }
    if (name === undefined) { left?.(t.full, "two tools would share the name"); continue; }
    out.set(name, { ...t, name });
  }
  return out;
}

/** A bridge tool's description: its own words and its plugin; a shortened one starts with its plugin's and tool's real
 *  names and says the name it was given in full. */
export function bridgeToolDescription(t: Pick<BridgeTool, "server" | "tool" | "name" | "full">): string {
  const words = t.tool.description ?? t.tool.title ?? t.tool.name;
  if (t.name === t.full) return `${words} (from the plugin ${t.server.plugin})`;
  return `[${t.server.plugin}] ${t.tool.name}: ${words} (the tool ${t.full}, its name shortened to fit)`;
}

const text = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

/** The bridge's plugin tools for one daemon. */
export function agentPluginTools(d: AgentPluginReachDeps): BridgeToolSource {
  const listing = (s: AgentSessionFacts | undefined) => (s === undefined ? new Map<string, BridgeTool>() : bridgeToolsOf(d.servers(s.kind, s.backend, s.bot)));
  return {
    async tools(sessionId, session): Promise<BridgeToolDef[]> {
      const left: string[] = [];
      const tools = session === undefined ? new Map<string, BridgeTool>() : bridgeToolsOf(d.servers(session.kind, session.backend, session.bot), (name, why) => left.push(`${name} (${why})`));
      if (left.length > 0) d.log?.(`${sessionId}: plugin tools left off its bridge: ${left.join(", ")}`);
      return [...tools.values()].map((t) => ({
        name: t.name,
        // A description stands on its own (some agents never show a server's instructions): it names its plugin.
        description: bridgeToolDescription(t),
        inputSchema: t.tool.inputSchema as Record<string, unknown>,
        ...(t.tool.load === "preload" ? { preload: true } : {}),
      }));
    },
    async instructions(_sessionId, session) {
      if (session === undefined) return "";
      const seen = new Set<string>();
      const parts: string[] = [];
      const servers = d.servers(session.kind, session.backend, session.bot);
      const listed = [...bridgeToolsOf(servers).values()];
      for (const s of servers) {
        if (s.instructions === undefined || s.instructions.trim() === "" || seen.has(s.server)) continue;
        seen.add(s.server);
        // A shortened name doesn't start with its server's: named here too.
        const short = listed.filter((t) => t.server.server === s.server && t.name !== t.full).map((t) => t.name);
        parts.push(`Tools named ${s.server}__…${short.length > 0 ? ` and ${short.join(", ")}` : ""} (the plugin ${s.plugin}):\n${s.instructions.trim()}`);
      }
      return parts.join("\n\n");
    },
    async call(_sessionId, c, ctx) {
      const s = ctx.session;
      if (s === undefined) return text(`No tool named ${c.tool} is available to this agent.`);
      // The listing now, not the one the session started with: a plugin turned off, stopped or refused since is gone.
      const found = listing(s).get(c.tool);
      if (found === undefined) return text(`No tool named ${c.tool} is available to this agent.`);
      if (c.input !== undefined && (typeof c.input !== "object" || c.input === null || Array.isArray(c.input))) return text(`${c.tool} was refused: its input must be an object.`);
      const served = `mcp__${found.server.server}__${found.tool.name}`;
      let input = (c.input ?? {}) as Record<string, unknown>;
      const hookSession: HookSession = { id: s.id, kind: s.kind, caller: agentCallerOf(s), ...(s.bot === undefined ? {} : { bot: s.bot }), computer: s.computer, backend: s.backend };
      // The plugins' tool hooks, as a bot's call meets them, under the tool's own name, on every backend (the in-process
      // one leaves its bridge's plugin tools to this; the manager doesn't run them at the permission request either).
      const hooks = d.hooks?.() ?? (d.hooks === undefined ? "none" : undefined);
      if (hooks === undefined) return text(`${c.tool} was refused: Clover's plugin hooks aren't running yet, so plugin tools are refused until they are; try again in a moment.`);
      if (hooks !== "none") {
        const before = await hooks.toolBefore(hookSession, { name: served, callId: c.callId }, input, ctx.signal);
        if (before.deny !== undefined) return text(`${c.tool} was refused by a plugin's hook: ${before.deny}`);
        if (before.input !== null && typeof before.input === "object" && !Array.isArray(before.input)) input = before.input as Record<string, unknown>;
      }
      const verdict = await d.judge(s, ctx, { served, input, callId: c.callId });
      if (!verdict.allowed) return text(verdict.message);
      try {
        const { result } = await d.runner.run(found.server.server, found.tool.name, verdict.input, {
          session: s.id, as: agentCallerOf(s), callId: c.callId, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });
        const out = { content: Array.isArray(result.content) && result.content.length > 0 ? result.content : [{ type: "text", text: "" }], isError: result.isError === true };
        if (hooks === "none") return out;
        const after = await hooks.toolAfter(hookSession, { name: served, callId: c.callId }, verdict.input, out, ctx.signal);
        const a = after as { content?: unknown; isError?: unknown } | undefined;
        return a !== undefined && Array.isArray(a.content) ? { content: a.content, isError: a.isError === true } : out;
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** Whether a plugin's skills and agent definitions reach the session: its `scope` covers the session (`servesScope`:
 *  a bot's delegated agent takes `bots` parts, its own bot's `own-bot` ones) and its `onlyBackends` its backend. A plugin
 *  that isn't running here gives no active entry at all. */
function servesSession(d: Pick<AgentPluginReachDeps, "registry">, s: AgentSessionFacts, pluginId: string): boolean {
  return partsServe(d.registry, pluginId, s);
}

/** `path` inside `folder`, by real paths: a link out of the plugin's folder is never followed. */
function insideReal(folder: string, path: string): string | undefined {
  try {
    const real = realpathSync(path);
    const root = realpathSync(folder);
    const rel = relative(root, real);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The skill folders a `skills` entry names (a glob, as the Glossary reads it): each folder holding a `SKILL.md`. */
function skillDirs(folder: string, pattern: string): string[] {
  try {
    const files = [...new Bun.Glob(pattern).scanSync({ cwd: folder, onlyFiles: true, followSymlinks: false })].filter((p) => /(^|\/)SKILL\.md$/i.test(p)).slice(0, 200);
    return [...new Set(files.map((f) => dirname(join(folder, f))))];
  } catch {
    return [];
  }
}

/** A name for a part, unique per plugin: `<plugin, its "/" as "-">-<name>`. */
const partName = (pluginId: string, name: string) => `${pluginId.replace(/\//g, "-")}-${name}`;

/** The plugins' skills and agent definitions for one session (never their command hooks). */
export function agentPluginParts(d: Pick<AgentPluginReachDeps, "registry" | "watch">): PluginPartsSource {
  return {
    async parts(_sessionId, session): Promise<PluginParts> {
      if (session === undefined) return NO_PARTS;
      const parts: PluginParts = { skills: [], agents: [], hooks: [] };
      for (const c of d.registry.entries("skills")) {
        if (c.state !== "active" || typeof c.value !== "string" || !servesSession(d, session, c.pluginId)) continue;
        const record = d.registry.get(c.pluginId);
        if (record === undefined) continue;
        for (const dir of skillDirs(record.folder, c.value)) {
          const real = insideReal(record.folder, dir);
          if (real === undefined || !statSync(real).isDirectory()) continue;
          parts.skills.push({ name: partName(c.pluginId, dir.split(/[\\/]/).pop() ?? "skill"), pluginId: c.pluginId, dir: real });
        }
      }
      // Agent definitions as Glossary reads them (its `agent` items carry the file's words).
      for (const item of glossaryIndex({ tools: () => [], registry: d.registry, serves: (pluginId) => servesSession(d, session, pluginId) })) {
        if (item.kind !== "agent") continue;
        const [pluginId, id] = [item.name.slice(0, item.name.lastIndexOf(":")), item.name.slice(item.name.lastIndexOf(":") + 1)];
        const markdown = agentMarkdown(d.registry, pluginId, id);
        if (markdown !== undefined) parts.agents.push({ name: partName(pluginId, id), pluginId, markdown });
      }
      return parts;
    },
    ...(d.watch === undefined ? {} : { watch: (fn: () => void) => d.watch!(fn) }),
  };
}

/** An agent definition's file as Claude Code reads one (front matter and instructions), from its plugin's folder. */
function agentMarkdown(registry: Pick<PluginRegistry, "entries" | "get">, pluginId: string, id: string): string | undefined {
  const record = registry.get(pluginId);
  if (record === undefined) return undefined;
  for (const c of registry.entries("agents")) {
    if (c.pluginId !== pluginId || c.state !== "active") continue;
    const file = typeof c.value === "string" ? c.value : (c.value as { id?: string; instructions?: string } | null)?.id === id ? (c.value as { instructions?: string }).instructions : undefined;
    if (file === undefined) continue;
    const real = insideReal(record.folder, join(record.folder, file));
    if (real === undefined) continue;
    let raw: string;
    try {
      raw = statSync(real).size > AGENT_FILE_MAX ? "" : readFileSync(real, "utf8");
    } catch {
      continue;
    }
    if (raw === "") continue;
    if (typeof c.value === "string") {
      const base = file.split("/").pop()!.replace(/\.md$/i, "");
      if ((parseFrontmatter(raw).name ?? base) !== id) continue;
      return raw;
    }
    // An object entry: Claude Code wants a name and a description in the front matter.
    const name = partName(pluginId, id);
    const body = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
    return `---\nname: ${name}\ndescription: ${JSON.stringify(`An agent from the plugin ${pluginId}`)}\n---\n${body}`;
  }
  return undefined;
}

/** `Glossary` on the bridge: search and load the plugins' skills, agent definitions and tools in the session's scope,
 *  the same index a bot's Glossary reads, limited to that scope. */
export function agentGlossary(d: Pick<AgentPluginReachDeps, "registry" | "servers">) {
  return async (_sessionId: string, q: { query?: string | string[]; load?: string | string[] }, session?: AgentSessionFacts): Promise<{ results: unknown[]; loaded: unknown[] }> => {
    if (session === undefined) return { results: [], loaded: [] };
    const tools = [...bridgeToolsOf(d.servers(session.kind, session.backend, session.bot)).values()];
    const items: GlossaryItem[] = glossaryIndex({
      tools: () => tools.map(({ tool, name }) => ({ name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: tool.inputSchema })),
      registry: d.registry,
      serves: (pluginId) => servesSession({ registry: d.registry }, session, pluginId),
      // A plugin's own listing on the bridge: only the tools this session has.
      servers: () => [],
    }).filter((i) => i.kind !== "plugin" && i.kind !== "point");
    const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter((x) => typeof x === "string" && x.trim() !== "");
    const results = list(q.query).slice(0, 20).flatMap((query) => searchGlossary(items, query).map((i) => ({ query, name: i.name, kind: i.kind, description: i.description })));
    const loaded = list(q.load).slice(0, 50).map((name) => {
      const item = items.find((i) => i.name === name) ?? items.find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (item === undefined) return { name, found: false };
      const body = item.body ?? item.description;
      return { name: item.name, kind: item.kind, text: body.length > SKILL_BODY_MAX_CHARS ? `${body.slice(0, SKILL_BODY_MAX_CHARS)}\n[cut at ${SKILL_BODY_MAX_CHARS} characters]` : body };
    });
    return { results, loaded };
  };
}

/** The three for an agents manager made before the deps are (the daemon makes the bot side's approval check with its
 *  drivers): each reads them at each call, and gives nothing while there are none. `watch` is the registry's. */
export function lateAgentPlugins(deps: () => AgentPluginReachDeps | undefined, watch?: (fn: () => void) => () => void): { pluginTools: BridgeToolSource; pluginParts: PluginPartsSource; glossary: ReturnType<typeof agentGlossary> } {
  return {
    pluginTools: {
      tools: async (id, s) => { const d = deps(); return d === undefined ? [] : agentPluginTools(d).tools(id, s); },
      instructions: async (id, s) => { const d = deps(); return d === undefined ? "" : agentPluginTools(d).instructions!(id, s); },
      call: async (id, c, ctx) => {
        const d = deps();
        return d === undefined ? text(`${c.tool} was refused: Clover's plugins aren't running for agents yet; try again in a moment.`) : agentPluginTools(d).call(id, c, ctx);
      },
    },
    pluginParts: {
      parts: async (id, s) => { const d = deps(); return d === undefined ? NO_PARTS : agentPluginParts(d).parts(id, s); },
      ...(watch === undefined ? {} : { watch }),
    },
    glossary: async (id, q, s) => { const d = deps(); return d === undefined ? { results: [], loaded: [] } : agentGlossary(d)(id, q, s); },
  };
}
