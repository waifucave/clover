// The DeviceRegistry conformance suite (review S15). `runDeviceRegistryConformance(make)` registers every case against the
// implementation `make` builds; `tests/device-registry.test.ts` runs it against FakeDeviceRegistry, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// real Ed25519 keys in memory, adding and revoking,
// and signatures that stop counting once a device is revoked.
import { describe, expect, test } from "bun:test";
import { DeviceId } from "@waifucave/clover-protocol";
import { isContractError } from "../common";
import { deviceIdFor, verifyKeySignature, type DeviceChange } from "../device-registry";
import { FakeClock } from "../fakes/clock";
import { type FakeDeviceRegistry, type FakeDevice, fromBase64, makeFakeDevice } from "../fakes/device-registry";

/** What the suite drives: the contract and the fake's own drivers, as public members. */
export type DeviceRegistryHarness = Pick<FakeDeviceRegistry, keyof FakeDeviceRegistry>;
/** Builds the implementation under test, with this device's own key, from the options the fake takes. */
export type DeviceRegistryFactory = (...args: Parameters<typeof FakeDeviceRegistry.create>) => Promise<{ registry: DeviceRegistryHarness; device: FakeDevice }>;

/** Cases an implementation can run as todo until it has them: `answer-alg`, a P-256 answer key (lanes H and I). */
/** `phone-answer-key-only`: a phone answers only with its answer key, never its link key (the controller's ruling,
 *  item 91). Lane H's registry keeps it; the fake runs it as todo until lane B's follow-up (fd143e92e on
 *  lane/b-m1-followups) drops the fallback in `answerKeyOf` and gives the test phones answer keys. */
export type DeviceRegistryPendingCase = "answer-alg" | "phone-answer-key-only";

export function runDeviceRegistryConformance(make: DeviceRegistryFactory, opts: { pending?: readonly DeviceRegistryPendingCase[] } = {}): void {
  const pendingOr = (key: DeviceRegistryPendingCase) => (opts.pending?.includes(key) ? test.todo : test);
  const data = new TextEncoder().encode("clover/card-answer/1\ncard_abcdef\n00\napprove\n5");

  describe("DeviceRegistry", () => {
    test("this device has its own key, and its id is derived from it", async () => {
      const { registry, device } = await make({ clock: new FakeClock(), name: "Studio", os: "macos" });
      const self = registry.self();
      expect(self).toMatchObject({ id: device.id, name: "Studio", kind: "desktop", runsCore: true, computer: "Studio", addedBy: "self" });
      expect(DeviceId.safeParse(self.id).success).toBe(true);
      expect(await deviceIdFor(fromBase64(self.publicKey))).toBe(self.id);
      expect(registry.list().map((d) => d.id)).toEqual([self.id]);
    });

    test("a paired device's signature verifies; another device's, or over other bytes, doesn't", async () => {
      const { registry } = await make({ clock: new FakeClock() });
      const phone = await makeFakeDevice();
      const stranger = await makeFakeDevice();
      const changes: DeviceChange[] = [];
      registry.watch((c) => changes.push(c));
      const added = await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey }, { via: "code", card: "card_pair01" });
      expect(added.addedBy).toBe("code");
      const sig = await phone.sign(data);
      expect(await registry.verify(phone.id, data, sig)).toBe(true);
      expect(await registry.verify(phone.id, new TextEncoder().encode("other"), sig)).toBe(false);
      expect(await registry.verify(phone.id, data, await stranger.sign(data))).toBe(false);
      expect(await registry.verify(stranger.id, data, await stranger.sign(data))).toBe(false);
      expect(changes.map((c) => c.type)).toEqual(["added"]);
    });

    test("an id must match its key, and a device is paired once", async () => {
      const { registry } = await make({ clock: new FakeClock() });
      const a = await makeFakeDevice();
      const b = await makeFakeDevice();
      expect(isContractError(await registry.add({ id: a.id, name: "A", kind: "phone", runsCore: false, publicKey: b.publicKey }, { via: "terminal" }).catch((e: unknown) => e), "invalid")).toBe(true);
      await registry.add({ id: a.id, name: "A", kind: "phone", runsCore: false, publicKey: a.publicKey }, { via: "terminal" });
      expect(isContractError(await registry.add({ id: a.id, name: "A", kind: "phone", runsCore: false, publicKey: a.publicKey }, { via: "terminal" }).catch((e: unknown) => e), "conflict")).toBe(true);
    });

    test("a revoked device drops out, its signatures stop counting, and it pairs again only with a new key", async () => {
      const { registry, device: self } = await make({ clock: new FakeClock() });
      const laptop = await makeFakeDevice();
      await registry.add({ id: laptop.id, name: "Laptop1", kind: "desktop", runsCore: true, computer: "Laptop1", publicKey: laptop.publicKey }, { via: "account", account: "acct_1" });
      const changes: DeviceChange[] = [];
      registry.watch((c) => changes.push(c));
      await registry.revoke(laptop.id, "lost");
      expect(changes).toEqual([{ type: "revoked", id: laptop.id, reason: "lost" }]);
      expect(registry.list().map((d) => d.id)).toEqual([self.id]);
      expect(registry.get(laptop.id)?.revokedAt).toBeDefined();
      expect(await registry.verify(laptop.id, data, await laptop.sign(data))).toBe(false);
      expect(isContractError(await registry.add({ id: laptop.id, name: "Laptop1", kind: "desktop", runsCore: true, publicKey: laptop.publicKey }, { via: "terminal" }).catch((e: unknown) => e), "refused")).toBe(true);
      expect(isContractError(await registry.revoke(self.id).catch((e: unknown) => e), "refused")).toBe(true);
    });

    pendingOr("answer-alg")("an answer key verifies with its own algorithm: Ed25519 by default, P-256 when the record says so", async () => {
      const { registry } = await make({ clock: new FakeClock() });
      const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
      const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const ecPublic = b64(await crypto.subtle.exportKey("raw", ec.publicKey));
      const ecSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, data));
      const enclave = await makeFakeDevice();
      await registry.add({ id: enclave.id, name: "Laptop2", kind: "desktop", runsCore: true, computer: "Laptop2", publicKey: enclave.publicKey, answerKey: { publicKey: ecPublic, held: "secure-enclave", alg: "p256" } }, { via: "terminal" });
      expect(await registry.verifyAnswer(enclave.id, data, ecSig)).toBe(true);
      expect(await registry.verifyAnswer(enclave.id, new TextEncoder().encode("other"), ecSig)).toBe(false);
      // The same key under no `alg` (Ed25519) doesn't verify, and neither does an Ed25519 signature under `p256`.
      const relabelled = await makeFakeDevice();
      await registry.add({ id: relabelled.id, name: "Laptop3", kind: "desktop", runsCore: true, computer: "Laptop3", publicKey: relabelled.publicKey, answerKey: { publicKey: ecPublic, held: "secure-enclave" } }, { via: "terminal" });
      expect(await registry.verifyAnswer(relabelled.id, data, ecSig)).toBe(false);
    });

    pendingOr("phone-answer-key-only")("a phone's record keeps its ios; it answers only with its answer key, never its link key (no fallback)", async () => {
      const { registry } = await make({ clock: new FakeClock() });
      const phone = await makeFakeDevice();
      await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, os: "ios", publicKey: phone.publicKey }, { via: "code", card: "card_pair02" });
      expect(registry.get(phone.id)?.os).toBe("ios");
      // No answer key: its link key's signature is refused, so it answers no card (the controller's ruling, item 91;
      // lane B's follow-up, lane/b-m1-followups fd143e92e, inverts this case the same way).
      expect(await registry.verifyAnswer(phone.id, data, await phone.sign(data))).toBe(false);
      // With one, that key answers, and the link key still doesn't.
      const linked = await makeFakeDevice();
      const answers = await makeFakeDevice();
      await registry.add({ id: linked.id, name: "Phone2", kind: "phone", runsCore: false, os: "ios", publicKey: linked.publicKey, answerKey: { publicKey: answers.publicKey, held: "app-keychain" } }, { via: "code", card: "card_pair03" });
      expect(await registry.verifyAnswer(linked.id, data, await answers.sign(data))).toBe(true);
      expect(await registry.verifyAnswer(linked.id, data, await linked.sign(data))).toBe(false);
      expect(await verifyKeySignature("p256", fromBase64(answers.publicKey), data, await answers.sign(data))).toBe(false);
    });

    test("rename", async () => {
      const { registry, device } = await make({ clock: new FakeClock() });
      await registry.rename(device.id, "Studio 2");
      expect(registry.self().name).toBe("Studio 2");
      expect(isContractError(await registry.rename(device.id, "").catch((e: unknown) => e), "invalid")).toBe(true);
    });
  });
}
