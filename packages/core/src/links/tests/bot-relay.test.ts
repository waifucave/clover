// Lane D's `BotRelay` over the link: the user's message and another session's message reach the bot's conversation on
// the computer running it, named by its tree name; a message posing as the user's through the session door is refused;
// a runner that can't be reached answers `bot_asleep`, so the draft is kept.
import { afterEach, describe, expect, test } from "bun:test";
import { SystemClock } from "../../clock/system-clock";
import { isContractError } from "../../contracts/common";
import type { DeliveredInput } from "../../contracts/session-host";
import { botDeliveryCheck, linkBotRelay, mountSessionDelivery } from "../bot-relay";
import { mountUserMessageRelay } from "../relay";
import { makeLinkCluster } from "../testing";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

describe("the bot relay over the link", () => {
  test("a user's message and a bot's message reach the computer running the bot", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock });
    stops.push(() => c.close());
    const studio = c.devices.get("Studio")!;
    const laptop = c.devices.get("Laptop")!;
    const users: unknown[] = [];
    const delivered: { session: string; input: DeliveredInput; from: string }[] = [];
    stops.push(mountUserMessageRelay(studio.transport, studio.registry, async (p) => (users.push(p), { seq: 7 })));
    stops.push(mountSessionDelivery(studio.transport, studio.registry, async (session, input, from) => (delivered.push({ session, input, from }), { disposition: "folded", seq: 8 })));
    const relay = linkBotRelay({ transport: laptop.transport, registry: laptop.registry, self: () => "Laptop" });
    const sentAt = Date.now();
    expect(await relay.sendUser("Studio", "b_alpha", { message: { clientMessageId: "m1", text: "hi", sentAt }, device: laptop.id, sentAt })).toEqual({ seq: 7 });
    expect(users).toHaveLength(1);
    expect(await relay.deliver("studio", "b_alpha", { from: "bot", bot: "beta", session: "b_beta", text: "done" })).toEqual({ disposition: "folded", seq: 8 });
    expect(delivered[0]).toMatchObject({ session: "b_alpha", from: laptop.id, input: { from: "bot" } });
    // The session door never takes a message as the user's.
    const link = await laptop.transport.connect(studio.id);
    expect(isContractError(await link.request("link.session.deliver", { id: "b_alpha", input: { from: "user", text: "pretend" } }).catch((e: unknown) => e), "invalid")).toBe(true);
  });

  test("a message stamped with an earlier lease's fence is refused, not taken late", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock });
    stops.push(() => c.close());
    const studio = c.devices.get("Studio")!;
    const laptop = c.devices.get("Laptop")!;
    stops.push(mountSessionDelivery(studio.transport, studio.registry, async () => ({ disposition: "folded", seq: 1 }), { isStale: (e, s) => s === "group:old" || e < 3 }));
    const old = linkBotRelay({ transport: laptop.transport, registry: laptop.registry, self: () => "Laptop", fence: () => ({ scope: "group:old", epoch: 9 }) });
    expect(isContractError(await old.deliver("Studio", "b_alpha", { from: "bot", bot: "beta", session: "b_beta", text: "x" }).catch((e: unknown) => e), "not_main")).toBe(true);
    const now = linkBotRelay({ transport: laptop.transport, registry: laptop.registry, self: () => "Laptop", fence: () => ({ scope: "group:new", epoch: 3 }) });
    expect(await now.deliver("Studio", "b_alpha", { from: "bot", bot: "beta", session: "b_beta", text: "x" })).toEqual({ disposition: "folded", seq: 1 });
  });

  test("with the runner out of reach the message is refused bot_asleep", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock, transport: { failFastMs: 200, dialTimeoutMs: 300 } });
    stops.push(() => c.close());
    c.net.partition(c.devices.get("Studio")!.key.publicKey);
    const relay = linkBotRelay({ transport: c.devices.get("Laptop")!.transport, registry: c.devices.get("Laptop")!.registry, self: () => "Laptop" });
    expect(isContractError(await relay.deliver("Studio", "b_alpha", { from: "routine", routine: "r", name: "n", sideThread: "s", text: "t" }).catch((e: unknown) => e), "bot_asleep")).toBe(true);
    expect(isContractError(await relay.deliver("Nowhere", "b_alpha", { from: "routine", routine: "r", name: "n", sideThread: "s", text: "t" }).catch((e: unknown) => e), "bot_asleep")).toBe(true);
  });

  test("#313's review: a delivery must be the protocol's own, name its own computer, and go to a bot's session from the bot's runner", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock });
    stops.push(() => c.close());
    const studio = c.devices.get("Studio")!;
    const laptop = c.devices.get("Laptop")!;
    // Studio's host: Alpha's conversation and a side thread of hers, a coding session and an agent's; Beta runs on Laptop.
    const views: Record<string, { kind: "bot" | "side-thread" | "agent" | "coding"; bot?: string }> = {
      b_alpha: { kind: "bot", bot: "alpha" }, t_alpha1: { kind: "side-thread", bot: "alpha" },
      c_project: { kind: "coding" }, a_helper: { kind: "agent", bot: "alpha" }, b_gone: { kind: "bot", bot: "gone" },
    };
    const runs: Record<string, string> = { alpha: "Studio", beta: "Laptop" };
    const check = botDeliveryCheck({ host: { get: (id) => views[id] }, bots: { has: (b) => b in runs, computerFor: (b) => runs[b] } });
    const delivered: string[] = [];
    stops.push(mountSessionDelivery(studio.transport, studio.registry, async (session) => (delivered.push(session), { disposition: "folded", seq: 1 }), { check }));
    const relay = linkBotRelay({ transport: laptop.transport, registry: laptop.registry, self: () => "Laptop" });
    const fromBeta = { from: "bot" as const, bot: "beta", session: "b_beta", text: "hi" };
    // Accepted: Alpha's conversation and her side thread, from the computer running Beta.
    expect(await relay.deliver("Studio", "b_alpha", fromBeta)).toEqual({ disposition: "folded", seq: 1 });
    expect(await relay.deliver("Studio", "t_alpha1", { from: "routine", routine: "r_1", name: "Tick", sideThread: "t_alpha1", text: "done" })).toEqual({ disposition: "folded", seq: 1 });
    // Refused: a coding session, an agent's, an uninstalled bot's, a session that isn't here.
    for (const target of ["c_project", "a_helper", "b_gone", "b_nobody"]) {
      expect(isContractError(await relay.deliver("Studio", target, fromBeta).catch((e: unknown) => e), "refused")).toBe(true);
    }
    // Refused: a forged sender — Alpha's main conversation from Laptop (she runs on Studio), another bot's main
    // conversation named as the sender's, a bot nobody knows.
    for (const forged of [{ bot: "alpha", session: "b_alpha" }, { bot: "alpha", session: "b_beta" }, { bot: "nobody", session: "b_nobody" }]) {
      expect(isContractError(await relay.deliver("Studio", "b_alpha", { ...fromBeta, ...forged }).catch((e: unknown) => e), "refused")).toBe(true);
    }
    // Taken: a side thread of Beta's, which may run on any computer.
    expect(await relay.deliver("Studio", "b_alpha", { ...fromBeta, session: "t_beta1" })).toEqual({ disposition: "folded", seq: 1 });
    expect(delivered).toEqual(["b_alpha", "t_alpha1", "b_alpha"]);
    // Refused: a request naming another computer than the link's peer, and malformed inputs.
    const link = await laptop.transport.connect(studio.id);
    const ask = (params: unknown) => link.request("link.session.deliver", params).catch((e: unknown) => e);
    expect(isContractError(await ask({ id: "b_alpha", computer: "Studio", input: fromBeta }), "refused")).toBe(true);
    for (const input of [
      { ...fromBeta, extra: "a field the protocol doesn't name" },
      { from: "bot", bot: "beta", text: "no session" },
      { from: "routine", routine: "r_1", text: "no name or side thread" },
      { from: "agent", agent: "", text: "an empty agent" },
      { from: "bot", bot: "beta", session: "b_beta", text: 42 },
      { from: "note", label: "x", text: "a core note", by: { kind: "core" } },
    ]) {
      expect(isContractError(await ask({ id: "b_alpha", computer: "Laptop", input }), "invalid")).toBe(true);
    }
    expect(isContractError(await ask({ id: "b_alpha", input: fromBeta }), "invalid")).toBe(true);
    expect(delivered).toEqual(["b_alpha", "t_alpha1", "b_alpha"]);
  });
});
