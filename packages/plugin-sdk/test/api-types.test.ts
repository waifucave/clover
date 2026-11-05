// The plugin API and UI API declarations, used as an author would. `tsc` checks this file (typecheck:plugin-sdk); at run
// time it only checks the constants. A change that breaks an author's code fails the typecheck here first.
import { describe, expect, test } from "bun:test";
import {
  API_CALL_MAX_TIMEOUT_MS, API_CALL_TIMEOUT_MS, CONFIRM_TIMEOUT_MS, SYNCED_STORE_LIMIT_BYTES, WAIFUCAVE_AUTH,
  WEBHOOK_NEXT_GRACE_MS, WEBHOOK_NEXT_WAIT_MAX_MS, mayUseWaifucaveAuth, webhookKeyHash, type ClientModule, type EntryProps,
  type Handler, type HandlerObject, type HookInput, type HookOutput, type HostModule, type Manifest, type NotifierHandler,
  type PluginApi, type UiApi, type WebhookIngressHandler,
} from "../src/index";
import { createHash } from "node:crypto";
import { DEFAULT_KEY_PLACEMENT, keyHeaderFor, stripEchoedKey, validateManifest } from "../src/index";

// A host half: handlers named by the manifest, a `host` MCP server, and the lifecycle.
const draw: Handler<{ count: number }, { cards: string[] }> = async (args, ctx) => {
  const deck = (await ctx.api.storage.synced.get<string[]>("deck")) ?? [];
  if (ctx.caller.kind === "session") await ctx.api.conversation?.note?.(ctx.caller.sessionId, { label: "Tarot", text: `drew ${args.count}` });
  return { cards: deck.slice(0, args.count) };
};

const beforeTool: Handler<HookInput, HookOutput> = (input) =>
  input.event === "tool.before" && input.tool?.name === "Bash" ? { event: "tool.before", ask: { reason: "a tarot reading first" } } : { event: "turn.end" };

// A service: an object of handlers, whose caller names the one it calls (the waifucave forwarder's `webhook.ingress`).
const ingress: WebhookIngressHandler = {
  register: async (args, ctx) => {
    const pub = await ctx.api.keys?.publicKey("forwarder");
    const res = await ctx.api.net.fetch("https://hooks.waifucave.com/v1/routines", { method: "POST", body: JSON.stringify({ ...args, key: pub?.length }) }, { auth: WAIFUCAVE_AUTH });
    return res.status === 409 ? { conflict: { device: "Laptop" } } : { url: `https://hooks.waifucave.com/t/${args.routine}` };
  },
  unregister: async () => ({}),
  list: async () => ({ routines: [] }),
  next: async (_args, ctx) => {
    const res = await ctx.api.net.fetch("https://hooks.waifucave.com/v1/next", undefined, { auth: WAIFUCAVE_AUTH });
    const sealed = new Uint8Array(await res.arrayBuffer());
    await ctx.api.keys?.open("forwarder", { enc: sealed.subarray(0, 32), ciphertext: sealed.subarray(32), info: new Uint8Array([1]) });
    return { deliveries: [] };
  },
  ack: async () => ({}),
  drop: async () => ({}),
};
const asObject: HandlerObject = { ...ingress };
const notifier: NotifierHandler = {
  notify: async (update, ctx) => void (await ctx.api.storage.synced.set("unseen", update.unseen)),
  clear: async (_args, ctx) => void (await ctx.api.storage.synced.set("unseen", 0)),
};

const host: HostModule = {
  draw,
  beforeTool,
  ingress,
  notifier,
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
  const card = ui.Card({ id: "card_123456", tokens: { "card.background": "#18181C" }, className: "luna-card", children: [
    ui.Card.Field({ name: "title" }), ui.Card.Field({ name: "command", lines: 3 }),
    ui.Card.Approve({ look: "check", size: 28 }), ui.Card.Deny({ look: "cross", size: 28 }),
    ...ui.useApprovals().cards.flatMap((c) => c.options.filter((o) => o.remember === "always").map((o) => ui.Card.Approve({ option: o.id }))),
  ] });
  const view = ui.AppView({ call: { session: "ses_1", callId: "call_1" }, className: "luna-app" });
  void api.points.call("webhook.ingress", { pluginId: "clover/forwarder", entryId: "waifucave" }, "handler", { routine: "r" }, { method: "register" });
  return [ui.Spot({ name: "luna.deck", props: { bot: props.bot.id } }), card, view, tokens["color.accent"]];
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

  test("only the clover tree fetches waifucave's own https hosts with the account token", () => {
    expect(mayUseWaifucaveAuth("clover/forwarder", "https://hooks.waifucave.com/v1/next")).toBe(true);
    expect(mayUseWaifucaveAuth("clover", "https://push.waifucave.com./v1/notify")).toBe(true);
    expect(mayUseWaifucaveAuth("luna", "https://hooks.waifucave.com/")).toBe(false);
    expect(mayUseWaifucaveAuth("clover/forwarder", "http://hooks.waifucave.com/")).toBe(false);
    expect(mayUseWaifucaveAuth("clover/forwarder", "https://evil-waifucave.com/")).toBe(false);
    expect(mayUseWaifucaveAuth("clover/forwarder", "https://waifucave.com.evil.example/")).toBe(false);
    expect(mayUseWaifucaveAuth("clover/forwarder", "https://u:p@hooks.waifucave.com/")).toBe(false);
    expect(mayUseWaifucaveAuth("clover/forwarder", "not a url")).toBe(false);
    expect(mayUseWaifucaveAuth("clover/forwarder", "https://hooks.emulator.test/", "emulator.test")).toBe(true);
    expect(typeof host.ingress).toBe("object");
    expect(Object.keys(asObject).sort()).toEqual(["ack", "drop", "list", "next", "register", "unregister"]);
  });

  test("a key goes only where its auth entry's placement says, from a fixed list, and never comes back", () => {
    const key = ["k", Math.random().toString(36).slice(2), "z9"].join("-");
    expect(keyHeaderFor(undefined, key)).toEqual({ header: "authorization", value: `Bearer ${key}` });
    expect(keyHeaderFor(DEFAULT_KEY_PLACEMENT, key)?.header).toBe("authorization");
    expect(keyHeaderFor({ header: "authorization", scheme: "Token" }, key)).toEqual({ header: "authorization", value: `Token ${key}` });
    expect(keyHeaderFor({ header: "x-goog-api-key" }, key)).toEqual({ header: "x-goog-api-key", value: key });
    expect(keyHeaderFor({ header: "x-echo" } as never, key)).toBeNull();
    expect(keyHeaderFor({ header: "authorization", scheme: "Bearer x" }, key)).toBeNull();
    const echoed = new Headers([["content-type", "application/json"], ["x-echo", `you sent ${key}`], ["location", `https://a.example/?k=${encodeURIComponent(key)}`], ["set-cookie", `s=${key}`]]);
    const clean = stripEchoedKey(echoed, key);
    expect([...clean.keys()]).toEqual(["content-type"]);
    // The manifest takes a placement only from the list.
    const auth = (placement: unknown) => validateManifest({
      manifest: 1, id: "weather", name: "W", engines: { clover: "^1.0.0" }, host: { entry: "host/index.ts" },
      auth: [{ method: "api-key", secret: "api_key", placement }],
    });
    expect(auth({ header: "x-api-key" }).ok).toBe(true);
    expect(auth({ header: "authorization", scheme: "Bearer" }).ok).toBe(true);
    expect(auth({ header: "x-echo" }).ok).toBe(false);
    expect(auth({ header: "x-api-key", scheme: "Bearer" }).ok).toBe(false);
  });

  test("a routine's key reaches an ingress only as its hash; the long poll fits the 10-minute cap", async () => {
    const want = createHash("sha256").update("clover hook key v1|k3y").digest("base64url");
    expect(await webhookKeyHash("k3y")).toBe(want);
    expect(WEBHOOK_NEXT_WAIT_MAX_MS + WEBHOOK_NEXT_GRACE_MS).toBeLessThanOrEqual(API_CALL_MAX_TIMEOUT_MS);
  });

  test("the limits are §5.4's", () => {
    expect(API_CALL_TIMEOUT_MS).toBe(10_000);
    expect(API_CALL_MAX_TIMEOUT_MS).toBe(600_000);
    expect(CONFIRM_TIMEOUT_MS).toBe(600_000);
    expect(SYNCED_STORE_LIMIT_BYTES).toBe(1_048_576);
  });
});
