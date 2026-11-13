// Agent SDK 0.0.80 on the bot side: whether a bot's Edit needs a Read first depends on its model's hand-set strength,
// a column of the catalog (the owner's ruling, 2026-11-12). A strong or medium model edits a file it never read; a weak
// one is refused and told which lines to read. Two bots on the bundled Fireworks plugin (one provider, one key): one on
// a model the catalog marks strong, one on a model it marks weak. Each asks once for the same Edit of a file in its
// scratch that it never read, on the real embedded runtime, against a loopback fake.
//
// ISOLATION: a temp home, a `FileSecretStore` under it, a loopback fake, a dummy key. No Keychain, no network.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiChatFake, startFake, type FakeServer } from "@waifucave/clover-provider-conformance/fakes";
import { query as sdkQuery } from "@waifucave/clover-agent-sdk";
import { FileSecretStore } from "../../../src/auth/secret-store";
import { botPaths } from "../../../src/bots/paths";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { MemorySecretStore } from "../../../src/contracts/fakes/secret-store";
import type { PluginRecord } from "../../../src/contracts/plugin-registry";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import { keychainService } from "../../../src/profile";
import { createHostCredentialBroker } from "../../../src/runtime-sdk/host-credentials";
import { createPluginAuth, pluginAuthMethods } from "../../../src/runtime-sdk/plugin-auth";
import { BotSessionDriver } from "../../../src/runtime-sdk/turn-loop/driver";
import { botProviderFill } from "../../../src/runtime-sdk/turn-loop/provider-fill";
import type { Settings } from "../../../src/settings";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";

const STRONG = "fireworks/deepseek-v4-pro";
const WEAK = "fireworks/gpt-oss-20b";
const FIREWORKS = { id: "clover/model-fireworks", source: "bundled", manifest: { contributes: { models: [{ provider: "fireworks", auth: [{ method: "api-key", secret: "api-key" }] }] } } } as unknown as PluginRecord;
const USER = { caller: { kind: "user", client: "app" } } as never;
const KEY = "fw-dummy-edit-strength-0b7e";

const temps: string[] = [];
let fake: FakeServer | undefined;
afterAll(async () => {
  await fake?.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const control = (): TurnControl => ({ origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: () => {} });
const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

function context(home: string, id: string, model: string): BotSessionContext {
  const bot: EffectiveBot = { id, name: id, instructions: `You are ${id}.`, model, modelFrom: "user", userLayer: [] };
  return {
    botId: id, sessionId: `b_${id}`, kind: "bot", computer: "Studio", paths: botPaths(home, id),
    caller: { kind: "session", sessionId: `b_${id}`, sessionKind: "bot", bot: id },
    current: () => bot,
    memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true,
    whenMayAct: async () => {},
    cacheCold: () => false,
  } as unknown as BotSessionContext;
}

/** The bundled plugin's own row for `model` (what the catalog the bots run on carries). */
function bundledStrength(model: string): string | undefined {
  const file = join(import.meta.dir, "../../../../../plugins/clover/plugins/model-fireworks/catalog.json");
  const rows = (JSON.parse(readFileSync(file, "utf8")) as { rows: { key: string; strength?: string }[] }).rows;
  return rows.find((r) => r.key === model)?.strength;
}

describeWithEmbeddedRuntime("a bot's Edit of a file it never read, by its model's strength (agent SDK 0.0.80)", (spawn) => {
  test("the strong model's bot edits it; the weak model's bot is refused and told the line to read", async () => {
    expect(bundledStrength(STRONG)).toBe("strong");
    expect(bundledStrength(WEAK)).toBe("weak");
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-edit-strength-")));
    temps.push(home);
    // Per bot: the file its Edit names, and the tool result the runtime sent back on the second request.
    const files = new Map<string, string>();
    const toolResults = new Map<string, string>();
    fake = await startFake({
      routes: [{
        path: "*",
        handler: (_req, recorded) => {
          if (!recorded.path.endsWith("/chat/completions")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          const body = JSON.parse(recorded.body) as { messages: { role: string; content?: unknown }[] };
          const bot = [...files.keys()].find((id) => recorded.body.includes(`You are ${id}.`)) ?? "";
          const tool = body.messages.find((m) => m.role === "tool");
          if (tool === undefined) {
            const input = { file_path: files.get(bot), old_string: "two\n", new_string: "TWO\n" };
            return openaiChatFake.chatStream({ toolCalls: [{ index: 0, id: `call_${bot}`, name: "Edit", argumentChunks: [JSON.stringify(input)] }], finishReason: "tool_calls" });
          }
          toolResults.set(bot, typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content));
          return openaiChatFake.chatStream({ text: ["done"], finishReason: "stop" });
        },
      }],
    });
    const secrets = new FileSecretStore(join(home, "secrets"));
    const pluginAuth = createPluginAuth({ registry: { get: (id) => (id === FIREWORKS.id ? FIREWORKS : undefined) }, secrets, pluginSecrets: new MemorySecretStore(), modelProviders: () => [] });
    expect(await pluginAuthMethods(pluginAuth)["plugin.auth.signIn"]!({ id: FIREWORKS.id, index: 0, key: KEY }, USER)).toEqual({ state: "signed-in" });
    const settings = { providers: { fireworks: { baseUrl: `${fake.url}/v1` } } } as unknown as Settings;
    const broker = createHostCredentialBroker({ secrets, keychainService: keychainService(undefined, home) });
    const deps = {
      home, spawn, query: sdkQuery,
      canUseTool: () => async (_n: string, input: unknown) => ({ behavior: "allow" as const, updatedInput: input as Record<string, unknown> }),
      sandbox: () => ({ enabled: false }), stopGraceMs: 5_000, log: () => {},
      provider: botProviderFill({ home, broker, secrets, settings: () => settings, modelPlugins: () => undefined }),
    };

    for (const [id, model] of [["strongbot", STRONG], ["weakbot", WEAK]] as const) {
      const ctx = context(home, id, model);
      mkdirSync(ctx.paths.scratch, { recursive: true });
      const file = join(ctx.paths.scratch, "notes.md");
      writeFileSync(file, "one\ntwo\nthree\n");
      files.set(id, file);
      const driver = new BotSessionDriver(ctx, deps as never);
      try {
        expect((await driver.turn(user("change line two of notes.md to upper case"), control())).reason).toBe("end_turn");
      } finally {
        await driver.stop();
      }
    }

    // Strong: written without a Read.
    expect(readFileSync(files.get("strongbot")!, "utf8")).toBe("one\nTWO\nthree\n");
    expect(toolResults.get("strongbot")).not.toContain("Read line");
    // Weak: refused, the file unchanged, and told the line its edit changes and the Read that shows it.
    expect(readFileSync(files.get("weakbot")!, "utf8")).toBe("one\ntwo\nthree\n");
    expect(toolResults.get("weakbot")).toContain("changes line 2");
    expect(toolResults.get("weakbot")).toContain("Read line 2 first (offset 2, limit 1)");
  }, 120_000);
});
