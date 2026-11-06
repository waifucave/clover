// Lane D's `BotRelay` over the link: the user's message and another session's message reach the bot's conversation on
// the computer running it, named by its tree name; a message posing as the user's through the session door is refused;
// a runner that can't be reached answers `bot_asleep`, so the draft is kept.
import { afterEach, describe, expect, test } from "bun:test";
import { SystemClock } from "../../clock/system-clock";
import { isContractError } from "../../contracts/common";
import type { DeliveredInput } from "../../contracts/session-host";
import { linkBotRelay, mountSessionDelivery } from "../bot-relay";
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
    const relay = linkBotRelay({ transport: laptop.transport, registry: laptop.registry });
    const sentAt = Date.now();
    expect(await relay.sendUser("Studio", "b_alpha", { message: { clientMessageId: "m1", text: "hi", sentAt }, device: laptop.id, sentAt })).toEqual({ seq: 7 });
    expect(users).toHaveLength(1);
    expect(await relay.deliver("studio", "b_alpha", { from: "bot", bot: "beta", session: "b_beta", text: "done" })).toEqual({ disposition: "folded", seq: 8 });
    expect(delivered[0]).toMatchObject({ session: "b_alpha", from: laptop.id, input: { from: "bot" } });
    // The session door never takes a message as the user's.
    const link = await laptop.transport.connect(studio.id);
    expect(isContractError(await link.request("link.session.deliver", { id: "b_alpha", input: { from: "user", text: "pretend" } }).catch((e: unknown) => e), "invalid")).toBe(true);
  });

  test("with the runner out of reach the message is refused bot_asleep", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock, transport: { failFastMs: 200, dialTimeoutMs: 300 } });
    stops.push(() => c.close());
    c.net.partition(c.devices.get("Studio")!.key.publicKey);
    const relay = linkBotRelay({ transport: c.devices.get("Laptop")!.transport, registry: c.devices.get("Laptop")!.registry });
    expect(isContractError(await relay.deliver("Studio", "b_alpha", { from: "routine", routine: "r", name: "n", sideThread: "s", text: "t" }).catch((e: unknown) => e), "bot_asleep")).toBe(true);
    expect(isContractError(await relay.deliver("Nowhere", "b_alpha", { from: "routine", routine: "r", name: "n", sideThread: "s", text: "t" }).catch((e: unknown) => e), "bot_asleep")).toBe(true);
  });
});
