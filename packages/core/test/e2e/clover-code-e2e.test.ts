// P8b Task 17 Step 2 — CODE ON THE CLOVER LEG, end to end.
//
// A real `startDaemon` in a temp home with `winterLeg: { code: true }`, a real NDJSON client, and the
// real runtime: until A-M1 the spawned `winter` binary, since A-M1 (spec §3.3) the same runtime
// EMBEDDED in a Worker of the daemon — the binary is still configured and no longer runs a session.
// Every model is a `winter-test/<double>`; nothing reaches the network.
//
//   (a) `tooluse` under `ask` → an `approval_requested` carrying the phone's fields; `approval.respond`
//       allows; the `tool_result` follows (the double's unregistered tool → its own fallback text)
//   (b) the same call under `plan` → the plan-mode deny, no card, no mutation
//   (c) the per-session `computer` capability reaches the daemon's ComputerUseService (a spy) and is
//       code-only (CLOVER_CAPABILITY_TOOLS: computer ∈ code, ∉ chat)
//   (d) P8b-27(c): a control-plane self-grant is DENIED — a Write to `<cwd>/.clover/settings.json`
//       (the host fence) and a Bash redirect to a path outside the session's write roots (the
//       sandbox). This case is the gate for `winterLeg.code`.
//   (m) fix wave (review row 3 / F11): file-based memory EXISTS on this leg — a Write by the child
//       into the session's MEMDIR `<home>/projects/<key>/memory/` lands (the SDK 0.0.4 carve-out
//       `isMemoryCarveOut` + Clover's fence, which never covered the MEMDIR), with no card under
//       `auto`. Chat cannot host this case: chat disallows `Write` by design (no fs surface; its
//       `_assistant` bucket is Dreaming's to write), so a CODE session is the only real child write.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@waifucave/clover-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { computerCapability } from "../../src/capabilities";
import { CLOVER_CAPABILITY_TOOLS } from "../../src/capabilities/names";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import type { RuntimeStateWiring } from "../../src/runtime-state";
import { controlPlaneDenialMessage } from "../../src/runtime-sdk/control-plane";
import { sessionLegOf } from "../../src/runtime-sdk/leg";
import { memoryDirFor } from "../../src/agent/memory-dir";
import { disallowedToolsFor } from "../../src/runtime-sdk/mode-options";
import { describeWithEmbeddedRuntime } from "../helpers/embedded-runtime";
import { storeProjectsDir } from "../../src/agent/paths";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else if (msg.method === METHODS.event) c.events.push(msg.params as SessionEvent);
          }
        },
        drain() { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async call<T>(method: string, params?: unknown): Promise<T> {
    const r = await this.request(method, params);
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
    return r.result as T;
  }
  async hello(token: string, clientName: string): Promise<void> {
    await this.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }
  async waitFor(pred: (e: SessionEvent) => boolean, ms = 20_000): Promise<SessionEvent> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timed out; saw: ${this.events.map((e) => e.type).join(",")}`);
      await Bun.sleep(20);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

const REAL_HOMES = [join(homedir(), ".clover"), join(homedir(), ".clover-dev")];
const MCP_FIXTURE = join(import.meta.dir, "../agent/mcp/fake-mcp-server.ts");
function walkHome(dir: string, describe: (rel: string, st: Stats) => string): string {
  if (!existsSync(dir)) return `${dir}: absent`;
  const lines: string[] = [];
  const walk = (p: string, rel: string): void => {
    let entries: string[];
    try { entries = readdirSync(p).sort(); } catch { lines.push(`${rel}/ <unreadable>`); return; }
    for (const name of entries) {
      const child = join(p, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st: Stats;
      try { st = statSync(child); } catch { lines.push(`${childRel} <unreadable>`); continue; }
      lines.push(describe(childRel, st));
      if (st.isDirectory()) walk(child, childRel);
    }
  };
  walk(dir, "");
  return `${dir}: present\n${lines.join("\n")}`;
}
const homeSignature = (dir: string): string => walkHome(dir, (rel, st) => (st.isDirectory() ? `${rel}/` : rel));
const projectsSignature = (home: string): string => walkHome(join(home, "projects"), (rel, st) => `${rel} ${st.size} ${st.mtimeMs}`);
/** A-M1 (review S7): sessions run EMBEDDED, one Worker per session inside the daemon, so no `winter` child exists to
 *  look for. A survivor is any process other than this one whose command line names this file's own home (a
 *  session's tool children, MCP servers and hooks run with paths under it) — never a stray from another run. */
const cloverSurvivors = (home: string): string[] =>
  Bun.spawnSync(["ps", "-axww", "-o", "pid=,command="]).stdout.toString().split("\n")
    .map((l) => l.trim()).filter((l) => l.includes(home) && Number.parseInt(l, 10) !== process.pid);
/** The child processes of THIS test process (compared before and after an action: an embedded session adds a
 *  Worker, never a process). */
const cloverChildren = (): string[] =>
  Bun.spawnSync(["pgrep", "-P", String(process.pid)]).stdout.toString().trim().split("\n").filter(Boolean);
/** The stdio fake MCP servers this process started (an embedded session's spawn is this process's child). */
const fakeMcpChildren = (): string[] =>
  Bun.spawnSync(["pgrep", "-P", String(process.pid), "-f", "fake-mcp-server"]).stdout.toString().trim().split("\n").filter(Boolean);
const types = (events: SessionEvent[]): string[] => events.map((e) => e.type);

describeWithEmbeddedRuntime("code on the Clover leg — the built binary through a real daemon", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let rt: RuntimeStateWiring;
  let client: TestClient;
  const signaturesBefore = new Map<string, string>();
  const projectsBefore = new Map<string, string>();

  const writeSettings = (): void => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/tooluse", baseUrl: "http://127.0.0.1:9/v1" },
      computerUse: { enabled: true },
      runtimes: { winterLeg: { code: true }, winterIdleTimeoutSec: 10 },
    }, null, 2));
    // fix wave (review row 7): a configured user MCP server — the repo's fake stdio server — must
    // reach the child (case (n)). The daemon's own McpManager probes a copy at boot (WS-24: connects,
    // lists, closes); the child spawns its own from the forwarded config. WS-21: the user scope is
    // `sdk/.clover.json` (claude's `.claude.json` shape).
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "sdk", ".clover.json"), JSON.stringify({ mcpServers: { fake: { command: "bun", args: ["run", MCP_FIXTURE] } } }, null, 2));
  };

  async function createCode(model: string, cwd: string, policy = "ask"): Promise<string> {
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: `winter-test/${model}`, cwd, approvalPolicy: policy });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    return sessionId;
  }
  const mainKinds = (sid: string): string[] => types(daemon!.sessions.read(sid).filter((e) => (e as { threadId?: string }).threadId === "main")).filter((t) => ["user_message", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed", "approval_requested", "agent_error"].includes(t));

  beforeAll(async () => {
    for (const h of REAL_HOMES) { signaturesBefore.set(h, homeSignature(h)); projectsBefore.set(h, projectsSignature(h)); }
    // Fix-wave re-review N-2: the home gets a `.clover` LEAF segment, so a child's write under it is
    // protected-unless-carved-out on BOTH halves of the SDK's rule — the stage-2 baseline deny
    // `//<cloverHome>/projects/**` (+ `memoryCarveOutSkip`) AND the §6.7 protected-directory half
    // (`isInsideProtectedDirectory`, keyed on a `.clover` segment) — which is how a real
    // `~/.clover` / `~/.clover-dev` home is shaped. Case (m)'s MEMDIR write now exercises both.
    home = join(realpathSync(mkdtempSync(join(tmpdir(), "clover-code-e2e-"))), ".clover");
    mkdirSync(home, { recursive: true });
    writeSettings();
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    rt = daemon.runtimeState;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
    expect(daemon.clover.legForNewSession("code")).toBe("winter");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    for (const pid of cloverChildren()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    rmSync(join(home, ".."), { recursive: true, force: true });
  });

  test("(a) tooluse under `ask` → approval_requested with the phone's fields; approval.respond allows; the tool_result follows", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clover-code-cwd-")));
    const sid = await createCode("tooluse", cwd, "ask");
    expect(sessionLegOf(rt.records.get(sid))).toBe("winter");
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "use the tool" });
    const card = await client.waitFor((e) => e.type === "approval_requested" && e.sessionId === sid) as {
      callId: string; toolName: string; summary: string; issuedAt?: number; expiresAt?: number;
    };
    // the phone reads exactly these
    expect(card.callId.length).toBeGreaterThan(0);
    expect(card.toolName).toBe("test_tool");
    expect(card.summary.length).toBeGreaterThan(0);
    expect(typeof card.issuedAt).toBe("number");
    expect(typeof card.expiresAt).toBe("number");
    // nothing has resolved yet: no tool_result before the answer
    expect(daemon!.sessions.read(sid).some((e) => e.type === "tool_result")).toBe(false);
    await client.call(METHODS.approvalRespond, { sessionId: sid, callId: card.callId, approved: true });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(50);
    // the call proceeded past the card; a tool_result followed (the double's tool is unregistered,
    // so it is the child's own fallback — the point is that approval let it RUN)
    expect(mainKinds(sid).filter((t) => t !== "approval_requested")).toEqual(["user_message", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed"]);
    expect(daemon!.sessions.read(sid).filter((e) => e.type === "approval_requested")).toHaveLength(1);
    const res = daemon!.sessions.read(sid).find((e) => e.type === "tool_result") as { callId: string };
    expect(res.callId).toBe(card.callId);
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);

  test("(b) the same call under `plan` → the plan-mode deny, no card, no mutation", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clover-code-plan-")));
    const sid = await createCode("tooluse", cwd, "plan");
    const evCount = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "use the tool" });
    await client.waitFor((e) => client.events.indexOf(e) >= evCount && e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(50);
    const res = daemon!.sessions.read(sid).find((e) => e.type === "tool_result") as { isError: boolean; output: string };
    expect(res.isError).toBe(true);
    // Clover's `plan` mode denies the mutation; whether the message is Clover's own or the bridge's,
    // it must READ as plan mode and NO card was raised
    expect(res.output.toLowerCase()).toContain("plan");
    expect(daemon!.sessions.read(sid).filter((e) => e.type === "approval_requested")).toEqual([]);
    expect(client.events.filter((e) => e.type === "approval_requested" && e.sessionId === sid)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);

  test("(c) the per-session computer capability reaches the daemon's ComputerUseService (spy) and is code-only", async () => {
    // CLOVER_CAPABILITY_TOOLS: computer is a code/dispatch tool, never chat.
    const modes = CLOVER_CAPABILITY_TOOLS["mcp__clover__computer__computer"].modes as readonly string[];
    expect(modes).toContain("code");
    expect(modes).not.toContain("chat");
    // the daemon's own builder includes a computer server for a code session (computerUse.enabled: true) —
    // since ComputerV2 (2026-10-08) `computer_v2`, never beside the legacy `computer` (built only with
    // `computerUse.legacyComputer`; the spy below still drives the legacy capability directly)
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clover-code-cap-")));
    const record = daemon!.buildSessionCapabilities({ sessionId: "s_probe", mode: "code", cwd, roots: [cwd], tmpDir: cwd });
    expect(Object.keys(record)).toContain("clover__computer_v2");
    expect(Object.keys(record)).not.toContain("clover__computer");
    expect(disallowedToolsFor("chat", {})).toContain("ComputerV2");
    expect(disallowedToolsFor("code", {})).not.toContain("ComputerV2");
    // the server is built for every mode (P8b-36); the MODE scoping is `disallowedTools` (P8b-12),
    // under the plain name the child knows it by since the 2026-10-01 tool-surface ruling
    expect(disallowedToolsFor("chat", {})).toContain("Computer");
    expect(disallowedToolsFor("code", {})).not.toContain("Computer");
    // the tool reaches the service: build the capability with a spy and drive its instance
    const calls: Array<{ cls: string; payload: string }> = [];
    const spy = { act: async (_sid: string, cls: string, payload: string) => { calls.push({ cls, payload }); return { ok: true, resultJson: JSON.stringify({ text: "#0 window" }) }; } };
    const cap = computerCapability({ sessionId: "s_probe", mode: "code", cwd, roots: [cwd] }, { computerUse: () => spy as never });
    const out = await (cap as { instance: { callTool(name: string, args: unknown): Promise<{ content: unknown[]; isError?: boolean }> } }).instance.callTool("computer", { action: "ax_snapshot" });
    expect(out.isError ?? false).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cls).toBe("ax-read");
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);

  test("(d) P8b-27(c): a control-plane self-grant is DENIED — the host fence on a Write, the sandbox on a Bash redirect", async () => {
    // (d1) the HOST FENCE (P8b-27b): a Write to a `.clover/settings.json` never reaches the child's
    // filesystem. `p5checkpoint` reads then writes the path in the prompt's last line.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clover-code-grant-")));
    mkdirSync(join(cwd, ".clover"), { recursive: true });
    const rules = join(cwd, ".clover", "settings.json");
    writeFileSync(rules, JSON.stringify({ before: true }));   // exists so the double's Read succeeds
    const sid = await createCode("p5checkpoint", cwd, "auto");
    await client.call(METHODS.sessionSend, { sessionId: sid, text: `write to this exact path:\n${rules}` });
    // Since fix wave F1 (`auto` → Clover `default`) the double's THIRD step — a Bash redirect into
    // `<cwd>/.clover/` — reaches the bridge carrying Clover's protected-home `blockedPath` (any
    // `.clover` segment, `permissions/protected.ts`), which the bridge escalates to a CARD in code
    // (Task 9 F1: "Clover asking, not refusing"). Before F1 Clover's own classifier answered it.
    // The card is incidental to this case (the Write denial is the subject): deny it so the turn
    // completes. Recorded in the fix-wave report as a cross-leg divergence — the engine let a bash
    // write into `.clover/` run silently under `auto` (only the three control-plane filenames were
    // fenced); the Clover leg cards it.
    const first = await client.waitFor((e) => e.sessionId === sid && (e.type === "turn_completed" || e.type === "approval_requested"));
    if (first.type === "approval_requested") {
      const card = first as { callId: string; toolName: string };
      expect(card.toolName).toBe("bash");
      expect(card.callId).toBe("p5-ckpt-bash");
      await client.call(METHODS.approvalRespond, { sessionId: sid, callId: card.callId, approved: false });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    }
    await Bun.sleep(50);
    const writeRes = daemon!.sessions.read(sid).find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p5-ckpt-write") as { isError: boolean; output: string } | undefined;
    expect(writeRes).toBeDefined();
    expect(writeRes!.isError).toBe(true);
    // MEASURED: Clover's stage-2 deny rule (P8b-27a, `Write(//**/.clover/settings.json)`) fires
    // BEFORE `canUseTool`, so the bridge's own fence (P8b-27b) is the second layer behind it —
    // either denial text is the invariant holding
    expect(writeRes!.output === controlPlaneDenialMessage("Write", rules) || /Denied by permission rule/.test(writeRes!.output)).toBe(true);
    expect(JSON.parse(readFileSync(rules, "utf8"))).toEqual({ before: true });   // untouched on disk

    // (d2) the SANDBOX: the double's Bash step (`printf ... > <path>.bash`) writes OUTSIDE the
    // session's write roots. The sandbox must deny it (the write never lands). This is the layer
    // P8b-27(c) can only prove against the real binary — the gate for `winterLeg.code`.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "clover-code-outside-"))); // NOT a root of `sid`
    const target = join(outside, "grant");   // the double appends ".bash"
    const sid2 = await createCode("p5checkpoint", cwd, "auto");
    writeFileSync(join(cwd, "seed.txt"), "seed");   // the double reads/writes this in-root file first
    await client.call(METHODS.sessionSend, { sessionId: sid2, text: `write to this exact path:\n${target}` });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid2);
    await Bun.sleep(50);
    const bashRes = daemon!.sessions.read(sid2).find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p5-ckpt-bash") as { isError: boolean; output: string } | undefined;
    expect(bashRes).toBeDefined();
    // the write outside the roots did not land (the sandbox fenced it)
    expect(existsSync(`${target}.bash`)).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }, 60_000);

  test("(m) file-based memory on the Clover leg: the child's Write into the store home's `projects/<key>/memory/` (sdk/projects) LANDS, no card under `auto` (the 0.0.4 carve-out)", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clover-code-memdir-")));
    // The SAME derivation the daemon files this cwd under (`memoryKeyOf` → `memoryProjectKeyFor`;
    // no `memory.directory` override, no relocation in this home). WS-21: the store home (`sdk/`).
    const memdir = memoryDirFor(cwd, { cloverHome: home });
    expect(memdir.startsWith(storeProjectsDir(home) + "/")).toBe(true);
    expect(memdir.endsWith("/memory")).toBe(true);
    mkdirSync(memdir, { recursive: true });
    const note = join(memdir, "fix-wave-note.md");
    writeFileSync(note, "BEFORE\n");   // the double Reads before it Writes (read-ladder)
    const sid = await createCode("p5checkpoint", cwd, "auto");
    await client.call(METHODS.sessionSend, { sessionId: sid, text: `remember this at the exact path:\n${note}` });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid, 40_000);
    await Bun.sleep(50);
    const log = daemon!.sessions.read(sid);
    const writeRes = log.find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p5-ckpt-write") as { isError: boolean; output: string } | undefined;
    expect(writeRes).toBeDefined();
    expect(writeRes!.isError, `memory write refused: ${writeRes!.output}`).toBe(false);
    // THE proof: the child's Write reached the MEMDIR — the SDK's protected-home check carved it
    // out, Clover's deny rules never named it, and the gate's `auto` verdict let it through silently.
    expect(readFileSync(note, "utf8")).toBe("AFTER\n");
    expect(log.filter((e) => e.type === "approval_requested")).toEqual([]);
    expect(client.events.filter((e) => e.type === "approval_requested" && e.sessionId === sid)).toEqual([]);
    expect(log.filter((e) => e.type === "agent_error")).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("(n) a configured user MCP server (sdk/.clover.json) reaches the session: ITS Worker spawns the forwarded stdio server, and its end stops it", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clover-code-mcp-")));
    // A-M1: the session runs EMBEDDED (spec §3.3), in a Worker of this process, so the server it spawns
    // is a child of THIS process. The daemon's own McpManager probe copy is too, but it ran at boot and
    // closed (WS-24: connects, lists, closes), so a `fake-mcp-server` child that is new since `before`
    // is the session's own.
    const before = new Set(fakeMcpChildren());
    const sid = await createCode("echo", cwd, "auto");
    const driver = daemon!.clover.get(sid)!;
    const t0 = Date.now();
    while (driver.init === undefined && Date.now() - t0 < 15_000) await Bun.sleep(20);
    expect(driver.init).toBeDefined();
    // the daemon-owned capability servers are offered (no shadowing) — DEFERRED since the 2026-10-01
    // ruling, so not in `init.tools`; the runtime still says the daemon's server connected
    expect(driver.init!.tools).toContain("ToolSearch");
    expect(driver.init!.tools).not.toContain("Computer");
    expect(daemon!.embedded.live().length).toBeGreaterThan(0);
    // MEASURED: a stdio server's tools are NOT in `system/init.tools` — the runtime connects
    // process-transport servers asynchronously after init (`WaitForMcpServers`/`RefreshMcpTools`
    // are advertised for exactly that), so the observable fact is the SPAWN.
    const spawned = (): string[] => fakeMcpChildren().filter((p) => !before.has(p));
    const t1 = Date.now();
    while (spawned().length === 0 && Date.now() - t1 < 10_000) await Bun.sleep(50);
    const sessionServers = spawned();
    expect(sessionServers.length).toBeGreaterThanOrEqual(1);
    await driver.end();
    // The Worker's teardown stops what its session started (WS-24's process groups): nothing outlives it.
    const t2 = Date.now();
    while (fakeMcpChildren().some((p) => sessionServers.includes(p)) && Date.now() - t2 < 10_000) await Bun.sleep(50);
    expect(fakeMcpChildren().filter((p) => sessionServers.includes(p))).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);

  test("(e) home isolation and zero survivors", async () => {
    client.close();
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    for (const h of REAL_HOMES) {
      expect(homeSignature(h)).toBe(signaturesBefore.get(h)!);
      expect(projectsSignature(h)).toBe(projectsBefore.get(h)!);
    }
    const t0 = Date.now();
    while (cloverSurvivors(home).length > 0 && Date.now() - t0 < 3000) await Bun.sleep(50);
    expect(cloverSurvivors(home).map((l) => l.slice(0, 120))).toEqual([]);
  });
});
