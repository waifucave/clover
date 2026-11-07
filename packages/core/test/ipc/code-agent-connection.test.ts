// K-M3b: `codeAgent.*` on the daemon's endpoint (ipc/clover.ts's mount, the controller's ruling A): a `cli` connection
// that counts as the user binds itself to one coding session; a relay started inside a sandbox or at the escape floor
// gets none; a bound connection takes nothing else; its close ends the session.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_ERR, CLOVER_PROTOCOL_VERSION, encodeLine, ERR, LineDecoder, METHODS } from "@waifucave/clover-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { createCloverServer, type CodeAgentDoor } from "../../src/ipc/clover";
import { CloverTokens } from "../../src/auth/clover-tokens";
import { SessionProcesses } from "../../src/auth/clover-caller";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { PeerFacts } from "../../src/platform/caller-probe";
import { resolveEndpoint } from "../../src/platform/transport";

class Client {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly notes: any[] = [];
  closed = false;
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  static async connect(path: string): Promise<Client> {
    const c = new Client();
    c.socket = await Bun.connect({ unix: path, socket: {
      data(_s, chunk) {
        for (const line of c.decoder.push(chunk)) {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number" && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
          else if (msg.method) c.notes.push(msg);
        }
      },
      close() { c.closed = true; },
    } });
    return c;
  }
  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  hello(token: string): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "cli", token, clientName: "clover-code-agent" });
  }
  close(): void { this.socket.end(); }
}

const outside: PeerFacts = { pid: 4242, ancestors: [1], probe: { sandboxedMac: false, inHostNamespacesLinux: true, tokenRestrictedWin: false, appContainerWin: false }, floor: "outside-floor" };
const fenced: PeerFacts = { pid: 5151, ancestors: [5150, 1], probe: { sandboxedMac: true }, floor: "fenced" };
const inAgent: PeerFacts = { pid: 6161, ancestors: [6160, 1], probe: { sandboxedMac: false, inHostNamespacesLinux: true, tokenRestrictedWin: false, appContainerWin: false }, floor: "outside-floor" };

class RecordingDoor implements CodeAgentDoor {
  readonly opened: { connId: number; cwd: string }[] = [];
  readonly inputs: { connId: number; line: string }[] = [];
  readonly closedConns: number[] = [];
  toClient?: (line: string) => void;
  end?: () => void;
  async open(conn: Parameters<CodeAgentDoor["open"]>[0], p: { cwd: string }): Promise<{ session: string }> {
    this.opened.push({ connId: conn.connId, cwd: p.cwd });
    this.toClient = conn.toClient;
    this.end = conn.end;
    return { session: "agent_code1" };
  }
  input(connId: number, line: string): void { this.inputs.push({ connId, line }); }
  close(connId: number): void { this.closedConns.push(connId); }
}

const homes: string[] = [];
describe("codeAgent.* on the daemon's endpoint (K-M3b)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "clover-codeagent-"));
    homes.push(home);
    const store = new SessionStore(home);
    const socketPath = resolveEndpoint(join(home, "run")).path;
    mkdirSync(join(home, "run"), { recursive: true });
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const legacy = await authority.ensureTokens();
    const tokens = new CloverTokens({ verifyCli: (t) => authority.verify("harness", t) });
    const processes = new SessionProcesses();
    const logs: string[] = [];
    let peer = outside;
    const door = new RecordingDoor();
    const clover = createCloverServer({ tokens, processes, serverVersion: "test", deviceId: "d".repeat(32), probe: () => peer, codeAgent: door, log: (l) => void logs.push(l) });
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, cloverConnections: clover });
    stop = () => { clover.dispose(); server.stop(); store.close(); };
    return { socketPath, token: legacy.harness, processes, door, logs, setPeer: (p: PeerFacts) => { peer = p; } };
  }

  test("the user's relay binds its connection to one session; the lines cross; the connection takes nothing else", async () => {
    const b = await boot();
    const c = await Client.connect(b.socketPath);
    expect((await c.hello(b.token)).result.caller).toEqual({ kind: "user", client: "cli" });
    // Nothing to send to before the session is open.
    expect((await c.request("codeAgent.send", { line: "{}" })).error.code).toBe(ERR.INVALID_REQUEST);
    expect((await c.request("codeAgent.open", { cwd: "/Users/me/project" })).result).toEqual({ session: "agent_code1" });
    expect(b.door.opened).toHaveLength(1);
    expect((await c.request("codeAgent.send", { line: "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}" })).result).toEqual({ ok: true });
    expect(b.door.inputs.map((i) => i.line)).toEqual(["{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}"]);
    b.door.toClient!("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}");
    for (let i = 0; i < 50 && c.notes.length === 0; i++) await Bun.sleep(10);
    expect(c.notes).toEqual([{ jsonrpc: "2.0", method: "codeAgent.line", params: { line: "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}" } }]);
    // A bound connection takes nothing else: another method, or a second session.
    expect((await c.request("pair.status", {})).error.code).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect((await c.request("agent.backends", {})).error.code).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect((await c.request("codeAgent.open", { cwd: "/Users/me/other" })).error.code).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(b.door.opened).toHaveLength(1);
    // Its close ends the session.
    c.close();
    for (let i = 0; i < 50 && b.door.closedConns.length === 0; i++) await Bun.sleep(10);
    expect(b.door.closedConns).toEqual([b.door.opened[0]!.connId]);
    // The token never reaches a log line.
    expect(b.logs.join("\n")).not.toContain(b.token);
  });

  test("a relay started at the escape floor, or inside an agent's session, gets no session", async () => {
    const b = await boot();
    // At the escape floor (fenced): not the user, and no one's session either.
    b.setPeer(fenced);
    const floor = await Client.connect(b.socketPath);
    expect((await floor.hello(b.token)).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    // Inside an agent's session: it acts as that session, which may not open one (userOnly).
    b.processes.add(6160, { sessionId: "agent_x", sessionKind: "agent", bot: "alpha" });
    b.setPeer(inAgent);
    const agent = await Client.connect(b.socketPath);
    expect((await agent.hello(b.token)).result.caller).toMatchObject({ kind: "session", sessionId: "agent_x" });
    expect((await agent.request("codeAgent.open", { cwd: "/Users/me/project" })).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect((await agent.request("codeAgent.send", { line: "{}" })).error.code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(b.door.opened).toEqual([]);
    floor.close();
    agent.close();
  });

  test("the session ending on the daemon's side closes the connection", async () => {
    const b = await boot();
    const c = await Client.connect(b.socketPath);
    await c.hello(b.token);
    await c.request("codeAgent.open", { cwd: "/Users/me/project" });
    b.door.end!();
    for (let i = 0; i < 50 && !c.closed; i++) await Bun.sleep(10);
    expect(c.closed).toBe(true);
  });
});
