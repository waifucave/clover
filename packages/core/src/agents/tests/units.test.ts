// Unit checks for the Agent tool's small parts: the JSON-RPC peer, the environment allow-list, the process table,
// version ranges, the "once" rule, the transcript's redaction, and the tokens' rules.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError, RpcPeer, type JsonRpcMessage } from "../acp/jsonrpc";
import { onceOnly } from "../acp/session";
import { isAuthRequired, pathsOf, readCaps, readConfigOptions } from "../acp/types";
import { versionSatisfies } from "../backend";
import { BridgeTokens } from "../bridge/tokens";
import { buildAgentEnv } from "../process/launch";
import { descendantsOf, isDescendant, parseElapsed, parsePs, type ProcessRow } from "../process/table";
import { ANTIGRAVITY_QUIRKS, CURSOR_QUIRKS } from "../quirks";
import { S5_ANTIGRAVITY_QUIRKS, S5_CURSOR_QUIRKS } from "../../contracts/fakes/agent-backend";
import { AgentTranscript, REDACTED_TOKEN, botSegment, transcriptPaths } from "../transcript";
import { effectOf, promptOf, ruleKeyOf } from "../manager";

function pair(opts: { stringIds?: boolean } = {}) {
  const tapped: [string, JsonRpcMessage][] = [];
  let a!: RpcPeer;
  let b!: RpcPeer;
  a = new RpcPeer({ write: (l) => queueMicrotask(() => b.feed(l)), tap: (d, m) => tapped.push([d, m]), onRequest: (m, p) => (m === "echo" ? p : m === "boom" ? Promise.reject(new RpcError(-32001, "boom")) : undefined), ...(opts.stringIds ? { stringIds: true } : {}) });
  b = new RpcPeer({ write: (l) => queueMicrotask(() => a.feed(l)), onRequest: (m, p) => (m === "echo" ? p : undefined) });
  return { a, b, tapped };
}

describe("RpcPeer", () => {
  test("requests both ways, with number or string ids, and every message tapped", async () => {
    const { a, b, tapped } = pair({ stringIds: true });
    expect(await a.request("echo", { x: 1 })).toEqual({ x: 1 });
    expect(await b.request("echo", [2])).toEqual([2]);
    expect(tapped.find(([d]) => d === "out")?.[1].id).toBe("0");
    expect(tapped.filter(([d]) => d === "in").length).toBeGreaterThanOrEqual(2);
  });

  test("an error answer rejects with its code; a missing handler answers method-not-found", async () => {
    const { a, b } = pair();
    const err = await b.request("boom").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32001);
    let x!: RpcPeer;
    const lone = new RpcPeer({ write: (l) => queueMicrotask(() => x.feed(l)) });
    x = new RpcPeer({ write: (l) => queueMicrotask(() => lone.feed(l)) });
    const missing = await lone.request("anything").catch((e: unknown) => e);
    expect((missing as RpcError).code).toBe(-32601);
    void a;
  });

  test("a line that isn't JSON is skipped, not fatal; close rejects what waits", async () => {
    const bad: string[] = [];
    const p = new RpcPeer({ write: () => {}, onBadLine: (r) => bad.push(r) });
    p.feed("not json\n");
    expect(bad.length).toBe(1);
    const pending = p.request("never");
    p.close(new Error("gone"));
    expect(await pending.catch((e: Error) => e.message)).toBe("gone");
    expect(p.closed).toBe(true);
  });
});

describe("the environment allow-list", () => {
  test("only the base set, the backend's names and LC_* pass; nothing named CLOVER_* ever does", () => {
    const env = buildAgentEnv(["CURSOR_CONFIG_DIR", "CLOVER_HOME"], { NO_OPEN_BROWSER: "1", CLOVER_X: "no" }, {
      PATH: "/bin", HOME: "/h", LC_ALL: "C", CURSOR_CONFIG_DIR: "/c", CLOVER_HOME: "/secret", CLOVER_BRIDGE_TOKEN: "t", OPENAI_API_KEY: "k", AWS_SECRET_ACCESS_KEY: "s",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", CURSOR_CONFIG_DIR: "/c", NO_OPEN_BROWSER: "1" });
  });
});

describe("the process table", () => {
  test("ps's elapsed times and rows parse", () => {
    expect(parseElapsed("05:03")).toBe(303);
    expect(parseElapsed("2:05:03")).toBe(7503);
    expect(parseElapsed("1-00:00:01")).toBe(86_401);
    expect(parseElapsed("x")).toBeNull();
    expect(parsePs("  10     1   01:00\n  11    10   00:05\nbad line\n", 1_000_000)).toEqual([
      { pid: 10, ppid: 1, startedAt: 940_000 }, { pid: 11, ppid: 10, startedAt: 995_000 },
    ]);
  });

  test("ancestry walks parents, never loops, and stops at the root", () => {
    const rows: ProcessRow[] = [
      { pid: 100, ppid: 1, startedAt: 0 }, { pid: 101, ppid: 100, startedAt: 0 }, { pid: 102, ppid: 101, startedAt: 5 },
      { pid: 200, ppid: 1, startedAt: 0 }, { pid: 300, ppid: 301, startedAt: 0 }, { pid: 301, ppid: 300, startedAt: 0 },
    ];
    expect(isDescendant(rows, 102, 100)).toBe(true);
    expect(isDescendant(rows, 100, 100)).toBe(true);
    expect(isDescendant(rows, 200, 100)).toBe(false);
    expect(isDescendant(rows, 300, 100)).toBe(false);
    expect(descendantsOf(rows, 100).map((r) => r.pid)).toEqual([101, 102]);
  });

  test("version ranges", () => {
    expect(versionSatisfies("2026.10.22-27dcf5f", ">=2026.10.22")).toBe(true);
    expect(versionSatisfies("2026.9.30-abc", ">=2026.10.22")).toBe(false);
    expect(versionSatisfies("1.4.12", ">=1.4.12 <1.5.0")).toBe(true);
    expect(versionSatisfies("1.5.0", ">=1.4.12 <1.5.0")).toBe(false);
    expect(versionSatisfies("nonsense", ">=1.0.0")).toBe(false);
  });
});

describe("reading ACP tolerantly", () => {
  test("Antigravity's snake_case capabilities and its system-prompt append; Cursor's MCP capabilities", () => {
    const agy = readCaps({ protocolVersion: 1, agentCapabilities: { load_session: true, session_capabilities: { resume: {}, close: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } } });
    expect(agy).toMatchObject({ loadSession: true, resume: true, close: true, systemPromptAppend: true, mcpHttp: false });
    const cursor = readCaps({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true } }, authMethods: [{ id: "cursor_login", name: "Cursor Login" }] });
    expect(cursor).toMatchObject({ loadSession: true, resume: false, mcpHttp: true, image: true, authMethods: [{ id: "cursor_login", name: "Cursor Login" }] });
    expect(readCaps(null).loadSession).toBe(false);
  });

  test("config options, paths and the sign-in error", () => {
    expect(readConfigOptions({ configOptions: [{ id: "model", category: "model", currentValue: "a", options: [{ value: "a" }, { value: "b" }] }, { nope: 1 }] }))
      .toEqual([{ id: "model", category: "model", currentValue: "a", values: ["a", "b"] }]);
    expect(pathsOf({ locations: [{ path: "/p/a" }], content: [{ type: "diff", path: "/p/b" }] }, { Path: "/p/c", command: "ls" }).sort()).toEqual(["/p/a", "/p/b", "/p/c"]);
    expect(isAuthRequired({ code: -32000, message: "Authentication required" }, ANTIGRAVITY_QUIRKS.auth.requiredError)).toBe(true);
    expect(isAuthRequired({ code: -32603, message: "Not logged in. Run 'cursor-agent login'" }, CURSOR_QUIRKS.auth.requiredError)).toBe(true);
    expect(isAuthRequired({ code: -32603, message: "model not available on your plan" }, CURSOR_QUIRKS.auth.requiredError)).toBe(false);
  });
});

describe("answers are held to once (S5 edit 5)", () => {
  const cursor = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" as const },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" as const },
  ];
  test("an always becomes the matching once; an unknown option, or no once to give, is cancelled", () => {
    expect(onceOnly({ outcome: "selected", optionId: "allow-always" }, cursor)).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(onceOnly({ outcome: "selected", optionId: "allow-once" }, cursor)).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(onceOnly({ outcome: "selected", optionId: "made-up" }, cursor)).toEqual({ outcome: "cancelled" });
    expect(onceOnly({ outcome: "selected", optionId: "x" }, [{ optionId: "x", name: "x", kind: "reject_always" }])).toEqual({ outcome: "cancelled" });
  });
});

describe("the card's inputs", () => {
  test("effects, rule keys and prompts", async () => {
    expect(effectOf("execute")).toBe("execute");
    expect(effectOf("switch_mode")).toBe("other");
    expect(ruleKeyOf("cursor", { toolCallId: "1", toolKind: "execute", title: "`ls`", rawInput: { command: "ls -la" }, options: [], paths: [] })).toBe("Agent(cursor):Bash(ls -la)");
    expect(ruleKeyOf("cursor", { toolCallId: "1", toolKind: "other", title: "x", mcp: { server: "blender", tool: "Render" }, options: [], paths: [] })).toBe("mcp__blender__Render");
    expect(ruleKeyOf("cursor", { toolCallId: "1", toolKind: "edit", title: "x", options: [], paths: [] })).toBeUndefined();
    expect((await promptOf({ from: "bot", bot: "alpha", session: "s", text: "go on" })).text).toBe("go on");
    expect((await promptOf({ from: "note", label: "Fish", text: "hi", by: { kind: "core" } })).text).toBe("[Fish] hi");
  });
});

describe("the transcript", () => {
  test("lives under bots/<bot>/agents/<session>, drops replays, and never writes the token", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-k-tr-"));
    try {
      const t = new AgentTranscript(home, "agent_x", "pack/luna");
      expect(t.treeWirePath).toBe("bots/pack--luna/agents/agent_x/acp.ndjson");
      expect(botSegment("pack/luna")).toBe("pack--luna");
      // No id climbs out of bots/<bot>/agents/.
      expect(() => transcriptPaths(home, "..", "alpha")).toThrow();
      expect(() => transcriptPaths(home, "agent_x", "../etc")).toThrow();
      const token = "tok_0123456789abcdefghijklmnopqrstuv";
      t.redact(token);
      t.wire("out", { method: "session/new", params: { mcpServers: [{ env: [{ name: "CLOVER_BRIDGE_TOKEN", value: token }] }] } }, false, 1);
      t.wire("in", { method: "session/update", params: { old: true } }, true, 2);
      t.stderr(new TextEncoder().encode(`starting server with ${token.slice(0, 10)}`));
      t.stderr(new TextEncoder().encode(`${token.slice(10)} ok\n`));
      const wire = readFileSync(t.wirePath, "utf8");
      expect(wire).not.toContain(token);
      expect(wire).toContain(REDACTED_TOKEN);
      expect(wire.trim().split("\n").length).toBe(1);
      const err = readFileSync(t.stderrPath, "utf8");
      expect(err).not.toContain(token);
      expect(err).toContain(REDACTED_TOKEN);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the bridge's tokens", () => {
  const table = (rows: ProcessRow[]) => async () => rows;
  const tree: ProcessRow[] = [{ pid: 500, ppid: 1, startedAt: 0 }, { pid: 501, ppid: 500, startedAt: 0 }, { pid: 900, ppid: 1, startedAt: 0 }];

  test("accepted only from the agent's tree, once at a time, for its own session", async () => {
    const t = new BridgeTokens({ table: table(tree), bindWaitMs: 50 });
    const token = t.mint("s1");
    t.bind("s1", 500);
    expect(await t.accept(token, "s2", 501)).toEqual({ ok: false, reason: "wrong-session" });
    expect(await t.accept(token, "s1", 900)).toEqual({ ok: false, reason: "not-the-agent" });
    expect(await t.accept(token, "s1", null)).toEqual({ ok: false, reason: "unverified-caller" });
    expect(await t.accept("guess", "s1", 501)).toEqual({ ok: false, reason: "unknown-token" });
    const first = await t.accept(token, "s1", 501);
    expect(first.ok).toBe(true);
    expect(await t.accept(token, "s1", 501)).toEqual({ ok: false, reason: "in-use" });
    t.release("s1", (first as { connection: number }).connection);
    expect((await t.accept(token, "s1", 501)).ok).toBe(true);
  });

  test("a hello before the agent's pid is bound waits for it; revoking ends the token and says so", async () => {
    const t = new BridgeTokens({ table: table(tree), bindWaitMs: 2_000 });
    const token = t.mint("s1");
    const revoked: string[] = [];
    t.onRevoke((e) => revoked.push(e.sessionId));
    const pending = t.accept(token, "s1", 501);
    setTimeout(() => t.bind("s1", 500), 20);
    expect((await pending).ok).toBe(true);
    t.revoke("s1");
    expect(revoked).toEqual(["s1"]);
    expect(await t.accept(token, "s1", 501)).toEqual({ ok: false, reason: "unknown-token" });
    const unbound = new BridgeTokens({ table: table(tree), bindWaitMs: 20 });
    const tok2 = unbound.mint("s9");
    expect(await unbound.accept(tok2, "s9", 501)).toEqual({ ok: false, reason: "agent-not-started" });
  });

  test("minting again revokes the earlier token (a reattach)", async () => {
    const t = new BridgeTokens({ table: table(tree) });
    const a = t.mint("s1");
    const b = t.mint("s1");
    t.bind("s1", 500);
    expect((await t.accept(a, "s1", 501)).ok).toBe(false);
    expect((await t.accept(b, "s1", 501)).ok).toBe(true);
  });
});

describe("the quirks table", () => {
  test("agrees with lane B's presets on every row S5 measured", () => {
    for (const [mine, theirs] of [[CURSOR_QUIRKS, S5_CURSOR_QUIRKS], [ANTIGRAVITY_QUIRKS, S5_ANTIGRAVITY_QUIRKS]] as const) {
      expect(mine.turns).toEqual(theirs.turns);
      expect(mine.config).toEqual(theirs.config);
      expect(mine.permissions.optionKinds).toEqual(theirs.permissions.optionKinds);
      expect(mine.permissions.mcpNames).toEqual(theirs.permissions.mcpNames);
      expect(mine.marks).toEqual(theirs.marks);
      expect(mine.sessions.load).toEqual(theirs.sessions.load);
      expect(mine.sessions.resume).toEqual(theirs.sessions.resume);
      expect(mine.sessions.replayKeepsToolCallIds).toBe(theirs.sessions.replayKeepsToolCallIds);
      expect(mine.mcp.storesPlainText).toBe(theirs.mcp.storesPlainText);
      expect(mine.mcp.passesEnvironment).toBe(theirs.mcp.passesEnvironment);
      expect(mine.mcp.systemPromptChannel).toBe(theirs.mcp.systemPromptChannel);
    }
  });
});
