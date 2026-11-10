// Forged records, end to end (lane C's call-binding review, on #342): the REAL approval broker's cards taken by the
// REAL computer registry as `{ via: "card" }` raises. The registry judges a raise on the broker's own record of the
// card (`cardRecord`, the broker's `get`), so nothing a caller builds or edits counts: not a record the broker never
// issued, not a denied, open, expired or withdrawn card handed over as approved, not a real approved card re-bound and
// re-hashed for another level, not another computer's broker's card, and not the broker's own answer edited in place
// after `get` gave it out. The last case runs through `startDaemonParts`, as the daemon wires the node.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBindingInput, cardHashInput, UNATTENDED_CARD_TIMEOUT_MS, type Card, type Level } from "@waifucave/clover-protocol";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import { SystemClock } from "../../src/clock/system-clock";
import { CoreComputerRegistry } from "../../src/computers/registry";
import type { ApprovalRequest, CallRequestBinding, CardRecord } from "../../src/contracts/approval-broker";
import { isContractError } from "../../src/contracts/common";
import { levelRaiseCall } from "../../src/contracts/computer-registry";
import { FakeClock, flush } from "../../src/contracts/fakes/clock";
import { FakePluginRegistry } from "../../src/contracts/fakes/plugin-registry";
import { startDaemonParts } from "../../src/daemon-parts";
import { startDaemonLinks } from "../../src/ipc/device-links";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { CloverSecretStore, KeychainValues, memoryVault } from "../../src/secrets/clover-secret-store";
import { catalogPointDecl } from "../../../plugin-sdk/src/catalogs/index";
import { Drivers } from "../../src/bots/tests/fixtures";
import type { Clock } from "../../src/contracts/clock";

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const raise = (name: string, level: Level = "automatic"): CallRequestBinding => ({ computer: name, ...levelRaiseCall(name, level) });
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** The refusal's reason, or "ok". */
async function why(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  if (e === undefined) return "ok";
  expect(isContractError(e, "refused")).toBe(true);
  return (e as Error).message;
}

/** A card re-hashed after an edit, as a forger who knows the hash rule makes it. */
function rehashed(card: Card, edit: Partial<Card>): Card {
  const { hash: _old, ...rest } = { ...structuredClone(card), ...edit };
  return { ...rest, hash: sha256(cardHashInput(rest as never)) } as Card;
}

/** A level-raise card request for `computer`, from the user (or `origin`). */
const raiseRequest = (computer: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  kind: "change", change: "computer-level", origin: "user", computers: [computer], effect: "other",
  fields: { title: { type: "text", text: "Raise this computer's level" } }, binds: raise(computer), ...over,
});

/** A real broker for `computer`, its cards answered through the app's sealed frame. */
function brokerFor(clock: Clock, computer: string) {
  const broker = new CloverApprovalBroker({ clock, levels: () => "ask-risky", localComputer: computer });
  /** Raises a card and leaves it open: its id. */
  const open = async (req: ApprovalRequest): Promise<{ id: string; decision: Promise<unknown> }> => {
    const decision = broker.request(req);
    await flush();
    return { id: broker.cards().at(-1)!.id, decision };
  };
  /** Raises a card and answers it with `option`; the broker's own record afterwards. */
  const answered = async (req: ApprovalRequest, option: "approve" | "deny" = "approve"): Promise<CardRecord> => {
    const { id, decision } = await open(req);
    const card = broker.cards().find((c) => c.id === id)!;
    expect(await broker.answer(id, { optionId: option, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(id)!, input: "click", at: 1 } }, { role: "app" })).toBe("accepted");
    await decision;
    return broker.get(id)!;
  };
  return { broker, open, answered };
}

function world() {
  const clock = new FakeClock();
  const studio = brokerFor(clock, "Studio");
  const laptop = brokerFor(clock, "Laptop1");
  const registry = new CoreComputerRegistry({ clock, self: { name: "Studio", device: "studio00000000000000" }, cardRecord: (id) => studio.broker.get(id) });
  return { clock, studio, laptop, registry };
}

describe("forged records against the real broker and registry", () => {
  test("a record the broker never issued, however right it looks, raises nothing", async () => {
    const { clock, registry } = world();
    const { method, params } = levelRaiseCall("Studio", "automatic");
    const unhashed = {
      id: `card_${"ab".repeat(12)}`, kind: "change" as const, change: "computer-level" as const, computer: "Studio", origin: "user" as const,
      issuedAt: clock.now(), expiresAt: null, fields: {}, options: [{ id: "approve", kind: "approve" as const, label: "Allow once" }],
      binds: { computer: "Studio", method, params: sha256(callBindingInput(method, params)) },
    };
    const madeUp: CardRecord = { card: { ...unhashed, hash: sha256(cardHashInput(unhashed as never)) } as Card, outcome: "approved", optionId: "approve", resolvedAt: clock.now() };
    expect(await why(registry.setLevel("Studio", "automatic", { via: "card", record: madeUp }))).toContain("holds no such card");
    expect(registry.self().level).toBe("ask-risky");
  });

  test("a denied card handed over as approved is judged on the broker's record: refused", async () => {
    const { studio, registry } = world();
    const denied = await studio.answered(raiseRequest("Studio"), "deny");
    expect(denied.outcome).toBe("denied");
    const asApproved: CardRecord = { ...denied, outcome: "approved", optionId: "approve" };
    expect(await why(registry.setLevel("Studio", "automatic", { via: "card", record: asApproved }))).toContain("wasn't approved");
    // The copy `get` gave out, edited in place, is the caller's: the broker's record is unchanged.
    const got = studio.broker.get(denied.card.id)!;
    Object.assign(got, { outcome: "approved", optionId: "approve" });
    expect(studio.broker.get(denied.card.id)!.outcome).toBe("denied");
    expect(await why(registry.setLevel("Studio", "automatic", { via: "card", record: got }))).toContain("wasn't approved");
    expect(registry.self().level).toBe("ask-risky");
  });

  test("an open card, an expired one and a withdrawn one, each handed over as approved, are refused", async () => {
    const { clock, studio, registry } = world();
    // Open: the person hasn't answered.
    const open = await studio.open(raiseRequest("Studio"));
    const openRecord = { ...studio.broker.get(open.id)!, outcome: "approved" as const, optionId: "approve", resolvedAt: clock.now() };
    expect(await why(registry.setLevel("Studio", "automatic", { via: "card", record: openRecord }))).toContain("wasn't approved");
    // Expired: a routine's card nobody answered settles as expired.
    const routine = await studio.open(raiseRequest("Studio", { origin: "routine" }));
    clock.correct(clock.now() + UNATTENDED_CARD_TIMEOUT_MS + 1);
    await flush();
    expect(studio.broker.get(routine.id)!.outcome).toBe("expired");
    const expired = { ...studio.broker.get(routine.id)!, outcome: "approved" as const, optionId: "approve", resolvedAt: clock.now() };
    expect(await why(registry.setLevel("Studio", "automatic", { via: "card", record: expired }))).toContain("wasn't approved");
    // Withdrawn: its session ended before the answer.
    const withdrawn = await studio.open(raiseRequest("Studio", { session: "s_gone" }));
    studio.broker.withdrawSession("s_gone");
    await flush();
    expect(studio.broker.get(withdrawn.id)!.outcome).not.toBe("approved");
    const asApproved = { ...studio.broker.get(withdrawn.id)!, outcome: "approved" as const, optionId: "approve", resolvedAt: clock.now() };
    expect(await why(registry.setLevel("Studio", "automatic", { via: "card", record: asApproved }))).toContain("wasn't approved");
    expect(registry.self().level).toBe("ask-risky");
  });

  test("a real approved card re-bound to another level and re-hashed is not the broker's card", async () => {
    const { studio, registry } = world();
    const good = await studio.answered(raiseRequest("Studio", { binds: raise("Studio", "accept-edits") }));
    expect(good.outcome).toBe("approved");
    const { method, params } = levelRaiseCall("Studio", "automatic");
    const rebound: CardRecord = { ...good, card: rehashed(good.card, { binds: { computer: "Studio", method, params: sha256(callBindingInput(method, params)) } }) };
    expect(await why(registry.setLevel("Studio", "automatic", { via: "card", record: rebound }))).toContain("isn't the one");
    // Nor does the untouched card prove the level it wasn't for.
    expect(await why(registry.setLevel("Studio", "automatic", { via: "card", record: good }))).toContain("another change");
    expect(registry.self().level).toBe("ask-risky");
    // It proves its own level, once.
    expect(await why(registry.setLevel("Studio", "accept-edits", { via: "card", record: good }))).toBe("ok");
    await registry.setLevel("Studio", "ask");
    expect(await why(registry.setLevel("Studio", "accept-edits", { via: "card", record: good }))).toContain("used already");
  });

  test("another computer's broker's approved card is no proof here", async () => {
    const { laptop, registry } = world();
    // Laptop1's broker approves a raise for Studio (a request that names Studio): Studio's broker holds no such card.
    const elsewhere = await laptop.answered(raiseRequest("Studio"));
    expect(elsewhere.outcome).toBe("approved");
    expect(await why(registry.setLevel("Studio", "automatic", { via: "card", record: elsewhere }))).toContain("holds no such card");
    expect(registry.self().level).toBe("ask-risky");
  });
});

describe("through startDaemonParts, with the real broker as the node's", () => {
  let stops: Array<() => unknown> = [];
  afterEach(async () => {
    for (const s of stops.reverse()) await s();
    stops = [];
  });

  test("forged and denied-as-approved records are refused; the broker's approved card raises exactly once", async () => {
    const clock = new SystemClock();
    const home = temp("lane-c-forged-home-");
    const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
    const net = new MemoryNetwork();
    const d = await startDaemonLinks({
      home, store, clock, self: { name: "Studio", os: "macos" }, handlers: {}, binary: null, wire: (k) => net.endpoint(k.publicKey),
      handshake: null, publicTime: null, mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {},
      dispatch: async () => null,
    });
    stops.push(() => d.close());
    const { broker, answered } = brokerFor(clock, "Studio");
    const fakes = new Drivers();
    const parts = await startDaemonParts({
      cloverHome: home, userHome: temp("lane-c-forged-user-"), clock, links: d.links, handlers: {},
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => fakes.factory, defaultModel: () => ({ model: "clover-test/calls" }) },
      approvals: broker,
    });
    stops.push(() => parts.close());
    const reg = parts.node!.registry;
    const name = reg.self().name;
    expect(reg.self().level).toBe("ask-risky");

    const denied = await answered(raiseRequest(name), "deny");
    expect(await why(reg.setLevel(name, "automatic", { via: "card", record: { ...denied, outcome: "approved", optionId: "approve" } }))).toContain("wasn't approved");
    const good = await answered(raiseRequest(name));
    const forged: CardRecord = { ...good, card: rehashed(good.card, { id: `card_${"cd".repeat(12)}` }) };
    expect(await why(reg.setLevel(name, "automatic", { via: "card", record: forged }))).toContain("holds no such card");
    expect(reg.self().level).toBe("ask-risky");

    // Only the card id is taken from what's handed over; the broker's record does the rest.
    expect(await why(reg.setLevel(name, "automatic", { via: "card", record: { card: good.card } }))).toBe("ok");
    expect(reg.self().level).toBe("automatic");
    await reg.setLevel(name, "ask");
    expect(await why(reg.setLevel(name, "automatic", { via: "card", record: good }))).toContain("used already");
    expect(reg.self().level).toBe("ask");
  }, 30_000);
});
