// `clover-core code-agent` on the daemon's side (K-M3b, code-agent/service.ts): the session an outside ACP client opens,
// what it may and may not reach, and whose answers allow its calls. The agent here is a stand-in that records what it
// is fed and says what the test tells it to.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Level } from "@waifucave/clover-protocol";
import { isContractError } from "../../contracts/common";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import { FakeSessionHost } from "../../contracts/fakes/session-host";
import { FakeTree } from "../../contracts/fakes/tree";
import type { CodeAgentServeSpec } from "../clover-code/backend";
import { CodeAgentService, type CodeAgentConnection } from "../code-agent/service";
import { transcriptPaths } from "../transcript";

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };

class StandIn {
  readonly fed: Msg[] = [];
  spec?: CodeAgentServeSpec;
  closed = false;
  installed = true;
  #out?: (line: string) => void;
  #end!: () => void;
  async detect() {
    return this.installed
      ? { installed: true, identityOk: true, versionOk: true, sandboxed: true }
      : { installed: false, identityOk: true, versionOk: true, sandboxed: false, reason: "clover-code isn't available on Linux yet" };
  }
  async serve(spec: CodeAgentServeSpec, out: (line: string) => void) {
    this.spec = spec;
    this.#out = out;
    const ended = new Promise<void>((r) => (this.#end = r));
    return {
      feed: (line: string) => void this.fed.push(JSON.parse(line) as Msg),
      ended,
      close: async () => {
        this.closed = true;
        this.#end();
      },
    };
  }
  say(msg: Msg): void {
    this.#out!(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  }
  /** The agent's server ends on its own. */
  end(): void {
    this.#end();
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: { level?: Level } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-k-ca-")));
  temps.push(root);
  const userHome = join(root, "home");
  const cloverHome = join(userHome, ".clover");
  const project = join(userHome, "project1");
  const dev = join(userHome, "dev-secrets");
  for (const d of [project, cloverHome, dev, join(project, "sub")]) mkdirSync(d, { recursive: true });
  const clock = new FakeClock();
  const host = new FakeSessionHost({ clock });
  const fence = new FakeFence({ home: userHome, cloverHome, devFolders: [dev] });
  const tree = new FakeTree({ clock, computers: { Studio: { home: userHome } }, botComputer: () => "Studio" });
  const agent = new StandIn();
  let level: Level = o.level ?? "ask";
  const service = new CodeAgentService({
    home: cloverHome, computer: "Studio", userHome, host, tree, fence, clock, backend: () => agent, levelOf: () => level,
  });
  const client: Msg[] = [];
  let ended = 0;
  const conn: CodeAgentConnection = { connId: 7, clientName: "Zed", toClient: (line) => void client.push(JSON.parse(line) as Msg), end: () => void ended++ };
  return {
    root, userHome, cloverHome, project, dev, host, service, agent, client, conn,
    ended: () => ended,
    setLevel: (l: Level) => { level = l; },
    send: (msg: Msg) => service.input(conn.connId, JSON.stringify({ jsonrpc: "2.0", ...msg })),
  };
}

const ASK = (kind: string, rawInput: unknown) => ({
  toolCall: { toolCallId: "call-1", kind, title: kind, rawInput },
  options: [
    { optionId: "a1", name: "Allow", kind: "allow_once" },
    { optionId: "a2", name: "Always allow", kind: "allow_always" },
    { optionId: "r1", name: "Reject", kind: "reject_once" },
    { optionId: "r2", name: "Always reject", kind: "reject_always" },
  ],
});

describe("Clover's coding agent for an outside ACP client (daemon side)", () => {
  test("the session is a direct coding session of the user's: listed, recorded, in the folder the client opened, fenced", async () => {
    const s = setup();
    const r = await s.service.open(s.conn, { cwd: s.project, model: "winter-test/calls" });
    const view = s.host.get(r.session)!;
    expect(view).toMatchObject({ kind: "coding", computer: "Studio", backend: "clover-code", root: "home/Studio/project1", title: "From Zed", model: "winter-test/calls" });
    expect(view.bot).toBeUndefined();
    expect(s.service.bound(7)).toBe(true);
    // Recorded like any agent's session.
    const record = JSON.parse(readFileSync(join(transcriptPaths(s.cloverHome, r.session).dir, "agent.json"), "utf8"));
    expect(record).toMatchObject({ sessionId: r.session, backend: "clover-code", computer: "Studio", root: "home/Studio/project1" });
    // The agent runs in the root, with the Clover home denied whole.
    expect(s.agent.spec!.root).toBe(s.project);
    expect(s.agent.spec!.fence.denyRead).toContain(s.cloverHome);
    expect(s.agent.spec!.fence.denyWrite).toContain(s.cloverHome);
    // Lines cross both ways, and the transcript has them.
    s.send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    expect(s.agent.fed[0]).toMatchObject({ id: 1, method: "initialize" });
    s.agent.say({ id: 1, result: { protocolVersion: 1 } });
    expect(s.client[0]).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    const acp = readFileSync(join(transcriptPaths(s.cloverHome, r.session).dir, "acp.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(acp.map((l) => l.dir)).toEqual(["out", "in"]);
  });

  test("the client's folder must be a folder of this computer's home, under the fence", async () => {
    const s = setup();
    const err = async (cwd: string) => s.service.open({ ...s.conn, connId: Math.floor(Math.random() * 1e9) }, { cwd }).then(() => undefined, (e: unknown) => e);
    expect(isContractError(await err("project1"), "invalid")).toBe(true);
    expect(isContractError(await err(join(s.userHome, "nothing")), "not_found")).toBe(true);
    expect(isContractError(await err(s.root), "refused")).toBe(true); // outside the user's home
    expect(isContractError(await err(s.userHome), "refused")).toBe(true); // the home itself, which holds the Clover home
    expect(isContractError(await err(s.cloverHome), "fenced")).toBe(true); // Clover's own folder
    expect(s.host.list({ kind: "coding" })).toEqual([]);
    // Not on this computer (Linux, Windows): refused with the reason, no session.
    s.agent.installed = false;
    const e = await err(s.project);
    expect(isContractError(e, "not_installed")).toBe(true);
    expect((e as Error).message).toContain("isn't available on Linux yet");
  });

  test("one session per connection, in the root, with no MCP server the client names", async () => {
    const s = setup();
    await s.service.open(s.conn, { cwd: s.project });
    // A folder outside the root: answered here, never fed.
    s.send({ id: 2, method: "session/new", params: { cwd: s.userHome, mcpServers: [] } });
    expect(s.client.at(-1)).toMatchObject({ id: 2, error: { code: -32602 } });
    s.send({ id: 3, method: "session/new", params: { cwd: join(s.project, "sub"), mcpServers: [{ name: "x", command: "/bin/sh", args: [], env: [] }] } });
    expect(s.agent.fed.at(-1)).toMatchObject({ id: 3, method: "session/new", params: { cwd: join(s.project, "sub"), mcpServers: [] } });
    s.agent.say({ id: 3, result: { sessionId: "sess-1" } });
    s.send({ id: 4, method: "session/new", params: { cwd: s.project, mcpServers: [] } });
    expect(s.client.at(-1)).toMatchObject({ id: 4, error: { code: -32602 } });
    expect(s.agent.fed.filter((m) => m.method === "session/new")).toHaveLength(1);
  });

  test("a mode that skips asking only where the level allows edits, and only while it does", async () => {
    const s = setup({ level: "ask" });
    await s.service.open(s.conn, { cwd: s.project });
    s.send({ id: 1, method: "session/new", params: { cwd: s.project, mcpServers: [] } });
    s.agent.say({ id: 1, result: { sessionId: "sess-1" } });
    s.send({ id: 5, method: "session/set_mode", params: { sessionId: "sess-1", modeId: "acceptEdits" } });
    expect(s.client.at(-1)).toMatchObject({ id: 5, error: { code: -32602 } });
    s.send({ id: 6, method: "session/set_config_option", params: { sessionId: "sess-1", configId: "mode", value: "acceptEdits" } });
    expect(s.client.at(-1)).toMatchObject({ id: 6, error: { code: -32602 } });
    s.send({ id: 7, method: "session/set_mode", params: { sessionId: "sess-1", modeId: "plan" } });
    expect(s.agent.fed.at(-1)).toMatchObject({ id: 7, method: "session/set_mode" });
    s.setLevel("accept-edits");
    s.send({ id: 8, method: "session/set_mode", params: { sessionId: "sess-1", modeId: "acceptEdits" } });
    expect(s.agent.fed.at(-1)).toMatchObject({ id: 8, method: "session/set_mode" });
    s.agent.say({ id: 8, result: {} });
    // The level drops: before the next message moves, the session goes back to asking, and both sides are told.
    s.setLevel("ask");
    s.send({ id: 9, method: "session/prompt", params: { sessionId: "sess-1", prompt: [{ type: "text", text: "hi" }] } });
    const fed = s.agent.fed.slice(-2);
    expect(fed[0]).toMatchObject({ method: "session/set_mode", params: { sessionId: "sess-1", modeId: "default" } });
    expect(fed[1]).toMatchObject({ id: 9, method: "session/prompt" });
    expect(s.client.at(-1)).toMatchObject({ method: "session/update", params: { update: { sessionUpdate: "current_mode_update", currentModeId: "default" } } });
    // The agent's answer to that goes no further.
    const before = s.client.length;
    s.agent.say({ id: fed[0]!.id, result: {} });
    expect(s.client.length).toBe(before);
  });

  test("one session, the connection's own: no resume or load of another, nothing about another, before or after", async () => {
    const s = setup();
    await s.service.open(s.conn, { cwd: s.project });
    // Before any session: a resume, or a prompt, of any id is refused.
    s.send({ id: 1, method: "session/resume", params: { sessionId: "another-connections", cwd: s.project, mcpServers: [] } });
    expect(s.client.at(-1)).toMatchObject({ id: 1, error: { code: -32602 } });
    s.send({ id: 2, method: "session/prompt", params: { sessionId: "another-connections", prompt: [] } });
    expect(s.client.at(-1)).toMatchObject({ id: 2, error: { code: -32602 } });
    s.send({ id: 3, method: "session/new", params: { cwd: s.project, mcpServers: [] } });
    s.agent.say({ id: 3, result: { sessionId: "sess-1" } });
    // After it: another id is refused, its own goes on (a resume of it too).
    s.send({ id: 4, method: "session/load", params: { sessionId: "another-connections", cwd: s.project, mcpServers: [] } });
    expect(s.client.at(-1)).toMatchObject({ id: 4, error: { code: -32602 } });
    s.send({ id: 5, method: "session/prompt", params: { sessionId: "another-connections", prompt: [] } });
    expect(s.client.at(-1)).toMatchObject({ id: 5, error: { code: -32602 } });
    s.send({ id: 6, method: "session/resume", params: { sessionId: "sess-1", cwd: s.project, mcpServers: [] } });
    expect(s.agent.fed.at(-1)).toMatchObject({ id: 6, method: "session/resume", params: { sessionId: "sess-1" } });
    s.agent.say({ id: 6, result: {} });
    s.send({ id: 7, method: "session/prompt", params: { sessionId: "sess-1", prompt: [] } });
    expect(s.agent.fed.at(-1)).toMatchObject({ id: 7, method: "session/prompt" });
    expect(s.agent.fed.filter((m) => [1, 2, 4, 5].includes(m.id as number))).toEqual([]);
  });

  test("only an answer to a request the client was sent reaches the agent, under the agent's own id", async () => {
    const s = setup({ level: "ask" });
    await s.service.open(s.conn, { cwd: s.project });
    // An answer to nothing the agent asked: dropped.
    s.send({ id: 99, result: { outcome: { outcome: "selected", optionId: "a1" } } });
    expect(s.agent.fed).toEqual([]);
    // Asked as 20, answered as "20" with an "always" it wasn't offered: the agent gets cancelled, under 20.
    s.agent.say({ id: 20, method: "session/request_permission", params: ASK("execute", { command: "npm test" }) });
    s.send({ id: "20", result: { outcome: { outcome: "selected", optionId: "a2" } } });
    expect(s.agent.fed.at(-1)).toEqual({ jsonrpc: "2.0", id: 20, result: { outcome: { outcome: "cancelled" } } });
    // A second answer to the same request: dropped.
    s.send({ id: 20, result: { outcome: { outcome: "selected", optionId: "a1" } } });
    expect(s.agent.fed).toHaveLength(1);
    // Another request of the agent's passes, and its answer comes back under the agent's id.
    s.agent.say({ id: 21, method: "fs/read_text_file", params: { path: "x" } });
    expect(s.client.at(-1)).toMatchObject({ id: 21, method: "fs/read_text_file" });
    s.send({ id: "21", result: { content: "x" } });
    expect(s.agent.fed.at(-1)).toMatchObject({ id: 21, result: { content: "x" } });
  });

  test("two opens on one connection at once: one session, never an orphan", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.service.open(s.conn, { cwd: s.project }), s.service.open(s.conn, { cwd: s.project })].map((p) => p.then((v) => v, (e: unknown) => e)));
    const opened = [a, b].filter((x) => !(x instanceof Error));
    expect(opened).toHaveLength(1);
    expect(isContractError([a, b].find((x) => x instanceof Error), "refused")).toBe(true);
    expect(s.host.list({ kind: "coding" })).toHaveLength(1);
    s.service.close(7);
    await Bun.sleep(10);
    expect(s.host.list({ kind: "coding" }).map((v) => v.status)).toEqual(["stopped"]);
  });

  test("the agent's permission requests: the level decides here, the client is asked only what it would ask about, never with an always", async () => {
    const s = setup({ level: "read-only" });
    await s.service.open(s.conn, { cwd: s.project });
    const file = join(s.project, "a.txt");
    const answerFed = (id: number) => s.agent.fed.find((m) => m.id === id && m.method === undefined)?.result?.["outcome"];
    // Read-only: a command is refused without asking.
    s.agent.say({ id: 10, method: "session/request_permission", params: ASK("execute", { command: "npm test" }) });
    expect(answerFed(10)).toEqual({ outcome: "selected", optionId: "r1" });
    // Automatic: allowed without asking.
    s.setLevel("automatic");
    s.agent.say({ id: 11, method: "session/request_permission", params: ASK("edit", { file_path: file }) });
    expect(answerFed(11)).toEqual({ outcome: "selected", optionId: "a1" });
    // At every level, the Clover home and the fenced set are refused, never asked about.
    s.agent.say({ id: 12, method: "session/request_permission", params: ASK("edit", { file_path: join(s.cloverHome, "x") }) });
    expect(answerFed(12)).toEqual({ outcome: "selected", optionId: "r1" });
    s.agent.say({ id: 13, method: "session/request_permission", params: ASK("read", { file_path: join(s.dev, "key") }) });
    expect(answerFed(13)).toEqual({ outcome: "selected", optionId: "r1" });
    expect(s.client.filter((m) => m.method === "session/request_permission")).toEqual([]);
    // Ask: the client is asked, offered no "always".
    s.setLevel("ask");
    s.agent.say({ id: 14, method: "session/request_permission", params: ASK("execute", { command: "npm test" }) });
    const asked = s.client.at(-1)!;
    expect(asked).toMatchObject({ id: 14, method: "session/request_permission" });
    expect((asked.params!["options"] as { kind: string }[]).map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(answerFed(14)).toBeUndefined();
    s.send({ id: 14, result: { outcome: { outcome: "selected", optionId: "a1" } } });
    expect(answerFed(14)).toEqual({ outcome: "selected", optionId: "a1" });
    // An answer naming an option it wasn't offered (an always) counts as cancelled.
    s.agent.say({ id: 15, method: "session/request_permission", params: ASK("execute", { command: "rm -rf build" }) });
    s.send({ id: 15, result: { outcome: { outcome: "selected", optionId: "a2" } } });
    expect(answerFed(15)).toEqual({ outcome: "cancelled" });
  });

  test("the session ends with the connection, and the connection with the session", async () => {
    const s = setup();
    const a = await s.service.open(s.conn, { cwd: s.project });
    s.service.close(7);
    await Bun.sleep(10);
    expect(s.agent.closed).toBe(true);
    expect(s.host.get(a.session)!.status).toBe("stopped");
    expect(s.service.bound(7)).toBe(false);
    expect(s.ended()).toBe(0);
    expect(() => s.service.input(7, "{}")).toThrow();
    // Stopped from Clover: the agent and the connection end.
    const s2 = setup();
    const b = await s2.service.open(s2.conn, { cwd: s2.project });
    await s2.host.stop(b.session);
    expect(s2.agent.closed).toBe(true);
    expect(s2.ended()).toBe(1);
    // The agent's server ending on its own ends both.
    const s3 = setup();
    const c = await s3.service.open(s3.conn, { cwd: s3.project });
    s3.agent.end();
    await Bun.sleep(10);
    expect(s3.host.get(c.session)!.status).toBe("stopped");
    expect(s3.ended()).toBe(1);
    // A message from Clover's own surfaces is answered, never sent on.
    const s4 = setup();
    const d = await s4.service.open(s4.conn, { cwd: s4.project });
    await s4.host.sendUser(d.session, { text: "hi", device: "d", clientMessageId: "m1", sentAt: 1 });
    expect(s4.agent.fed).toEqual([]);
    expect(existsSync(s4.project)).toBe(true);
  });
});
