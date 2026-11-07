// Lane K's agents in the real daemon (the daemon integration lane): `createAgents` starts with the bot side over its
// host, and `clover-core code-agent`'s relay (K's #291) opens a coding session against the daemon's own endpoint, as
// the user's terminal. Before the agents are up, and after they stop, the doors refuse. Fakes only where their lanes use
// them: H's in-memory network, D's plugin registry and drivers; the coding agent runs on the real embedded runtime.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { runCodeAgentRelay } from "../src/agents/code-agent/relay";
import { FileSecretStore } from "../src/auth/secret-store";
import { Drivers } from "../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { lateAgentDoors } from "../src/daemon-parts";
import { MemoryNetwork } from "../src/links/memory-wire";
import { describeWithEmbeddedRuntime } from "./helpers/embedded-runtime";

setDefaultTimeout(90_000);
const MODEL = "winter-test/calls";

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

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

test("the doors refuse until the agents are up: a code-agent client is told to try again, a bridge hello is refused", async () => {
  const handlers = {};
  const doors = lateAgentDoors(handlers);
  await expect(doors.codeAgent.open({ connId: 1, clientName: "x", toClient: () => {}, end: () => {} }, { cwd: "/" })).rejects.toThrow(/isn't running on this computer yet/);
  expect(() => doors.codeAgent.input(1, "{}")).toThrow(/isn't running/);
  expect(await doors.bridge.gate.accept("token", "s_1", 1)).toEqual({ ok: false, reason: "no agents are running on this computer" });
  expect(Object.keys(handlers)).toEqual([]);
});

describeWithEmbeddedRuntime("clover-core code-agent against the real daemon", () => {
  test("the agents start with the bot side; the relay opens a coding session through the daemon's endpoint and a turn runs; the stop ends it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-int-agents-")));
    const home = join(root, "clover-home");
    const userHome = join(root, "home");
    const project = join(userHome, "project1");
    mkdirSync(project, { recursive: true });
    const net = new MemoryNetwork();
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
      links: {
        wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null,
        mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" },
      },
      parts: {
        userHome,
        bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: MODEL }) },
        agents: { defaultModel: () => MODEL },
      },
    });
    await daemon.cloverParts.ready;
    const agents = daemon.cloverParts.agents();
    expect(agents).toBeDefined();
    expect(agents!.backends().map((b) => b.id)).toEqual(expect.arrayContaining(["clover-code"]));
    const side = daemon.cloverParts.bots()!;

    const input = new Lines();
    const out: Record<string, unknown>[] = [];
    const said: string[] = [];
    const exit = runCodeAgentRelay({
      endpoint: daemon.socketPath, cwd: project, token: async () => daemon!.tokens.harness, input,
      output: (text) => { for (const l of text.split("\n").filter(Boolean)) out.push(JSON.parse(l)); }, say: (t) => void said.push(t),
    });
    const reply = async (id: number) => {
      for (let i = 0; i < 1200; i++) {
        const m = out.find((x) => x["id"] === id && x["method"] === undefined);
        if (m) return m;
        await Bun.sleep(50);
      }
      throw new Error(`no answer to ${id}; the client got ${JSON.stringify(out).slice(0, 500)}; the relay said ${said.join(" | ")}`);
    };
    input.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    expect((await reply(1))["result"]).toMatchObject({ agentInfo: { name: "clover-code" } });
    input.push({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: project, mcpServers: [] } });
    const sessionId = ((await reply(2))["result"] as { sessionId: string }).sessionId;
    expect(typeof sessionId).toBe("string");
    // The user's coding session, in the bot side's host, rooted in the project's place in the tree.
    expect(side.host.list({ kind: "coding" })).toEqual([expect.objectContaining({ kind: "coding", root: "home/Studio/project1" })]);
    input.push({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello" }] } });
    expect(((await reply(3))["result"] as { stopReason: string }).stopReason).toBe("end_turn");

    // The stop: the agents close before the bot side, and the relay's connection ends.
    await daemon.stop();
    daemon = undefined;
    input.end();
    expect(typeof (await exit)).toBe("number");
  });
});
