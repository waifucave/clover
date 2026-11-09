// A level raise with a card counts only when the card record handed over is the approval broker's own (C's
// call-binding review; the registry's `cardRecord`): an in-process caller can't hand over a record it built itself.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { callBindingInput, cardHashInput, type Card, type Level } from "@waifucave/clover-protocol";
import type { CardRecord } from "../../src/contracts/approval-broker";
import { isContractError } from "../../src/contracts/common";
import { levelRaiseCall } from "../../src/contracts/computer-registry";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { CoreComputerRegistry } from "../../src/computers/registry";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function record(name: string, level: Level, over: Partial<CardRecord> = {}): CardRecord {
  const { method, params } = levelRaiseCall(name, level);
  const unhashed = {
    id: `card_${name.toLowerCase()}${level.replace(/-/g, "")}`.padEnd(29, "0").slice(0, 29), kind: "change" as const, change: "computer-level" as const,
    computer: name, origin: "user" as const, issuedAt: 1, expiresAt: null, fields: {},
    options: [{ id: "approve", kind: "approve" as const, label: "Raise" }, { id: "deny", kind: "deny" as const, label: "Keep" }],
    binds: { computer: name, method, params: sha256(callBindingInput(method, params)) },
  };
  return { card: { ...unhashed, hash: sha256(cardHashInput(unhashed as never)) } as Card, outcome: "approved", optionId: "approve", ...over };
}

const refused = async (p: Promise<unknown>) => isContractError(await p.catch((e: unknown) => e), "refused");

describe("a raise with a card, checked against the broker's own record", () => {
  test("the broker's record raises; one it doesn't have, or one that differs from it, doesn't", async () => {
    const broker = new Map<string, CardRecord>();
    const reg = new CoreComputerRegistry({ clock: new FakeClock(), self: { name: "Studio", device: "d000000000000000" }, cardRecord: (id) => broker.get(id) });
    const good = record("Studio", "automatic");
    // A record the broker never issued: refused, however right it looks.
    expect(await refused(reg.setLevel("Studio", "automatic", { via: "card", record: good }))).toBe(true);
    // The broker's record says the person denied it; a copy claiming approval is refused.
    broker.set(good.card.id, { ...structuredClone(good), outcome: "denied", optionId: "deny" });
    expect(await refused(reg.setLevel("Studio", "automatic", { via: "card", record: good }))).toBe(true);
    // The broker's own record (deep-equal, not the same object): the raise goes through.
    broker.set(good.card.id, structuredClone(good));
    await reg.setLevel("Studio", "automatic", { via: "card", record: good });
    expect(reg.self().level).toBe("automatic");
  });

  test("without the broker's records, the record handed over is judged as it is (as before)", async () => {
    const reg = new CoreComputerRegistry({ clock: new FakeClock(), self: { name: "Studio", device: "d000000000000000" } });
    await reg.setLevel("Studio", "automatic", { via: "card", record: record("Studio", "automatic") });
    expect(reg.self().level).toBe("automatic");
  });
});
