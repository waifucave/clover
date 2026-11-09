// Lane K's agents in the real daemon (the daemon integration lane): `createAgents` starts with the bot side over its
// host, and `clover-core code-agent`'s relay (K's #291) opens a coding session against the daemon's own endpoint, as
// the user's terminal. Before the agents are up, and after they stop, the doors refuse. Fakes only where their lanes use
// them: H's in-memory network, D's plugin registry and drivers; the coding agent runs on the real embedded runtime.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import type { Level } from "@waifucave/clover-protocol";
import { AcpAgentSession } from "../src/agents/acp/session";
import { runCodeAgentRelay } from "../src/agents/code-agent/relay";
import { writeOpenAiApiKey } from "../src/auth/credential-material";
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

/** A real daemon in a temp home, on H's in-memory network, with D's fake bots and K's agents on `model`. */
async function bootDaemon(o: { model: string; prepare?(home: string, secrets: FileSecretStore): Promise<void> }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-int-agents-")));
  const home = join(root, "clover-home");
  const userHome = join(root, "home");
  const project = join(userHome, "project1");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  const secrets = new FileSecretStore(join(home, "secrets.json"));
  await o.prepare?.(home, secrets);
  const net = new MemoryNetwork();
  daemon = await startDaemon({
    home, secrets, agentProvider: null, pair: false,
    links: {
      wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" },
    },
    parts: {
      userHome,
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: o.model }) },
      agents: { defaultModel: () => o.model },
    },
  });
  await daemon.cloverParts.ready;
  return { home, project };
}

/** `clover-core code-agent`'s relay against the daemon's endpoint, as the user's terminal, and its answers by id. */
function relay(project: string) {
  const input = new Lines();
  const out: Record<string, unknown>[] = [];
  const said: string[] = [];
  const exit = runCodeAgentRelay({
    endpoint: daemon!.socketPath, cwd: project, token: async () => daemon!.tokens.harness, input,
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
  return { input, reply, exit };
}

describeWithEmbeddedRuntime("clover-core code-agent against the real daemon", () => {
  test("the agents start with the bot side; the relay opens a coding session through the daemon's endpoint and a turn runs; a level drop reaches it; the stop ends it", async () => {
    const { project } = await bootDaemon({ model: MODEL });
    const agents = daemon!.cloverParts.agents();
    expect(agents).toBeDefined();
    expect(agents!.backends().map((b) => b.id)).toEqual(expect.arrayContaining(["clover-code"]));
    const side = daemon!.cloverParts.bots()!;
    // The bot side asks through lane C's broker: its one SessionGrants is there for the browser.
    expect(side.grants).toBeDefined();

    const { input, reply, exit } = relay(project);
    input.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    expect((await reply(1))["result"]).toMatchObject({ agentInfo: { name: "clover-code" } });
    input.push({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: project, mcpServers: [] } });
    const sessionId = ((await reply(2))["result"] as { sessionId: string }).sessionId;
    expect(typeof sessionId).toBe("string");
    // The user's coding session, in the bot side's host, rooted in the project's place in the tree.
    expect(side.host.list({ kind: "coding" })).toEqual([expect.objectContaining({ kind: "coding", root: "home/Studio/project1" })]);
    const relayed = side.host.list({ kind: "coding" })[0]!.id;
    input.push({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello" }] } });
    expect(((await reply(3))["result"] as { stopReason: string }).stopReason).toBe("end_turn");

    // The daemon's `watchLevels` (the computer node's registry): the user lowering this computer's level reaches a
    // running agent session at once, not only at its next turn. (The relay's own session reads the level at each ask.)
    const levels: Level[] = [];
    const setLevel = AcpAgentSession.prototype.setLevel;
    AcpAgentSession.prototype.setLevel = function (this: AcpAgentSession, level: Level) {
      levels.push(level);
      return setLevel.call(this, level);
    };
    try {
      const started = await agents!.manager.start({ caller: { kind: "user", device: "dev_test", clientMessageId: "m_1" }, backend: "clover-code", prompt: "hello", root: "home/Studio/project1" });
      expect(side.host.list({ kind: "coding" }).map((v) => v.id)).toContain(started.sessionId);
      // The agent starts with its first turn, held to the level then.
      for (let i = 0; i < 1000 && levels.length === 0; i++) await Bun.sleep(10);
      expect(levels).toEqual(["ask-risky"]);
      await daemon!.cloverParts.node()!.registry.setLevel("Studio", "read-only");
      for (let i = 0; i < 100 && levels.length === 1; i++) await Bun.sleep(10);
      expect(levels).toEqual(["ask-risky", "read-only"]);
    } finally {
      AcpAgentSession.prototype.setLevel = setLevel;
    }

    // The stop: the agents close before the bot side, the relay's coding session ends with them (#292 review S4: the
    // server's doors close first, so the connection's own close never reaches the service), and its connection ends.
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); error(...args); };
    try {
      await daemon!.stop();
    } finally {
      console.error = error;
    }
    daemon = undefined;
    expect(side.host.get(relayed)?.status).toBe("stopped");
    // The code-agent service itself ended the relay (its served agent closed), not only the host's session: by the
    // connection's close when the server goes first, else by the agents' close (`closeAll`).
    expect(lines.some((l) => l.includes(`code-agent: ${relayed} ended (`))).toBe(true);
    input.end();
    expect(typeof (await exit)).toBe("number");
  });
  test("an agent's turn gets its provider and credential as a bot's does: the daemon's one provider fill, the user's endpoint and the stored key", async () => {
    // The user's own OpenAI endpoint, a local stand-in that records what reaches it and refuses it.
    const seen: Array<{ path: string; auth: string | null }> = [];
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req) {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
        return Response.json({ error: { message: "refused by the test's endpoint", type: "invalid_request_error" } }, { status: 400 });
      },
    });
    try {
      const { project } = await bootDaemon({
        model: "openai/gpt-5.4",
        prepare: async (home, secrets) => {
          writeFileSync(join(home, "settings.json"), JSON.stringify({ providers: { openai: { baseUrl: `http://127.0.0.1:${server.port}/v1` } } }));
          await writeOpenAiApiKey(secrets, "sk-int-test-not-real");
        },
      });
      const { input, reply, exit } = relay(project);
      input.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
      await reply(1);
      input.push({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: project, mcpServers: [] } });
      const sessionId = ((await reply(2))["result"] as { sessionId: string }).sessionId;
      input.push({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello" }] } });
      await reply(3);
      // The turn went to the user's endpoint for the model's provider, with the key the user stored, resolved through
      // the daemon's one broker: what A-M3's fill gives a bot's turn.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]!.path.startsWith("/v1/")).toBe(true);
      expect(seen[0]!.auth).toBe("Bearer sk-int-test-not-real");
      await daemon!.stop();
      daemon = undefined;
      input.end();
      await exit;
    } finally {
      server.stop(true);
    }
  });
});
