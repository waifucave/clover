// The devices area's handlers (as lane C's server mounts them) and the `peer.call` door: the terminal changes
// directly, any other client gets a sealed card, a bot never; and a peer's call runs only with a signed answer from
// a desktop's app-held answer key, bound to exactly that call.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callBindingInput, cardAnswerSigningInput, cardHashInput, CLOVER_ERR, DEVICES_METHODS, type Card, type CardContent, type Caller,
} from "@waifucave/clover-protocol";
import { isContractError } from "../../contracts/common";
import { FakeApprovalBroker, MemoryAnswerLedger } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { SystemClock } from "../../clock/system-clock";
import { toBase64 } from "../../identity/bytes";
import { DeviceKey } from "../../identity/device-key";
import { generateEd25519 } from "../../identity/keys";
import { MemoryNetwork } from "../../links/memory-wire";
import { PairingService } from "../../links/pairing";
import { peerCall } from "../../links/peer-call";
import { answerKeyStatement, FileDeviceRegistry } from "../registry";
import { brokerCardOpener, devicesEvents, devicesMethods, type MethodError } from "../rpc";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const terminal: Caller = { kind: "user", client: "cli" };
const app: Caller = { kind: "user", client: "app" };
const bot: Caller = { kind: "session", sessionId: "ses_abcdef12", sessionKind: "chat" };

async function computer(net: MemoryNetwork, name: string) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-rpc-")), key, clock, self: { name } });
  const pairing = new PairingService({ self: key, registry, wire: net.endpoint(key.publicKey), clock, store, selfTarget: () => ({}), account: () => null });
  stops.push(() => pairing.close());
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const transport = { links: () => [], watch: () => () => undefined };
  const methods = devicesMethods({ registry, pairing, transport, clock, openCard: brokerCardOpener(broker), revoke: { store } });
  const events: { type: string }[] = [];
  stops.push(devicesEvents({ registry, transport, pairing, clock }, (e) => events.push(e)));
  const call = (method: string, params: unknown, caller: Caller) => methods[method]!(params, { caller });
  return { name, key, registry, pairing, broker, call, events };
}

describe("devices methods", () => {
  test("pairing through the methods: from the terminal no card; from the app a sealed card first", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const view = (await a.call("device.pair.begin", {}, terminal)) as { pairingId: string; qr: string };
    const joined = (await b.call("device.pair.join", { code: view.qr }, terminal)) as { words: string[] };
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
    expect(await b.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words }, terminal)).toEqual({ applied: true });
    const res = (await a.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words }, app)) as { applied: false; card: string };
    expect(res.applied).toBe(false);
    const card = a.broker.cards().find((c) => c.id === res.card)!;
    expect(card.change).toBe("device-add");
    expect(a.registry.get(b.key.id)).toBeUndefined();
    // The user approves it in the app's sealed frame.
    const channel = a.broker.frameChannel(card.id)!;
    expect(await a.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame: channel, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
    await waitFor(() => a.registry.get(b.key.id)?.addedBy === "code" && b.registry.get(a.key.id) !== undefined);
    expect(a.events.map((e) => e.type)).toContain("pairing_changed");
    expect(a.events.map((e) => e.type)).toContain("device_changed");
    const list = (await a.call("device.list", {}, app)) as { devices: { id: string; isThis: boolean }[] };
    expect(list.devices.map((d) => d.isThis).sort()).toEqual([false, true]);
    // A revoke from the terminal applies at once, and says so to the clients.
    expect(await a.call("device.revoke", { id: b.key.id }, terminal)).toEqual({ applied: true });
    expect(a.events.some((e) => e.type === "device_removed")).toBe(true);
  });

  test("a bot can't pair, rename or revoke", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    for (const [m, p] of [["device.pair.begin", {}], ["device.rename", { id: a.key.id, name: "x" }], ["device.revoke", { id: a.key.id }]] as const) {
      const err = (await a.call(m, p, bot).catch((e: unknown) => e)) as MethodError;
      expect(err.code).toBe(CLOVER_ERR.NOT_THE_USER);
    }
  });
});

describe("peer.call", () => {
  const computerName = "Studio";
  async function setup() {
    const net = new MemoryNetwork();
    const a = await computer(net, computerName);
    // A paired desktop whose app holds its answer key apart from its link key.
    const laptop = await DeviceKey.fromKey(generateEd25519());
    const app = generateEd25519();
    await a.registry.add({ id: laptop.id, name: "Laptop", kind: "desktop", runsCore: true, computer: "Laptop", publicKey: laptop.publicKeyBase64 }, { via: "terminal" });
    const appKey = toBase64(app.publicKey);
    // The laptop's own registry took its app's key with proof; here it reaches A as a signed peer update.
    const update = { answerKey: { publicKey: appKey, held: "app-keychain" as const }, at: Date.now() };
    const { peerUpdateStatement } = await import("../registry");
    expect(await a.registry.applyPeerUpdate(laptop.id, update, laptop.sign(peerUpdateStatement(laptop.id, update)))).toBe(true);
    expect(answerKeyStatement(laptop.id, appKey, "app-keychain").length).toBeGreaterThan(0);
    const ran: { method: string; caller: Caller }[] = [];
    const render = (call: { computer: string; method: string; params: unknown }): CardContent => ({
      kind: "change", change: "core-setting", binds: { computer: call.computer, method: call.method, params: sha(callBindingInput(call.method, call.params)) },
      fields: { title: { type: "text", text: `Run ${call.method}?` } }, options: [{ id: "approve", kind: "approve", label: "Approve" }, { id: "deny", kind: "deny", label: "Deny" }],
    });
    const deps = {
      computer: () => computerName, devices: a.registry, ledger: new MemoryAnswerLedger(), render, clock,
      dispatch: async (method: string, _p: unknown, caller: Caller) => {
        ran.push({ method, caller });
        return "done";
      },
    };
    const signed = (method: string, params: unknown, key = app) => {
      const content = render({ computer: computerName, method, params });
      const unhashed: Omit<Card, "hash"> = { id: "card_peer01", computer: computerName, origin: "user", issuedAt: Date.now(), expiresAt: null, ...content } as Omit<Card, "hash">;
      const card: Card = { ...unhashed, hash: sha(cardHashInput(unhashed)) } as Card;
      const at = Date.now();
      const signature = toBase64(key.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "approve", at, children: [] }))));
      return { card, option: "approve", device: laptop.id, at, signature };
    };
    return { a, laptop, app, deps, ran, signed };
  }

  test("an allowed method runs as the peer device, never as the user", async () => {
    const { laptop, deps, ran } = await setup();
    expect(await peerCall(deps, { method: "device.list", params: {}, as: { kind: "user", client: "app" }, role: "remote" }, laptop.id)).toEqual({ result: "done" });
    expect(ran[0]!.caller).toEqual({ kind: "peer", device: laptop.id });
  });

  test("a change runs only with the app's signed answer bound to this call, once", async () => {
    const { laptop, deps, ran, signed } = await setup();
    const params = { id: laptop.id, name: "Laptop 2" };
    const call = (answer?: unknown, p: unknown = params) => peerCall(deps, { method: "device.rename", params: p, as: { kind: "user", client: "app" }, role: "remote", ...(answer ? { answer } : {}) }, laptop.id);
    expect(isContractError(await call().catch((e: unknown) => e), "refused")).toBe(true);
    // Signed with the laptop's link key instead of its app's answer key: refused.
    expect(isContractError(await call(signed("device.rename", params, (await import("../../identity/keys")).generateEd25519())).catch((e: unknown) => e), "refused")).toBe(true);
    // Bound to other params: refused.
    expect(isContractError(await call(signed("device.rename", { ...params, name: "Other" })).catch((e: unknown) => e), "refused")).toBe(true);
    const good = signed("device.rename", params);
    expect(await call(good)).toEqual({ result: "done" });
    expect(ran.map((r) => r.method)).toEqual(["device.rename"]);
    // The same answer counts once.
    expect(isContractError(await call(good).catch((e: unknown) => e), "refused")).toBe(true);
  });

  test("a peer method or a role that isn't remote is refused", async () => {
    const { laptop, deps } = await setup();
    expect(isContractError(await peerCall(deps, { method: "peer.hello", params: {}, as: { kind: "core" }, role: "remote" }, laptop.id).catch((e: unknown) => e), "refused")).toBe(true);
    expect(isContractError(await peerCall(deps, { method: "device.list", params: {}, as: { kind: "core" }, role: "app" }, laptop.id).catch((e: unknown) => e), "invalid")).toBe(true);
    expect(DEVICES_METHODS.peerCall.name).toBe("peer.call");
  });
});

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}
