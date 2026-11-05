// Pins the DeviceRegistry contract through FakeDeviceRegistry: real Ed25519 keys in memory, adding and revoking,
// and signatures that stop counting once a device is revoked.
import { describe, expect, test } from "bun:test";
import { DeviceId } from "@waifucave/clover-protocol";
import { isContractError } from "../common";
import { deviceIdFor, type DeviceChange } from "../device-registry";
import { FakeClock } from "../fakes/clock";
import { FakeDeviceRegistry, fromBase64, makeFakeDevice } from "../fakes/device-registry";

const data = new TextEncoder().encode("clover/card-answer/1\ncard_abcdef\n00\napprove\n5");

describe("FakeDeviceRegistry", () => {
  test("this device has its own key, and its id is derived from it", async () => {
    const { registry, device } = await FakeDeviceRegistry.create({ clock: new FakeClock(), name: "Studio", os: "macos" });
    const self = registry.self();
    expect(self).toMatchObject({ id: device.id, name: "Studio", kind: "desktop", runsCore: true, computer: "Studio", addedBy: "self" });
    expect(DeviceId.safeParse(self.id).success).toBe(true);
    expect(await deviceIdFor(fromBase64(self.publicKey))).toBe(self.id);
    expect(registry.list().map((d) => d.id)).toEqual([self.id]);
  });

  test("a paired device's signature verifies; another device's, or over other bytes, doesn't", async () => {
    const { registry } = await FakeDeviceRegistry.create({ clock: new FakeClock() });
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
    const { registry } = await FakeDeviceRegistry.create({ clock: new FakeClock() });
    const a = await makeFakeDevice();
    const b = await makeFakeDevice();
    expect(isContractError(await registry.add({ id: a.id, name: "A", kind: "phone", runsCore: false, publicKey: b.publicKey }, { via: "terminal" }).catch((e: unknown) => e), "invalid")).toBe(true);
    await registry.add({ id: a.id, name: "A", kind: "phone", runsCore: false, publicKey: a.publicKey }, { via: "terminal" });
    expect(isContractError(await registry.add({ id: a.id, name: "A", kind: "phone", runsCore: false, publicKey: a.publicKey }, { via: "terminal" }).catch((e: unknown) => e), "conflict")).toBe(true);
  });

  test("a revoked device drops out, its signatures stop counting, and it pairs again only with a new key", async () => {
    const { registry, device: self } = await FakeDeviceRegistry.create({ clock: new FakeClock() });
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

  test("rename", async () => {
    const { registry, device } = await FakeDeviceRegistry.create({ clock: new FakeClock() });
    await registry.rename(device.id, "Studio 2");
    expect(registry.self().name).toBe("Studio 2");
    expect(isContractError(await registry.rename(device.id, "").catch((e: unknown) => e), "invalid")).toBe(true);
  });
});
