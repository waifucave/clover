// The plugin registry's broker before the parts' is up (#397's review): a bounded wait that follows the caller's
// signal, and one OK card per plugin however many switches arrive while it waits.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import { FakeApprovalBroker } from "../../src/contracts/fakes/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { ContractError } from "../../src/contracts/common";
import { lateApprovalBroker } from "../../src/daemon-parts";
import { RegistryCore } from "../../src/registry/core";
import { brokerOkCards } from "../../src/registry/ok-cards";
import { memoryRegistryStore } from "../../src/registry/state";
import type { CloverApprovalBroker } from "../../src/approvals/broker";

const okRequest = { kind: "plugin-ok", origin: "user", computers: [], effect: "other", pluginId: "tarot", fields: {} } as const;

describe("the late broker", () => {
  test("a broker that never comes: the request is refused within the bound, with a try-again error", async () => {
    const late = lateApprovalBroker(new Promise<CloverApprovalBroker | undefined>(() => {}), { waitMs: 80 });
    const t0 = Date.now();
    const err = await late.request(okRequest as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractError);
    expect((err as ContractError).code).toBe("busy");
    expect((err as ContractError).message).toContain("try again");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("the caller's signal ends the wait", async () => {
    const late = lateApprovalBroker(new Promise<CloverApprovalBroker | undefined>(() => {}), { waitMs: 60_000 });
    const ac = new AbortController();
    const pending = late.request(okRequest as never, { signal: ac.signal }).catch((e: unknown) => e);
    ac.abort(new ContractError("cancelled", "gone"));
    expect(((await pending) as ContractError).code).toBe("cancelled");
  });

  test("parts that started without a broker: refused with why, at once", async () => {
    const late = lateApprovalBroker(Promise.resolve(undefined));
    expect(((await late.request(okRequest as never).catch((e: unknown) => e)) as ContractError).message).toContain("aren't up on this computer");
  });

  test("two switches of one found plugin while its card waits for the broker give one card", async () => {
    const fake = new FakeApprovalBroker({ clock: new FakeClock() });
    let bind: (b: CloverApprovalBroker) => void = () => {};
    const late = lateApprovalBroker(new Promise<CloverApprovalBroker | undefined>((r) => (bind = r)), { waitMs: 5_000 });
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore(), cards: brokerOkCards(late, (id) => ({ title: id, lines: [], source: "Found on disk" })) });
    reg.putAll([{ id: "tarot", manifest: { manifest: 1, name: "Tarot" }, treeHash: "sha256:t", approved: false }]);
    const first = reg.setEnabled("tarot", true);
    const second = reg.setEnabled("tarot", true);
    const third = reg.installed("tarot", "app");
    await Bun.sleep(20);
    bind(fake as unknown as CloverApprovalBroker);
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(fake.cards().filter((card) => card.pluginId === "tarot")).toHaveLength(1);
    const id = fake.cards()[0]!.id;
    expect([a, b, c.card]).toEqual([{ applied: false, card: id }, { applied: false, card: id }, id]);
  });
});
