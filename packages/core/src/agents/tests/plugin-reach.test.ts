// How plugins reach agents (spec §9.3, checklist row 1.93) over the REAL registry and PluginMcp (a stand-in for the
// plugin host's servers), the bots' real approval check and the agent manager with the scripted ACP agent: the bridge
// lists a plugin's tools in the session's scope and its call is judged as the same call in the session that owns it
// (the user's coding session by its own level and rules, a bot's agent by its bot's, its card naming the agent's
// session); a plugin out of scope, left out by `onlyBackends` or switched off gives nothing. Skills and agent
// definitions are placed in Claude Code's per-session plugin folder and leave it when their plugin goes off; Glossary
// on the bridge serves the same scope. Temp homes, the fake broker, an in-memory secret store; nothing opens a window.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { Listeners } from "../../contracts/common";
import type { McpChannel } from "../../contracts/plugin-host";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { botApprovalCheck } from "../../approvals/bot-check";
import type { BotSessionContext } from "../../bots/service";
import { thisPlatform } from "../../registry/core";
import { openPluginRegistry } from "../../registry/open";
import type { TurnHooks } from "../../runtime-sdk/turn-loop/hooks";
import { PluginMcp, localMcpRunner } from "../../runtime-sdk/turn-loop/plugin-mcp";
import { CLAUDE_PLUGIN_FOLDER, placeInClaudeCode } from "../claude-code/placement";
import { agentGlossary, agentPluginParts, agentPluginTools, agentToolJudge, type AgentPluginReachDeps } from "../plugin-reach";
import type { AgentSessionFacts, BridgeToolSource } from "../bridge/tools";
import type { PluginPartsSource } from "../placement";
import { waitFor, World, type WorldOptions } from "./world";

setDefaultTimeout(60_000);
const ENGINES = { clover: `^${PLUGIN_API_VERSION}` };
const TOOL = "toolbox-tools__toolbox";
/** A platform that isn't this computer's, for a plugin not for this computer. */
const ELSEWHERE = thisPlatform() === "windows-x64" ? "linux-x64" : "windows-x64";
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
let world: World | undefined;
const closers: (() => void)[] = [];
afterEach(async () => {
  await world?.close();
  world = undefined;
  for (const c of closers.splice(0)) c();
});

/** A stand-in for the plugin host's MCP servers: each lists its plugin's one tool (named after the plugin) and echoes
 *  a call. */
const host = {
  async openMcp(plugin: string, server: string): Promise<McpChannel> {
    const out = new Listeners<Record<string, unknown>>();
    let closed = false;
    const reply = (m: Record<string, unknown>) => queueMicrotask(() => { if (!closed) out.emit(m); });
    const tool = plugin.replace(/[^a-z]/g, "");
    return {
      send(m: Record<string, unknown>) {
        if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } } });
        else if (m.method === "tools/list") reply({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: tool, description: `The ${plugin} tool.`, inputSchema: { type: "object" } }] } });
        else if (m.method === "tools/call") reply({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${tool} ran with ${JSON.stringify((m.params as { arguments?: unknown }).arguments ?? {})}` }] } });
      },
      onMessage: (fn: (m: Record<string, unknown>) => void) => out.add(fn),
      close() { closed = true; },
      get closed() { return closed; },
    } as unknown as McpChannel;
  },
};

const plugin = (id: string, extra: Record<string, unknown> = {}) => ({
  manifest: 1, id, name: id, version: "1.0.0", engines: ENGINES, host: { entry: "host/index.js" },
  contributes: { mcpServers: { tools: { type: "host" } } }, ...extra,
});

/** The real registry with `toolbox` (agents), `botsonly` (bots, with a skill), `cconly` (Claude Code only), `cloveronly`
 *  (Clover's own runtime only) and `kit` (agents: a skill and an agent definition), each OK'd; PluginMcp over it; the
 *  judge over the bots' approval check on `broker`. */
async function plugins(broker: FakeApprovalBroker) {
  const home = mkdtempSync(join(tmpdir(), "clover-b-reach-"));
  temps.push(home);
  const files: Record<string, unknown> = {
    "toolbox/clover.json": plugin("toolbox", { scope: "agents" }), "toolbox/host/index.js": "export {};\n",
    "botsonly/clover.json": plugin("botsonly", { scope: "bots", contributes: { mcpServers: { tools: { type: "host" } }, skills: ["skills/*/SKILL.md"] } }), "botsonly/host/index.js": "export {};\n",
    "botsonly/skills/limerick/SKILL.md": "---\nname: limerick\ndescription: Write a limerick.\n---\nFive lines.\n",
    "cconly/clover.json": plugin("cconly", { onlyBackends: ["claude-code"] }), "cconly/host/index.js": "export {};\n",
    "cloveronly/clover.json": plugin("cloveronly", { onlyBackends: ["clover"] }), "cloveronly/host/index.js": "export {};\n",
    "elsewhere/clover.json": plugin("elsewhere", { platforms: [ELSEWHERE] }), "elsewhere/host/index.js": "export {};\n",
    "kit/clover.json": { manifest: 1, id: "kit", name: "Kit", version: "1.0.0", engines: ENGINES, scope: "agents", contributes: { skills: ["skills/*/SKILL.md"], agents: ["agents/review.md"] } },
    "kit/skills/haiku/SKILL.md": "---\nname: haiku\ndescription: Write a haiku about the code.\n---\nCount five, seven, five.\n",
    "kit/agents/review.md": "---\nname: reviewer\ndescription: Reviews a diff.\n---\nRead the diff and list the bugs.\n",
  };
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(home, "plugins", path)), { recursive: true });
    writeFileSync(join(home, "plugins", path), typeof value === "string" ? value : JSON.stringify(value));
  }
  const okBroker = new FakeApprovalBroker({ clock: new FakeClock() });
  const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker: okBroker, secrets: new MemorySecretStore(), settleMs: 50 });
  for (const id of ["toolbox", "botsonly", "cconly", "cloveronly", "elsewhere", "kit"]) {
    for (let i = 0; i < 250 && opened.registry.get(id) === undefined; i++) await Bun.sleep(20);
    const { card } = await opened.registry.installed(id, "app");
    if (card !== undefined) {
      const shown = okBroker.cards().find((c) => c.id === card)!;
      await okBroker.answer(card, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: okBroker.frameChannel(card)!, input: "click", at: Date.now() } }, { role: "app" });
    }
    for (let i = 0; i < 250 && opened.registry.get(id)?.state === "found"; i++) await Bun.sleep(20);
  }
  const mcp = new PluginMcp({ registry: opened.registry, host: host as never, self: () => "Studio", computers: () => ["Studio"] });
  await mcp.refresh();
  closers.push(() => { mcp.close(); opened.close(); });
  const check = botApprovalCheck(broker, {});
  const deps: AgentPluginReachDeps = {
    servers: (kind, backend) => mcp.servers(kind, backend), runner: localMcpRunner(mcp, () => "Studio"),
    judge: agentToolJudge(check), registry: opened.registry, watch: (fn) => opened.registry.watch(() => fn()),
  };
  return { home, registry: opened.registry, mcp, deps, check };
}

/** A world whose manager's bridge serves the plugins' tools and parts (the daemon's `lateAgentPlugins` shape: the
 *  sources read deps made after the world, over its own broker). */
async function setup(o: WorldOptions & { parts?: boolean } = {}) {
  let tools: BridgeToolSource | undefined;
  let parts: PluginPartsSource | undefined;
  const w = (world = new World({
    ...o,
    pluginTools: { tools: (id, s) => tools!.tools(id, s), instructions: (id, s) => tools!.instructions!(id, s), call: (id, c, ctx) => tools!.call(id, c, ctx) },
    ...(o.parts ? {
      pluginParts: { parts: (id, s) => parts!.parts(id, s) },
      place: (p, ctx) => placeInClaudeCode(p, { dir: ctx.dir, shim: { command: "/bin/echo", args: [] } }),
    } : {}),
  }));
  const p = await plugins(w.approvals);
  tools = agentPluginTools(p.deps);
  parts = agentPluginParts(p.deps);
  return { w, p };
}

const asUser = (w: World, prompt = "Use the tool.") =>
  w.manager.start({ caller: { kind: "user", device: "d".repeat(16), clientMessageId: `m${Math.random()}`, sentAt: w.clock.now() }, backend: "fake", prompt, root: "home/Studio/project1" });
const approve = async (w: World, cardId: string, optionId: string) => {
  const card = w.approvals.cards().find((c) => c.id === cardId)!;
  expect(await w.approvals.answer(cardId, { optionId, hash: card.hash, proof: { via: "sealed-frame", frame: w.approvals.frameChannel(cardId)!, input: "click", at: w.clock.now() } }, { role: "app" })).toBe("accepted");
};
const facts = (o: Partial<AgentSessionFacts> = {}): AgentSessionFacts => ({ id: "s_code", kind: "coding", backend: "fake", computer: "Studio", root: tmpdir(), ...o });

describe("a plugin's tools on an agent's bridge", () => {
  test("allowed: the user's coding session lists the tools in its scope, calls one with no card at automatic, and the answer comes back", async () => {
    const { w } = await setup({ level: "automatic", script: [[{ mcp: { server: "$bridge", tool: TOOL, input: { n: 1 } } }, { say: "Done." }]] });
    const r = await asUser(w);
    const res = await waitFor(() => w.report("mcp-result")[0], "the tool's answer");
    expect(res).toMatchObject({ tool: TOOL, text: 'toolbox ran with {"n":1}', isError: false });
    expect(w.approvals.cards()).toEqual([]);
    // What `bridge.tools` answers the session: Glossary and toolbox's tool; not the bots-only plugin's, not the
    // Claude-Code-only one's, not the Clover-only one's (the scripted agent's backend is `fake`).
    const listed = await w.manager.bridgeHandlers().tools(r.sessionId);
    expect(listed.tools.map((t) => t.name)).toEqual(["Glossary", TOOL]);
    expect(listed.tools[1]!.description).toBe("The toolbox tool. (from the plugin toolbox)");
  });

  test("by backend and kind: Claude Code gets the Claude-Code-only plugin, Clover's own runtime (clover-code, clover) the Clover-only one, a bot's agent the agents' plugins; one not for this computer, none", async () => {
    const { p } = await setup();
    expect(p.registry.get("elsewhere")?.state).toBe("off");
    const tools = agentPluginTools(p.deps);
    const names = async (f: Partial<AgentSessionFacts>) => (await tools.tools("s", facts(f))).map((t) => t.name).sort();
    expect(await names({})).toEqual([TOOL]);
    expect(await names({ backend: "claude-code" })).toEqual(["cconly-tools__cconly", TOOL]);
    expect(await names({ backend: "clover-code" })).toEqual(["cloveronly-tools__cloveronly", TOOL]);
    expect(await names({ backend: "clover" })).toEqual(["cloveronly-tools__cloveronly", TOOL]);
    expect(await names({ kind: "agent", bot: "alpha" })).toEqual([TOOL]);
  });

  test("needs a card: at ask the call raises one naming the agent's session; the user's coding session's card offers always, and its yes runs the call", async () => {
    const { w } = await setup({ level: "ask", script: [[{ mcp: { server: "$bridge", tool: TOOL, input: { n: 2 } } }, { say: "Done." }]] });
    const r = await asUser(w);
    const card = await waitFor(() => w.approvals.cards().find((c) => c.kind === "tool"), "a card");
    expect(card.session).toBe(r.sessionId);
    expect(card.bot).toBeUndefined();
    expect(card.fields["what"]).toEqual({ type: "code", code: `mcp__${TOOL}` });
    expect(card.options.some((o) => o.remember === "always")).toBe(true);
    await approve(w, card.id, "approve");
    expect(await waitFor(() => w.report("mcp-result")[0], "the tool's answer")).toMatchObject({ text: 'toolbox ran with {"n":2}', isError: false });
  });

  test("refused by scope and by onlyBackends: a tool never listed to the session answers 'no tool named', with no card", async () => {
    const { w } = await setup({ level: "automatic", script: [[{ mcp: { server: "$bridge", tool: "botsonly-tools__botsonly" } }, { mcp: { server: "$bridge", tool: "cconly-tools__cconly" } }, { mcp: { server: "$bridge", tool: "nothing__here" } }, { say: "Done." }]] });
    await asUser(w);
    const results = await waitFor(() => (w.report("mcp-result").length === 3 ? w.report("mcp-result") : undefined), "three answers");
    expect(results.map((x) => [x["text"], x["isError"]])).toEqual([
      ["No tool named botsonly-tools__botsonly is available to this agent.", true],
      ["No tool named cconly-tools__cconly is available to this agent.", true],
      ["No tool named nothing__here is available to this agent.", true],
    ]);
    expect(w.approvals.cards()).toEqual([]);
  });

  test("read-only: the call is refused with no card", async () => {
    const { w } = await setup({ level: "read-only", script: [[{ mcp: { server: "$bridge", tool: TOOL, ask: false } }, { say: "Done." }]] });
    await asUser(w);
    const res = await waitFor(() => w.report("mcp-result")[0], "the answer");
    expect(res).toMatchObject({ isError: true });
    expect(String(res["text"])).toContain("level");
    expect(w.approvals.cards().filter((c) => c.kind === "tool")).toEqual([]);
  });

  test("a bot's agent: judged by its bot's level and saved rules; its own card offers no always", async () => {
    const { w, p } = await setup({ level: "ask", script: [[{ mcp: { server: "$bridge", tool: TOOL, input: {} } }, { say: "Done." }]] });
    const first = await w.delegate();
    const card = await waitFor(() => w.approvals.cards().find((c) => c.kind === "tool" && c.session === first.sessionId), "the agent's card");
    expect(card.bot).toBe("alpha");
    expect(card.options.map((o) => o.remember)).toEqual([undefined, undefined]);
    await approve(w, card.id, "deny");
    expect(await waitFor(() => w.report("mcp-result")[0], "the refusal")).toMatchObject({ isError: true });
    // The bot's own call to the same tool, answered "always": a rule under the bot's id.
    const botCtx = { botId: "alpha", sessionId: "s_alpha", kind: "bot", computer: "Studio", paths: { scratch: tmpdir(), root: tmpdir() }, caller: { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } } as unknown as BotSessionContext;
    const own = p.check(botCtx, () => "user")(`mcp__${TOOL}`, {}, { signal: new AbortController().signal, toolUseID: "own-1" } as never);
    const ownCard = await waitFor(() => w.approvals.cards().find((c) => c.kind === "tool" && c.session === "s_alpha"), "the bot's own card");
    await approve(w, ownCard.id, ownCard.options.find((o) => o.remember === "always")!.id);
    expect((await own)?.behavior).toBe("allow");
    // The bot's next agent calls the tool with no card: its bot's saved rule answers it.
    const cardsBefore = w.approvals.cards().length;
    const second = await w.delegate("Again.");
    await waitFor(() => w.report("mcp-result").find((x) => x["isError"] === false), "the second agent's answer");
    expect(w.approvals.cards().filter((c) => c.session === second.sessionId && c.kind === "tool")).toEqual([]);
    expect(w.approvals.cards().length).toBe(cardsBefore);
  });

  test("the plugins' tool hooks see the call under the tool's own name, on every backend; a deny refuses it", async () => {
    const { p } = await setup();
    const seen: string[] = [];
    const hooks = {
      toolBefore: async (s: { backend?: string }, t: { name: string }, input: unknown) => { seen.push(`${s.backend}:${t.name}`); return (input as { stop?: boolean }).stop ? { deny: "not today", input } : { input }; },
      toolAfter: async (_s: unknown, _t: unknown, _i: unknown, result: unknown) => result,
    } as unknown as TurnHooks;
    const tools = agentPluginTools({ ...p.deps, hooks: () => hooks });
    for (const backend of ["fake", "clover", "clover-code"]) {
      const r = await tools.call("s_code", { callId: `c-${backend}`, tool: TOOL, input: {} }, { computer: "Studio", origin: "user", session: facts({ backend }) });
      expect(r.isError).toBe(false);
    }
    expect(seen).toEqual([`fake:mcp__${TOOL}`, `clover:mcp__${TOOL}`, `clover-code:mcp__${TOOL}`]);
    const denied = await tools.call("s_code", { callId: "c-deny", tool: TOOL, input: { stop: true } }, { computer: "Studio", origin: "user", session: facts() });
    expect(denied).toEqual({ content: [{ type: "text", text: `${TOOL} was refused by a plugin's hook: not today` }], isError: true });
  });

  test("a plugin switched off since the session started: its tool answers 'no tool named'", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    const call = () => tools.call("s_code", { callId: "c1", tool: TOOL, input: {} }, { computer: "Studio", origin: "user", session: facts() });
    await p.registry.setEnabled("toolbox", false);
    await p.mcp.refresh();
    expect(await call()).toEqual({ content: [{ type: "text", text: `No tool named ${TOOL} is available to this agent.` }], isError: true });
  });
});

describe("a plugin's skills and agent definitions for an agent", () => {
  test("placed in Claude Code's per-session plugin folder (never the user's own), and gone from it when the plugin is turned off", async () => {
    const { w, p } = await setup({ parts: true, script: [[{ say: "Done." }]] });
    const parts = await agentPluginParts(p.deps).parts("s", facts());
    expect(parts.skills.map((s) => s.name)).toEqual(["kit-haiku"]);
    expect(parts.agents.map((a) => a.name)).toEqual(["kit-reviewer"]);
    expect(parts.hooks).toEqual([]);
    // The bots-only plugin's skill isn't the agent's.
    expect(parts.skills.some((s) => s.pluginId === "botsonly")).toBe(false);
    const r = await asUser(w, "Hello.");
    await waitFor(() => w.report("prompt")[0], "the prompt");
    const folder = join(w.manager.setupDir(r.sessionId), CLAUDE_PLUGIN_FOLDER);
    expect(readFileSync(join(folder, "skills", "kit-haiku", "SKILL.md"), "utf8")).toContain("five, seven, five");
    expect(readFileSync(join(folder, "agents", "kit-reviewer.md"), "utf8")).toContain("list the bugs");
    // It reached the agent at `session/new` as a local plugin in that folder.
    expect(JSON.stringify(w.report("session")[0]!["meta"])).toContain(folder);
    // Turned off: placed again, its skill and agent leave the folder.
    await p.registry.setEnabled("kit", false);
    await w.manager.placePartsAgain();
    expect(existsSync(join(folder, "skills", "kit-haiku"))).toBe(false);
    expect(existsSync(join(folder, "agents", "kit-reviewer.md"))).toBe(false);
  });

  test("Glossary on the bridge finds and loads the session's skills; another scope's stays out", async () => {
    const { p } = await setup();
    const glossary = agentGlossary(p.deps);
    const r = await glossary("s", { query: ["haiku", "limerick"], load: ["kit:haiku", "botsonly:limerick"] }, facts());
    expect(r.results).toEqual(expect.arrayContaining([expect.objectContaining({ name: "kit:haiku", kind: "skill" })]));
    expect(r.results.some((x) => (x as { name: string }).name === "botsonly:limerick")).toBe(false);
    expect(r.loaded).toEqual([expect.objectContaining({ name: "kit:haiku", kind: "skill", text: expect.stringContaining("five, seven, five") }), { name: "botsonly:limerick", found: false }]);
    // Its tools are the bridge's names.
    const t = await glossary("s", { query: "toolbox" }, facts());
    expect(t.results).toEqual(expect.arrayContaining([expect.objectContaining({ name: TOOL, kind: "tool" })]));
  });
});
