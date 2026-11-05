// Pins the SecretStore contract through MemorySecretStore: values leave only through `get`, wrapped; nothing else
// carries one; owners are separate; a locked store answers `locked`.
import { describe, expect, test } from "bun:test";
import { isContractError } from "../common";
import { FakeClock } from "../fakes/clock";
import { MemorySecretStore } from "../fakes/secret-store";
import { Secret, secretTokenSource, type SecretChange, type SecretRef } from "../secret-store";

// Built at run time, so no secret-looking literal sits in a fixture.
const VALUE = ["sk", "test", Math.random().toString(36).slice(2)].join("-");
const core = (name: string): SecretRef => ({ owner: { kind: "core" }, name });
const plugin = (pluginId: string, name: string): SecretRef => ({ owner: { kind: "plugin", pluginId }, name });

describe("MemorySecretStore", () => {
  test("a write gives a new generation, and get returns the value wrapped", async () => {
    const store = new MemorySecretStore({ clock: new FakeClock() });
    const first = await store.set(core("anthropic:default"), VALUE);
    expect(first.generation).toBe(1);
    expect(first.synced).toBe(true);
    const second = await store.set(core("anthropic:default"), `${VALUE}-rotated`);
    expect(second.generation).toBe(2);
    const got = await store.get(core("anthropic:default"));
    expect(got?.generation).toBe(2);
    expect(got?.value.reveal()).toBe(`${VALUE}-rotated`);
    expect(await store.get(core("missing"))).toBeNull();
  });

  test("a Secret never prints its value", async () => {
    const s = new Secret(VALUE);
    expect(JSON.stringify({ s })).toBe('{"s":"[secret]"}');
    expect(String(s)).toBe("[secret]");
    expect(`${s}`).toBe("[secret]");
    expect(Bun.inspect(s)).not.toContain(VALUE);
    expect(s.length).toBe(VALUE.length);
  });

  test("list, watch and errors never carry a value", async () => {
    const store = new MemorySecretStore();
    const changes: SecretChange[] = [];
    store.watch((c) => changes.push(c));
    await store.set(plugin("fish-audio", "FISH_KEY"), VALUE);
    await store.delete(plugin("fish-audio", "FISH_KEY"));
    await store.set(core("x"), VALUE);
    expect(JSON.stringify(await store.list())).not.toContain(VALUE);
    expect(JSON.stringify(changes)).not.toContain(VALUE);
    expect(changes.map((c) => ("meta" in c ? c.deleted : "status"))).toEqual([false, true, false]);
    store.lock("no unlocked keyring");
    const err = await store.get(core("x")).catch((e: unknown) => e);
    expect(isContractError(err, "locked")).toBe(true);
    expect(String((err as Error).message)).not.toContain(VALUE);
  });

  test("owners are separate: a plugin's name never reaches another plugin's or the core's item", async () => {
    const store = new MemorySecretStore();
    await store.set(plugin("luna", "TOKEN"), VALUE);
    expect(await store.get(plugin("weather", "TOKEN"))).toBeNull();
    expect(await store.get(core("TOKEN"))).toBeNull();
    expect((await store.list({ kind: "plugin", pluginId: "luna" })).map((m) => m.ref.name)).toEqual(["TOKEN"]);
    expect(await store.list({ kind: "plugin", pluginId: "weather" })).toEqual([]);
  });

  test("the device's own items never sync", async () => {
    const store = new MemorySecretStore();
    const meta = await store.set({ owner: { kind: "device" }, name: "device-key" }, VALUE, { synced: true });
    expect(meta.synced).toBe(false);
    expect((await store.set(core("local-only"), VALUE, { synced: false })).synced).toBe(false);
  });

  test("a locked store refuses reads and writes until unlocked, and says so to watchers", async () => {
    const store = new MemorySecretStore({ locked: "no unlocked keyring" });
    expect(store.status()).toEqual({ backend: "memory", state: "locked", reason: "no unlocked keyring" });
    expect(isContractError(await store.set(core("a"), VALUE).catch((e: unknown) => e), "locked")).toBe(true);
    const seen: SecretChange[] = [];
    store.watch((c) => seen.push(c));
    store.unlock();
    expect(seen).toEqual([{ status: { backend: "memory", state: "unlocked" } }]);
    expect((await store.set(core("a"), VALUE)).generation).toBe(1);
  });

  test("a token source hands out generations: the current one, then after a 401 only a newer one", async () => {
    const store = new MemorySecretStore({ clock: new FakeClock() });
    const ref = plugin("weather", "api_token");
    const refreshed: number[] = [];
    const source = secretTokenSource(store, ref, async (g) => {
      refreshed.push(g);
      await store.set(ref, `${VALUE}-${g + 1}`);
    });
    expect(await source.current()).toBeNull();
    await store.set(ref, VALUE);
    const first = await source.current();
    expect(first?.generation).toBe(1);
    expect(String(first?.value)).toBe("[secret]");
    // The refused generation is the stored one: the refresher writes a newer one.
    const next = await source.newer(1);
    expect(next?.generation).toBe(2);
    expect(next?.value.reveal()).toBe(`${VALUE}-2`);
    expect(refreshed).toEqual([1]);
    // Someone already wrote a newer one: no refresh needed.
    await store.set(ref, `${VALUE}-3`);
    expect((await source.newer(2))?.generation).toBe(3);
    expect(refreshed).toEqual([1]);
    // An API key has no refresher: a 401 is the answer.
    expect(await secretTokenSource(store, ref).newer(3)).toBeNull();
  });

  test("names are checked", async () => {
    const store = new MemorySecretStore();
    expect(isContractError(await store.set(core("has space"), VALUE).catch((e: unknown) => e), "invalid")).toBe(true);
    expect(isContractError(await store.set(core("x".repeat(129)), VALUE).catch((e: unknown) => e), "invalid")).toBe(true);
  });
});
