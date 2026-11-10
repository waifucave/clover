// A bot's plugin-chosen provider (the controller's ruling on #298's review): the first turn on a provider the bot's
// plugin chose asks the user with a sealed change card, a yes holds for that bot and provider, a new provider asks
// again, a no fails the turn with its reason, and the user's own choice never asks.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FileSecretStore } from "../../auth/secret-store";
import type { ApprovalDecision, ApprovalRequest } from "../../contracts/approval-broker";
import { CLOVER_CREDENTIAL_INVENTORY } from "../../runtime-sdk/keychain";
import { botKeyPresence } from "../key-presence";
import { flush } from "../../contracts/fakes/clock";
import { projectRecords } from "../../sessions/wire";
import { agentToolDefs } from "../../agents/tools";
import { providerGrantKey, providerOfModel, voiceGrantKey } from "../provider-consent";
import { boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin } from "./fixtures";

afterEach(() => removeTemps());

const theUser = { kind: "user", client: "app" } as const;
const user = (text: string) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: `m-${text}` });

/** Luna, whose plugin names `model` (or none), on a side whose broker answers each card with what `answer` says. */
async function luna(model: string | undefined, opts: { broker?: boolean; hold?: boolean; voice?: Record<string, unknown>; home?: string; hasKeyFor?: (model: string) => boolean } = {}) {
  const root = tempDir();
  const write = (m: string | undefined) => writePlugin(root, "luna", {
    "clover.json": botManifest("luna", "Luna", { ...(m === undefined ? {} : { model: { default: m } }), ...(opts.voice === undefined ? {} : { voice: opts.voice }) }),
    "bot/instructions.md": "You are Luna.",
  });
  const asked: ApprovalRequest[] = [];
  const answers: ApprovalDecision[] = [];
  /** With `hold`, each card waits until the test answers it. */
  const waiting: Array<(d: ApprovalDecision) => void> = [];
  const approvals = {
    cancelSession: () => {},
    request: async (req: ApprovalRequest) => {
      asked.push(req);
      if (opts.hold) return new Promise<ApprovalDecision>((resolve) => waiting.push(resolve));
      return answers.shift() ?? { allowed: false, by: "card" as const };
    },
  };
  const b = await boot({
    home: opts.home ?? tempDir(), plugins: (await pluginFromFolder(write(model))).inputs, askProvider: true,
    ...(opts.broker === false ? {} : { approvals: approvals as never }),
    ...(opts.hasKeyFor === undefined ? {} : { hasKeyFor: opts.hasKeyFor }),
  });
  /** The plugin's next version, naming another model. */
  const update = async (m: string) => {
    b.registry.put({ ...(await pluginFromFolder(write(m))).inputs[0]!, change: "applies" });
    await flush();
  };
  /** The user's message, and the turn it starts as far as the driver goes. */
  const say = async (text: string) => {
    await b.host.sendUser("b_luna", user(text));
    await flush();
    await flush();
  };
  const driver = () => b.drivers.for("b_luna");
  /** Ends the driver's running turn, if one runs. */
  const end = async () => {
    if (driver().turns.length > 0 && b.host.get("b_luna")?.status === "prompting") driver().end({ text: "ok" });
    await flush();
  };
  return { b, asked, answers, waiting, update, say, driver, end };
}

describe("a provider the bot's plugin chose", () => {
  test("asks once, on a sealed change card; a yes holds for that bot and provider, and its next turns don't ask", async () => {
    const { b, asked, answers, say, driver, end } = await luna("anthropic/claude-sonnet-5-5");
    answers.push({ allowed: true, by: "card", cardId: "card_1" });
    await say("hi");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "change", change: "bot-provider", session: "b_luna", bot: "luna", computers: [], effect: "other" });
    // Clover's own words; what the plugin wrote only as code values (#311 B2).
    expect(asked[0]!.fields.title).toEqual({ type: "text", text: "Let this bot use a provider its plugin chose?" });
    expect(asked[0]!.fields.what).toMatchObject({ type: "text" });
    expect(asked[0]!.fields.source).toEqual({ type: "code", code: "luna" });
    expect(asked[0]!.fields.host).toEqual({ type: "code", code: "anthropic" });
    expect(asked[0]!.fields.command).toEqual({ type: "code", code: "anthropic/claude-sonnet-5-5" });
    expect(driver().turns).toHaveLength(1);
    expect(b.side.grants!.has("b_luna", providerGrantKey("anthropic"))).toBe(true);
    await end();
    await say("again");
    expect(asked).toHaveLength(1);
    expect(driver().turns).toHaveLength(2);
    await end();
    await b.shutdown();
  });

  test("the user's own choice never asks: a model in the bot's settings, or the user's default", async () => {
    const own = await luna("anthropic/claude-sonnet-5-5");
    await own.b.bots.setUserLayer("luna", { model: "openai/gpt-6.1-sol" }, theUser);
    await own.say("hi");
    expect(own.asked).toHaveLength(0);
    expect(own.driver().turns).toHaveLength(1);
    // The plugin's own tag, set by the user as theirs, is theirs too.
    await own.end();
    await own.b.bots.setUserLayer("luna", { model: "anthropic/claude-sonnet-5-5" }, theUser);
    await own.say("again");
    expect(own.asked).toHaveLength(0);
    expect(own.driver().turns).toHaveLength(2);
    await own.end();
    await own.b.shutdown();

    // No model from the plugin: the bot falls back to the user's default, which asks nothing.
    const fallback = await luna(undefined);
    expect(fallback.b.bots.effective("luna")).toMatchObject({ model: "fireworks/kimi-k3", modelFrom: "default" });
    await fallback.say("hi");
    expect(fallback.asked).toHaveLength(0);
    expect(fallback.driver().turns).toHaveLength(1);
    await fallback.end();
    await fallback.b.shutdown();
  });

  test("a plugin that moves its tag to a new provider asks again; another model on the same provider doesn't", async () => {
    const { b, asked, answers, update, say, driver, end } = await luna("anthropic/claude-sonnet-5-5");
    answers.push({ allowed: true, by: "card", cardId: "card_1" });
    await say("hi");
    await end();
    await update("anthropic/claude-opus-5-5");
    await say("same provider");
    expect(asked).toHaveLength(1);
    expect(driver().turns).toHaveLength(2);
    await end();
    answers.push({ allowed: true, by: "card", cardId: "card_2" });
    await update("openrouter/qwen-4-max");
    await say("new provider");
    expect(asked).toHaveLength(2);
    expect(asked[1]!.fields.host).toEqual({ type: "code", code: "openrouter" });
    expect(asked[1]!.fields.command).toEqual({ type: "code", code: "openrouter/qwen-4-max" });
    expect(driver().turns).toHaveLength(3);
    await end();
    await b.shutdown();
  });

  test("a no fails the turn with its reason, nothing runs, and the next turn asks again; a yes by anything but the card is a no", async () => {
    const { b, asked, answers, say, driver, end } = await luna("anthropic/claude-sonnet-5-5");
    answers.push({ allowed: false, by: "card", cardId: "card_1" });
    await say("hi");
    expect(asked).toHaveLength(1);
    expect(driver().turns).toHaveLength(0);
    const log = b.host.history("b_luna");
    const ended = log.find((r) => r.type === "turn_ended");
    expect(ended).toMatchObject({ end: { reason: "failed", failure: "error" } });
    expect((ended as { end: { text: string } }).end.text).toContain("You didn't let this bot use a model on a provider you didn't choose with your stored key");
    // The person sees why, and how to change it.
    const shown = projectRecords(log, { kind: "bot" }).find((e) => e.type === "agent_error");
    expect(shown).toMatchObject({ code: "provider_not_allowed" });
    expect(String(shown?.message)).toContain("Pick it in the bot's settings");
    expect(b.side.grants!.has("b_luna", providerGrantKey("anthropic"))).toBe(false);
    // A yes by a level or a rule isn't the person's own: still a no.
    answers.push({ allowed: true, by: "level" });
    await say("again");
    expect(asked).toHaveLength(2);
    expect(driver().turns).toHaveLength(0);
    // Asked again, a yes on the card lets the turn run.
    answers.push({ allowed: true, by: "card", cardId: "card_3" });
    await say("third");
    expect(asked).toHaveLength(3);
    expect(driver().turns).toHaveLength(1);
    await end();
    await b.shutdown();
  });

  test("with no broker to ask, a plugin's provider is refused with its reason", async () => {
    const { b, say, driver } = await luna("anthropic/claude-sonnet-5-5", { broker: false });
    await say("hi");
    expect(driver().turns).toHaveLength(0);
    const ended = b.host.history("b_luna").find((r) => r.type === "turn_ended") as { end: { reason: string; text: string } } | undefined;
    expect(ended?.end.reason).toBe("failed");
    expect(ended?.end.text).toContain("can't ask you here");
    await b.shutdown();
  });

  test("the provider of a tag", () => {
    expect(providerOfModel("anthropic/claude-sonnet-5-5")).toBe("anthropic");
    expect(providerOfModel("openrouter/qwen/qwen-4")).toBe("openrouter");
    expect(providerOfModel("gpt")).toBeUndefined();
    // The runtime's test models use no stored key.
    expect(providerOfModel("winter-test/calls")).toBeUndefined();
  });
});

describe("#311's review", () => {
  test("B1: a plugin that moves to another provider while the card waits is asked about again, and the turn runs pinned to what was allowed", async () => {
    const { b, asked, waiting, update, say, driver, end } = await luna("anthropic/claude-sonnet-5-5", { hold: true });
    await say("hi");
    expect(asked).toHaveLength(1);
    // While the card for anthropic waits, the plugin (the bot itself can edit it) moves to another provider.
    await update("openrouter/qwen-4-max");
    waiting.shift()!({ allowed: true, by: "card", cardId: "card_1" });
    await flush();
    await flush();
    // Not run on the new provider ungranted: asked about it first.
    expect(asked).toHaveLength(2);
    expect(asked[1]!.fields.host).toEqual({ type: "code", code: "openrouter" });
    expect(driver().turns).toHaveLength(0);
    waiting.shift()!({ allowed: true, by: "card", cardId: "card_2" });
    await flush();
    await flush();
    expect(driver().turns).toHaveLength(1);
    // Pinned: a change during the turn doesn't reach it; the next turn checks it again.
    const ctx = b.drivers.made.find((m) => m.ctx.sessionId === "b_luna")!.ctx;
    expect(ctx.current().model).toBe("openrouter/qwen-4-max");
    await update("fireworks/kimi-k3");
    expect(ctx.current().model).toBe("openrouter/qwen-4-max");
    await end();
    expect(ctx.current().model).toBe("fireworks/kimi-k3");
    await b.shutdown();
  });

  test("B2: a manifest tag that isn't a qualified model id is refused at load; hiding characters never reach the card", async () => {
    const bad = await luna("Clover checked it");
    expect(bad.b.bots.has("luna")).toBe(false);
    expect(bad.b.warnings.some((w) => w.includes("isn't a qualified model id"))).toBe(true);
    await bad.b.shutdown();
    // A tag that passes but hides a right-to-left override: the card shows it without.
    const hidden = await luna("anthropic/claude\u202Etxet-reversed");
    hidden.answers.push({ allowed: false, by: "card", cardId: "card_1" });
    await hidden.say("hi");
    expect(hidden.asked[0]!.fields.command).toEqual({ type: "code", code: "anthropic/claudetxet-reversed" });
    expect(JSON.stringify(hidden.asked[0]!.fields)).not.toContain("\u202E");
    await hidden.b.shutdown();
  });

  test("S2: a no holds until the user's next message of their own: a wake or another bot's message isn't asked about", async () => {
    const { b, asked, answers, say, driver } = await luna("anthropic/claude-sonnet-5-5");
    answers.push({ allowed: false, by: "card", cardId: "card_1" });
    await say("hi");
    expect(asked).toHaveLength(1);
    // Another bot's message starts a turn that isn't the user's: no card, the no holds.
    await b.host.deliver("b_luna", { from: "bot", bot: "sol", session: "b_sol", text: "ping" });
    await flush();
    await flush();
    expect(asked).toHaveLength(1);
    expect(driver().turns).toHaveLength(0);
    const ends = b.host.history("b_luna").filter((r) => r.type === "turn_ended");
    expect(ends).toHaveLength(2);
    // The user's own next message asks again.
    answers.push({ allowed: true, by: "card", cardId: "card_2" });
    await say("again");
    expect(asked).toHaveLength(2);
    expect(driver().turns).toHaveLength(1);
    await b.shutdown();
  });

  test("S1: an agent the bot starts uses the bot's own user-chosen provider freely; another provider asks the same card", async () => {
    const { b, asked, answers } = await luna("anthropic/claude-sonnet-5-5");
    await b.bots.setUserLayer("luna", { model: "openai/gpt-6.1-sol" }, theUser);
    const ctx = b.drivers.made.find((m) => m.ctx.sessionId === "b_luna")!.ctx;
    expect(await ctx.providerCheck!("openai/gpt-6.1-mini", "user")).toEqual({ ok: true });
    expect(await ctx.providerCheck!("sonnet", "user")).toEqual({ ok: true });
    expect(asked).toHaveLength(0);
    answers.push({ allowed: false, by: "card", cardId: "card_1" });
    const refused = await ctx.providerCheck!("openrouter/qwen-4-max", "user");
    expect(refused.ok).toBe(false);
    expect(asked[0]).toMatchObject({ kind: "change", change: "bot-provider", session: "b_luna" });
    expect(asked[0]!.fields.host).toEqual({ type: "code", code: "openrouter" });
    // Granted for the bot, an agent on it asks nothing more.
    answers.push({ allowed: true, by: "card", cardId: "card_2" });
    expect(await ctx.providerCheck!("openrouter/qwen-4-max", "user")).toEqual({ ok: true });
    expect(await ctx.providerCheck!("openrouter/other", "bot")).toEqual({ ok: true });
    expect(asked).toHaveLength(2);
    await b.shutdown();
  });

  test("S1: the Agent tool refuses a model the check refuses, and never starts the agent", async () => {
    const started: unknown[] = [];
    const manager = { start: async (p: unknown) => (started.push(p), { sessionId: "a_1", transcript: "x" }) } as unknown as Parameters<typeof agentToolDefs>[0];
    const [agent] = agentToolDefs(manager, { bot: "luna", session: "b_luna", origin: "user" }, { checkModel: async () => ({ ok: false, reason: "not allowed" }) });
    const out = await agent!.run({ prompt: "do it", backend: "clover-code", root: "home/Studio/x", model: "openrouter/qwen-4-max" });
    expect(out).toEqual({ text: "not allowed", isError: true });
    expect(started).toHaveLength(0);
  });

  test("voice: a voice the plugin chose asks once (bot.voice:<provider>); the user's own voice never asks", async () => {
    const plugin = await luna(undefined, { voice: { provider: "fish-audio", voice: "v1", model: "s2" } });
    plugin.answers.push({ allowed: true, by: "card", cardId: "card_1" });
    expect(await plugin.b.bots.checkVoice("luna")).toEqual({ ok: true });
    expect(plugin.asked[0]).toMatchObject({ kind: "change", change: "bot-provider" });
    expect(plugin.asked[0]!.fields.title).toEqual({ type: "text", text: "Let this bot use a voice provider its plugin chose?" });
    expect(plugin.asked[0]!.fields.host).toEqual({ type: "code", code: "fish-audio" });
    expect(plugin.b.side.grants!.has("b_luna", voiceGrantKey("fish-audio"))).toBe(true);
    expect(await plugin.b.bots.checkVoice("luna")).toEqual({ ok: true });
    expect(plugin.asked).toHaveLength(1);
    await plugin.b.shutdown();
    const own = await luna(undefined, { voice: { provider: "fish-audio", voice: "v1" } });
    await own.b.bots.setUserLayer("luna", { voice: { provider: "elevenlabs", voice: "v2" } }, theUser);
    expect(await own.b.bots.checkVoice("luna")).toEqual({ ok: true });
    expect(own.asked).toHaveLength(0);
    await own.b.shutdown();
  });

  test("the card belongs to the asking session: a side thread's run asks with its own turn's origin", async () => {
    const { b, asked, answers } = await luna("anthropic/claude-sonnet-5-5");
    answers.push({ allowed: false, by: "card", cardId: "card_1" });
    const run = b.bots.runSideThread("luna", { routine: "r_1", name: "Check", text: "Check things." });
    await flush();
    await flush();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.session).toMatch(/^t_/);
    expect(asked[0]!.origin).toBe(b.host.turnOrigin(asked[0]!.session!) ?? "routine");
    expect(asked[0]!.origin).not.toBe("user");
    await run;
    await b.shutdown();
  });
});

describe("#311's check 2", () => {
  const slotOf = (provider: string) => CLOVER_CREDENTIAL_INVENTORY.find((x) => x.provider === provider)!.secretName;

  test("the daemon's hasKeyFor: a plugin's model on a provider with no stored key falls back to the user's default, and nothing asks", async () => {
    const home = tempDir();
    const store = new FileSecretStore(join(home, "secrets.json"));
    const noKey = await luna("anthropic/claude-sonnet-5-5", { home, hasKeyFor: await botKeyPresence(store, home, { pluginServes: () => false }) });
    expect(noKey.b.bots.effective("luna")).toMatchObject({ model: "fireworks/kimi-k3", modelFrom: "default" });
    await noKey.say("hi");
    expect(noKey.asked).toHaveLength(0);
    expect(noKey.driver().turns).toHaveLength(1);
    expect(noKey.b.drivers.made.find((m) => m.ctx.sessionId === "b_luna")!.ctx.current().model).toBe("fireworks/kimi-k3");
    await noKey.end();
    await noKey.b.shutdown();
    // With the key stored, the plugin's model is used, and its provider asks once.
    const keyed = tempDir();
    const withKey = new FileSecretStore(join(keyed, "secrets.json"));
    await withKey.set(slotOf("anthropic"), JSON.stringify({ kind: "api-key", key: "sk-ant-test" }));
    const has = await luna("anthropic/claude-sonnet-5-5", { home: keyed, hasKeyFor: await botKeyPresence(withKey, keyed, { pluginServes: () => false }) });
    expect(has.b.bots.effective("luna")).toMatchObject({ model: "anthropic/claude-sonnet-5-5", modelFrom: "plugin" });
    has.answers.push({ allowed: true, by: "card", cardId: "card_1" });
    await has.say("hi");
    expect(has.asked).toHaveLength(1);
    await has.end();
    await has.b.shutdown();
  });

  test("a held no is kept with the grants: it survives a restart, until the user's own next message", async () => {
    const home = tempDir();
    const first = await luna("anthropic/claude-sonnet-5-5", { home });
    first.answers.push({ allowed: false, by: "card", cardId: "card_1" });
    await first.say("hi");
    expect(first.asked).toHaveLength(1);
    expect(first.b.side.grants!.held("b_luna", providerGrantKey("anthropic"))).toBe(true);
    // Core-only: the hold never reaches a client.
    expect(projectRecords(first.b.host.history("b_luna"), { kind: "bot" }).some((e) => String(e.type).startsWith("session_grant"))).toBe(false);
    await first.b.shutdown();

    const again = await luna("anthropic/claude-sonnet-5-5", { home });
    expect(again.b.side.grants!.held("b_luna", providerGrantKey("anthropic"))).toBe(true);
    await again.b.host.deliver("b_luna", { from: "bot", bot: "sol", session: "b_sol", text: "ping" });
    await flush();
    await flush();
    expect(again.asked).toHaveLength(0);
    expect(again.driver().turns).toHaveLength(0);
    // The user's own message lifts it, in the log too, and asks again.
    again.answers.push({ allowed: true, by: "card", cardId: "card_2" });
    await again.say("again");
    expect(again.asked).toHaveLength(1);
    expect(again.driver().turns).toHaveLength(1);
    expect(again.b.side.grants!.held("b_luna", providerGrantKey("anthropic"))).toBe(false);
    await again.end();
    await again.b.shutdown();
    const third = await luna("anthropic/claude-sonnet-5-5", { home });
    expect(third.b.side.grants!.held("b_luna", providerGrantKey("anthropic"))).toBe(false);
    expect(third.b.side.grants!.has("b_luna", providerGrantKey("anthropic"))).toBe(true);
    await third.b.shutdown();
  });

  test("a card nobody answered, or one withdrawn with its turn, says so, holds nothing, and asks again next time", async () => {
    const { b, asked, answers, say, driver } = await luna("anthropic/claude-sonnet-5-5");
    const reasons = () => b.host.history("b_luna").filter((r) => r.type === "turn_ended").map((r) => (r as { end: { text: string } }).end.text);
    answers.push({ allowed: false, by: "expired", cardId: "card_1" });
    await say("hi");
    expect(reasons().at(-1)).toContain("Nobody answered the card asking whether this bot may use a model on a provider you didn't choose");
    expect(reasons().at(-1)).not.toContain("You didn't let");
    expect(b.side.grants!.held("b_luna", providerGrantKey("anthropic"))).toBe(false);
    // Not held: a turn that isn't the user's asks again.
    answers.push({ allowed: false, by: "withdrawn", cardId: "card_2" });
    await b.host.deliver("b_luna", { from: "bot", bot: "sol", session: "b_sol", text: "ping" });
    await flush();
    await flush();
    expect(asked).toHaveLength(2);
    expect(reasons().at(-1)).toContain("was withdrawn when its turn stopped, before anyone answered");
    answers.push({ allowed: false, by: "cancelled", cardId: "card_3" });
    await say("third");
    expect(reasons().at(-1)).toContain("was withdrawn when its turn stopped");
    expect(driver().turns).toHaveLength(0);
    expect(b.side.grants!.held("b_luna", providerGrantKey("anthropic"))).toBe(false);
    await b.shutdown();
  });

  test("a voice check takes the real origin: speaking in a turn the user didn't start never lifts a held no", async () => {
    const { b, asked, answers } = await luna(undefined, { voice: { provider: "fish-audio", voice: "v1" } });
    answers.push({ allowed: false, by: "card", cardId: "card_1" });
    // Speaking in the main conversation with no turn of the user's: the card is that session's, not the user's turn.
    expect((await b.bots.checkVoice("luna", { session: "b_luna" })).ok).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ session: "b_luna" });
    expect(asked[0]!.origin).not.toBe("user");
    // Held: speaking again doesn't ask.
    expect((await b.bots.checkVoice("luna", { session: "b_luna" })).ok).toBe(false);
    // A session's speech takes that session's own origin, whatever its caller says.
    expect((await b.bots.checkVoice("luna", { session: "b_luna", origin: "user" })).ok).toBe(false);
    expect(asked).toHaveLength(1);
    // The user talking (push-to-talk passes the user's origin) asks again.
    answers.push({ allowed: true, by: "card", cardId: "card_2" });
    expect(await b.bots.checkVoice("luna", { origin: "user" })).toEqual({ ok: true });
    expect(asked).toHaveLength(2);
    await b.shutdown();
  });
});
