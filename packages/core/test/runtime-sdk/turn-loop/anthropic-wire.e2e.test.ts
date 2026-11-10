// The Anthropic request a bot's turns put on the wire, through the real embedded runtime and its Anthropic adapter, to
// the acceptance run's strict fake (scripts/acceptance/fake-anthropic.ts), which refuses with the API's 400 what the
// provider's docs say it refuses. Two turns, a plugin's MCP server added (an install), and a turn that calls its tool:
// every request is accepted; the content-less system message the SDK leads with is the documented per-message effort
// marker (`output_config.effort`, its beta in `anthropic-beta`), never an empty one; the added tool goes as a
// `tool_addition` in a system message that follows the user's turn.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver } from "../../../src/runtime-sdk/turn-loop/driver";
import type { BotMcpServer, McpRunner } from "../../../src/runtime-sdk/turn-loop/servers";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";
import { requestRefusal, startFakeAnthropic } from "../../../../../scripts/acceptance/fake-anthropic";
import { FileSecretStore } from "../../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../../src/auth/credential-material";
import { CLOVER_CREDENTIAL_INVENTORY } from "../../../src/runtime-sdk/keychain";
import { createHostCredentialBroker } from "../../../src/runtime-sdk/host-credentials";
import { keychainService } from "../../../src/profile";
import { botProviderFill } from "../../../src/runtime-sdk/turn-loop/provider-fill";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

type WireMessage = { role: string; content: unknown; output_config?: { effort?: unknown } };
type Wire = { model: string; messages: WireMessage[] };
const BETA = "mid-conversation-output-config-2026-07-01";

describeWithEmbeddedRuntime("the Anthropic wire, through the strict fake", (spawn) => {
  test("two turns, an install, a tool turn: no request the API refuses; the leading system message carries the effort; the tool comes as a tool_addition", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a3-wire-")));
    temps.push(home);
    const KEY = "a3-wire-dummy-key";
    const fake = startFakeAnthropic({ key: KEY, writePath: join(home, "w.txt"), writeContent: "x" });
    const secrets = new FileSecretStore(join(home, "secrets.json"));
    await writeCredentialMaterial(secrets, CLOVER_CREDENTIAL_INVENTORY.find((x) => x.provider === "anthropic")!.secretName, { kind: "api-key", key: KEY });
    const provider = botProviderFill({ home, broker: createHostCredentialBroker({ secrets, keychainService: keychainService(undefined, home) }), secrets, settings: () => ({ providers: { anthropic: { baseUrl: fake.url } } }) as never, modelPlugins: () => undefined });
    const runner: McpRunner = { async run() { return { result: { content: [{ type: "text", text: "acceptance-echo-pong: hi" }] }, computer: "Studio" }; } };
    const servers: BotMcpServer[] = [];
    const bot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: "anthropic/claude-sonnet-5-5", modelFrom: "user", userLayer: [] };
    const ctx = { bot, botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(home, "luna"), caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" }, current: () => bot, memoryBlock: () => "", mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false } as never;
    const driver = new BotSessionDriver(ctx, { home, spawn, canUseTool: () => async (_n: string, input: unknown) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }), sandbox: () => ({ enabled: false }), stopGraceMs: 5_000, log: () => {}, provider, mcp: { servers: () => servers, runner } } as never);
    const ctl = () => ({ origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: () => {} }) as never;
    const msg = (text: string) => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() }) as never;
    try {
      await driver.turn(msg("ACCEPTANCE-REPLY: say hello"), ctl());
      await driver.turn(msg("ACCEPTANCE-REPLY: say hello again"), ctl());
      servers.push({ server: "acceptance-echo-echo", plugin: "acceptance-echo", tools: [{ name: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, load: "preload" }] });
      await driver.turn(msg("ACCEPTANCE-ECHO: call the echo tool"), ctl());
    } finally {
      await driver.stop();
      fake.close();
    }

    const asked = fake.requests.filter((r) => r.path.endsWith("/messages"));
    expect(asked.length).toBeGreaterThanOrEqual(4);
    expect(asked.map((r) => r.refused ?? "accepted")).toEqual(asked.map(() => "accepted"));
    for (const r of asked) {
      const wire = r.body as Wire;
      // Every system message is either the effort marker (no content, its effort set) or carries content blocks.
      for (const m of wire.messages.filter((x) => x.role === "system")) {
        const blocks = Array.isArray(m.content) ? m.content : [];
        if (blocks.length === 0) expect(typeof m.output_config?.effort).toBe("string");
      }
      // The leading entry is the effort marker, which the docs accept "anywhere in messages, including as the first
      // entry", with its beta in the header.
      expect(wire.messages[0]!.role).toBe("system");
      expect(wire.messages[0]!.content).toEqual([]);
      expect(typeof wire.messages[0]!.output_config?.effort).toBe("string");
      expect((r.beta ?? "").split(",").map((b) => b.trim())).toContain(BETA);
    }
    // The tool turn: the Echo tool came as a tool_addition, offered, called, and its result went back.
    const added = asked.find((r) => (r.body as Wire).messages.some((m) => m.role === "system" && Array.isArray(m.content) && (m.content as { type?: string }[]).some((b) => b.type === "tool_addition")));
    expect(added).toBeDefined();
    expect(added!.tools.some((t) => t.endsWith("Echo"))).toBe(true);
    expect(asked.some((r) => r.toolResult?.text.includes("acceptance-echo-pong") === true)).toBe(true);
    // The strict fake does refuse what the API refuses: the same request with the marker's effort gone.
    const first = structuredClone(asked[0]!.body as Wire);
    delete first.messages[0]!.output_config;
    expect(requestRefusal(first as never, asked[0]!.beta ?? null)).toContain("no output_config.effort");
  }, 180_000);
});
