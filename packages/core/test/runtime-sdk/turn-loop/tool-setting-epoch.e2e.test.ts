// The user's tool setting through a bot's real runtime (the embedded runtime and its Anthropic adapter, against the
// acceptance run's strict fake): a plugin's tool preloaded and called, then set on demand, is kept by the conversation
// that already has it; once the conversation starts over (`compact`) the next request lists it deferred; set off, it is
// gone from the next request at once. Each change reopens the runtime once. The conversation holds more exchanges than
// the runtime's compaction keeps (its four-pair retention window): a compaction that keeps the conversation's first
// message keeps the tool list it started with, so a shorter one would not start over.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver } from "../../../src/runtime-sdk/turn-loop/driver";
import type { BotMcpServer, McpRunner } from "../../../src/runtime-sdk/turn-loop/servers";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";
import { startFakeAnthropic, type FakeRequest } from "../../../../../scripts/acceptance/fake-anthropic";
import { FileSecretStore } from "../../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../../src/auth/credential-material";
import { MOSS_CREDENTIAL_INVENTORY } from "../../../src/runtime-sdk/keychain";
import { createHostCredentialBroker } from "../../../src/runtime-sdk/host-credentials";
import { keychainService } from "../../../src/profile";
import { botProviderFill } from "../../../src/runtime-sdk/turn-loop/provider-fill";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Offered = { name: string; defer_loading?: boolean }[];
const echoIn = (r: FakeRequest | undefined) => ((r?.body as { tools?: Offered } | undefined)?.tools ?? []).find((t) => t.name.endsWith("__Echo"));

describeWithEmbeddedRuntime("the user's tool setting through a bot's runtime", (spawn) => {
    test("on demand: kept by the conversation that has it, deferred after it starts over; off: gone at once", async () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "moss-ts-epoch-")));
      temps.push(home);
      const KEY = "ts-epoch-dummy-key";
      const fake = startFakeAnthropic({ key: KEY, writePath: join(home, "w.txt"), writeContent: "x" });
      const secrets = new FileSecretStore(join(home, "secrets.json"));
      await writeCredentialMaterial(secrets, MOSS_CREDENTIAL_INVENTORY.find((x) => x.provider === "anthropic")!.secretName, { kind: "api-key", key: KEY });
      const provider = botProviderFill({ home, broker: createHostCredentialBroker({ secrets, keychainService: keychainService(undefined, home) }), secrets, settings: () => ({ providers: { anthropic: { baseUrl: fake.url } } }) as never, modelPlugins: () => undefined });
      const runner: McpRunner = { async run() { return { result: { content: [{ type: "text", text: "acceptance-echo-pong: hi" }] }, computer: "Studio" }; } };
      let load: "preload" | "on-demand" | "off" = "preload";
      const servers = (): BotMcpServer[] => [{ server: "acceptance-echo-echo", plugin: "acceptance-echo", tools: load === "off" ? [] : [{ name: "Echo", inputSchema: { type: "object" as const, properties: { text: { type: "string" } } }, load }] }].filter((s) => s.tools.length > 0);
      const bot = { id: "alpha", name: "Alpha", instructions: "You are Alpha.", model: "anthropic/claude-sonnet-5-5", modelFrom: "user", userLayer: [] };
      const ctx = { bot, botId: "alpha", sessionId: "b_alpha", kind: "bot", computer: "Studio", paths: botPaths(home, "alpha"), caller: { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" }, current: () => bot, memoryBlock: () => "", mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false } as never;
      const lines: string[] = [];
      const driver = new BotSessionDriver(ctx, { home, spawn, canUseTool: () => async (_n: string, input: unknown) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }), sandbox: () => ({ enabled: false }), stopGraceMs: 5_000, log: (l: string) => lines.push(l), provider, mcp: { servers, runner } } as never);
      const ctl = () => ({ origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: () => {} }) as never;
      const msg = (text: string) => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() }) as never;
      const call = (tool: string, input: unknown) => driver.turn(msg(`ACCEPTANCE-CALL ${tool} ${JSON.stringify(input)}`), ctl());
      const asked = () => fake.requests.filter((r) => r.path.endsWith("/messages"));
      try {
        for (let i = 0; i < 6; i++) await driver.turn(msg(`ACCEPTANCE-REPLY: turn ${i}`), ctl());
        await call("Echo", { text: "default" });
        expect(asked().at(-1)!.toolResult?.text).toContain("acceptance-echo-pong");
        const reopens = () => lines.filter((l) => l.includes("reopening: its MCP servers changed")).length;
        expect(reopens()).toBe(0);
        load = "on-demand";
        await call("Echo", { text: "kept" });
        expect(reopens()).toBe(1);
        expect(asked().at(-1)!.toolResult?.text).toContain("acceptance-echo-pong");
        expect(await driver.compact({ reason: "user", signal: new AbortController().signal })).toEqual({ compacted: true });
        await call("Glossary", { query: "Echo" });
        const from = asked().length;
        await call("Echo", { text: "loaded" });
        const after = asked().slice(from);
        expect(echoIn(after[0])?.defer_loading).toBe(true);
        expect(after.some((r) => r.toolResult?.text.includes("acceptance-echo-pong") === true)).toBe(true);
        load = "off";
        const offFrom = asked().length;
        await driver.turn(msg("ACCEPTANCE-REPLY: after off"), ctl());
        expect(reopens()).toBe(2);
        // A removed tool stays declared and is taken back by a removal in the conversation: what the model may call is
        // the fake's `tools`, worked out from both.
        expect(asked()[offFrom]!.tools.some((t) => t.endsWith("__Echo"))).toBe(false);
        expect(asked().map((r) => r.refused ?? "accepted")).toEqual(asked().map(() => "accepted"));
      } finally {
        await driver.stop();
        fake.close();
      }
    }, 240_000);
});
