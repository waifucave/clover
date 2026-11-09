// Unit checks for the Agent tool's small parts: the JSON-RPC peer, the environment allow-list, the process table,
// version ranges, the "once" rule, the transcript's redaction, and the tokens' rules.
import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError, RpcPeer, type JsonRpcMessage } from "@waifucave/clover-agent-sdk/acp";
import { UserSelections } from "../acp/selections";
import { MAX_RAW_INPUT_CHARS, capRawInput, onceOnly } from "../acp/session";
import { isAuthRequired, pathsOf, readCaps, readConfigOptions } from "@waifucave/clover-agent-sdk/acp";
import { AcpAgentBackend, versionSatisfies } from "../backend";
import { BridgeTokens } from "../bridge/tokens";
import { buildAgentEnv, launchContained, spawnPlan } from "../process/launch";
import { bridgeCloverParts } from "../bridge/handlers";
import { BRIDGE_ENV, runBridge } from "../bridge/server";
import type { CloverConn } from "../../ipc/clover";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import { fakeLaunch } from "../testing/harness";
import { descendantsOf, isDescendant, parseElapsed, parsePs, type ProcessRow } from "../process/table";
import { bundledBackends } from "../testing/bundled-backends";

// The bundled backends' rows, as their plugins hold them.
const ROWS = bundledBackends();
const QUIRKS = Object.fromEntries(Object.entries(ROWS).map(([id, r]) => [id, r.quirks]));
const CURSOR_QUIRKS = QUIRKS["cursor"]!;
const ANTIGRAVITY_QUIRKS = QUIRKS["antigravity"]!;
import { S5_ANTIGRAVITY_QUIRKS, S5_CURSOR_QUIRKS } from "../../contracts/fakes/agent-backend";
import { MAX_CHECKED_PATHS, agentPaths } from "../paths";
import { AgentTranscript, REDACTED_TOKEN, botSegment, redactDeep, transcriptPaths } from "../transcript";
import { effectOf, promptOf, ruleKeyOf } from "../manager";
import { ADMISSIONS, admissionFor } from "../sandbox/admission";
import { FileAgentOks, agentOksPath } from "../sandbox/oks";
import { fileToolDenials, homeReach, realPathOf, withHomeDenied } from "../memory";

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
    expect(ruleKeyOf("cursor", { toolCallId: "1", toolKind: "other", title: "x", mcp: { server: "blender", tool: "Render" }, options: [], paths: [] })).toBe('Agent(cursor):mcp(["blender","Render"])');
    // No two calls share a key: `a__b` + `c` and `a` + `b__c` (check 2's minor 2).
    const mcpKey = (server: string, tool: string) => ruleKeyOf("cursor", { toolCallId: "1", toolKind: "other", title: "x", mcp: { server, tool }, options: [], paths: [] });
    expect(mcpKey("a__b", "c")).not.toBe(mcpKey("a", "b__c"));
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

  test("a token expires after its life, live agent or not", async () => {
    let now = 1_000;
    const t = new BridgeTokens({ table: table(tree), ttlMs: 60_000, now: () => now });
    const token = t.mint("s1");
    t.bind("s1", 500);
    now += 60_001;
    expect(await t.accept(token, "s1", 501)).toEqual({ ok: false, reason: "expired" });
  });

  test("a revoke while the process table is read wins (review 5, the E2 probe); isLive follows the token", async () => {
    let release!: () => void;
    const slow = () => new Promise<ProcessRow[]>((r) => (release = () => r(tree)));
    const t = new BridgeTokens({ table: slow, bindWaitMs: 50 });
    const token = t.mint("s1");
    t.bind("s1", 500);
    const pending = t.accept(token, "s1", 501);
    await new Promise((r) => setTimeout(r, 10));
    t.revoke("s1");
    release();
    expect(await pending).toEqual({ ok: false, reason: "revoked" });
    const t2 = new BridgeTokens({ table: table(tree) });
    const tok = t2.mint("s2");
    t2.bind("s2", 500);
    const ok = (await t2.accept(tok, "s2", 501)) as { ok: true; connection: number };
    expect(t2.isLive("s2", ok.connection)).toBe(true);
    expect(t2.isLive("s2", ok.connection + 1)).toBe(false);
    t2.revoke("s2");
    expect(t2.isLive("s2", ok.connection)).toBe(false);
  });

  test("on Windows the agent's job object is the caller check, not the process tree", async () => {
    const t = new BridgeTokens({ table: table(tree), bindWaitMs: 50 });
    const token = t.mint("s1");
    const inJob = new Set([777]);
    t.bind("s1", 500, (pid) => inJob.has(pid));
    // 501 descends from 500 in the table, but isn't in the job: refused; 777 is in the job: accepted.
    expect(await t.accept(token, "s1", 501)).toEqual({ ok: false, reason: "not-the-agent" });
    expect((await t.accept(token, "s1", 777)).ok).toBe(true);
  });

  test("the bridge's methods refuse a connection that isn't its session token's live one", async () => {
    const t = new BridgeTokens({ table: table(tree) });
    const token = t.mint("s1");
    t.bind("s1", 500);
    const v = await t.accept(token, "s1", 501);
    if (!v.ok) throw new Error(v.reason);
    const parts = bridgeCloverParts(t, {
      sessionInfo: () => ({ bot: "alpha" }), tools: async () => ({ tools: [], instructions: "" }),
      call: async () => ({ content: [], isError: false }), sendMessage: async () => {}, glossary: async () => ({ results: [], loaded: [] }),
    });
    const caller = { kind: "session", sessionId: "s1", sessionKind: "agent", bot: "alpha" };
    const conn = { caller, bridgeConnection: v.connection } as unknown as CloverConn;
    const refusal = (c: CloverConn) => Promise.resolve().then(() => parts.handlers["bridge.tools"]!(c, {})).then(() => "ran", (e: unknown) => (e as Error).message);
    expect(await parts.handlers["bridge.tools"]!(conn, {})).toEqual({ tools: [], instructions: "" });
    // No connection number, or another one: refused while the session's token is live.
    expect(await refusal({ caller } as unknown as CloverConn)).toBe("this bridge's connection isn't its token's live one");
    expect(await refusal({ caller, bridgeConnection: v.connection + 1 } as unknown as CloverConn)).toBe("this bridge's connection isn't its token's live one");
    t.revoke("s1");
    expect(await refusal(conn)).toBe("this bridge's connection isn't its token's live one");
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

describe("the user's own selections (review 10)", () => {
  test("one record per backend: the first holder captures, the last one sets back, a crash keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-k-sel-"));
    try {
      const sel = new UserSelections(dir);
      const a = {};
      const b = {};
      sel.begin("cursor", "model", a, "user-model");
      sel.set("cursor", "model", "bot-a");
      // A second delegation at the same time reads the first one's choice: it captures nothing.
      sel.begin("cursor", "model", b, "bot-a");
      sel.set("cursor", "model", "bot-b");
      expect(sel.end("cursor", "model", a, true)).toBeUndefined();
      expect(sel.end("cursor", "model", b, true)).toBe("user-model");
      sel.restored("cursor", "model");
      expect(sel.record("cursor", "model")).toBeUndefined();
      // A crash: nothing to set it back through, so the record stays, on disk, for the next daemon.
      sel.begin("cursor", "model", a, "user-model");
      sel.set("cursor", "model", "bot-a");
      expect(sel.end("cursor", "model", a, false)).toBeUndefined();
      const next = new UserSelections(dir);
      expect(next.record("cursor", "model")).toEqual({ user: "user-model", ours: "bot-a" });
      // The next delegation finds Clover's value still set: the old record stands.
      next.begin("cursor", "model", b, "bot-a");
      expect(next.end("cursor", "model", b, true)).toBe("user-model");
      // Had the user changed it since, their new choice would be the one kept.
      const later = new UserSelections(dir);
      later.begin("cursor", "model", a, "user-model");
      later.set("cursor", "model", "bot-a");
      later.end("cursor", "model", a, false);
      later.begin("cursor", "model", b, "user-new");
      expect(later.end("cursor", "model", b, true)).toBe("user-new");
      later.restored("cursor", "model");
      // A session that opens finds a leftover with no holder: still Clover's value, so the user's comes back now;
      // a value the user set since drops the record (check 2's minor 4).
      later.begin("cursor", "model", a, "user-model");
      later.set("cursor", "model", "bot-a");
      later.end("cursor", "model", a, false);
      expect(later.leftover("cursor", "model", "bot-a")).toBe("user-model");
      expect(later.leftover("cursor", "model", "user-changed")).toBeUndefined();
      expect(later.record("cursor", "model")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the paths the fence sees (review 8)", () => {
  test("relative, ~ and file: paths resolve against the root; a path through a link adds its real path", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "clover-k-paths-")));
    try {
      const root = join(dir, "project");
      const clover = join(dir, ".clover");
      mkdirSync(root);
      mkdirSync(clover);
      symlinkSync(clover, join(root, "link"));
      expect(agentPaths(["notes.md"], root, dir).paths).toEqual([join(root, "notes.md")]);
      expect(agentPaths(["../.clover/settings"], root, dir).paths).toEqual([join(clover, "settings")]);
      expect(agentPaths(["~/.clover/settings", `file://${join(root, "a b")}`], root, dir).paths).toEqual([join(clover, "settings"), join(root, "a b")]);
      expect(agentPaths(["link/settings"], root, dir).paths).toEqual([join(root, "link", "settings"), join(clover, "settings")]);
      expect(agentPaths(["link/new/deep.txt"], root, dir).paths).toEqual([join(root, "link", "new", "deep.txt"), join(clover, "new", "deep.txt")]);
      expect(agentPaths(["", "a\0b"], root, dir).paths).toEqual([]);
      // Every path is checked, however many come before it; past the hard cap the request is over.
      const many = [...Array.from({ length: 300 }, (_, i) => `f${i}.txt`), "../.clover/run/x.json"];
      expect(agentPaths(many, root, dir).paths.at(-1)).toBe(join(clover, "run", "x.json"));
      expect(agentPaths(Array.from({ length: MAX_CHECKED_PATHS + 1 }, (_, i) => `f${i}`), root, dir)).toEqual({ paths: [], over: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a hostile agent's sizes (review 12)", () => {
  test("a rawInput past the cap becomes a preview; each transcript file stops at its cap and says so", () => {
    expect(capRawInput({ command: "ls" })).toEqual({ command: "ls" });
    const big = capRawInput({ command: "x".repeat(MAX_RAW_INPUT_CHARS + 1) }) as { clover_truncated: string; length: number };
    expect(big.clover_truncated.length).toBe(4096);
    expect(big.length).toBeGreaterThan(MAX_RAW_INPUT_CHARS);
    const home = mkdtempSync(join(tmpdir(), "clover-k-cap-"));
    try {
      const t = new AgentTranscript(home, "agent_cap", "alpha", { "calls.ndjson": 200 });
      for (let i = 0; i < 10; i++) t.call({ type: "permission", i, pad: "y".repeat(40) });
      const lines = readFileSync(join(t.dir, "calls.ndjson"), "utf8").trim().split("\n");
      expect(lines.length).toBeLessThan(10);
      expect(JSON.parse(lines.at(-1)!)).toEqual({ clover: "truncated", cap: 200 });
      t.call({ type: "after" });
      expect(readFileSync(join(t.dir, "calls.ndjson"), "utf8").trim().split("\n").length).toBe(lines.length);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a link the bot planted anywhere in its agents folder is never written through (#213's review)", () => {
    const root = mkdtempSync(join(tmpdir(), "clover-k-link-"));
    try {
      const home = join(root, "home");
      const outside = join(root, "outside");
      mkdirSync(outside);
      const victim = join(outside, "victim.txt");
      const before = "the user's own file\n";
      const untouched = () => {
        expect(readFileSync(victim, "utf8")).toBe(before);
        expect(readdirSync(outside).sort()).toEqual(["victim.txt"]);
      };
      const writeAll = (t: AgentTranscript) => {
        t.wire("out", { method: "session/new", params: {} }, false, 1);
        t.call({ type: "permission" });
        t.stderr(new TextEncoder().encode("line\n"));
        t.writeRecord({ v: 1, sessionId: "agent_l", backend: "codex", computer: "mac", root: "projects/x", startedAt: 1 });
      };
      const agents = join(home, "bots", "alpha", "agents");
      const reset = () => {
        rmSync(home, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
        mkdirSync(outside);
        writeFileSync(victim, before);
        mkdirSync(agents, { recursive: true });
      };

      // 1. `agents` itself is a link to a folder outside.
      reset();
      rmSync(agents, { recursive: true });
      symlinkSync(outside, agents);
      writeAll(new AgentTranscript(home, "agent_l", "alpha"));
      untouched();

      // 2. The session's folder is a link.
      reset();
      symlinkSync(outside, join(agents, "agent_l"));
      writeAll(new AgentTranscript(home, "agent_l", "alpha"));
      untouched();

      // 3. Each file's name is a link to the user's file (and a dangling one, which would create a file outside).
      for (const file of ["acp.ndjson", "calls.ndjson", "agent.stderr.log", "agent.json"]) {
        reset();
        const t = new AgentTranscript(home, "agent_l", "alpha");
        symlinkSync(victim, join(t.dir, file));
        writeAll(t);
        untouched();
        reset();
        const t2 = new AgentTranscript(home, "agent_l", "alpha");
        symlinkSync(join(outside, "made.txt"), join(t2.dir, file));
        writeAll(t2);
        untouched();
      }

      // 4. A hard link to the user's file under a transcript file's name.
      reset();
      const t4 = new AgentTranscript(home, "agent_l", "alpha");
      linkSync(victim, join(t4.dir, "acp.ndjson"));
      t4.wire("out", { method: "session/new", params: {} }, false, 1);
      untouched();

      // 5. The session folder swapped for a link after the transcript made it: the next append is refused.
      reset();
      const t5 = new AgentTranscript(home, "agent_l", "alpha");
      t5.call({ type: "first" });
      expect(readFileSync(join(t5.dir, "calls.ndjson"), "utf8")).toContain("first");
      renameSync(t5.dir, join(agents, "moved"));
      symlinkSync(outside, t5.dir);
      writeAll(t5);
      untouched();
      expect(existsSync(join(agents, "moved", "acp.ndjson"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("redactDeep replaces the token in every string and key, at any depth", () => {
    const tok: string = "tok_ABCDEFGHIJKLMNOP";
    expect(redactDeep<unknown>({ a: [`x ${tok} y`, { [tok]: tok }], n: 1 }, [tok])).toEqual({ a: [`x ${REDACTED_TOKEN} y`, { [REDACTED_TOKEN]: REDACTED_TOKEN }], n: 1 });
  });
});

describe("the bridge's hello", () => {
  test("an unverified caller (two pipe clients at once, on Windows) is tried once more; a second refusal stands", async () => {
    const run = (answers: string[]) => {
      let connects = 0;
      const r = runBridge({ [BRIDGE_ENV.token]: "t".repeat(32), [BRIDGE_ENV.session]: "s1", [BRIDGE_ENV.socket]: "/x" }, {
        onInput: () => {}, output: () => {}, log: () => {},
        connect: async (_p, onData) => {
          const answer = answers[connects++] ?? "ok";
          return {
            write: (line) => {
              const id = (JSON.parse(line) as { id: unknown }).id;
              const body = answer === "ok" ? { result: { ok: true } } : { error: { code: -32020, message: `the bridge was refused: ${answer}` } };
              queueMicrotask(() => onData(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`)));
            },
            close: () => {},
          };
        },
      });
      return { ready: r.ready, connects: () => connects };
    };
    const once = run(["unverified-caller", "ok"]);
    await once.ready;
    expect(once.connects()).toBe(2);
    const twice = run(["unverified-caller", "unverified-caller"]);
    expect(await twice.ready.then(() => "ok", (e: unknown) => String(e))).toContain("unverified-caller");
    expect(twice.connects()).toBe(2);
    const other = run(["not-the-agent"]);
    expect(await other.ready.then(() => "ok", (e: unknown) => String(e))).toContain("not-the-agent");
    expect(other.connects()).toBe(1);
  });
});

describe("Windows containment (lane C's AgentJob)", () => {
  test("a .cmd runs through cmd.exe, every part quoted; an argument cmd.exe would read is refused", () => {
    expect(spawnPlan("/usr/bin/x", ["a"], "darwin")).toEqual({ file: "/usr/bin/x", args: ["a"], verbatim: false });
    const plan = spawnPlan("C:\\npm\\codex-acp.cmd", ["--flag", "a b"], "win32");
    expect(plan.verbatim).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]).toBe('""C:\\npm\\codex-acp.cmd" "--flag" "a b""');
    expect(() => spawnPlan("C:\\x.cmd", ["a&calc"], "win32")).toThrow();
    expect(() => spawnPlan("C:\\x.bat", ["%PATH%"], "win32")).toThrow();
  });

  test("an agent that can't join its job is ended and refused; a backend with no job refuses to start", async () => {
    const job = { assign: () => false, contains: () => false, terminate: () => true, close: () => {} };
    const p = launchContained({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"], cwd: tmpdir(), env: { PATH: process.env["PATH"] ?? "" } }, { job });
    expect(p.contained).toBe(false);
    await p.exited;
    const backend = new AcpAgentBackend({
      id: "w", pluginId: "clover/agent-w", quirks: fakeLaunch(WELL_BEHAVED_QUIRKS), clock: new FakeClock(), os: "windows", makeJob: () => null,
      command: { program: process.execPath, prefixArgs: ["-e", "1"], acpArgs: [] },
    });
    backend.detect = async () => ({ installed: true, path: process.execPath, version: "1.0.0", identityOk: true, versionOk: true, sandboxed: true });
    const err = await backend.start({ sessionId: "s", root: tmpdir(), bridge: { name: "b", command: "x", args: [], env: {}, tools: [] }, fence: new FakeFence({ home: tmpdir(), cloverHome: join(tmpdir(), ".c") }).policy() }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("job object");
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

describe("sandbox admissions and OKs", () => {
  test("only an admitted sandbox, inside its versions, counts; Cursor and Antigravity need the OK today", () => {
    expect(admissionFor(ADMISSIONS, "cursor", "macos", "2026.10.22").status).toBe("unsupported");
    expect(admissionFor(ADMISSIONS, "antigravity", "linux", "1.4.12").status).toBe("unverified");
    expect(admissionFor(ADMISSIONS, "unknown", "macos", "1.0.0").status).toBe("unsupported");
    const table = { x: { macos: { status: "protected" as const, versions: ">=1.2.0 <2.0.0", evidence: "gates", writer: () => ({}) } } };
    expect(admissionFor(table, "x", "macos", "1.3.0").status).toBe("protected");
    expect(admissionFor(table, "x", "macos", "2.0.1")).toMatchObject({ status: "unverified" });
    expect(admissionFor(table, "x", "macos", undefined)).toMatchObject({ status: "unverified" });
  });

  test("an OK is kept per backend, version, computer, program path and file hash, in the fenced trust folder", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-k-oks-"));
    try {
      const oks = new FileAgentOks(home);
      const key = { backend: "cursor", version: "2026.10.22", computer: "Studio", path: "/opt/cursor-agent", sha256: "a".repeat(64) };
      expect(oks.has(key)).toBe(false);
      oks.grant(key, { cardId: "card_abcdef", at: 1 });
      expect(new FileAgentOks(home).has(key)).toBe(true);
      expect(oks.has({ ...key, version: "2026.11.1" })).toBe(false);
      expect(oks.has({ ...key, computer: "Desk" })).toBe(false);
      expect(oks.has({ ...key, path: "/tmp/cursor-agent" })).toBe(false);
      expect(oks.has({ ...key, sha256: "b".repeat(64) })).toBe(false);
      expect(agentOksPath(home)).toBe(join(home, "trust", "agent-oks.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the backends' rows", () => {
  test("every backend has a command on every OS, a version pattern that reads its real version line, and a source", () => {
    const lines: Record<string, string> = {
      cursor: "2026.10.22-27dcf5f", antigravity: "1.4.12", grok: "grok 1.0.70 (f50904eaee6c) [stable]", gemini: "0.46.0",
      "claude-code": "0.100.0", codex: "2.5.0", deepseek: "dsh 0.1.2",
      devin: "devin 3000.11.234 (92c83011d113)", "devin-cloud": "devin 3000.11.234 (92c83011d113)",
    };
    for (const [id, q] of Object.entries(QUIRKS)) {
      for (const os of ["macos", "linux", "windows"] as const) expect(q.launch.command[os]?.length ?? 0).toBeGreaterThan(0);
      const m = new RegExp(q.launch.identity.versionPattern, "m").exec(lines[id]!);
      expect(m).not.toBeNull();
      expect(ROWS[id]!.file.source.length).toBeGreaterThan(0);
      expect(q.mcp.transports).toContain("stdio");
      // No backend's sandbox is admitted yet: each asks for the user's OK until its gates pass.
      expect(admissionFor(ADMISSIONS, id, "macos", (m![1] ?? m![0]).trim()).status).not.toBe("protected");
    }
    // `agent` is Cursor's and Grok's: neither row resolves that name.
    for (const q of Object.values(QUIRKS)) expect(q.launch.command.macos![0]).not.toBe("agent");
  });
});

describe("the Clover home is out of agents' reach", () => {
  test("the whole home is denied, once; a path in it, as written or through a link, is in reach; one that holds it holds it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-k-home-")));
    try {
      const home = join(root, ".clover");
      mkdirSync(join(home, "transcripts", "beta"), { recursive: true });
      mkdirSync(join(root, "project"));
      symlinkSync(join(home, "transcripts"), join(root, "project", "link"));
      const p = withHomeDenied({ allowWrite: [root], denyWrite: ["/a"], denyRead: [], closedDoors: [], blockedAddresses: [], network: "none" }, home);
      expect(p.denyRead).toEqual([home]);
      expect(p.denyWrite).toEqual(["/a", home]);
      expect(withHomeDenied(p, home).denyRead).toEqual([home]);
      expect(homeReach(home, join(home, "diffs", "s", "1.diff"), root)).toBe("inside");
      expect(homeReach(home, join(root, ".CLOVER", "x"), root)).toBe("inside");
      expect(homeReach(home, join(root, "project", "link", "beta", "s.jsonl"), root)).toBe("inside");
      expect(homeReach(home, "link/beta", join(root, "project"))).toBe("inside");
      expect(homeReach(home, root, root)).toBe("holds");
      expect(homeReach(home, join(root, "project", "a.txt"), root)).toBeUndefined();
      expect(realPathOf(join(root, "project", "link", "new", "file"), root)).toBe(join(home, "transcripts", "new", "file"));
      expect(fileToolDenials(["/m1"], ["/w"])).toEqual(["Read(//m1)", "Read(//m1/**)", "Edit(//m1)", "Edit(//m1/**)", "Write(//m1)", "Write(//m1/**)", "Glob(//m1)", "Glob(//m1/**)", "Grep(//m1)", "Grep(//m1/**)", "NotebookEdit(//m1)", "NotebookEdit(//m1/**)", "Edit(//w)", "Edit(//w/**)", "Write(//w)", "Write(//w/**)", "NotebookEdit(//w)", "NotebookEdit(//w/**)"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
