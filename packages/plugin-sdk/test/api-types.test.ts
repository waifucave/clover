// The plugin API and UI API declarations, used as an author would. `tsc` checks this file (typecheck:plugin-sdk); at run
// time it only checks the constants. A change that breaks an author's code fails the typecheck here first.
import { describe, expect, test } from "bun:test";
import {
  API_CALL_MAX_TIMEOUT_MS, API_CALL_TIMEOUT_MS, CONFIRM_TIMEOUT_MS, SYNCED_STORE_LIMIT_BYTES,
  type ClientModule, type EntryProps, type Handler, type HookInput, type HookOutput, type HostModule, type Manifest,
  type PluginApi, type UiApi,
} from "../src/index";

// A host half: handlers named by the manifest, a `host` MCP server, and the lifecycle.
const draw: Handler<{ count: number }, { cards: string[] }> = async (args, ctx) => {
  const deck = (await ctx.api.storage.synced.get<string[]>("deck")) ?? [];
  if (ctx.caller.kind === "session") await ctx.api.conversation?.note?.(ctx.caller.sessionId, { label: "Tarot", text: `drew ${args.count}` });
  return { cards: deck.slice(0, args.count) };
};

const beforeTool: Handler<HookInput, HookOutput> = (input) =>
  input.event === "tool.before" && input.tool?.name === "Bash" ? { event: "tool.before", ask: { reason: "a tarot reading first" } } : { event: "turn.end" };

const host: HostModule = {
  draw,
  beforeTool,
  async start(api: PluginApi) {
    api.points.watch("luna.cards", (entries) => api.ui.send("cards", entries.length));
    await api.net.fetch("https://api.luna.example/deck", undefined, { auth: "luna" });
  },
  mcp: {
    tarot: async (transport) => {
      transport.onmessage = (m) => void transport.send({ jsonrpc: "2.0", id: m.id, result: {} });
      await transport.start();
    },
  },
};

// A component module, against the UI API lane E implements.
declare const ui: UiApi;
const TarotPanel = ({ props, tokens }: EntryProps<{ bot: { id: string } }>) => {
  const api = ui.usePluginApi();
  void api.host.call("draw", { count: 3 });
  return [ui.Spot({ name: "luna.deck", props: { bot: props.bot.id } }), ui.Card({ id: "card_123456" }), ui.Card.Approve({}), tokens["color.accent"]];
};
const client: ClientModule = { TarotPanel };

// A manifest, typed.
const manifest: Manifest = {
  manifest: 1, id: "luna", name: { en: "Luna", fr: "Luna" }, engines: { clover: "^1.0.0" },
  host: { entry: "host/index.ts" }, client: { entry: "client/index.tsx" },
  capabilities: ["conversation.post", "network:api.luna.example"],
  contributes: {
    commands: [{ name: "draw", description: "Draw cards", handler: "draw", args: { type: "object" } }],
    hooks: [{ id: "ask-first", on: ["tool.before"], tools: ["Bash"], handler: "beforeTool" }],
    mcpServers: { tarot: { type: "host", tools: { Read: "preload" } } },
    ui: [{ spot: "panel", key: "luna", component: "TarotPanel" }],
    "luna.cards": [{ id: "fool" }],
  },
};

describe("the declarations", () => {
  test("compile as an author would use them", () => {
    expect(typeof host.start).toBe("function");
    expect(Object.keys(client)).toEqual(["TarotPanel"]);
    expect(manifest.contributes?.commands?.[0]?.handler).toBe("draw");
  });

  test("the limits are §5.4's", () => {
    expect(API_CALL_TIMEOUT_MS).toBe(10_000);
    expect(API_CALL_MAX_TIMEOUT_MS).toBe(600_000);
    expect(CONFIRM_TIMEOUT_MS).toBe(600_000);
    expect(SYNCED_STORE_LIMIT_BYTES).toBe(1_048_576);
  });
});
