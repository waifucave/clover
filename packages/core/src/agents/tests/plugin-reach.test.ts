// How plugins reach agents (spec §9.3, checklist row 1.93) over the REAL registry and PluginMcp (a stand-in for the
// plugin host's servers), the bots' real approval check and the agent manager with the scripted ACP agent: the bridge
// lists a plugin's tools in the session's scope and its call is judged as the same call in the session that owns it
// (the user's coding session by its own level and rules, a bot's agent by its bot's, its card naming the agent's
// session); a plugin out of scope, left out by `onlyBackends` or switched off gives nothing. Skills and agent
// definitions are placed in Claude Code's per-session plugin folder and leave it when their plugin goes off; Glossary
// on the bridge serves the same scope. Temp homes, the fake broker, an in-memory secret store; nothing opens a window.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/moss-plugin-sdk";
import { Listeners } from "../../contracts/common";
import type { McpChannel } from "../../contracts/plugin-host";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { botApprovalCheck } from "../../approvals/bot-check";
import type { BotSessionContext } from "../../bots/service";
import type { CanUseTool, Options, SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { buildCoreBrand } from "../../runtime-sdk/brand";
import { testProviderNameFor } from "../../runtime-sdk/provider-selection";
import { describeWithEmbeddedRuntime } from "../../../test/helpers/embedded-runtime";
import { botChildFor } from "../bot-child";
import { MOSS_CODE_ID, MossCodeBackend, type MossCodeDeps } from "../moss-code/backend";
import { thisPlatform } from "../../registry/core";
import { openPluginRegistry } from "../../registry/open";
import type { TurnHooks } from "../../runtime-sdk/turn-loop/hooks";
import { glossaryIndex } from "../../runtime-sdk/turn-loop/glossary";
import { partsServe } from "../../runtime-sdk/turn-loop/only-backends";
import { PluginMcp, localMcpRunner } from "../../runtime-sdk/turn-loop/plugin-mcp";
import { CLAUDE_PLUGIN_FOLDER, placeInClaudeCode } from "../claude-code/placement";
import { toolOffMessage } from "../../approvals/tool-settings";
import { exposureOf } from "../exposure";
import { MOSS_CODE_QUIRKS } from "../moss-code/backend";
import { agentBackendOf, agentGlossary, bridgeNamesOf, agentPluginParts, agentPluginTools, agentToolJudge, BRIDGE_TOOL_NAME_MAX, bridgeShortName, bridgeToolsOf, type AgentPluginReachDeps } from "../plugin-reach";
import type { BotMcpServer } from "../../runtime-sdk/turn-loop/servers";
import type { AgentSessionFacts, BridgeToolSource } from "../bridge/tools";
import type { PluginPartsSource } from "../placement";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import { waitFor, World, type WorldOptions } from "./world";

setDefaultTimeout(60_000);
const ENGINES = { moss: `^${PLUGIN_API_VERSION}` };
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
/** The tools a plugin's server lists when a test changes them (an update that drops one); none set: its one tool. */
const hostTools = new Map<string, string[]>();
const host = {
  async openMcp(plugin: string, server: string): Promise<McpChannel> {
    const out = new Listeners<Record<string, unknown>>();
    let closed = false;
    const reply = (m: Record<string, unknown>) => queueMicrotask(() => { if (!closed) out.emit(m); });
    const tool = plugin.replace(/[^a-z]/g, "");
    return {
      send(m: Record<string, unknown>) {
        if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } } });
        else if (m.method === "tools/list") reply({ jsonrpc: "2.0", id: m.id, result: { tools: (hostTools.get(plugin) ?? [tool]).map((name) => ({ name, description: `The ${plugin} tool.`, inputSchema: { type: "object" } })) } });
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

/** The real registry with `toolbox` (agents), `botsonly` (bots, with a skill), `cconly` (Claude Code only), `mossonly`
 *  (MOSS's own runtime only) and `kit` (agents: a skill and an agent definition), each OK'd; PluginMcp over it; the
 *  judge over the bots' approval check on `broker`. */
/** Two plugins whose ids are long (`agents` scope): their tools' bridge names pass `BRIDGE_TOOL_NAME_MAX`, and both
 *  tools' names start with the same 27 letters. */
const LONG_IDS = ["longnamedplugin-alphastudio-tool-a", "longnamedplugin-alphastudio-tool-b"];
type ToolSetting = NonNullable<NonNullable<Parameters<typeof botApprovalCheck>[1]>["toolSetting"]>;
async function plugins(broker: FakeApprovalBroker, o: { long?: boolean; toolSetting?: ToolSetting; availability?: (server: string, tool: string) => "off" | "on-demand" | "always" | undefined; computers?: () => string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "moss-b-reach-"));
  temps.push(home);
  const files: Record<string, unknown> = {
    "toolbox/moss.json": plugin("toolbox", { scope: "agents" }), "toolbox/host/index.js": "export {};\n",
    "botsonly/moss.json": plugin("botsonly", { scope: "bots", contributes: { mcpServers: { tools: { type: "host" } }, skills: ["skills/*/SKILL.md"] } }), "botsonly/host/index.js": "export {};\n",
    "botsonly/skills/limerick/SKILL.md": "---\nname: limerick\ndescription: Write a limerick.\n---\nFive lines.\n",
    "cconly/moss.json": plugin("cconly", { onlyBackends: ["claude-code"] }), "cconly/host/index.js": "export {};\n",
    "mossonly/moss.json": plugin("mossonly", { onlyBackends: ["moss"] }), "mossonly/host/index.js": "export {};\n",
    "elsewhere/moss.json": plugin("elsewhere", { platforms: [ELSEWHERE] }), "elsewhere/host/index.js": "export {};\n",
    "kit/moss.json": { manifest: 1, id: "kit", name: "Kit", version: "1.0.0", engines: ENGINES, scope: "agents", contributes: { skills: ["skills/*/SKILL.md"], agents: ["agents/review.md"] } },
    "kit/skills/haiku/SKILL.md": "---\nname: haiku\ndescription: Write a haiku about the code.\n---\nCount five, seven, five.\n",
    "kit/agents/review.md": "---\nname: reviewer\ndescription: Reviews a diff.\n---\nRead the diff and list the bugs.\n",
    // Two bots' own plugins (`own-bot`: a bot's id is its plugin's), each with a server and a persona skill.
    ...Object.fromEntries(["luna", "nova"].flatMap((b) => [
      [`${b}/moss.json`, plugin(b, { scope: "own-bot", contributes: { mcpServers: { tools: { type: "host" } }, skills: ["skills/*/SKILL.md"] } })],
      [`${b}/host/index.js`, "export {};\n"],
      [`${b}/skills/persona/SKILL.md`, `---\nname: persona\ndescription: How ${b} talks.\n---\nTalk like ${b}.\n`],
    ])),
    ...(o.computers ? { "percomp/moss.json": plugin("percomp", { contributes: { mcpServers: { tools: { type: "host", perComputer: true } } } }), "percomp/host/index.js": "export {};\n" } : {}),
    ...(o.long ? Object.fromEntries(LONG_IDS.flatMap((id) => [[`${id}/moss.json`, plugin(id, { scope: "agents", contributes: { mcpServers: { tools: { type: "host", tools: { [id.replace(/[^a-z]/g, "")]: "preload" } } } } })], [`${id}/host/index.js`, "export {};\n"]])) : {}),
  };
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(home, "plugins", path)), { recursive: true });
    writeFileSync(join(home, "plugins", path), typeof value === "string" ? value : JSON.stringify(value));
  }
  const okBroker = new FakeApprovalBroker({ clock: new FakeClock() });
  const opened = await openPluginRegistry({ mossHome: home, os: "linux", broker: okBroker, secrets: new MemorySecretStore(), settleMs: 50 });
  for (const id of ["toolbox", "botsonly", "cconly", "mossonly", ...(o.computers ? ["percomp"] : []), "elsewhere", "kit", "luna", "nova", ...(o.long ? LONG_IDS : [])]) {
    for (let i = 0; i < 250 && opened.registry.get(id) === undefined; i++) await Bun.sleep(20);
    const { card } = await opened.registry.installed(id, "app");
    if (card !== undefined) {
      const shown = okBroker.cards().find((c) => c.id === card)!;
      await okBroker.answer(card, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: okBroker.frameChannel(card)!, input: "click", at: Date.now() } }, { role: "app" });
    }
    for (let i = 0; i < 250 && opened.registry.get(id)?.state === "found"; i++) await Bun.sleep(20);
  }
  const mcp = new PluginMcp({ registry: opened.registry, host: host as never, self: () => "Studio", computers: o.computers ?? (() => ["Studio"]), ...(o.availability ? { availability: o.availability } : {}) });
  await mcp.refresh();
  closers.push(() => { mcp.close(); opened.close(); });
  const check = botApprovalCheck(broker, o.toolSetting === undefined ? {} : { toolSetting: o.toolSetting });
  const deps: AgentPluginReachDeps = {
    servers: (kind, backend, bot, opts) => mcp.servers(kind, backend, bot, opts), runner: localMcpRunner(mcp, () => "Studio"),
    judge: agentToolJudge(check), registry: opened.registry, watch: (fn) => opened.registry.watch(() => fn()),
  };
  return { home, registry: opened.registry, mcp, deps, check, okBroker };
}

/** A world whose manager's bridge serves the plugins' tools and parts (the daemon's `lateAgentPlugins` shape: the
 *  sources read deps made after the world, over its own broker). */
/** The bridge's name, fixed so a moss-code session's prompt can name its tools. */
const CODE_BRIDGE = "moss_reachbridge";
const CODE_MODEL = "winter-test/calls";
/** MOSS's coding agent (`moss-code`) on the embedded runtime, beside the scripted one, as moss-code.test.ts makes it. */
const codeBackend = (spawn: SpawnClaudeCodeProcess, query?: MossCodeDeps["query"]): WorldOptions => ({
  bridgeServerName: CODE_BRIDGE,
  extraBackends: (wire, self) => [new MossCodeBackend({
    clock: { now: () => Date.now() } as never, wire, defaultModel: () => CODE_MODEL, sandboxReady: () => true,
    botChild: botChildFor({ mossHome: self.mossHome, userHome: self.userHome }),
    baseOptions: (x): Options => {
      const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", MOSS_HOME: self.mossHome };
      const provider = testProviderNameFor(x.model);
      if (provider !== undefined) env["WINTER_TEST_PROVIDER"] = provider;
      return { brand: buildCoreBrand(undefined, self.mossHome), model: x.model, cwd: x.cwd, env, spawnClaudeCodeProcess: spawn, settingSources: [] };
    },
    pause: { mayAct: () => true },
    ...(query === undefined ? {} : { query }),
  })],
});
/** A runtime that, at the prompt, asks about the calls `script` makes through the agent's own `canUseTool` (the backend's
 *  wrapper over the ACP agent's), then ends the turn: what a provider giving two tool uses one id would make it ask. */
const askingQuery = (script: (can: CanUseTool) => Promise<void>) => ((args: { prompt: AsyncIterable<string>; options: Options & { canUseTool: CanUseTool } }) => {
  async function* run() {
    yield { type: "system", subtype: "init", model: CODE_MODEL, permissionMode: "default" };
    for await (const _ of args.prompt) {
      await script(args.options.canUseTool);
      yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
    }
  }
  return Object.assign(run(), { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, setEffort: async () => {}, supportedModels: async () => [] });
}) as unknown as MossCodeDeps["query"];

async function setup(o: WorldOptions & { parts?: boolean; long?: boolean; toolSetting?: ToolSetting; availability?: Parameters<typeof plugins>[1] extends infer X ? (X extends { availability?: infer A } ? A : never) : never; computers?: () => string[]; settle?: () => Promise<void> } = {}) {
  let tools: BridgeToolSource | undefined;
  let parts: PluginPartsSource | undefined;
  const watchers = new Set<() => void>();
  const w = (world = new World({
    ...o,
    watchTools: (fn) => { watchers.add(fn); return () => void watchers.delete(fn); },
    glossary: (id, q, s) => agentGlossary(p.deps)(id, q, s),
    pluginTools: { ...(o.settle ? { settled: () => o.settle!() } : {}), tools: (id, s) => tools!.tools(id, s), instructions: (id, s) => tools!.instructions!(id, s), call: (id, c, ctx) => tools!.call(id, c, ctx) },
    ...(o.parts ? {
      pluginParts: { parts: (id, s) => parts!.parts(id, s) },
      place: (p, ctx) => placeInClaudeCode(p, { dir: ctx.dir, shim: { command: "/bin/echo", args: [] } }),
    } : {}),
  }));
  const p = await plugins(w.approvals, { long: o.long === true, ...(o.toolSetting === undefined ? {} : { toolSetting: o.toolSetting }), ...(o.availability ? { availability: o.availability } : {}), ...(o.computers ? { computers: o.computers } : {}) });
  tools = agentPluginTools(p.deps);
  parts = agentPluginParts(p.deps);
  /** The plugins changed: what the daemon's registry, listing and tool-setting watches tell the manager. */
  const changed = async () => { await p.mcp.refresh(); await p.mcp.settled(5_000); for (const fn of [...watchers]) fn(); await w.manager.refreshBridgeTools(); };
  return { w, p, changed };
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
    // Claude-Code-only one's, not the MOSS-only one's (the scripted agent's backend is `fake`).
    const listed = await w.manager.bridgeHandlers().tools(r.sessionId);
    expect(listed.tools.map((t) => t.name)).toEqual(["Glossary", TOOL]);
    expect(listed.tools[1]!.description).toBe("The toolbox tool. (from the plugin toolbox)");
  });

  test("by backend and kind: Claude Code gets the Claude-Code-only plugin, MOSS's own runtime (moss-code, moss) the MOSS-only one, a bot's agent the agents' and the bots' plugins; one not for this computer, none", async () => {
    const { p } = await setup();
    expect(p.registry.get("elsewhere")?.state).toBe("off");
    const tools = agentPluginTools(p.deps);
    const names = async (f: Partial<AgentSessionFacts>) => (await tools.tools("s", facts(f))).map((t) => t.name).sort();
    expect(await names({})).toEqual([TOOL]);
    expect(await names({ backend: "claude-code" })).toEqual(["cconly-tools__cconly", TOOL]);
    expect(await names({ backend: "moss-code" })).toEqual(["mossonly-tools__mossonly", TOOL]);
    expect(await names({ backend: "moss" })).toEqual(["mossonly-tools__mossonly", TOOL]);
    expect(await names({ kind: "agent", bot: "alpha" })).toEqual(["botsonly-tools__botsonly", TOOL]);
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
    for (const backend of ["fake", "moss", "moss-code"]) {
      const r = await tools.call("s_code", { callId: `c-${backend}`, tool: TOOL, input: {} }, { computer: "Studio", origin: "user", session: facts({ backend }) });
      expect(r.isError).toBe(false);
    }
    expect(seen).toEqual([`fake:mcp__${TOOL}`, `moss:mcp__${TOOL}`, `moss-code:mcp__${TOOL}`]);
    const denied = await tools.call("s_code", { callId: "c-deny", tool: TOOL, input: { stop: true } }, { computer: "Studio", origin: "user", session: facts() });
    expect(denied).toEqual({ content: [{ type: "text", text: `${TOOL} was refused by a plugin's hook: not today` }], isError: true });
  });

  test("a call's result reaches the observer as the tool returned it, before any hook, in the session's own context; a refused call's never does", async () => {
    const { p } = await setup();
    const seen: { session: string; kind: string; backend: string | undefined; served: string; text: string }[] = [];
    const hooks = {
      toolBefore: async (_s: unknown, _t: unknown, input: unknown) => ((input as { stop?: boolean }).stop ? { deny: "not today", input } : { input }),
      toolAfter: async () => ({ content: [{ type: "text", text: "rewritten by a hook" }], isError: false }),
    } as unknown as TurnHooks;
    const tools = agentPluginTools({
      ...p.deps, hooks: () => hooks,
      observeResult: (ctx, served, result) => seen.push({ session: ctx.sessionId, kind: ctx.kind, backend: agentBackendOf(ctx), served, text: (result as { content: { text: string }[] }).content[0]!.text }),
    });
    const r = await tools.call("s_code", { callId: "c-1", tool: TOOL, input: { n: 1 } }, { computer: "Studio", origin: "user", session: facts({ id: "s_code", backend: "moss-code" }) });
    expect(r.content).toEqual([{ type: "text", text: "rewritten by a hook" }]);
    expect(seen).toEqual([{ session: "s_code", kind: "coding", backend: "moss-code", served: `mcp__${TOOL}`, text: 'toolbox ran with {"n":1}' }]);
    await tools.call("s_code", { callId: "c-2", tool: TOOL, input: { stop: true } }, { computer: "Studio", origin: "user", session: facts({ id: "s_code", backend: "moss-code" }) });
    expect(seen).toHaveLength(1);
  });

  test("a long name: a short form that fits, the same each time; a name that fits is untouched; two cut to the same start stay apart; one that takes another's name gets more digits; only other characters leave a tool out", async () => {
    const srv = (server: string, ...tools: string[]): BotMcpServer => ({ server, plugin: server, tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) }) as unknown as BotMcpServer;
    const left: string[] = [];
    const short = bridgeShortName("acme-studio-blender-bridge-tools", "Render");
    // The tool's name kept whole, the server's cut, six hex digits of the full name's hash.
    expect(short).toMatch(/^acme-studio-blender__Render_[0-9a-f]{6}$/);
    expect(short.length).toBe(BRIDGE_TOOL_NAME_MAX);
    // A tool whose own name leaves no room: its name cut, then the digits.
    const a = bridgeShortName("x-tools", "longnamedpluginalphastudioone"), b = bridgeShortName("y-tools", "longnamedpluginalphastudioone");
    expect(a.slice(0, 27)).toBe(b.slice(0, 27));
    expect(a).not.toBe(b);
    // A fitting tool whose full name is exactly the long one's short form: the long one takes eight digits.
    const cut = short.indexOf("__");
    const names = [...bridgeToolsOf([
      srv("toolbox-tools", "toolbox"),
      srv("acme-studio-blender-bridge-tools", "Render"),
      srv(short.slice(0, cut), short.slice(cut + 2)),
      srv("acme-studio-blender-bridge-tools", "has.dot"),
    ], (n, why) => left.push(`${n}: ${why}`)).entries()].map(([name, t]) => [name, `${t.server.server}__${t.tool.name}`]);
    expect(names).toEqual([
      ["toolbox-tools__toolbox", "toolbox-tools__toolbox"],
      [short, short],
      [bridgeShortName("acme-studio-blender-bridge-tools", "Render", 8), "acme-studio-blender-bridge-tools__Render"],
    ]);
    expect(left).toEqual(["acme-studio-blender-bridge-tools__has.dot: a character MCP clients refuse"]);
    for (const [name] of names) expect(name!.length).toBeLessThanOrEqual(BRIDGE_TOOL_NAME_MAX);
    // The same servers give the same names.
    expect([...bridgeToolsOf([srv("acme-studio-blender-bridge-tools", "Render")]).keys()]).toEqual([short]);
  });

  test("a long plugin id: its tool listed under a short name whose description starts with the real names, called through it, its card and hooks under the real name", async () => {
    const real = (id: string) => `${id}-tools__${id.replace(/[^a-z]/g, "")}`;
    const one = bridgeShortName(`${LONG_IDS[0]}-tools`, LONG_IDS[0]!.replace(/[^a-z]/g, ""));
    const two = bridgeShortName(`${LONG_IDS[1]}-tools`, LONG_IDS[1]!.replace(/[^a-z]/g, ""));
    // Both tools' names start with the same letters, so the cut alone would give them one name.
    expect(one.slice(0, 27)).toBe(two.slice(0, 27));
    expect(one).not.toBe(two);
    const { w, p } = await setup({ long: true, level: "ask", script: [[{ mcp: { server: "$bridge", tool: one, input: { n: 3 } } }, { say: "Done." }]] });
    const lines: string[] = [];
    const tools = agentPluginTools({ ...p.deps, log: (l) => lines.push(l) });
    const listed = await tools.tools("s_code", facts());
    expect(listed.map((t) => t.name).sort()).toEqual([one, two, TOOL].sort());
    expect(lines).toEqual([]);
    expect(listed.find((t) => t.name === one)!.description).toBe(`[${LONG_IDS[0]}] longnamedpluginalphastudiotoola: The ${LONG_IDS[0]} tool. (the tool ${real(LONG_IDS[0]!)}, its name shortened to fit)`);
    // The plugins' hooks see the call under the real name.
    const seen: string[] = [];
    const hooks = { toolBefore: async (_s: unknown, t: { name: string }, input: unknown) => { seen.push(t.name); return { input }; }, toolAfter: async (_s: unknown, _t: unknown, _i: unknown, r: unknown) => r } as unknown as TurnHooks;
    const hooked = agentPluginTools({ ...p.deps, judge: async (_s, _c, call) => ({ allowed: true, input: call.input }), hooks: () => hooks });
    expect(await hooked.call("s_code", { callId: "c-two", tool: two, input: {} }, { computer: "Studio", origin: "user", session: facts() })).toEqual({ content: [{ type: "text", text: "longnamedpluginalphastudiotoolb ran with {}" }], isError: false });
    expect(seen).toEqual([`mcp__${real(LONG_IDS[1]!)}`]);
    // The agent calls the short name: the card names the real one, and its yes runs it.
    await asUser(w);
    const card = await waitFor(() => w.approvals.cards().find((c) => c.kind === "tool"), "a card");
    expect(card.fields["what"]).toEqual({ type: "code", code: `mcp__${real(LONG_IDS[0]!)}` });
    await approve(w, card.id, "approve");
    expect(await waitFor(() => w.report("mcp-result")[0], "the tool's answer")).toMatchObject({ tool: one, text: 'longnamedpluginalphastudiotoola ran with {"n":3}', isError: false });
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

/** Every way a plugin tool can go away from a running session, and the refusal of a call to the name the agent kept (lane AG):
 *  the call reads the plugins' list at the moment it is made, so none of these needs the agent to have heard. */
describe("a tool that has gone is refused at the call, whatever the agent still holds", () => {
  const goneText = (tool: string) => ({ content: [{ type: "text", text: `No tool named ${tool} is available to this agent.` }], isError: true });
  const callOf = (tools: ReturnType<typeof agentPluginTools>, tool = TOOL, session: Partial<AgentSessionFacts> = {}) =>
    tools.call("s_code", { callId: `c-${Math.random()}`, tool, input: {} }, { computer: "Studio", origin: "user", session: facts(session) });
  const names = async (tools: ReturnType<typeof agentPluginTools>, session: Partial<AgentSessionFacts> = {}) => (await tools.tools("s_code", facts(session))).map((t) => t.name);

  test("uninstalled: the folder is gone; the list drops it and the call says no tool of that name", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    expect(await names(tools)).toContain(TOOL);
    expect((await callOf(tools)).isError).toBe(false);
    rmSync(join(p.home, "plugins", "toolbox"), { recursive: true, force: true });
    await waitFor(() => p.registry.get("toolbox") === undefined, "the registry to notice the removal", 15_000);
    await p.mcp.refresh();
    expect(await names(tools)).not.toContain(TOOL);
    expect(await callOf(tools)).toEqual(goneText(TOOL));
  });

  test("disabled, then enabled again: refused while off, served again after", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    await p.registry.setEnabled("toolbox", false);
    await p.mcp.refresh();
    expect(await callOf(tools)).toEqual(goneText(TOOL));
    await p.registry.setEnabled("toolbox", true);
    await p.mcp.refresh();
    await p.mcp.settled(5_000);
    expect((await callOf(tools)).isError).toBe(false);
  });

  test("an update that drops the tool: refused; a tool the update adds is served at once, with no new session", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    expect(await names(tools)).toContain(TOOL);
    hostTools.set("toolbox", ["newer"]);
    try {
      await p.mcp.relist("toolbox", ["tools"]);
      expect(await callOf(tools)).toEqual(goneText(TOOL));
      expect(await names(tools)).toContain("toolbox-tools__newer");
      expect(await callOf(tools, "toolbox-tools__newer")).toMatchObject({ isError: false });
    } finally {
      hostTools.delete("toolbox");
    }
  });

  test("an update that changes who may reach it (onlyBackends): refused to the session it no longer serves", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    expect(await names(tools)).toContain(TOOL);
    writeFileSync(join(p.home, "plugins", "toolbox", "moss.json"), JSON.stringify(plugin("toolbox", { scope: "agents", onlyBackends: ["claude-code"] })));
    await waitFor(async () => { await p.mcp.refresh(); return !(await names(tools)).includes(TOOL); }, "the tool to leave the fake agent's list", 15_000);
    expect(await callOf(tools)).toEqual(goneText(TOOL));
    expect(await names(tools, { backend: "claude-code" })).not.toContain("never-there");
  });

  test("set off in Settings' Tools: refused with the words that say the user did it, and back on it runs", async () => {
    const off = new Set<string>(["toolbox"]);
    const { p } = await setup({ availability: (_server, tool) => (off.has(tool) ? "off" : undefined) });
    const tools = agentPluginTools(p.deps);
    expect(await names(tools)).not.toContain(TOOL);
    const refused = await callOf(tools);
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toBe(toolOffMessage(`mcp__${TOOL}`));
    off.clear();
    expect(await names(tools)).toContain(TOOL);
    expect((await callOf(tools)).isError).toBe(false);
  });

  test("Always block: still listed, refused at the call with the user's own message, and the tool never runs", async () => {
    const toolSetting: ToolSetting = (_ctx, t) => (t === `mcp__${TOOL}` ? { setting: "deny", message: "Blocked in Settings' Tools." } : undefined);
    const { p, w } = await setup({ toolSetting });
    const tools = agentPluginTools(p.deps);
    expect(await names(tools)).toContain(TOOL);
    const r = await callOf(tools);
    expect(r).toEqual({ content: [{ type: "text", text: "Blocked in Settings' Tools." }], isError: true });
    expect(w.approvals.cards().filter((c) => c.kind === "tool")).toEqual([]);
  });

  test("Always block set while the session runs: the name it kept is refused at the call with the user's words, the tool never runs, and unblocked it runs again", async () => {
    let blocked = false;
    const toolSetting: ToolSetting = (_ctx, t) => (blocked && t === `mcp__${TOOL}` ? { setting: "deny", message: "Blocked in Settings' Tools." } : undefined);
    const { p } = await setup({ toolSetting });
    const tools = agentPluginTools(p.deps);
    expect(await names(tools)).toContain(TOOL);
    expect((await callOf(tools)).isError).toBe(false);
    blocked = true;
    // Still in the list (it is the user's refusal, not an absence), and the call to it is refused with no card.
    expect(await names(tools)).toContain(TOOL);
    expect(await callOf(tools)).toEqual({ content: [{ type: "text", text: "Blocked in Settings' Tools." }], isError: true });
    blocked = false;
    expect((await callOf(tools)).isError).toBe(false);
  });

  test("a plugin whose OK is pending again after an update that asks for more: its tool is refused at the call; once the user OKs it, it runs again", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    expect((await callOf(tools)).isError).toBe(false);
    // The update changes the plugin's code: it asks again, and until the user says yes nothing of it runs on the old OK.
    writeFileSync(join(p.home, "plugins", "toolbox", "host", "index.js"), "export {}; // updated\n");
    await waitFor(() => p.registry.get("toolbox")?.state === "found", "the update to wait for its OK again", 20_000);
    await p.mcp.refresh();
    expect(await names(tools)).not.toContain(TOOL);
    expect(await callOf(tools)).toEqual(goneText(TOOL));
    const { card } = await p.registry.installed("toolbox", "app");
    expect(card).toBeDefined();
    const shown = p.okBroker.cards().find((c) => c.id === card)!;
    await p.okBroker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: p.okBroker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
    await waitFor(() => p.registry.get("toolbox")?.state !== "found", "the plugin to run on the new OK", 20_000);
    await p.mcp.refresh();
    await p.mcp.settled(5_000);
    expect((await callOf(tools)).isError).toBe(false);
  });

  test("its per-computer server no longer ticked on this computer: refused", async () => {
    let here = ["Studio"];
    const { p } = await setup({ computers: () => here });
    const tools = agentPluginTools(p.deps);
    const PER = "percomp-tools__percomp";
    await p.mcp.settled(5_000);
    expect(await names(tools)).toContain(PER);
    expect((await callOf(tools, PER)).isError).toBe(false);
    here = [];
    await p.mcp.refresh();
    expect(await names(tools)).not.toContain(PER);
    expect(await callOf(tools, PER)).toEqual(goneText(PER));
  });

  test("the agent's kind or backend is not the one the tool serves: a name from another session's list is refused", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    // `cconly` serves Claude Code only; a session on the scripted agent that learned its name is refused.
    expect(await callOf(tools, "cconly-tools__cconly", { backend: "fake" })).toEqual(goneText("cconly-tools__cconly"));
    expect((await callOf(tools, "cconly-tools__cconly", { backend: "claude-code" })).isError).toBe(false);
  });
});

describeWithEmbeddedRuntime("a plugin's tool from a coding session on MOSS's coding agent (moss-code): one card, the judge's", (spawn) => {
  const tool = LONG_IDS[0]!.replace(/[^a-z]/g, "");
  const real = `mcp__${LONG_IDS[0]}-tools__${tool}`;
  const short = bridgeShortName(`${LONG_IDS[0]}-tools`, tool);
  /** The user's own coding session on moss-code, told to make one call. */
  const code = (w: World, call: string) => w.manager.start({
    caller: { kind: "user", device: "d".repeat(16), clientMessageId: `m${Math.random()}`, sentAt: w.clock.now() },
    backend: MOSS_CODE_ID, root: "home/Studio/project1", model: CODE_MODEL, prompt: `CALL ${call}`,
  });
  const wire = (w: World, transcript: string) => { try { return readFileSync(join(w.mossHome, transcript), "utf8"); } catch { return ""; } };
  const mine = (w: World, session: string) => w.approvals.cards().filter((c) => c.session === session);
  /** Every card raised for a session, answered or not, by kind. */
  const raised = (w: World) => {
    const all: { session?: string; kind: string }[] = [];
    closers.push(w.approvals.watch((e) => { if (e.type === "requested") all.push({ ...(e.card.session === undefined ? {} : { session: e.card.session }), kind: e.card.kind }); }));
    return (session: string) => all.filter((c) => c.session === session).map((c) => c.kind);
  };

  test("at ask: no agent-permission card; the judge's tool card under the real name, and its yes runs the call", async () => {
    const { w } = await setup({ ...codeBackend(spawn), long: true, level: "ask" });
    const kinds = raised(w);
    const r = await code(w, `mcp__${CODE_BRIDGE}__${short} {"n":4}`);
    const card = await waitFor(() => mine(w, r.sessionId).find((c) => c.kind === "tool"), "the judge's card");
    expect(card.fields["what"]).toEqual({ type: "code", code: real });
    expect(card.fields["reason"]).toBeUndefined();
    expect(card.fields["source"]).toMatchObject({ type: "rows", rows: [{ label: "Agent", value: "moss-code" }, { label: "Started by", value: "You" }, { label: "Folder" }] });
    await approve(w, card.id, "approve");
    await waitFor(() => wire(w, r.transcript).includes(`${tool} ran with`), "the tool's answer");
    expect(kinds(r.sessionId)).toEqual(["tool"]);
  });

  test("on demand in a moss-code session: the tool is refused by name before a load, and a Glossary load makes the next call run, under the name the request lists", async () => {
    const { w } = await setup({ ...codeBackend(spawn), long: true, level: "automatic", availability: () => "on-demand" });
    const send = (id: string, text: string, n: number) => w.host.sendUser(id, { text, device: "d".repeat(16), clientMessageId: `m-od-${n}`, sentAt: w.clock.now() });
    const ends = (id: string) => w.host.history(id).filter((x) => x.type === "turn_ended").length;
    // Before any load: called by its exact name, it does not run.
    const r = await code(w, `mcp__${CODE_BRIDGE}__${short} {"n":1}`);
    await waitFor(() => ends(r.sessionId) >= 1, "the first turn's end", 60_000);
    expect(wire(w, r.transcript)).not.toContain(`${tool} ran with`);
    expect(wire(w, r.transcript)).toContain("has not been loaded");
    // The load: Glossary names the tool by its bridge name.
    await send(r.sessionId, `CALL mcp__${CODE_BRIDGE}__Glossary {"load":${JSON.stringify(short)}}`, 2);
    await waitFor(() => ends(r.sessionId) >= 2, "the load turn's end", 60_000);
    // After it, the same name runs.
    await send(r.sessionId, `CALL mcp__${CODE_BRIDGE}__${short} {"n":3}`, 3);
    await waitFor(() => ends(r.sessionId) >= 3, "the call turn's end", 60_000);
    const text = wire(w, r.transcript);
    expect([text.includes(`${tool} ran with`), text.slice(text.lastIndexOf("has not been loaded") - 200, text.lastIndexOf("has not been loaded") + 80)]).toEqual([true, expect.anything()]);
  });

  test("on demand in a moss-code session, ONE turn: a Glossary load, then in the same turn the call by name runs the plugin", async () => {
    const { w } = await setup({ ...codeBackend(spawn), long: true, level: "automatic", availability: () => "on-demand" });
    // Two rounds of one turn: the model loads, then (its next step) calls what it loaded.
    const r = await code(w, `mcp__${CODE_BRIDGE}__Glossary {"load":${JSON.stringify(short)}}\nCALL mcp__${CODE_BRIDGE}__${short} {"n":2}`);
    await waitFor(() => w.host.history(r.sessionId).some((x) => x.type === "turn_ended"), "the turn's end", 60_000);
    const text = wire(w, r.transcript);
    expect([text.includes("has not been loaded"), text.includes(`${tool} ran with`)]).toEqual([false, true]);
  });

  test("a model loads a tool by the name its own list shows (mcp__<server>__<name>) as by the bridge's name, in one turn", async () => {
    const { w } = await setup({ ...codeBackend(spawn), long: true, level: "automatic", availability: () => "on-demand" });
    const r = await code(w, `mcp__${CODE_BRIDGE}__Glossary {"load":${JSON.stringify(`mcp__${CODE_BRIDGE}__${short}`)}}\nCALL mcp__${CODE_BRIDGE}__${short} {"n":2}`);
    await waitFor(() => w.host.history(r.sessionId).some((x) => x.type === "turn_ended"), "the turn's end", 60_000);
    const text = wire(w, r.transcript);
    expect([text.includes("has not been loaded"), text.includes(`${tool} ran with`)]).toEqual([false, true]);
  });

  test("a turn the runtime ends with no word, no event and no tokens (no model call) ends as the failure it is, said in words, not a silent end_turn", async () => {
    let opened = 0;
    const query = ((args: { prompt: AsyncIterable<string> }) => {
      const mine = ++opened;
      async function* run() {
        yield { type: "system", subtype: "init", model: CODE_MODEL, permissionMode: "default" };
        for await (const _ of args.prompt) {
          // The first agent answers the message with the end of something else: a `result` and nothing before it.
          if (mine === 1) yield { type: "result", subtype: "success", is_error: false };
          else {
            yield { type: "assistant", message: { content: [{ type: "text", text: "Here you are." }] } };
            yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 2 } };
          }
        }
      }
      return Object.assign(run(), { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, setEffort: async () => {}, supportedModels: async () => [] });
    }) as unknown as MossCodeDeps["query"];
    const { w } = await setup({ ...codeBackend(spawn, query), long: true, level: "automatic" });
    const r = await code(w, "say hello");
    const ended = () => w.host.history(r.sessionId).filter((x) => x.type === "turn_ended") as unknown as { end: { reason: string; failure?: string; text?: string } }[];
    await waitFor(() => ended().length >= 1, "the first turn's end", 60_000);
    expect(ended()[0]!.end).toMatchObject({ reason: "failed", failure: "error" });
    expect(String(ended()[0]!.end.text)).toContain("without answering");
  });

  test("a plugin enabled while the session runs: its tool is called in the next turn of the same session, and set off, the call after is not run", async () => {
    const off = new Set<string>();
    const { w, p, changed } = await setup({ ...codeBackend(spawn), level: "automatic", availability: (_s, t) => (off.has(t) ? "off" : "always") });
    // (Always on: MOSS's own agent holds an on-demand tool back until it loads it, which the tests of the Glossary below cover.)
    // The plugin is not there when the session starts.
    await p.registry.setEnabled("toolbox", false);
    await p.mcp.refresh();
    const r = await code(w, `mcp__${CODE_BRIDGE}__Glossary {}`);
    /** The tool ran with `{"n": n}`, as the transcript writes it (its quotes escaped inside a string). */
    const ran = (n: number) => new RegExp(`toolbox ran with \\{\\\\*"n\\\\*":${n}\\}`).test(wire(w, r.transcript));
    await waitFor(() => w.host.history(r.sessionId).some((x) => x.type === "turn_ended"), "the first turn", 30_000);
    expect(ran(8)).toBe(false);
    const turns = () => w.host.history(r.sessionId).filter((x) => x.type === "turn_ended").length;
    // Installed (enabled) now: the next turn calls it, in this session, with no new one started.
    await p.registry.setEnabled("toolbox", true);
    await changed();
    await w.host.sendUser(r.sessionId, { text: `CALL mcp__${CODE_BRIDGE}__${TOOL} {"n":8}`, device: "d".repeat(16), clientMessageId: "m-on", sentAt: w.clock.now() });
    await waitFor(() => ran(8), "the tool's answer in the same session", 30_000);
    await waitFor(() => turns() >= 2, "the second turn's end", 30_000);
    // Set off in Settings' Tools: the next turn's call is not run.
    off.add("toolbox");
    await changed();
    await w.host.sendUser(r.sessionId, { text: `CALL mcp__${CODE_BRIDGE}__${TOOL} {"n":9}`, device: "d".repeat(16), clientMessageId: "m-off", sentAt: w.clock.now() });
    await waitFor(() => turns() >= 3, "the third turn's end", 30_000);
    expect(ran(9)).toBe(false);
    // Back on: it runs again.
    off.clear();
    await changed();
    await w.host.sendUser(r.sessionId, { text: `CALL mcp__${CODE_BRIDGE}__${TOOL} {"n":10}`, device: "d".repeat(16), clientMessageId: "m-on2", sentAt: w.clock.now() });
    await waitFor(() => ran(10), "the tool's answer after it came back", 30_000);
  });

  test("a reopen for a changed tool list never costs the person's next message: many changes in a row, each turn reaches the model and ends normally", async () => {
    const { w, p, changed } = await setup({ ...codeBackend(spawn), level: "automatic" });
    const r = await code(w, `mcp__${CODE_BRIDGE}__Glossary {}`);
    const ends = () => w.host.history(r.sessionId).filter((x) => x.type === "turn_ended") as unknown as { end: { reason: string } }[];
    await waitFor(() => ends().length >= 1, "the first turn", 30_000);
    for (let i = 1; i <= 8; i++) {
      // A change of the list (the plugin off, then on), then the person's next message.
      await p.registry.setEnabled("toolbox", i % 2 === 0);
      await changed();
      await w.host.sendUser(r.sessionId, { text: `CALL mcp__${CODE_BRIDGE}__Glossary {}`, device: "d".repeat(16), clientMessageId: `m-${i}`, sentAt: w.clock.now() });
      await waitFor(() => ends().length >= i + 1, `turn ${i + 1}'s end`, 60_000);
      expect(ends().map((e) => e.end.reason)).toEqual(Array(i + 1).fill("end_turn"));
    }
  });

  test("the list changes before the session's FIRST turn (a server finished listing as it began): the reopen starts it afresh, there is no transcript to resume, and the first message is answered", async () => {
    let flip: (() => Promise<void>) | undefined;
    const { w, p } = await setup({ ...codeBackend(spawn), level: "automatic", settle: async () => { const f = flip; flip = undefined; await f?.(); } });
    // Started with the plugin's tool listed; as the first turn begins, the plugin is gone from the list.
    flip = async () => { await p.registry.setEnabled("toolbox", false); await p.mcp.refresh(); };
    const r = await code(w, `mcp__${CODE_BRIDGE}__Glossary {}`);
    await waitFor(() => w.host.history(r.sessionId).some((x) => x.type === "turn_ended"), "the first turn's end", 60_000);
    const end = (w.host.history(r.sessionId).find((x) => x.type === "turn_ended") as unknown as { end: { reason: string } }).end;
    expect(end.reason).toBe("end_turn");
    // And the session keeps working: a later change is a resume of a transcript that now exists.
    await p.registry.setEnabled("toolbox", true);
    await p.mcp.refresh();
    await w.host.sendUser(r.sessionId, { text: `CALL mcp__${CODE_BRIDGE}__Glossary {}`, device: "d".repeat(16), clientMessageId: "m-2", sentAt: w.clock.now() });
    await waitFor(() => w.host.history(r.sessionId).filter((x) => x.type === "turn_ended").length >= 2, "the second turn's end", 60_000);
    expect((w.host.history(r.sessionId).filter((x) => x.type === "turn_ended") as unknown as { end: { reason: string } }[]).map((x) => x.end.reason)).toEqual(["end_turn", "end_turn"]);
  });

  test("Settings' Tools decide it with no card at all: Always block refuses it, Always allow runs it", async () => {
    const said = new Map<string, "allow" | "deny">([[real, "deny"]]);
    const toolSetting: ToolSetting = (_ctx, t) => (said.get(t) === "deny" ? { setting: "deny", message: "Blocked in Settings' Tools." } : said.get(t) === "allow" ? { setting: "allow" } : undefined);
    const { w } = await setup({ ...codeBackend(spawn), long: true, level: "ask", toolSetting });
    const kinds = raised(w);
    const blocked = await code(w, `mcp__${CODE_BRIDGE}__${short} {"n":5}`);
    await waitFor(() => wire(w, blocked.transcript).includes("Blocked in Settings' Tools."), "the refusal");
    expect(wire(w, blocked.transcript)).not.toContain(`${tool} ran with`);
    expect(kinds(blocked.sessionId)).toEqual([]);
    said.set(real, "allow");
    const allowed = await code(w, `mcp__${CODE_BRIDGE}__${short} {"n":6}`);
    await waitFor(() => wire(w, allowed.transcript).includes(`${tool} ran with`), "the tool's answer");
    expect(kinds(allowed.sessionId)).toEqual([]);
  });

  test("a bot's agent: one card, the judge's, saying it's her agent asking and not her, with no always", async () => {
    const { w } = await setup({ ...codeBackend(spawn), long: true, level: "ask" });
    const kinds = raised(w);
    const r = await w.manager.start({
      caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" },
      backend: MOSS_CODE_ID, root: "home/Studio/project1", title: "Use it", model: CODE_MODEL, prompt: `CALL mcp__${CODE_BRIDGE}__${short} {"n":7}`,
    });
    const card = await waitFor(() => mine(w, r.sessionId).find((c) => c.kind === "tool"), "the judge's card");
    expect(card.bot).toBe("alpha");
    expect(card.fields["what"]).toEqual({ type: "code", code: real });
    expect(card.fields["reason"]).toEqual({ type: "text", text: "alpha's agent (moss-code) is asking, not alpha itself." });
    expect(card.fields["source"]).toMatchObject({ type: "rows", rows: [{ label: "Agent", value: "moss-code" }, { label: "Started by", value: "alpha" }, { label: "Folder" }] });
    expect(card.options.map((o) => o.remember)).toEqual([undefined, undefined]);
    await approve(w, card.id, "approve");
    await waitFor(() => wire(w, r.transcript).includes(`${tool} ran with`), "the tool's answer");
    expect(kinds(r.sessionId)).toEqual(["tool"]);
  });

  test("read-only: the call is refused with no card of any kind", async () => {
    const { w } = await setup({ ...codeBackend(spawn), long: true, level: "read-only" });
    const kinds = raised(w);
    const r = await code(w, `mcp__${CODE_BRIDGE}__${short} {"n":8}`);
    await waitFor(() => wire(w, r.transcript).includes("stopReason"), "the turn's end");
    expect(wire(w, r.transcript)).not.toContain(`${tool} ran with`);
    expect(kinds(r.sessionId)).toEqual([]);
  });

  /** Answers (deny) every card raised for the session until `done`, saying each card's kind and the call it shows. */
  const denyUntil = async (w: World, session: () => string | undefined, done: () => boolean) => {
    const shown: string[] = [];
    await waitFor(async () => {
      const id = session();
      for (const c of id === undefined ? [] : mine(w, id)) {
        shown.push(`${c.kind}: ${JSON.stringify(c.fields["command"] ?? c.fields["what"])}`);
        await approve(w, c.id, (c.options.find((o) => o.kind === "deny") ?? c.options[c.options.length - 1]!).id);
      }
      return done();
    }, "the calls' answers");
    return shown;
  };
  const can = (call: CanUseTool, name: string, input: Record<string, unknown>, id: string) => call(name, input, { signal: new AbortController().signal, toolUseID: id } as Parameters<CanUseTool>[2]).then((r) => `${name.startsWith("mcp__") ? "plugin" : name}: ${r?.behavior}`);

  test("two tool uses with one id: the plugin call's record is consumed on its first lookup and bound to its own tool, so the other (a Bash naming the tool) still asks on agent-permission", async () => {
    const answers: string[] = [];
    let finished = false;
    const plugin = `mcp__${CODE_BRIDGE}__${short}`;
    const bash = { command: plugin };
    const query = askingQuery(async (call) => {
      // The plugin call asked first, then a Bash under the same id while its ask is out: the Bash finds no record.
      answers.push(...await Promise.all([can(call, plugin, {}, "toolu_same_a"), can(call, "Bash", bash, "toolu_same_a")]));
      // The Bash asked first, the plugin call's record made while the Bash's request is on its way: the Bash's lookup
      // finds a record for another tool (bound: not taken) and consumes it, so the plugin call asks on a card too.
      answers.push(...await Promise.all([can(call, "Bash", bash, "toolu_same_b"), can(call, plugin, {}, "toolu_same_b")]));
      finished = true;
    });
    const { w } = await setup({ ...codeBackend(spawn, query), long: true, level: "ask" });
    let id: string | undefined;
    const started = code(w, "anything").then((r) => { id = r.sessionId; });
    const shown = await denyUntil(w, () => id, () => finished);
    await started;
    const bashCard = `agent-permission: ${JSON.stringify({ type: "code", code: plugin })}`;
    // The first pair: the plugin call through to the bridge's judge with no card; the Bash on its card, denied.
    expect(answers.slice(0, 2)).toEqual(["plugin: allow", "Bash: deny"]);
    // The second pair: both on agent-permission cards, both denied; nothing passed by the bridge rule.
    expect(answers.slice(2)).toEqual(["Bash: deny", "plugin: deny"]);
    // Three agent-permission cards: the two Bashes (their command names the tool) and the second plugin call (with no
    // input, its card shows its title, its own name).
    expect(shown).toEqual([bashCard, bashCard, bashCard]);
  });

  test("the bridge's own tools (Glossary; SendMessage for a bot's agent) raise no card, in a user's coding session or a bot's agent, at the ask level; a tool that needs one still does", async () => {
    let finished = 0;
    const answers: string[] = [];
    const query = askingQuery(async (call) => {
      answers.push(await (finished === 0 ? can(call, `mcp__${CODE_BRIDGE}__Glossary`, { query: "haiku" }, "toolu_glossary") : can(call, `mcp__${CODE_BRIDGE}__SendMessage`, { message: "halfway" }, "toolu_send")));
      finished++;
    });
    const { w } = await setup({ ...codeBackend(spawn, query), long: true, level: "ask" });
    let id: string | undefined;
    void code(w, "anything").then((r) => { id = r.sessionId; });
    const user = await denyUntil(w, () => id, () => finished === 1);
    let agentId: string | undefined;
    void w.manager.start({ caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" }, backend: MOSS_CODE_ID, root: "home/Studio/project1", title: "Report", model: CODE_MODEL, prompt: "anything" }).then((r) => { agentId = r.sessionId; });
    const agent = await denyUntil(w, () => agentId, () => finished === 2);
    // Rule 2 lets them through (the engine's own tools for the session, as for a bot): allowed, and no card for either.
    expect(answers).toEqual(["plugin: allow", "plugin: allow"]);
    expect([user.length, agent.length]).toEqual([0, 0]);
  });

  test("a tool that isn't a plugin's on the bridge still asks on the agent-permission card", async () => {
    const { w } = await setup({ ...codeBackend(spawn), long: true, level: "ask" });
    const kinds = raised(w);
    const r = await code(w, `Write {"file_path":${JSON.stringify(join(w.project, "note.txt"))},"content":"ok"}`);
    const card = await waitFor(() => mine(w, r.sessionId).find((c) => c.kind === "agent-permission"), "the agent-permission card");
    await approve(w, card.id, card.options[0]!.id);
    await waitFor(() => existsSync(join(w.project, "note.txt")), "the write");
    expect(kinds(r.sessionId)).toEqual(["agent-permission"]);
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
    // In its tag, as a bot's Glossary gives it.
    expect(String((r.loaded[0] as { text?: string }).text)).toStartWith('<skill name="kit:haiku">\n');
    // Its tools are the bridge's names.
    const t = await glossary("s", { query: "toolbox" }, facts());
    expect(t.results).toEqual(expect.arrayContaining([expect.objectContaining({ name: TOOL, kind: "tool" })]));
  });
});

describe("one scope rule (servesScope) at every call site", () => {
  /** The bots' Glossary index for a bot's own session, as the driver builds it (`partsServe` on the registry). */
  const botIndex = (registry: Parameters<typeof partsServe>[0] & Parameters<typeof glossaryIndex>[0]["registry"], bot: string, kind: "bot" | "side-thread" = "bot") =>
    glossaryIndex({ tools: () => [], registry: registry!, serves: (id) => partsServe(registry!, id, { kind, bot }), bot }).map((i) => i.name);

  test("a bots-scoped plugin: its tools and its skills both reach a bot's delegated agent; never the user's coding session", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    const parts = agentPluginParts(p.deps);
    const agent = facts({ id: "s_agent", kind: "agent", bot: "nova" });
    expect((await tools.tools("s", agent)).map((t) => t.name)).toContain("botsonly-tools__botsonly");
    expect((await parts.parts("s", agent)).skills.map((x) => x.name)).toContain("botsonly-limerick");
    const g = await agentGlossary(p.deps)("s", { load: "botsonly:limerick" }, agent);
    expect(g.loaded).toEqual([expect.objectContaining({ name: "botsonly:limerick", kind: "skill" })]);
    // The routed call the daemon's approvals read: the same server for the agent.
    expect(p.mcp.routedTool("agent", "mcp__botsonly-tools__botsonly", undefined, "nova")?.plugin).toBe("botsonly");
    // The user's own coding session: none of it.
    expect((await tools.tools("s", facts())).map((t) => t.name)).not.toContain("botsonly-tools__botsonly");
    expect((await parts.parts("s", facts())).skills.map((x) => x.name)).not.toContain("botsonly-limerick");
    expect(p.mcp.routedTool("coding", "mcp__botsonly-tools__botsonly")).toBeUndefined();
  });

  test("an agents-scoped plugin reaches both kinds of agent (a bot's, the user's) and no bot's own session", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    const parts = agentPluginParts(p.deps);
    for (const f of [facts(), facts({ id: "s_agent", kind: "agent", bot: "nova" })]) {
      expect((await tools.tools("s", f)).map((t) => t.name)).toContain(TOOL);
      expect((await parts.parts("s", f)).skills.map((x) => x.name)).toContain("kit-haiku");
    }
    // A bot's conversation and side thread: neither the agents' server nor the agents' skill and agent definition;
    // the bots' plugin's are there.
    for (const kind of ["bot", "side-thread"] as const) {
      const servers = p.mcp.servers(kind, undefined, "nova").map((sv) => sv.plugin);
      expect(servers).not.toContain("toolbox");
      expect(servers).toContain("botsonly");
      expect(p.mcp.routedTool(kind, `mcp__${TOOL}`, undefined, "nova")).toBeUndefined();
      const index = botIndex(p.registry, "nova", kind);
      expect(index).not.toContain("kit:haiku");
      expect(index).not.toContain("kit:reviewer");
      expect(index).toContain("botsonly:limerick");
    }
  });
});

describe("two bots on one computer: each one's own-bot parts are its own", () => {
  test("a bot's delegated agent and its own sessions get only their bot's own-bot server and skill, never the other bot's; a coding session neither", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    const parts = agentPluginParts(p.deps);
    const glossary = agentGlossary(p.deps);
    for (const [bot, other] of [["luna", "nova"], ["nova", "luna"]] as const) {
      const agent = facts({ id: `s_${bot}_agent`, kind: "agent", bot });
      const names = (await tools.tools("s", agent)).map((t) => t.name);
      expect(names).toContain(`${bot}-tools__${bot}`);
      expect(names).not.toContain(`${other}-tools__${other}`);
      const skills = (await parts.parts("s", agent)).skills.map((x) => x.name);
      expect(skills).toContain(`${bot}-persona`);
      expect(skills).not.toContain(`${other}-persona`);
      expect((await glossary("s", { load: [`${bot}:persona`, `${other}:persona`] }, agent)).loaded).toEqual([
        expect.objectContaining({ name: `${bot}:persona`, kind: "skill" }), { name: `${other}:persona`, found: false },
      ]);
      // A call to the other bot's tool is no tool of this agent's, and is routed for no one but its own bot.
      expect(p.mcp.routedTool("agent", `mcp__${other}-tools__${other}`, undefined, bot)).toBeUndefined();
      expect(p.mcp.routedTool("agent", `mcp__${bot}-tools__${bot}`, undefined, bot)?.plugin).toBe(bot);
      // The bot's own conversation: the same split.
      const servers = p.mcp.servers("bot", undefined, bot).map((sv) => sv.plugin);
      expect(servers).toContain(bot);
      expect(servers).not.toContain(other);
      const index = glossaryIndex({ tools: () => [], registry: p.registry, serves: (id) => partsServe(p.registry, id, { kind: "bot", bot }), bot }).map((i) => i.name);
      expect(index).toContain(`${bot}:persona`);
      expect(index).not.toContain(`${other}:persona`);
    }
    // The user's coding session: neither bot's.
    const coding = (await tools.tools("s", facts())).map((t) => t.name);
    expect(coding.some((n) => n.startsWith("luna-") || n.startsWith("nova-"))).toBe(false);
    expect((await parts.parts("s", facts())).skills.some((x) => x.pluginId === "luna" || x.pluginId === "nova")).toBe(false);
  });
});

describe("Alpha's persona stays hers", () => {
  test("her skills and agent definitions (her own and her extras') reach her sessions and her delegated agents; never another bot, another bot's agent or a coding session", async () => {
    const home = mkdtempSync(join(tmpdir(), "moss-b-alpha-"));
    temps.push(home);
    // Alpha as MOSS ships her: from a bundled folder (a copy of the repository's), which asks for no OK.
    const bundled = join(home, "bundled");
    cpSync(join(import.meta.dir, "..", "..", "..", "..", "..", "plugins", "alpha"), join(bundled, "alpha"), { recursive: true, filter: (src) => !src.includes("node_modules") });
    const opened = await openPluginRegistry({ mossHome: home, os: "linux", bundledDirs: [bundled], broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
    closers.push(() => opened.close());
    for (let i = 0; i < 250 && !["running", "enabled"].includes(String(opened.registry.get("alpha")?.state)); i++) await Bun.sleep(20);
    await opened.registry.setEnabled("alpha/extras", true);
    const active = (point: string) => opened.registry.entries(point).filter((c) => c.state === "active").map((c) => c.pluginId);
    expect(active("skills")).toEqual(expect.arrayContaining(["alpha", "alpha/extras"]));
    expect(active("agents")).toContain("alpha");
    // Her own sessions: her Glossary has them all.
    for (const kind of ["bot", "side-thread"] as const) {
      const index = glossaryIndex({ tools: () => [], registry: opened.registry, serves: (id) => partsServe(opened.registry, id, { kind, bot: "alpha" }), bot: "alpha" }).map((i) => i.name);
      expect(index).toEqual(expect.arrayContaining(["alpha:explain-like-a-friend", "alpha:plan-my-day", "alpha/extras:morning-check-in", "alpha:study-buddy"]));
    }
    // Another bot's: none of them (a point she declares, `alpha.scenes`, is a contract any plugin may fill, not hers).
    const other = glossaryIndex({ tools: () => [], registry: opened.registry, serves: (id) => partsServe(opened.registry, id, { kind: "bot", bot: "nova" }), bot: "nova" }).map((i) => i.name);
    expect(other.filter((n) => n.startsWith("alpha:") || n.startsWith("alpha/"))).toEqual([]);
    const deps = { registry: opened.registry, servers: () => [] };
    // Her own delegated agent (on MOSS's runtime): placed and in its Glossary.
    const hers = facts({ kind: "agent", bot: "alpha", backend: "moss-code" });
    const own = await agentPluginParts(deps).parts("s", hers);
    expect(own.skills.map((x) => x.name)).toEqual(expect.arrayContaining(["alpha-explain-like-a-friend", "alpha-plan-my-day"]));
    expect(own.agents.map((x) => x.name)).toContain("alpha-study-buddy");
    expect((await agentGlossary(deps)("s", { load: "alpha:study-buddy" }, hers)).loaded).toEqual([expect.objectContaining({ name: "alpha:study-buddy", kind: "agent" })]);
    for (const f of [facts(), facts({ backend: "claude-code" }), facts({ kind: "agent", bot: "nova", backend: "moss-code" })]) {
      const parts = await agentPluginParts(deps).parts("s", f);
      expect([parts.skills, parts.agents]).toEqual([[], []]);
      const g = await agentGlossary(deps)("s", { query: ["study", "morning"], load: "alpha:study-buddy" }, f);
      expect(g.results.filter((x) => String((x as { name: string }).name).startsWith("alpha"))).toEqual([]);
      expect(g.loaded).toEqual([{ name: "alpha:study-buddy", found: false }]);
    }
  });
});

describe("on demand in an agent's session: how each kind of agent is given a tool the user set so", () => {
  const quirksOf = (file: string): Parameters<typeof exposureOf>[0] => JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "plugins", "moss", "plugins", file, "quirks.json"), "utf8")).quirks;
  const coding = (o: Partial<AgentSessionFacts> = {}) => facts({ backend: "agent-x", ...o });
  const avail = (m: Map<string, "off" | "on-demand" | "always">) => (_s: string, t: string) => m.get(t);

  test("each shipped agent gets one exposure, read from what its quirks say, never from its name", () => {
    expect(exposureOf(MOSS_CODE_QUIRKS)).toBe("host-search");
    expect(exposureOf(quirksOf("agent-claude-code"))).toBe("agent-search");
    // No agent we ship besides those two declares a search of its own or a list that changes in a session.
    for (const a of ["agent-codex", "agent-gemini", "agent-cursor", "agent-antigravity", "agent-grok", "agent-deepseek", "agent-devin", "agent-devin-cloud"]) expect([a, exposureOf(quirksOf(a))]).toEqual([a, "up-front"]);
    // A search of its own wins over a list that changes; a list that changes (live, or next turn where it can be opened again) is `list`; next-turn with no honest resume is not.
    const base = quirksOf("agent-codex");
    const withMcp = (mcp: object, sessions?: object) => ({ ...base, mcp: { ...base.mcp, ...mcp }, sessions: { ...base.sessions, ...(sessions ?? {}) } }) as Parameters<typeof exposureOf>[0];
    expect(exposureOf(withMcp({ toolListChanges: "live" }))).toBe("list");
    expect(exposureOf(withMcp({ toolListChanges: "next-turn" }, { resume: { supported: true, replays: false } }))).toBe("list");
    expect(exposureOf(withMcp({ toolListChanges: "next-turn" }, { load: { supported: false, replays: false }, resume: { supported: true, replays: true } }))).toBe("up-front");
    expect(exposureOf(withMcp({ toolListChanges: "live", toolSearch: "own" }))).toBe("agent-search");
  });

  test("at the session's start each exposure lists the right thing: up front, the agent's own search and the host's all list the on-demand tool (flagged only when always on); a list that changes does not", async () => {
    const { p } = await setup();
    const tools = agentPluginTools(p.deps);
    for (const exposure of ["up-front", "agent-search", "host-search"] as const) {
      const listed = await tools.tools("s", coding({ exposure }));
      expect([exposure, listed.map((t) => t.name).includes(TOOL), listed.find((t) => t.name === TOOL)?.preload === true]).toEqual([exposure, true, false]);
    }
    expect((await tools.tools("s", coding({ exposure: "list", loaded: new Set() }))).map((t) => t.name)).not.toContain(TOOL);
    // Always on: listed and flagged up front for every kind, the list that changes included.
    const on = await setup({ availability: avail(new Map([["toolbox", "always"]])) });
    for (const exposure of ["up-front", "agent-search", "host-search", "list"] as const) {
      const listed = await agentPluginTools(on.p.deps).tools("s", coding({ exposure, loaded: new Set() }));
      expect([exposure, listed.find((t) => t.name === TOOL)?.preload === true]).toEqual([exposure, true]);
    }
  });

  test("the bridge's Glossary is a bot's: it finds plugins and points as well as tools, skills and agents, and a load answers what a bot's does", async () => {
    const { p } = await setup();
    const glossary = agentGlossary(p.deps);
    const found = await glossary("s", { query: ["toolbox", "kit"] }, coding({ exposure: "host-search" }));
    const kinds = (found.results as { name: string; kind: string }[]).map((r) => `${r.kind}:${r.name}`);
    expect(kinds).toEqual(expect.arrayContaining([`tool:${TOOL}`, "plugin:toolbox", "skill:kit:haiku"]));
    // The same index as a bot's: the points the registry knows are searchable here too.
    const points = p.registry.points().filter((pt) => pt.active);
    if (points.length > 0) expect(((await glossary("s", { query: points[0]!.name }, coding())).results as { kind: string }[]).some((r) => r.kind === "point")).toBe(true);
    // A tool: its schema, and it is the tool to load (by its bridge name).
    const tool = await glossary("s", { load: TOOL }, coding());
    expect(tool.load).toEqual([TOOL]);
    expect((tool.loaded[0] as { kind: string; text: string }).kind).toBe("tool");
    expect((tool.loaded[0] as { text: string }).text).toContain("Input schema:");
    // A plugin by id: what it offers by the bridge's names, and its tools to load.
    const plugin = await glossary("s", { load: "toolbox" }, coding());
    expect(plugin.load).toEqual([TOOL]);
    const text = (plugin.loaded[0] as { text: string }).text;
    expect(text).toContain(TOOL);
    expect(text).not.toContain("mcp__toolbox-tools__toolbox");
    // A skill as before.
    expect(((await glossary("s", { load: "kit:haiku" }, coding())).loaded[0] as { text: string }).text).toContain("five, seven, five");
  });

  test("a load reaches only what the session may use: an off tool, a plugin of another scope or backend, or an unknown name loads nothing", async () => {
    const m = new Map<string, "off" | "on-demand" | "always">([["toolbox", "off"]]);
    const { p } = await setup({ availability: avail(m) });
    const glossary = agentGlossary(p.deps);
    const g = await glossary("s", { load: [TOOL, "toolbox", "botsonly", "botsonly-tools__botsonly", "cconly", "mcp__toolbox-tools__toolbox", "nothing"] }, coding({ backend: "moss-code" }));
    expect(g.load).toBeUndefined();
    // The plugin itself is there to read about (it is running); none of its tools is, and nothing of the others.
    expect(g.loaded).toEqual([TOOL, "toolbox", "botsonly", "botsonly-tools__botsonly", "cconly", "mcp__toolbox-tools__toolbox", "nothing"].map((name) => name === "toolbox" ? expect.objectContaining({ name, kind: "plugin" }) : expect.objectContaining({ name, found: false })));
    expect(String((g.loaded[1] as { text: string }).text)).not.toContain("toolbox-tools__toolbox");
    // The engine's own name for a tool a session may use loads nothing of another server either.
    m.set("toolbox", "on-demand");
    await p.mcp.refresh();
    const ok = await glossary("s", { load: ["mcp__toolbox-tools__toolbox"] }, coding({ backend: "moss-code" }));
    expect(ok.load).toBeUndefined();
  });

  test("a list that changes: a tool is held back until loaded, a call to it before is refused, after it runs, and it is judged as any tool (its card, deny)", async () => {
    const { w, p } = await setup({ level: "ask" });
    const tools = agentPluginTools(p.deps);
    const loaded = new Set<string>();
    const f = coding({ exposure: "list", loaded });
    const ctx = { computer: "Studio", origin: "user" as const, session: f };
    expect((await tools.tools("s", f)).map((t) => t.name)).not.toContain(TOOL);
    const before = await tools.call("s", { callId: "c0", tool: TOOL, input: {} }, ctx);
    expect(before).toMatchObject({ isError: true });
    expect(JSON.stringify(before.content)).toContain("No tool named");
    expect(w.approvals.cards()).toEqual([]);
    // The load names it; the manager puts it in the set; now it is listed and the call is judged as a preloaded tool's is: a card at ask.
    const g = await agentGlossary(p.deps)("s", { load: TOOL }, f);
    for (const n of g.load ?? []) loaded.add(n);
    expect((await tools.tools("s", f)).map((t) => t.name)).toContain(TOOL);
    const running = tools.call("s", { callId: "c1", tool: TOOL, input: { n: 3 } }, ctx);
    const card = await waitFor(() => w.approvals.cards().find((c) => c.kind === "tool"), "the tool's card");
    expect(card.fields["what"]).toEqual({ type: "code", code: `mcp__${TOOL}` });
    await approve(w, card.id, "approve");
    expect(await running).toMatchObject({ isError: false });
  });

  test("through the manager: an agent whose list changes live holds the tool back at its start, and a Glossary load puts it on the list and tells the agent", async () => {
    const live = { ...WELL_BEHAVED_QUIRKS, mcp: { ...WELL_BEHAVED_QUIRKS.mcp, toolListChanges: "live" as const } };
    const { w } = await setup({ quirks: live, level: "automatic", script: [[{ say: "Ready." }]] });
    const r = await asUser(w);
    await waitFor(() => w.host.history(r.sessionId).some((x) => x.type === "turn_ended"), "the first turn", 30_000);
    const bridge = w.manager.bridgeHandlers();
    expect((await bridge.tools(r.sessionId)).tools.map((t) => t.name)).not.toContain(TOOL);
    const g = await bridge.glossary(r.sessionId, { load: TOOL });
    expect(g.load).toEqual([TOOL]);
    expect(g.note).toContain("on your tool list now");
    expect((await bridge.tools(r.sessionId)).tools.map((t) => t.name)).toContain(TOOL);
    // The call is the plugins' own (judged as ever); and a tool no load named stays out for an agent with no list of changes.
    const called = await bridge.call(r.sessionId, { callId: "c9", tool: TOOL, input: { n: 5 } });
    expect(called.isError).toBe(false);
  });

  /** The sequence the checklist asks for, over a long session: the bridge's list is always the always-on tools and the loaded ones still allowed. */
  test("a long session's sequence: on demand → loaded → off → on demand again → loaded again → plugin updated mid-conversation; the list equals always-on ∪ loaded-and-still-allowed at every step", async () => {
    const m = new Map<string, "off" | "on-demand" | "always">();
    const { p } = await setup({ availability: avail(m) });
    const tools = agentPluginTools(p.deps);
    const glossary = agentGlossary(p.deps);
    const loaded = new Set<string>();
    const f = coding({ exposure: "list", loaded });
    const NEW = "toolbox-tools__extra";
    const names = async () => (await tools.tools("s", f)).map((t) => t.name).filter((n) => n.startsWith("toolbox-tools__")).sort();
    const load = async (n: string) => { for (const x of (await glossary("s", { load: n }, f)).load ?? []) loaded.add(x); };
    const refresh = async () => { await p.mcp.refresh(); await p.mcp.settled(5_000); };
    expect(await names()).toEqual([]);                       // on demand at start: held back
    await load(TOOL);
    expect(await names()).toEqual([TOOL]);                   // loaded
    m.set("toolbox", "off"); await refresh();
    expect(await names()).toEqual([]);                       // set off: gone, and no longer loaded
    m.set("toolbox", "on-demand"); await refresh();
    expect(await names()).toEqual([]);                       // on demand again: held back until loaded again
    await load(TOOL);
    expect(await names()).toEqual([TOOL]);                   // loaded again
    hostTools.set("toolbox", ["toolbox", "extra"]);          // the plugin is updated (and approved again): a new tool, on demand
    await refresh();
    expect(await names()).toEqual([TOOL]);                   // the new one is held back; the loaded one stays
    m.set("extra", "always"); await refresh();
    expect(await names()).toEqual([NEW, TOOL].sort());       // always on: listed with no load
    hostTools.set("toolbox", ["extra"]);                      // updated again: the tool it dropped leaves the list and is no longer loaded
    await refresh();
    expect(await names()).toEqual([NEW]);
    expect(loaded.has(TOOL)).toBe(false);
    hostTools.delete("toolbox"); m.delete("extra");
    await refresh();
    expect(await names()).toEqual([]);                       // back: held back again, needing its load
  });
});

describe("one mapping between the engine's tool names and the bridge's", () => {
  const rnd = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = (r: () => number, from: string[]) => from[Math.floor(r() * from.length)]!;
  const server = (name: string, tools: string[]): BotMcpServer => ({ server: name, plugin: name, tools: tools.map((t) => ({ name: t, inputSchema: { type: "object" }, load: "on-demand" as const })) }) as unknown as BotMcpServer;

  test("property: a round trip returns the name, no two tools share a bridge name, and a hostile name never aliases another server's tool", () => {
    const r = rnd(7);
    const part = ["a", "b", "__", "_", "-", "c1", "long-plugin-name-here", "tool", "x__y", "mcp", "Z", "é", "a b"];
    for (let round = 0; round < 300; round++) {
      const servers = Array.from({ length: 1 + Math.floor(r() * 4) }, () => server(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, part)).join(""), Array.from({ length: 1 + Math.floor(r() * 4) }, () => Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, part)).join(""))));
      const listing = bridgeToolsOf(servers);
      const map = bridgeNamesOf(listing);
      const seen = new Set<string>();
      for (const t of listing.values()) {
        const engine = `mcp__${t.server.server}__${t.tool.name}`;
        expect(map.toBridge(engine)).toBe(t.name);
        expect(map.toEngine(t.name)).toBe(engine);
        expect(seen.has(t.name)).toBe(false);
        seen.add(t.name);
        expect(t.name.length).toBeLessThanOrEqual(BRIDGE_TOOL_NAME_MAX);
        expect(t.name).toMatch(/^[A-Za-z0-9_-]+$/);
      }
      // Every pair of (server, tool) that could be one name: neither is on the bridge.
      const all = servers.flatMap((s) => s.tools.map((t) => ({ s: s.server, t: t.name })));
      for (const x of all) for (const y of all) if ((x.s !== y.s || x.t !== y.t) && `${x.s}__${x.t}` === `${y.s}__${y.t}`) expect([map.toBridge(`mcp__${x.s}__${x.t}`), map.toBridge(`mcp__${y.s}__${y.t}`)]).toEqual([undefined, undefined]);
    }
    // The case named: `a` + `b__c` against `a__b` + `c`.
    const both = bridgeNamesOf(bridgeToolsOf([server("a", ["b__c"]), server("a__b", ["c"])]));
    expect(both.toBridge("mcp__a__b__c")).toBeUndefined();
  });
});
