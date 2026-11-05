// The real device registry: B's conformance suite, then what lane H adds (the file, the answer key, pairs, the
// group and the rotation list).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../contracts/common";
import { runDeviceRegistryConformance } from "../../contracts/conformance/device-registry";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { DeviceKey } from "../../identity/device-key";
import { toBase64 } from "../../identity/bytes";
import { generateEd25519 } from "../../identity/keys";
import { answerKeyStatement, FileDeviceRegistry, peerUpdateStatement } from "../registry";

const home = () => mkdtempSync(join(tmpdir(), "clover-h-registry-"));

runDeviceRegistryConformance(async (opts) => {
  const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
  const registry = await FileDeviceRegistry.open({
    home: home(), key, clock: opts.clock,
    self: { name: opts.name ?? "Studio", ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.os ? { os: opts.os } : {}), ...(opts.computer ? { computer: opts.computer } : {}) },
  });
  return { registry, device: { id: key.id, publicKey: key.publicKeyBase64, sign: async (d: Uint8Array) => key.sign(d) } };
});

async function open(dir = home(), clock = new FakeClock(), store = new MemorySecretStore()) {
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: dir, key, clock, self: { name: "Studio", os: "macos" } });
  return { registry, key, dir, clock, store };
}

async function peer(name = "Laptop") {
  const key = await DeviceKey.fromKey(generateEd25519());
  return { key, record: { id: key.id, name, kind: "desktop" as const, runsCore: true, computer: name, publicKey: key.publicKeyBase64 } };
}

describe("FileDeviceRegistry", () => {
  test("survives a restart, keeps no secret, and is readable by the user only", async () => {
    const { registry, dir, store } = await open();
    const p = await peer();
    await registry.add(p.record, { via: "terminal" });
    const again = await open(dir, new FakeClock(), store);
    expect(again.registry.list().map((d) => d.id).sort()).toEqual([registry.self().id, p.key.id].sort());
    const file = join(dir, "devices", "registry.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const seed = (await store.list()).length;
    expect(seed).toBe(1);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain((await store.get({ owner: { kind: "device" }, name: "device:link-key" }))!.value.reveal());
  });

  test("a registry written for another device key is refused", async () => {
    const { dir } = await open();
    expect(isContractError(await open(dir).catch((e: unknown) => e), "conflict")).toBe(true);
  });

  test("the app's answer key is taken only with its signature, and answers verify with it, not the link key", async () => {
    const { registry, key } = await open();
    const app = generateEd25519();
    const pub = toBase64(app.publicKey);
    const data = new TextEncoder().encode("clover/card-answer/1\ncard_x");
    expect(await registry.verifyAnswer(key.id, data, key.sign(data))).toBe(false);
    expect(isContractError(await registry.setOwnAnswerKey(pub, "app-keychain", key.sign(answerKeyStatement(key.id, pub, "app-keychain"))).catch((e: unknown) => e), "refused")).toBe(true);
    expect(isContractError(await registry.setOwnAnswerKey(pub, "nope" as "tpm", app.sign(answerKeyStatement(key.id, pub, "nope"))).catch((e: unknown) => e), "invalid")).toBe(true);
    await registry.setOwnAnswerKey(pub, "app-keychain", app.sign(answerKeyStatement(key.id, pub, "app-keychain")));
    expect(registry.self().answerKey).toEqual({ publicKey: pub, held: "app-keychain" });
    expect(await registry.verifyAnswer(key.id, data, app.sign(data))).toBe(true);
    expect(await registry.verifyAnswer(key.id, data, key.sign(data))).toBe(false);
  });

  test("a peer's signed update sets its answer key once; a replay or another key's signature is refused", async () => {
    const { registry, clock } = await open();
    const p = await peer();
    await registry.add(p.record, { via: "code", card: "card_1" });
    const app = generateEd25519();
    const update = { answerKey: { publicKey: toBase64(app.publicKey), held: "none" as const }, at: clock.now() + 1 };
    const other = generateEd25519();
    expect(await registry.applyPeerUpdate(p.key.id, update, other.sign(peerUpdateStatement(p.key.id, update)))).toBe(false);
    expect(await registry.applyPeerUpdate(p.key.id, update, p.key.sign(peerUpdateStatement(p.key.id, update)))).toBe(true);
    expect(registry.get(p.key.id)?.answerKey?.held).toBe("none");
    expect(await registry.applyPeerUpdate(p.key.id, update, p.key.sign(peerUpdateStatement(p.key.id, update)))).toBe(false);
    const clear = { answerKey: null, at: clock.now() + 2 };
    expect(await registry.applyPeerUpdate(p.key.id, clear, p.key.sign(peerUpdateStatement(p.key.id, clear)))).toBe(true);
    expect(registry.get(p.key.id)?.answerKey).toBeUndefined();
  });

  test("revoking ends the device's pairs, drops it from the group and lists the synced keys to rotate", async () => {
    const clock = new FakeClock();
    const store = new MemorySecretStore();
    await store.set({ owner: { kind: "core" }, name: "openai:default" }, "sk-test-not-real");
    await store.set({ owner: { kind: "plugin", pluginId: "acme.mail" }, name: "imap" }, "pw-test-not-real");
    const key = await DeviceKey.loadOrCreate(store);
    const registry = await FileDeviceRegistry.open({ home: home(), key, clock, self: { name: "Studio" }, syncedSecrets: () => store.list() });
    const p = await peer();
    await registry.add(p.record, { via: "code", card: "card_1" });
    registry.setGroup({ id: "grp_1", joinedAt: clock.now(), ownKey: "k", members: {} });
    registry.addGroupMember(p.key.id, "pk");
    registry.addPair({ pairId: "pair_1", peer: p.key.id, ownKey: "a", peerKey: "b" });
    await registry.revoke(p.key.id);
    expect(registry.pairWith(p.key.id)).toBeUndefined();
    expect(registry.pairs()[0]?.endedAt).toBeDefined();
    expect(registry.group()?.members).toEqual({});
    const [rot] = registry.rotations();
    expect(rot?.items.map((i) => `${i.owner}/${i.name}`).sort()).toEqual(["core/openai:default", "plugin:acme.mail/imap"]);
    registry.markRotated(p.key.id, "core", "openai:default");
    expect(registry.rotations()[0]?.items.find((i) => i.owner === "core")?.rotatedAt).toBeDefined();
  });

  test("a pair needs a paired peer, and a pair id is used once", async () => {
    const { registry } = await open();
    const p = await peer();
    expect(isContractError((() => { try { registry.addPair({ pairId: "x", peer: p.key.id, ownKey: "a", peerKey: "b" }); } catch (e) { return e; } })(), "not_found")).toBe(true);
    await registry.add(p.record, { via: "terminal" });
    registry.addPair({ pairId: "x", peer: p.key.id, ownKey: "a", peerKey: "b" });
    expect(isContractError((() => { try { registry.addPair({ pairId: "x", peer: p.key.id, ownKey: "a", peerKey: "b" }); } catch (e) { return e; } })(), "conflict")).toBe(true);
    registry.markPairRegistered("x");
    expect(registry.pairWith(p.key.id)?.registeredAt).toBeDefined();
  });
});
