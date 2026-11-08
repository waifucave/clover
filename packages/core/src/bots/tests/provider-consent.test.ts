// A bot's plugin-chosen provider (the controller's ruling on #298's review): the first turn on a provider the bot's
// plugin chose asks the user with a sealed change card, a yes holds for that bot and provider, a new provider asks
// again, a no fails the turn with its reason, and the user's own choice never asks.
import { afterEach, describe, expect, test } from "bun:test";
import type { ApprovalDecision, ApprovalRequest } from "../../contracts/approval-broker";
import { flush } from "../../contracts/fakes/clock";
import { projectRecords } from "../../sessions/wire";
import { providerGrantKey, providerOfModel } from "../provider-consent";
import { boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin } from "./fixtures";

afterEach(() => removeTemps());

const theUser = { kind: "user", client: "app" } as const;
const user = (text: string) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: `m-${text}` });

/** Luna, whose plugin names `model` (or none), on a side whose broker answers each card with what `answer` says. */
async function luna(model: string | undefined, opts: { broker?: boolean } = {}) {
  const root = tempDir();
  const write = (m: string | undefined) => writePlugin(root, "luna", {
    "clover.json": botManifest("luna", "Luna", m === undefined ? {} : { model: { default: m } }),
    "bot/instructions.md": "You are Luna.",
  });
  const asked: ApprovalRequest[] = [];
  const answers: ApprovalDecision[] = [];
  const approvals = { request: async (req: ApprovalRequest) => (asked.push(req), answers.shift() ?? { allowed: false, by: "card" as const }) };
  const b = await boot({
    home: tempDir(), plugins: (await pluginFromFolder(write(model))).inputs, askProvider: true,
    ...(opts.broker === false ? {} : { approvals: approvals as never }),
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
  return { b, asked, answers, update, say, driver, end };
}

describe("a provider the bot's plugin chose", () => {
  test("asks once, on a sealed change card; a yes holds for that bot and provider, and its next turns don't ask", async () => {
    const { b, asked, answers, say, driver, end } = await luna("anthropic/claude-sonnet-5-5");
    answers.push({ allowed: true, by: "card", cardId: "card_1" });
    await say("hi");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "change", change: "bot-provider", session: "b_luna", bot: "luna", computers: [], effect: "other" });
    expect(asked[0]!.fields.what).toEqual({ type: "text", text: "Luna wants to use anthropic (anthropic/claude-sonnet-5-5) with your stored key." });
    expect(asked[0]!.fields.source).toMatchObject({ type: "rows" });
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
    expect(asked[1]!.fields.what).toEqual({ type: "text", text: "Luna wants to use openrouter (openrouter/qwen-4-max) with your stored key." });
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
    expect((ended as { end: { text: string } }).end.text).toContain("You didn't let Luna use anthropic (anthropic/claude-sonnet-5-5) with your stored key");
    // The person sees why, and how to change it.
    const shown = projectRecords(log, { kind: "bot" }).find((e) => e.type === "agent_error");
    expect(shown).toMatchObject({ code: "provider_not_allowed" });
    expect(String(shown?.message)).toContain("Pick a model in the bot's settings");
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
  });
});
