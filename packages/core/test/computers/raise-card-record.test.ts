// A level raise with a card counts only on the approval broker's own record of it (C's call-binding review; #342's
// review): the registry looks the card up (`cardRecord`, the broker's `get`) and judges that record, never the copy
// handed over; with no lookup no card raises; a card answered too long ago, or before the registry started, is no
// proof; and a card raises once, across a restart too (the used ids kept on disk under the Clover home).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBindingInput, cardHashInput, type Card, type Level } from "@waifucave/clover-protocol";
import { SystemClock } from "../../src/clock/system-clock";
import type { ApprovalRequest, CardRecord } from "../../src/contracts/approval-broker";
import { isContractError } from "../../src/contracts/common";
import { CARD_PROOF_MAX_AGE_MS, levelRaiseCall } from "../../src/contracts/computer-registry";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { FakePluginRegistry } from "../../src/contracts/fakes/plugin-registry";
import { CoreComputerRegistry } from "../../src/computers/registry";
import { FileAnswerLedger, usedCardsPath } from "../../src/computers/store";
import { startDaemonParts } from "../../src/daemon-parts";
import { startDaemonLinks } from "../../src/ipc/device-links";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { CloverSecretStore, KeychainValues, memoryVault } from "../../src/secrets/clover-secret-store";
import { catalogPointDecl } from "../../../plugin-sdk/src/catalogs/index";
import { Drivers } from "../../src/bots/tests/fixtures";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** An approved level-raise card for `name` at `level`, as the approval broker records it. */
function record(name: string, level: Level, over: Partial<CardRecord> = {}, tag = ""): CardRecord {
  const { method, params } = levelRaiseCall(name, level);
  const unhashed = {
    id: `card_${name.toLowerCase()}${level.replace(/-/g, "")}${tag}`.padEnd(29, "0").slice(0, 29), kind: "change" as const, change: "computer-level" as const,
    computer: name, origin: "user" as const, issuedAt: 1, expiresAt: null, fields: {},
    options: [{ id: "approve", kind: "approve" as const, label: "Raise" }, { id: "deny", kind: "deny" as const, label: "Keep" }],
    binds: { computer: name, method, params: sha256(callBindingInput(method, params)) },
  };
  return { card: { ...unhashed, hash: sha256(cardHashInput(unhashed as never)) } as Card, outcome: "approved", optionId: "approve", ...over };
}

/** The refusal's reason, or "ok". */
const why = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  if (e === undefined) return "ok";
  expect(isContractError(e, "refused")).toBe(true);
  return (e as Error).message;
};

describe("a raise with a card, checked against the broker's own record", () => {
  test("the broker's record raises, once; one it doesn't hold, or one that differs from it, doesn't", async () => {
    const clock = new FakeClock();
    const broker = new Map<string, CardRecord>();
    const reg = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "d000000000000000" }, cardRecord: (id) => broker.get(id) });
    const good = record("Studio", "automatic", { resolvedAt: clock.now() });
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: good }))).toContain("holds no such card");
    // The broker's record says the person denied it; a copy claiming approval is refused on the broker's word.
    broker.set(good.card.id, { ...structuredClone(good), outcome: "denied", optionId: "deny" });
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: good }))).toContain("wasn't approved");
    // A copy whose card differs from the broker's (another hash) is refused too.
    broker.set(good.card.id, structuredClone(good));
    const forged = { ...good, card: { ...good.card, hash: "0".repeat(64) } };
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: forged }))).toContain("isn't the one");
    // The broker's own record: judged on it (not the copy), it raises, and only once.
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: { card: good.card } }))).toBe("ok");
    expect(reg.self().level).toBe("automatic");
    await reg.setLevel("Studio", "read-only");
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: good }))).toContain("used already");
  });

  test("with no lookup in the broker, no card raises a level", async () => {
    const clock = new FakeClock();
    const reg = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "d000000000000000" } });
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: record("Studio", "automatic", { resolvedAt: clock.now() }) }))).toContain("no approval broker");
    expect(reg.self().level).toBe("ask-risky");
  });

  test("a card with no answer time, answered too long ago, or before the registry started, is no proof", async () => {
    const clock = new FakeClock();
    const broker = new Map<string, CardRecord>();
    const before = record("Studio", "automatic", { resolvedAt: clock.now() - 1 }, "b");
    broker.set(before.card.id, before);
    clock.correct(clock.now() + 1);
    const reg = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "d000000000000000" }, cardRecord: (id) => broker.get(id) });
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: before }))).toContain("too old");
    const timeless = record("Studio", "automatic", {}, "t");
    broker.set(timeless.card.id, timeless);
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: timeless }))).toContain("too old");
    const old = record("Studio", "automatic", { resolvedAt: clock.now() }, "o");
    broker.set(old.card.id, old);
    clock.correct(clock.now() + CARD_PROOF_MAX_AGE_MS + 1);
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: old }))).toContain("too old");
    // Answered within the bound: it counts.
    const fresh = record("Studio", "automatic", { resolvedAt: clock.now() - CARD_PROOF_MAX_AGE_MS }, "f");
    broker.set(fresh.card.id, fresh);
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: fresh }))).toBe("ok");
  });

  test("a card bound to a transfer's source is no proof for a level", async () => {
    const clock = new FakeClock();
    const broker = new Map<string, CardRecord>();
    const reg = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "d000000000000000" }, cardRecord: (id) => broker.get(id) });
    const { method, params } = levelRaiseCall("Studio", "automatic");
    const unhashed = { ...record("Studio", "automatic").card, binds: { computer: "Studio", method, params: sha256(callBindingInput(method, params)), source: "Laptop" } } as Record<string, unknown>;
    delete unhashed.hash;
    const r: CardRecord = { card: { ...unhashed, hash: sha256(cardHashInput(unhashed as never)) } as Card, outcome: "approved", optionId: "approve", resolvedAt: clock.now() };
    broker.set(r.card.id, r);
    expect(await why(reg.setLevel("Studio", "automatic", { via: "card", record: r }))).toContain("another change");
  });
});

describe("the used cards on disk", () => {
  test("an id claimed once is refused by a ledger on the same file after a restart; old ids are pruned; the file is 0600", () => {
    const clock = new FakeClock();
    const path = usedCardsPath(temp("lane-j-used-cards-"));
    expect(new FileAnswerLedger(path, clock).claim("card_a")).toBe(true);
    const again = new FileAnswerLedger(path, clock);
    expect(again.claim("card_a")).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    clock.correct(clock.now() + 2 * CARD_PROOF_MAX_AGE_MS + 1);
    expect(again.claim("card_b")).toBe(true);
    expect(Object.keys((JSON.parse(readFileSync(path, "utf8")) as { used: Record<string, number> }).used)).toEqual(["card_b"]);
  });

  test("a claim that can't be written is refused", () => {
    const dir = temp("lane-j-used-cards-");
    // The ledger's folder is a file: nothing can be written under it.
    const blocked = join(dir, "levels");
    writeFileSync(blocked, "x");
    expect(new FileAnswerLedger(join(blocked, "used-cards.json"), new FakeClock()).claim("card_a")).toBe(false);
  });
});

describe("through startComputerNode, as the daemon calls it (startDaemonParts)", () => {
  let stops: Array<() => unknown> = [];
  afterEach(async () => {
    for (const s of stops.reverse()) await s();
    stops = [];
  });

  const clock = new SystemClock();

  async function start(home: string, store: CloverSecretStore, broker: Map<string, CardRecord>) {
    const net = new MemoryNetwork();
    const d = await startDaemonLinks({
      home, store, clock, self: { name: "Studio", os: "macos" }, handlers: {}, binary: null, wire: (k) => net.endpoint(k.publicKey),
      handshake: null, publicTime: null, mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {},
      dispatch: async () => null,
    });
    const fakes = new Drivers();
    const parts = await startDaemonParts({
      cloverHome: home, userHome: temp("lane-j-raise-user-"), clock, links: d.links, handlers: {},
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => fakes.factory, defaultModel: () => ({ model: "clover-test/calls" }) },
      approvals: { request: async (_r: ApprovalRequest) => ({ allowed: false, by: "card" }) as never, get: (id) => broker.get(id) },
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await parts.close();
      await d.close();
    };
    stops.push(stop);
    return { node: parts.node!, stop };
  }

  test("a made-up record is refused; the broker's own record raises exactly once, and not again after a restart", async () => {
    const home = temp("lane-j-raise-home-");
    const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
    const broker = new Map<string, CardRecord>();
    const first = await start(home, store, broker);
    const reg = first.node.registry;
    const name = reg.self().name;
    expect(reg.self().level).toBe("ask-risky");
    // A record the broker never issued, however right it looks.
    const madeUp = record(name, "automatic", { resolvedAt: Date.now() }, "m");
    expect(await why(reg.setLevel(name, "automatic", { via: "card", record: madeUp }))).toContain("holds no such card");
    expect(reg.self().level).toBe("ask-risky");
    // The broker's own record raises, once.
    const good = record(name, "automatic", { resolvedAt: Date.now() }, "g");
    broker.set(good.card.id, structuredClone(good));
    expect(await why(reg.setLevel(name, "automatic", { via: "card", record: good }))).toBe("ok");
    expect(reg.self().level).toBe("automatic");
    await reg.setLevel(name, "read-only");
    expect(await why(reg.setLevel(name, "automatic", { via: "card", record: good }))).toContain("used already");
    const used = usedCardsPath(home);
    expect(Object.keys((JSON.parse(readFileSync(used, "utf8")) as { used: Record<string, number> }).used)).toEqual([good.card.id]);
    if (process.platform !== "win32") expect(statSync(used).mode & 0o777).toBe(0o600);
    // A restart on the same home: the broker still holding the record makes it no newer.
    await first.stop();
    await Bun.sleep(5);
    const second = await start(home, store, broker);
    expect(second.node.registry.self().level).toBe("read-only");
    expect(await why(second.node.registry.setLevel(name, "automatic", { via: "card", record: good }))).not.toBe("ok");
    expect(second.node.registry.self().level).toBe("read-only");
  }, 30_000);
});
