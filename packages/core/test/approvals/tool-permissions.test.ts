// Settings' Tools tab, in the core: the three values on a plugin's tool (read by the same floor as the connector permissions),
// the refusal the bot reads, the new-tool rule, the card rules taken back, and that only the user sets any of it.
import { describe, expect, test } from "bun:test";
import type { HookCallback, HookCallbackMatcher } from "@waifucave/clover-agent-sdk";
import { CloverApprovalBroker, type StoredRule } from "../../src/approvals/broker";
import { ruleKeyHash } from "../../src/approvals/strings";
import { pluginToolName, toolPermissionMethods } from "../../src/approvals/tool-permissions";
import { connectorPermissionTable, type Settings } from "../../src/settings";
import { sessionHooksFor } from "../../src/runtime-sdk/hooks";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { ConnectorPermissionSource } from "../../src/agent/mcp/connector-permissions";
import type { MethodContext } from "../../src/rpc/handler";
import { gateCloverRequest } from "../../src/auth/clover-caller";

const USER: MethodContext = { caller: { kind: "user", client: "app" } };
const SERVER = "reel-reel";

function setup(tools: string[] = ["Export", "Trim"], rules: StoredRule[] = []) {
  let settings = {} as Settings;
  let listed = tools;
  const saves: Settings[] = [];
  const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "ask-for-risky-actions", fence: () => undefined, rules: { load: () => rules, save: (r: StoredRule[]) => { rules.length = 0; rules.push(...r); } }, localComputer: "Delta" } as never);
  const methods = toolPermissionMethods({
    listing: () => [{ server: SERVER, plugin: "reel", name: "reel", tools: listed.map((name) => ({ name })) }],
    pluginName: () => "Reel",
    loadSettings: () => settings,
    saveSettings: (next) => { settings = next; saves.push(next); },
    savedFor: (h) => broker.savedFor(h),
    forgetSaved: (h, b) => broker.forgetSaved(h, b),
  });
  return { methods, table: () => connectorPermissionTable(settings), settings: () => settings, setListed: (t: string[]) => { listed = t; }, saves, broker };
}

const list = async (s: ReturnType<typeof setup>) => (await s.methods["tool.permissions"]!({}, USER)) as { plugins: { name: string; tools: { name: string; permission: string; isNew?: boolean; cardRules: { bot: string; computers: string[] }[] }[] }[] };
const set = (s: ReturnType<typeof setup>, p: Record<string, unknown>, ctx = USER) => s.methods["tool.setPermission"]!(p, ctx);

/** The floor's own decision on a plugin tool's call, as a session's hook gives it. */
function floor(table: ConnectorPermissionSource["table"]): (tool: string) => Promise<{ decision: string; reason?: string }> {
  const source: ConnectorPermissionSource = { table, readOnly: () => undefined };
  const built = sessionHooksFor({ sessionId: "s_1", roots: ["/tmp"], mode: "chat", cwd: "/tmp", policy: () => "ask", connectors: source });
  const hook: HookCallback = (built.clover?.PreToolUse ?? []).filter((g: HookCallbackMatcher) => g.matcher === undefined)[1]!.hooks[0]!;
  return async (tool) => {
    const r = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { anything: "at all" }, session_id: "b", transcript_path: "", cwd: "/tmp" } as never, "tu1", { signal: new AbortController().signal }) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    return { decision: r.hookSpecificOutput?.permissionDecision ?? "none", ...(r.hookSpecificOutput?.permissionDecisionReason !== undefined ? { reason: r.hookSpecificOutput.permissionDecisionReason } : {}) };
  };
}

describe("the three values on a plugin's tool", () => {
  test("every tool starts at Ask; Always allow and Always block are stored, and Ask clears the value", async () => {
    const s = setup();
    expect((await list(s)).plugins[0]!.tools.map((t) => [t.name, t.permission])).toEqual([["Export", "ask"], ["Trim", "ask"]]);
    await set(s, { server: SERVER, tool: "Export", permission: "allow" });
    await set(s, { server: SERVER, tool: "Trim", permission: "deny" });
    expect(s.table()).toEqual({ [SERVER]: { Export: "allow", Trim: "deny" } });
    expect((await list(s)).plugins[0]!.tools.map((t) => [t.name, t.permission])).toEqual([["Export", "allow"], ["Trim", "deny"]]);
    await set(s, { server: SERVER, tool: "Export", permission: "ask" });
    expect(s.table()).toEqual({ [SERVER]: { Trim: "deny" } });
  });

  test("the same floor that decides a call reads the value on the next call, with no restart: allow runs with no card, block is refused", async () => {
    const s = setup();
    const decide = floor(() => s.table());
    const tool = pluginToolName(SERVER, "Export");
    expect(tool).toBe("mcp__reel-reel__Export");
    expect((await decide(tool)).decision).not.toBe("allow");
    await set(s, { server: SERVER, tool: "Export", permission: "allow" });
    expect((await decide(tool)).decision).toBe("allow");
    await set(s, { server: SERVER, tool: "Export", permission: "deny" });
    expect((await decide(tool)).decision).toBe("deny");
    await set(s, { server: SERVER, tool: "Export", permission: "ask" });
    expect((await decide(tool)).decision).not.toBe("deny");
  });

  test("a blocked call is refused with no card, and the bot is told plainly that the user blocked this tool in Settings and not to retry", async () => {
    const s = setup();
    await set(s, { server: SERVER, tool: "Export", permission: "deny" });
    const r = await floor(() => s.table())("mcp__reel-reel__Export");
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("blocked this tool in Settings");
    expect(r.reason).toContain("Do not retry");
    expect(r.reason).toContain("Export");
  });
});

describe("a plugin's row, and a tool that appears later", () => {
  test("the row sets each tool listed now (never a wildcard); a tool added later starts at Ask, is marked new, and keeps Ask", async () => {
    const s = setup(["Export", "Trim"]);
    await set(s, { server: SERVER, permission: "allow" });
    expect(s.table()).toEqual({ [SERVER]: { Export: "allow", Trim: "allow" } });
    expect(Object.keys(s.table()[SERVER]!)).not.toContain("*");
    s.setListed(["Export", "Trim", "Render"]);
    const tools = (await list(s)).plugins[0]!.tools;
    expect(tools.map((t) => [t.name, t.permission, t.isNew === true])).toEqual([["Export", "allow", false], ["Trim", "allow", false], ["Render", "ask", true]]);
    const decide = floor(() => s.table());
    expect((await decide("mcp__reel-reel__Render")).decision).not.toBe("allow");
  });

  test("a value for a tool the plugin no longer lists is not shown and is dropped the next time the user sets one", async () => {
    const s = setup(["Export", "Trim"]);
    await set(s, { server: SERVER, permission: "deny" });
    s.setListed(["Export"]);
    expect((await list(s)).plugins[0]!.tools.map((t) => t.name)).toEqual(["Export"]);
    await set(s, { server: SERVER, tool: "Export", permission: "allow" });
    expect(s.table()).toEqual({ [SERVER]: { Export: "allow" } });
  });

  test("a tool the plugin doesn't give, or a plugin that gives none, is refused", async () => {
    const s = setup();
    await expect(set(s, { server: SERVER, tool: "Nope", permission: "allow" })).rejects.toThrow();
    await expect(set(s, { server: "other-server", permission: "allow" })).rejects.toThrow();
  });
});

describe("a card's Always allow, shown on the tool's row and taken back there", () => {
  const rule = (tool: string, bot: string): StoredRule => ({ keyHash: ruleKeyHash(`tool:${pluginToolName(SERVER, tool)}`), display: `Always allow: every call to ${pluginToolName(SERVER, tool)}`, computers: ["Delta"], cardId: "card_1", savedAt: 1, bot });

  test("the row lists the bot and the computers; taking it back removes it from the broker and the file, for that bot only", async () => {
    const stored: StoredRule[] = [rule("Export", "alpha"), rule("Export", "luna"), rule("Trim", "alpha")];
    const s = setup(["Export", "Trim"], stored);
    expect((await list(s)).plugins[0]!.tools.map((t) => [t.name, t.cardRules])).toEqual([
      ["Export", [{ bot: "alpha", computers: ["Delta"] }, { bot: "luna", computers: ["Delta"] }]],
      ["Trim", [{ bot: "alpha", computers: ["Delta"] }]],
    ]);
    expect(await s.methods["tool.takeBackRule"]!({ server: SERVER, tool: "Export", bot: "alpha" }, USER)).toEqual({ removed: 1 });
    expect((await list(s)).plugins[0]!.tools.map((t) => [t.name, t.cardRules.map((r) => r.bot)])).toEqual([["Export", ["luna"]], ["Trim", ["alpha"]]]);
    expect(stored.map((r) => [r.keyHash === rule("Export", "x").keyHash, r.bot])).toEqual([[true, "luna"], [false, "alpha"]]);
  });
});

describe("only the user changes or reads these", () => {
  const callers: [string, MethodContext][] = [
    ["a plugin (its layer or its host half)", { caller: { kind: "plugin", pluginId: "reel" } }],
    ["a bot's session or tool call", { caller: { kind: "session", sessionId: "s_1", sessionKind: "bot", bot: "alpha" } }],
    ["a coding agent's session", { caller: { kind: "session", sessionId: "s_2", sessionKind: "coding" } }],
    ["the core", { caller: { kind: "core" } }],
    ["another computer", { caller: { kind: "peer", device: "dev_1" } }],
  ] as never;
  for (const [who, ctx] of callers) {
    test(`${who} can neither set, take back nor read`, async () => {
      const s = setup(["Export"], [{ keyHash: ruleKeyHash("tool:mcp__reel-reel__Export"), display: "x", computers: ["Delta"], cardId: "c", savedAt: 1, bot: "alpha" }]);
      await expect(set(s, { server: SERVER, tool: "Export", permission: "allow" }, ctx)).rejects.toThrow(/only the user/);
      await expect(s.methods["tool.takeBackRule"]!({ server: SERVER, tool: "Export", bot: "alpha" }, ctx)).rejects.toThrow(/only the user/);
      await expect(s.methods["tool.permissions"]!({}, ctx)).rejects.toThrow(/only the user/);
      expect(s.saves).toEqual([]);
      expect(s.broker.savedFor(ruleKeyHash("tool:mcp__reel-reel__Export"))).toHaveLength(1);
    });
  }

  test("the door refuses a plugin's own layer connection or a session before any handler runs", () => {
    for (const m of ["tool.permissions", "tool.setPermission", "tool.takeBackRule"]) {
      expect(gateCloverRequest("layer", { kind: "plugin", pluginId: "reel" }, m)).not.toBeNull(); // not a layer's method at all
      expect(gateCloverRequest("app", { kind: "plugin", pluginId: "reel" }, m)).not.toBeNull();
      expect(gateCloverRequest("app", { kind: "session", sessionId: "s_1", sessionKind: "bot" } as never, m)).not.toBeNull();
      expect(gateCloverRequest("app", { kind: "user", client: "app" }, m)).toBeNull();
    }
  });

  test("the protocol marks all three methods userOnly, and none is open to a plugin's own connection beyond the gate", async () => {
    const { CLOVER_METHODS } = await import("@waifucave/clover-protocol");
    for (const m of ["tool.permissions", "tool.setPermission", "tool.takeBackRule"]) {
      const spec = CLOVER_METHODS.get(m)!;
      expect([m, spec.userOnly]).toEqual([m, true]);
      expect(spec.roles).not.toContain("plugin-host");
    }
  });
});

describe("a bot's approval check reads the setting at each call", () => {
  const ctx = { botId: "luna", sessionId: "s1", kind: "bot", computer: "Studio", paths: { scratch: "/tmp" }, caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } } as never;
  const run = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
  const tool = "mcp__reel-reel__Export";
  test("Always allow runs the tool with no card at every level, Always block refuses with the message and no card, Ask judges as before", async () => {
    const { botApprovalCheck } = await import("../../src/approvals/bot-check");
    let setting: "allow" | "deny" | undefined;
    for (const level of ["read-only", "ask", "ask-risky", "automatic"] as const) {
      const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => level, localComputer: "Studio" });
      const check = botApprovalCheck(broker, { toolSetting: () => (setting === "deny" ? { setting: "deny", message: "the user blocked this tool in Settings (Tools)" } : setting === "allow" ? { setting: "allow" } : undefined) });
      setting = "allow";
      expect([level, (await check(ctx, () => "user")(tool, { any: "thing" }, run))?.behavior]).toEqual([level, "allow"]);
      setting = "deny";
      const d = await check(ctx, () => "user")(tool, {}, run);
      expect(d).toMatchObject({ behavior: "deny" });
      expect((d as { message: string }).message).toContain("blocked this tool in Settings");
      expect(broker.cards()).toHaveLength(0);
    }
    // Ask: nothing stored, the call goes to the broker (a card at "ask").
    const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "ask", localComputer: "Studio" });
    setting = undefined;
    const check = botApprovalCheck(broker, { toolSetting: () => undefined });
    void check(ctx, () => "user")(tool, {}, run);
    await new Promise((r) => setTimeout(r, 20));
    expect(broker.cards()).toHaveLength(1);
  });
  test("the core's own tools never read the setting", async () => {
    const { botApprovalCheck } = await import("../../src/approvals/bot-check");
    const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "read-only", localComputer: "Studio" });
    let asked = 0;
    const check = botApprovalCheck(broker, { hostTools: () => ["SendMessage"], toolSetting: () => (asked++, { setting: "allow" }) });
    await check(ctx, () => "user")("Bash", { command: "ls" }, run);
    await check(ctx, () => "user")("SendMessage", { to: "x", message: "y" }, run);
    expect(asked).toBe(0);
  });
});
