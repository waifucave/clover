// The card methods over lane C's broker as the daemon mounts them (a getter read at each call), and lane K's agent.*
// methods the same way: refused until the parts are up, answered from the one broker and the one set of agents.
import { describe, expect, test } from "bun:test";
import { ERR, type Caller, type Card, type CloverRole } from "@waifucave/clover-protocol";
import type { AgentManager } from "../../src/agents/manager";
import { lateAgentMethods, type RunningAgents } from "../../src/agents/rpc";
import { cardMethods } from "../../src/approvals/card-methods";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { CloverConn } from "../../src/ipc/clover";

const bash = (): ApprovalRequest => ({
  kind: "tool", session: "s1", bot: "luna", origin: "user", computers: ["Studio"], effect: "execute", ruleKey: "Bash(git push)",
  fields: { title: { type: "text", text: "Run a command" }, command: { type: "code", code: "git push", language: "sh" } },
});

const conn = (role: CloverRole, caller: Caller): CloverConn => ({ role, caller }) as unknown as CloverConn;
const APP = conn("app", { kind: "user", client: "app" });
const REMOTE = conn("remote", { kind: "user", client: "ios", device: "phone-device-0001" });

async function errorOf(p: unknown): Promise<{ code: number; message: string }> {
  try {
    await p;
  } catch (err) {
    return err as { code: number; message: string };
  }
  throw new Error("didn't fail");
}

/** Raises one card and hands it back with the decision's promise. */
async function raise(broker: CloverApprovalBroker): Promise<{ card: Card; decided: Promise<unknown> }> {
  const shown = new Promise<Card>((resolve) => {
    const off = broker.watch((e) => {
      if (e.type === "requested") {
        off();
        resolve(e.card);
      }
    });
  });
  const decided = broker.request(bash());
  return { card: await shown, decided };
}

describe("the card methods", () => {
  test("are refused while the broker isn't up, and answer from it once it is, through the getter", async () => {
    let broker: CloverApprovalBroker | undefined;
    const m = cardMethods(() => broker);
    for (const [name, params] of [["card.list", {}], ["card.get", { id: "c1" }], ["card.frame", { id: "c1" }]] as const) {
      expect(await errorOf(m[name]!(APP, params))).toMatchObject({ code: ERR.RETRY, message: expect.stringContaining("isn't running on this computer") });
    }

    broker = new CloverApprovalBroker({ clock: new FakeClock() });
    const { card, decided } = await raise(broker);
    expect(await m["card.list"]!(APP, {})).toEqual({ cards: [card] });
    expect(await m["card.get"]!(APP, { id: card.id })).toEqual({ card });
    expect(await errorOf(m["card.get"]!(APP, { id: "nope" }))).toMatchObject({ code: ERR.NOT_FOUND });

    // A sealed frame's answer counts through the app only: from a remote link it is refused, the card stays pending.
    const { channel } = (await m["card.frame"]!(APP, { id: card.id })) as { channel: string };
    const frame = { via: "sealed-frame", frame: channel, input: "click", at: 1 };
    expect(await m["card.answer"]!(REMOTE, { id: card.id, hash: card.hash, option: "approve", proof: frame })).toEqual({ accepted: false, reason: expect.any(String) });
    expect(await m["card.answer"]!(APP, { id: card.id, hash: "0".repeat(64), option: "approve", proof: frame })).toMatchObject({ accepted: false });
    expect(await m["card.answer"]!(APP, { id: card.id, hash: card.hash, option: "approve", proof: frame })).toEqual({ accepted: true });
    expect(await decided).toMatchObject({ allowed: true, by: "card" });

    // Resolved: card.get still draws it, with how it ended; card.frame and card.list no longer have it.
    expect(await m["card.get"]!(APP, { id: card.id })).toEqual({ card, outcome: "approved", option: "approve", resolvedAt: expect.any(Number) });
    expect(await m["card.list"]!(APP, {})).toEqual({ cards: [] });
    expect(await errorOf(m["card.frame"]!(APP, { id: card.id }))).toMatchObject({ code: ERR.NOT_FOUND });
    expect(await m["card.answer"]!(APP, { id: card.id, hash: card.hash, option: "deny", proof: frame })).toMatchObject({ accepted: false });

    // The parts stopped: refused again.
    broker = undefined;
    expect(await errorOf(m["card.list"]!(APP, {}))).toMatchObject({ code: ERR.RETRY });
  });

  test("a device's answer names the device the link authenticated, never one the answer claims", async () => {
    const seen: { role: string; device?: string }[] = [];
    const clock = new FakeClock();
    const broker = new CloverApprovalBroker({ clock, verify: (_card, _a, from) => (seen.push(from), false) });
    const m = cardMethods(() => broker);
    const { card } = await raise(broker);
    const proof = { via: "device", device: "someone-elses-dev", at: clock.now(), signature: "AAAA" };
    await m["card.answer"]!(REMOTE, { id: card.id, hash: card.hash, option: "approve", proof });
    await m["card.answer"]!(conn("peer", { kind: "peer", device: "laptop-device-01" }), { id: card.id, hash: card.hash, option: "approve", proof });
    await m["card.answer"]!(APP, { id: card.id, hash: card.hash, option: "approve", proof });
    expect(seen).toEqual([{ role: "remote", device: "phone-device-0001" }, { role: "peer", device: "laptop-device-01" }, { role: "app" }]);
  });
});

describe("the agent methods, mounted late", () => {
  test("are refused while no agents run; a contract's failure becomes its JSON-RPC code", async () => {
    let agents: RunningAgents | undefined;
    const m = lateAgentMethods(() => agents);
    expect(Object.keys(m).sort()).toEqual(["agent.backends", "agent.definitions", "agent.start"]);
    const user = { caller: { kind: "user", client: "app" } as Caller };
    expect(await errorOf(m["agent.definitions"]!({}, user))).toMatchObject({ code: ERR.RETRY, message: expect.stringContaining("aren't running on this computer") });

    agents = { manager: {} as AgentManager, backends: () => [], computer: "Studio" };
    expect(await m["agent.definitions"]!({}, user)).toEqual({ definitions: [] });
    expect(await m["agent.backends"]!({}, user)).toEqual({ backends: [] });
    const refused = await errorOf(m["agent.start"]!({ backend: "fake", computer: "Studio", root: "home/Studio/p" }, { caller: { kind: "peer", device: "laptop-device-01" } }));
    expect(refused).toMatchObject({ code: ERR.INVALID_REQUEST, message: "only the user starts a coding session" });
    expect(typeof refused.code).toBe("number");
    expect((await errorOf(m["agent.start"]!({ backend: 7 }, user))).code).toBe(ERR.INVALID_PARAMS);

    agents = undefined;
    expect((await errorOf(m["agent.backends"]!({}, user))).code).toBe(ERR.RETRY);
  });
});
