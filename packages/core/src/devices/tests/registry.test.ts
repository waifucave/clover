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
import { answerKeyRotateStatement, answerKeyStatement, computerNameFor, FileDeviceRegistry, peerUpdateStatement } from "../registry";

const home = () => mkdtempSync(join(tmpdir(), "clover-h-registry-"));

runDeviceRegistryConformance(async (opts) => {
  const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
  const registry = await FileDeviceRegistry.open({
    home: home(), key, clock: opts.clock,
    self: { name: opts.name ?? "Studio", ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.os ? { os: opts.os } : {}), ...(opts.computer ? { computer: opts.computer } : {}) },
  });
  return { registry, device: { id: key.id, publicKey: key.publicKeyBase64, sign: async (d: Uint8Array) => key.sign(d) } };
}, { pending: ["answer-alg"] }); // lane H takes `alg` (a P-256 key, verified by it, and covered by `answerKeyStatement`)

describe("answer keys by algorithm (B's #187, the conformance case \"answer-alg\")", () => {
  test("an answer key verifies with its own algorithm: Ed25519 by default, P-256 when the record says so", async () => {
    const { registry } = await open();
    const data = new TextEncoder().encode("an answer");
    const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
    const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const ecPublic = b64(await crypto.subtle.exportKey("raw", ec.publicKey));
    const ecSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, data));
    const enclave = await DeviceKey.loadOrCreate(new MemorySecretStore());
    await registry.add({ id: enclave.id, name: "Laptop2", kind: "desktop", runsCore: true, computer: "Laptop2", publicKey: enclave.publicKeyBase64, answerKey: { publicKey: ecPublic, held: "secure-enclave", alg: "p256" } as never }, { via: "terminal" });
    expect(await registry.verifyAnswer(enclave.id, data, ecSig)).toBe(true);
    expect(await registry.verifyAnswer(enclave.id, new TextEncoder().encode("other"), ecSig)).toBe(false);
    const relabelled = await DeviceKey.loadOrCreate(new MemorySecretStore());
    await registry.add({ id: relabelled.id, name: "Laptop3", kind: "desktop", runsCore: true, computer: "Laptop3", publicKey: relabelled.publicKeyBase64, answerKey: { publicKey: ecPublic, held: "secure-enclave" } }, { via: "terminal" });
    expect(await registry.verifyAnswer(relabelled.id, data, ecSig)).toBe(false);
  });
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

  test("a computer's tree name follows its name, in the form the tree takes", async () => {
    const { registry, key } = await open();
    await registry.rename(key.id, "Studio 2 (Mac)");
    expect(registry.self()).toMatchObject({ name: "Studio 2 (Mac)", computer: "Studio-2-Mac" });
    expect(computerNameFor("  ~~ ")).toBe("");
    expect(computerNameFor("Café Laptop")).toBe("Cafe-Laptop");
  });

  test("every computer has its tree name; a phone has none", async () => {
    const { registry } = await open();
    expect(registry.self().computer).toBe("Studio");
    const p = await peer("Laptop");
    const { computer: _c, ...noName } = p.record;
    expect((await registry.add(noName, { via: "terminal" })).computer).toBe("Laptop");
    const phone = await DeviceKey.fromKey(generateEd25519());
    expect((await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKeyBase64 }, { via: "terminal" })).computer).toBeUndefined();
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

  test("a peer's first answer key needs the app's own registration of it; a replay or another key's signature is refused", async () => {
    const { registry, clock } = await open();
    const p = await peer();
    await registry.add(p.record, { via: "code", card: "card_1" });
    const app = generateEd25519();
    const pub = toBase64(app.publicKey);
    const update = { answerKey: { publicKey: pub, held: "none" as const }, at: clock.now() + 1 };
    const proof = { registration: toBase64(app.sign(answerKeyStatement(p.key.id, pub, "none"))), rotations: [] };
    const other = generateEd25519();
    expect(await registry.applyPeerUpdate(p.key.id, update, other.sign(peerUpdateStatement(p.key.id, update)), proof)).toBe(false);
    // The link key alone can't put a key in (B1 of H-M1's review): no registration, or one the link key signed.
    expect(await registry.applyPeerUpdate(p.key.id, update, p.key.sign(peerUpdateStatement(p.key.id, update)))).toBe(false);
    const linkSigned = { registration: toBase64(p.key.sign(answerKeyStatement(p.key.id, pub, "none"))), rotations: [] };
    expect(await registry.applyPeerUpdate(p.key.id, update, p.key.sign(peerUpdateStatement(p.key.id, update)), linkSigned)).toBe(false);
    expect(await registry.applyPeerUpdate(p.key.id, update, p.key.sign(peerUpdateStatement(p.key.id, update)), proof)).toBe(true);
    expect(registry.get(p.key.id)?.answerKey?.held).toBe("none");
    expect(await registry.applyPeerUpdate(p.key.id, update, p.key.sign(peerUpdateStatement(p.key.id, update)), proof)).toBe(false);
  });

  test("a peer's answer key changes only with the current key's signature handing over to the new one", async () => {
    const { registry, clock } = await open();
    const p = await peer();
    await registry.add(p.record, { via: "code", card: "card_1" });
    const first = generateEd25519();
    const firstPub = toBase64(first.publicKey);
    const u1 = { answerKey: { publicKey: firstPub, held: "app-keychain" as const }, at: clock.now() + 1 };
    expect(await registry.applyPeerUpdate(p.key.id, u1, p.key.sign(peerUpdateStatement(p.key.id, u1)), { registration: toBase64(first.sign(answerKeyStatement(p.key.id, firstPub, "app-keychain"))), rotations: [] })).toBe(true);
    // Code beside the peer's core, holding its link key, makes a key of its own and registers it (the review's probe).
    const forged = generateEd25519();
    const forgedPub = toBase64(forged.publicKey);
    const u2 = { answerKey: { publicKey: forgedPub, held: "app-keychain" as const }, at: clock.now() + 2 };
    const forgedReg = toBase64(forged.sign(answerKeyStatement(p.key.id, forgedPub, "app-keychain")));
    expect(await registry.applyPeerUpdate(p.key.id, u2, p.key.sign(peerUpdateStatement(p.key.id, u2)), { registration: forgedReg, rotations: [] })).toBe(false);
    const linkRotation = { from: firstPub, to: forgedPub, at: 5, signature: toBase64(p.key.sign(answerKeyRotateStatement(p.key.id, firstPub, forgedPub, 5))) };
    expect(await registry.applyPeerUpdate(p.key.id, u2, p.key.sign(peerUpdateStatement(p.key.id, u2)), { registration: forgedReg, rotations: [linkRotation] })).toBe(false);
    const data = new TextEncoder().encode("any card answer");
    expect(await registry.verifyAnswer(p.key.id, data, forged.sign(data))).toBe(false);
    // The app's own hand-over, signed by the key it replaces, is taken.
    const next = generateEd25519();
    const nextPub = toBase64(next.publicKey);
    const u3 = { answerKey: { publicKey: nextPub, held: "app-keychain" as const }, at: clock.now() + 3 };
    const rotation = { from: firstPub, to: nextPub, at: 7, signature: toBase64(first.sign(answerKeyRotateStatement(p.key.id, firstPub, nextPub, 7))) };
    expect(await registry.applyPeerUpdate(p.key.id, u3, p.key.sign(peerUpdateStatement(p.key.id, u3)), { registration: toBase64(next.sign(answerKeyStatement(p.key.id, nextPub, "app-keychain"))), rotations: [rotation] })).toBe(true);
    expect(await registry.verifyAnswer(p.key.id, data, next.sign(data))).toBe(true);
    expect(await registry.verifyAnswer(p.key.id, data, first.sign(data))).toBe(false);
  });

  test("removing a peer's answer key takes only its link key, and then no new first key is taken", async () => {
    const { registry, clock } = await open();
    const p = await peer();
    await registry.add(p.record, { via: "code", card: "card_1" });
    const app = generateEd25519();
    const pub = toBase64(app.publicKey);
    const u1 = { answerKey: { publicKey: pub, held: "none" as const }, at: clock.now() + 1 };
    await registry.applyPeerUpdate(p.key.id, u1, p.key.sign(peerUpdateStatement(p.key.id, u1)), { registration: toBase64(app.sign(answerKeyStatement(p.key.id, pub, "none"))), rotations: [] });
    const clear = { answerKey: null, at: clock.now() + 2 };
    expect(await registry.applyPeerUpdate(p.key.id, clear, p.key.sign(peerUpdateStatement(p.key.id, clear)))).toBe(true);
    expect(registry.get(p.key.id)?.answerKey).toBeUndefined();
    // Remove-then-register would get round the hand-over rule: a device whose key went must pair again.
    const again = generateEd25519();
    const againPub = toBase64(again.publicKey);
    const u2 = { answerKey: { publicKey: againPub, held: "none" as const }, at: clock.now() + 3 };
    expect(await registry.applyPeerUpdate(p.key.id, u2, p.key.sign(peerUpdateStatement(p.key.id, u2)), { registration: toBase64(again.sign(answerKeyStatement(p.key.id, againPub, "none"))), rotations: [] })).toBe(false);
  });

  test("this device's own answer key changes only by its hand-over, and after a removal not at all", async () => {
    const { registry, key } = await open();
    const first = generateEd25519();
    const firstPub = toBase64(first.publicKey);
    await registry.setOwnAnswerKey(firstPub, "app-keychain", first.sign(answerKeyStatement(key.id, firstPub, "app-keychain")));
    const next = generateEd25519();
    const nextPub = toBase64(next.publicKey);
    const reg = next.sign(answerKeyStatement(key.id, nextPub, "app-keychain"));
    expect(isContractError(await registry.setOwnAnswerKey(nextPub, "app-keychain", reg).catch((e: unknown) => e), "refused")).toBe(true);
    expect(isContractError(await registry.setOwnAnswerKey(nextPub, "app-keychain", reg, { from: firstPub, at: 3, signature: key.sign(answerKeyRotateStatement(key.id, firstPub, nextPub, 3)) }).catch((e: unknown) => e), "refused")).toBe(true);
    await registry.setOwnAnswerKey(nextPub, "app-keychain", reg, { from: firstPub, at: 3, signature: first.sign(answerKeyRotateStatement(key.id, firstPub, nextPub, 3)) });
    expect(registry.ownAnswerKeyProof()?.rotations).toHaveLength(1);
    registry.clearOwnAnswerKey();
    expect(isContractError(await registry.setOwnAnswerKey(firstPub, "app-keychain", first.sign(answerKeyStatement(key.id, firstPub, "app-keychain"))).catch((e: unknown) => e), "refused")).toBe(true);
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

  test("tree names pass lane J's rules and stay unique ignoring case, with -2 on a collision (S4)", async () => {
    const { registry } = await open();
    const a = await peer("studio");
    const b = await peer("Laptop");
    const c = await peer("Server");
    // This device is "Studio": a peer naming itself "studio" becomes "studio-2" here.
    await registry.add({ ...a.record, computer: "studio" }, { via: "terminal" });
    expect(registry.get(a.key.id)?.computer).toBe("studio-2");
    // A name lane J refuses (a Windows device name, a space) is made into one it takes.
    await registry.add({ ...b.record, name: "My Laptop", computer: "CON" }, { via: "terminal" });
    expect(registry.get(b.key.id)?.computer).toBe("Computer");
    await registry.add({ ...c.record, name: "Server box", computer: "Server box" }, { via: "terminal" });
    expect(registry.get(c.key.id)?.computer).toBe("Server-box");
    // A peer's update to a name another computer holds gets the suffix too; an invalid one is refused.
    const u = { name: "Laptop", computer: "Server-box", at: Date.now() };
    expect(await registry.applyPeerUpdate(b.key.id, u, b.key.sign(peerUpdateStatement(b.key.id, u)))).toBe(true);
    expect(registry.get(b.key.id)?.computer).toBe("Server-box-2");
    const bad = { computer: "nul", at: Date.now() + 1 };
    expect(await registry.applyPeerUpdate(b.key.id, bad, b.key.sign(peerUpdateStatement(b.key.id, bad)))).toBe(false);
  });
});
