// `clover-core code-agent` end to end (K-M3b): an outside ACP client (a stand-in for Zed) talks to the relay
// (relay.ts) over its stdio, the relay to the daemon's real endpoint as the user's `cli`, and the daemon runs Clover's
// coding agent on the embedded runtime for it (service.ts, `CloverCodeBackend.serve`). The test model writes a file;
// the write asks the client, which allows it once.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import type { Level } from "@waifucave/clover-protocol";
import { CloverTokens } from "../../auth/clover-tokens";
import { SessionProcesses } from "../../auth/clover-caller";
import { FileSecretStore } from "../../auth/secret-store";
import { TokenAuthority } from "../../auth/tokens";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import { FakeSessionHost } from "../../contracts/fakes/session-host";
import { FakeTree } from "../../contracts/fakes/tree";
import { createCloverServer } from "../../ipc/clover";
import { startIpcServer } from "../../ipc/server";
import type { PeerFacts } from "../../platform/caller-probe";
import { resolveEndpoint } from "../../platform/transport";
import { buildCoreBrand } from "../../runtime-sdk/brand";
import { testProviderNameFor } from "../../runtime-sdk/provider-selection";
import { SessionStore } from "../../sessions/store";
import { describeWithEmbeddedRuntime } from "../../../test/helpers/embedded-runtime";
import { CloverCodeBackend } from "../clover-code/backend";
import { runCodeAgentRelay } from "../code-agent/relay";
import { codeAgentDoor, CodeAgentService } from "../code-agent/service";

setDefaultTimeout(90_000);
const MODEL = "winter-test/calls";
const outside: PeerFacts = { pid: 4242, ancestors: [1], probe: { sandboxedMac: false, inHostNamespacesLinux: true, tokenRestrictedWin: false, appContainerWin: false }, floor: "outside-floor" };

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function baseOptionsFor(home: string, spawn: SpawnClaudeCodeProcess) {
  return (o: { model: string; effort?: string; cwd: string }): Options => {
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", CLOVER_HOME: home };
    const provider = testProviderNameFor(o.model);
    if (provider !== undefined) env["WINTER_TEST_PROVIDER"] = provider;
    return { brand: buildCoreBrand(undefined, home), model: o.model, cwd: o.cwd, env, spawnClaudeCodeProcess: spawn, settingSources: [] };
  };
}

/** The client's side of the relay's stdin: lines pushed as the test goes. */
class Lines implements AsyncIterable<Uint8Array> {
  readonly #queue: Uint8Array[] = [];
  #wake?: () => void;
  #ended = false;
  push(msg: unknown): void {
    this.#queue.push(new TextEncoder().encode(`${JSON.stringify(msg)}\n`));
    this.#wake?.();
  }
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      while (this.#queue.length > 0) yield this.#queue.shift()!;
      if (this.#ended) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = undefined;
    }
  }
}

async function boot(spawn: SpawnClaudeCodeProcess, level: Level) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-k-cae2e-")));
  temps.push(root);
  const userHome = join(root, "home");
  const cloverHome = join(userHome, ".clover");
  const project = join(userHome, "project1");
  for (const d of [project, cloverHome, join(root, "run")]) mkdirSync(d, { recursive: true });
  const clock = new FakeClock();
  const host = new FakeSessionHost({ clock });
  const backend = new CloverCodeBackend({ clock: { now: () => Date.now() } as never, defaultModel: () => MODEL, baseOptions: baseOptionsFor(cloverHome, spawn), sandboxReady: () => true });
  const service = new CodeAgentService({
    home: cloverHome, computer: "Studio", userHome, host, clock,
    tree: new FakeTree({ clock, computers: { Studio: { home: userHome } }, botComputer: () => "Studio" }),
    fence: new FakeFence({ home: userHome, cloverHome }),
    backend: () => backend, levelOf: () => level,
  });
  const store = new SessionStore(root);
  const endpoint = resolveEndpoint(join(root, "run")).path;
  const authority = new TokenAuthority(new FileSecretStore(join(root, "secrets.json")));
  const legacy = await authority.ensureTokens();
  const logs: string[] = [];
  const clover = createCloverServer({
    tokens: new CloverTokens({ verifyCli: (t) => authority.verify("harness", t) }), processes: new SessionProcesses(), serverVersion: "test",
    deviceId: "d".repeat(32), probe: () => outside, codeAgent: codeAgentDoor(service), log: (l) => void logs.push(l),
  });
  const server = startIpcServer({ socketPath: endpoint, serverVersion: "test", tokens: authority, store, cloverConnections: clover });
  const stop = () => { clover.dispose(); server.stop(); store.close(); };
  return { root, userHome, cloverHome, project, host, endpoint, token: legacy.harness, logs, stop };
}

describeWithEmbeddedRuntime("clover-core code-agent end to end", (spawn) => {
  test("an outside client opens a session through the relay; a write asks it, and its answer allows it once", async () => {
    const b = await boot(spawn, "ask");
    const input = new Lines();
    const out: Record<string, unknown>[] = [];
    const said: string[] = [];
    const exit = runCodeAgentRelay({
      endpoint: b.endpoint, cwd: b.project, token: async () => b.token, input,
      output: (text) => { for (const l of text.split("\n").filter(Boolean)) out.push(JSON.parse(l)); }, say: (t) => void said.push(t),
    });
    const reply = async (id: number) => {
      for (let i = 0; i < 600; i++) {
        const m = out.find((x) => x["id"] === id && x["method"] === undefined);
        if (m) return m;
        await Bun.sleep(50);
      }
      throw new Error(`no answer to ${id}; the client got ${JSON.stringify(out).slice(0, 500)}`);
    };
    try {
      input.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
      expect((await reply(1))["result"]).toMatchObject({ agentInfo: { name: "clover-code" } });
      input.push({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: b.project, mcpServers: [] } });
      const sessionId = ((await reply(2))["result"] as { sessionId: string }).sessionId;
      // Listed as the user's coding session, from this client.
      expect(b.host.list({ kind: "coding" })).toEqual([expect.objectContaining({ kind: "coding", root: "home/Studio/project1", title: "From clover-code-agent" })]);
      const file = join(b.project, "hello.txt");
      input.push({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: `CALL Write {"file_path":${JSON.stringify(file)},"content":"hi"}` }] } });
      // The level asks about a write: the client is asked, with no "always".
      let ask: Record<string, unknown> | undefined;
      for (let i = 0; i < 600 && !ask; i++) {
        ask = out.find((x) => x["method"] === "session/request_permission");
        if (!ask) await Bun.sleep(50);
      }
      expect(ask).toBeDefined();
      const options = (ask!["params"] as { options: { optionId: string; kind: string }[] }).options;
      expect(options.map((o) => o.kind).sort()).toEqual(["allow_once", "reject_once"]);
      input.push({ jsonrpc: "2.0", id: ask!["id"], result: { outcome: { outcome: "selected", optionId: options.find((o) => o.kind === "allow_once")!.optionId } } });
      expect(((await reply(3))["result"] as { stopReason: string }).stopReason).toBe("end_turn");
      expect(readFileSync(file, "utf8")).toBe("hi");
      // The client's side closes: the relay exits, and the session ends with the connection.
      input.end();
      expect(await exit).toBe(0);
      for (let i = 0; i < 100 && b.host.list({ kind: "coding" })[0]!.status !== "stopped"; i++) await Bun.sleep(20);
      expect(b.host.list({ kind: "coding" })[0]!.status).toBe("stopped");
      // The token reached no line the client got, nothing the relay said, and no log.
      expect([JSON.stringify(out), said.join("\n"), b.logs.join("\n")].some((t) => t.includes(b.token))).toBe(false);
    } finally {
      input.end();
      b.stop();
    }
  });

  test("a folder Clover can't place, or a token it won't take, gets no session and says why", async () => {
    const b = await boot(spawn, "ask");
    try {
      const said: string[] = [];
      const outsideHome = await runCodeAgentRelay({ endpoint: b.endpoint, cwd: b.root, token: async () => b.token, input: new Lines(), output: () => {}, say: (t) => void said.push(t) });
      expect(outsideHome).toBe(1);
      expect(said.join("\n")).toContain("couldn't start here");
      const wrong = await runCodeAgentRelay({ endpoint: b.endpoint, cwd: b.project, token: async () => "not-the-token", input: new Lines(), output: () => {}, say: (t) => void said.push(t) });
      expect(wrong).toBe(1);
      expect(said.at(-1)).toContain("refused the connection");
      expect(said.join("\n")).not.toContain("not-the-token");
      const none = await runCodeAgentRelay({ endpoint: b.endpoint, cwd: b.project, token: async () => null, input: new Lines(), output: () => {}, say: (t) => void said.push(t) });
      expect(none).toBe(1);
      expect(b.host.list({ kind: "coding" })).toEqual([]);
      expect(existsSync(b.project)).toBe(true);
    } finally {
      b.stop();
    }
  });
});
