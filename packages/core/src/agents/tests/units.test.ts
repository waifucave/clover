// Unit checks for the Agent tool's small parts: the JSON-RPC peer, the environment allow-list, the process table,
// version ranges, the "once" rule, the transcript's redaction, and the tokens' rules.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError, RpcPeer, type JsonRpcMessage } from "../acp/jsonrpc";
import { UserSelections } from "../acp/selections";
import { MAX_RAW_INPUT_CHARS, capRawInput, onceOnly } from "../acp/session";
import { isAuthRequired, pathsOf, readCaps, readConfigOptions } from "../acp/types";
import { versionSatisfies } from "../backend";
import { BridgeTokens } from "../bridge/tokens";
import { buildAgentEnv } from "../process/launch";
import { descendantsOf, isDescendant, parseElapsed, parsePs, type ProcessRow } from "../process/table";
import { ANTIGRAVITY_QUIRKS, CURSOR_QUIRKS, QUIRKS, QUIRK_SOURCES } from "../quirks";
import { S5_ANTIGRAVITY_QUIRKS, S5_CURSOR_QUIRKS } from "../../contracts/fakes/agent-backend";
import { agentPaths } from "../paths";
import { AgentTranscript, REDACTED_TOKEN, botSegment, redactDeep, transcriptPaths } from "../transcript";
import { effectOf, promptOf, ruleKeyOf } from "../manager";
import { ADMISSIONS, admissionFor } from "../sandbox/admission";
import { FileAgentOks, agentOksPath } from "../sandbox/oks";

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
    expect(ruleKeyOf("cursor", { toolCallId: "1", toolKind: "other", title: "x", mcp: { server: "blender", tool: "Render" }, options: [], paths: [] })).toBe("Agent(cursor):mcp__blender__Render");
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
      expect(agentPaths(["notes.md"], root, dir)).toEqual([join(root, "notes.md")]);
      expect(agentPaths(["../.clover/settings"], root, dir)).toEqual([join(clover, "settings")]);
      expect(agentPaths(["~/.clover/settings", `file://${join(root, "a b")}`], root, dir)).toEqual([join(clover, "settings"), join(root, "a b")]);
      expect(agentPaths(["link/settings"], root, dir)).toEqual([join(root, "link", "settings"), join(clover, "settings")]);
      expect(agentPaths(["link/new/deep.txt"], root, dir)).toEqual([join(root, "link", "new", "deep.txt"), join(clover, "new", "deep.txt")]);
      expect(agentPaths(["", "a\0b"], root, dir)).toEqual([]);
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

  test("redactDeep replaces the token in every string and key, at any depth", () => {
    const tok: string = "tok_ABCDEFGHIJKLMNOP";
    expect(redactDeep<unknown>({ a: [`x ${tok} y`, { [tok]: tok }], n: 1 }, [tok])).toEqual({ a: [`x ${REDACTED_TOKEN} y`, { [REDACTED_TOKEN]: REDACTED_TOKEN }], n: 1 });
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

  test("an OK is kept per backend, version and computer, in the fenced trust folder", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-k-oks-"));
    try {
      const oks = new FileAgentOks(home);
      const key = { backend: "cursor", version: "2026.10.22", computer: "Studio" };
      expect(oks.has(key)).toBe(false);
      oks.grant(key, { cardId: "card_abcdef", at: 1 });
      expect(new FileAgentOks(home).has(key)).toBe(true);
      expect(oks.has({ ...key, version: "2026.11.1" })).toBe(false);
      expect(oks.has({ ...key, computer: "Desk" })).toBe(false);
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
    };
    for (const [id, q] of Object.entries(QUIRKS)) {
      for (const os of ["macos", "linux", "windows"] as const) expect(q.launch.command[os]?.length ?? 0).toBeGreaterThan(0);
      const m = new RegExp(q.launch.identity.versionPattern, "m").exec(lines[id]!);
      expect(m).not.toBeNull();
      expect(QUIRK_SOURCES[id]).toBeDefined();
      expect(q.mcp.transports).toContain("stdio");
      // No backend's sandbox is admitted yet: each asks for the user's OK until its gates pass.
      expect(admissionFor(ADMISSIONS, id, "macos", (m![1] ?? m![0]).trim()).status).not.toBe("protected");
    }
    // `agent` is Cursor's and Grok's: neither row resolves that name.
    for (const q of Object.values(QUIRKS)) expect(q.launch.command.macos![0]).not.toBe("agent");
  });
});
