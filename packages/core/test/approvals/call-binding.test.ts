// Rule 9 end to end: the real broker's bound card, taken by the real computer registry as a `{ via: "card" }` raise.
// A card answered for one binding never proves another: not another level, not another computer, not another call
// with the same change subject, not another change subject with the same call, and never twice.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Level } from "@waifucave/clover-protocol";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import { CoreComputerRegistry } from "../../src/computers/registry";
import { boundCardRecord, callBindingOf, type ApprovalRequest, type CallRequestBinding, type CardRecord } from "../../src/contracts/approval-broker";
import { isContractError } from "../../src/contracts/common";
import { levelRaiseCall } from "../../src/contracts/computer-registry";
import { FakeClock, flush } from "../../src/contracts/fakes/clock";

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const raise = (name = "Studio", level: Level = "automatic"): CallRequestBinding => ({ computer: name, ...levelRaiseCall(name, level) });
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

function world() {
  const clock = new FakeClock();
  const broker = new CloverApprovalBroker({ clock, levels: () => "ask-risky", localComputer: "Studio" });
  // Each registry judges a card raise on the broker's own record (#342: without the lookup, no card raises a level).
  const cardRecord = (id: string) => broker.get(id);
  const studio = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "studio00000000000000" }, cardRecord });
  const laptop = new CoreComputerRegistry({ clock, self: { name: "Laptop1", device: "laptop00000000000000" }, cardRecord });
  /** Raises a change card and answers it through the app's sealed frame; the record it hands over, if any. */
  const answered = async (over: Partial<ApprovalRequest>, option = "approve"): Promise<CardRecord | undefined> => {
    const req: ApprovalRequest = {
      kind: "change", change: "computer-level", origin: "user", computers: ["Studio"], effect: "other",
      fields: { title: { type: "text", text: "Raise this computer's level" } }, ...over,
    };
    const decision = broker.request(req);
    await flush();
    const card = broker.cards().at(-1)!;
    expect(await broker.answer(card.id, { optionId: option, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: 1 } }, { role: "app" })).toBe("accepted");
    return boundCardRecord(broker, await decision) ?? (option === "approve" ? broker.get(card.id) : undefined);
  };
  return { broker, studio, laptop, answered };
}

describe("rule 9: a bound card as a level raise's proof", () => {
  test("a card answered for one binding never proves another", async () => {
    const { studio, laptop, answered } = world();
    await studio.setLevel("Studio", "ask");
    await laptop.setLevel("Laptop1", "ask");
    const refused = async (p: Promise<unknown>) => expect(isContractError(await rejection(p), "refused")).toBe(true);

    const good = (await answered({ binds: raise() }))!;
    expect(good.card.binds).toEqual(callBindingOf(raise(), sha256));
    // Another level on the same computer.
    await refused(studio.setLevel("Studio", "accept-edits", { via: "card", record: good }));
    // The same raise on another computer.
    await refused(laptop.setLevel("Laptop1", "automatic", { via: "card", record: good }));
    // Another call under the same change subject, and the same call under another subject.
    const otherCall = (await answered({ binds: { computer: "Studio", method: "tool.run", params: { name: "Studio", level: "automatic" } } }))!;
    await refused(studio.setLevel("Studio", "automatic", { via: "card", record: otherCall }));
    const otherSubject = (await answered({ change: "routine-level", binds: raise() }))!;
    await refused(studio.setLevel("Studio", "automatic", { via: "card", record: otherSubject }));
    // A card with no binding, and a denied one.
    const unbound = (await answered({}))!;
    expect(unbound.card.binds).toBeUndefined();
    await refused(studio.setLevel("Studio", "automatic", { via: "card", record: unbound }));
    const denied = await answered({ binds: raise() }, "deny");
    expect(denied).toBeUndefined();
    expect(studio.self().level).toBe("ask");

    // Exactly its own call, once.
    await studio.setLevel("Studio", "automatic", { via: "card", record: good });
    expect(studio.self().level).toBe("automatic");
    await studio.setLevel("Studio", "ask");
    await refused(studio.setLevel("Studio", "automatic", { via: "card", record: good }));
    expect(studio.self().level).toBe("ask");
  });

  test("a binding for a computer the request doesn't touch is refused, with no card to prove anything", async () => {
    const { broker } = world();
    const decision = await broker.request({
      kind: "change", change: "computer-level", origin: "user", computers: ["Studio"], effect: "other",
      fields: { title: { type: "text", text: "Raise this computer's level" } }, binds: raise("Laptop1"),
    });
    expect(decision).toEqual({ allowed: false, by: "unbound" });
    expect(boundCardRecord(broker, decision)).toBeUndefined();
    expect(broker.cards()).toHaveLength(0);
  });
});
