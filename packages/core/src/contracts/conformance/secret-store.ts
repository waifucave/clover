// The SecretStore conformance suite (review S15). `runSecretStoreConformance(make)` registers every case against the
// implementation `make` builds; `tests/secret-store.test.ts` runs it against MemorySecretStore, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// values leave only through `get`, wrapped; nothing else
// carries one; owners are separate; a locked store answers `locked`.
import { describe, expect, test } from "bun:test";
import { isContractError } from "../common";
import { FakeClock } from "../fakes/clock";
import { type MemorySecretStore } from "../fakes/secret-store";
import {
  ACCOUNT_TOKEN_MAX_MS, ACCOUNT_TOKEN_RENEW_BEFORE_MS, Secret, encryptedFileStatus, mintedTokenSource, secretKeySourceFor,
  secretTokenSource, type KeyStoreProbe, type SecretChange, type SecretRef,
} from "../secret-store";

/** What the suite drives: the contract and the fake's own drivers (what a test does to the world around it),
 *  as public members, so a real implementation's harness can provide them. */
export type SecretStoreHarness = Pick<MemorySecretStore, keyof MemorySecretStore>;
/** Builds the implementation under test from the options the fake takes. */
export type SecretStoreFactory = (...args: ConstructorParameters<typeof MemorySecretStore>) => SecretStoreHarness;

export function runSecretStoreConformance(make: SecretStoreFactory): void {
  // Built at run time, so no secret-looking literal sits in a fixture.
  const VALUE = ["sk", "test", Math.random().toString(36).slice(2)].join("-");
  const core = (name: string): SecretRef => ({ owner: { kind: "core" }, name });
  const plugin = (pluginId: string, name: string): SecretRef => ({ owner: { kind: "plugin", pluginId }, name });

  describe("SecretStore", () => {
    test("a write gives a new generation, and get returns the value wrapped", async () => {
      const store = make({ clock: new FakeClock() });
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
      const store = make();
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
      const store = make();
      await store.set(plugin("luna", "TOKEN"), VALUE);
      expect(await store.get(plugin("weather", "TOKEN"))).toBeNull();
      expect(await store.get(core("TOKEN"))).toBeNull();
      expect((await store.list({ kind: "plugin", pluginId: "luna" })).map((m) => m.ref.name)).toEqual(["TOKEN"]);
      expect(await store.list({ kind: "plugin", pluginId: "weather" })).toEqual([]);
    });

    test("the device's own items never sync", async () => {
      const store = make();
      const meta = await store.set({ owner: { kind: "device" }, name: "device-key" }, VALUE, { synced: true });
      expect(meta.synced).toBe(false);
      expect((await store.set(core("local-only"), VALUE, { synced: false })).synced).toBe(false);
    });

    test("a locked store refuses reads and writes until unlocked, and says so to watchers", async () => {
      const store = make({ locked: "no unlocked keyring" });
      expect(store.status()).toEqual({ backend: "memory", plaintext: false, state: "locked", reason: "no unlocked keyring" });
      expect(isContractError(await store.set(core("a"), VALUE).catch((e: unknown) => e), "locked")).toBe(true);
      const seen: SecretChange[] = [];
      store.watch((c) => seen.push(c));
      store.unlock();
      expect(seen).toEqual([{ status: { backend: "memory", plaintext: false, state: "unlocked" } }]);
      expect((await store.set(core("a"), VALUE)).generation).toBe(1);
    });

    test("a token source hands out generations: the current one, then after a 401 only a newer one", async () => {
      const store = make({ clock: new FakeClock() });
      const ref = plugin("weather", "api_token");
      const refreshed: number[] = [];
      const source = secretTokenSource(store, ref, async (g) => {
        refreshed.push(g);
        await store.set(ref, `${VALUE}-${g + 1}`);
      });
      expect(await source.current("api.example.com")).toBeNull();
      await store.set(ref, VALUE);
      const first = await source.current("api.example.com");
      expect(first?.generation).toBe(1);
      expect(String(first?.value)).toBe("[secret]");
      // The refused generation is the stored one: the refresher writes a newer one.
      const next = await source.newer(1, "api.example.com");
      expect(next?.generation).toBe(2);
      expect(next?.value.reveal()).toBe(`${VALUE}-2`);
      expect(refreshed).toEqual([1]);
      // Someone already wrote a newer one: no refresh needed.
      await store.set(ref, `${VALUE}-3`);
      expect((await source.newer(2, "api.example.com"))?.generation).toBe(3);
      expect(refreshed).toEqual([1]);
      // An API key has no refresher: a 401 is the answer.
      expect(await secretTokenSource(store, ref).newer(3, "api.example.com")).toBeNull();
    });

    test("the account token is minted per audience, cached per host, at most 5 minutes, and minted afresh after a 401", async () => {
      const clock = new FakeClock();
      const minted: string[] = [];
      const source = mintedTokenSource(async (aud) => {
        minted.push(aud);
        return { value: new Secret(`${VALUE}:${aud}:${minted.length}`), expiresAt: clock.now() + ACCOUNT_TOKEN_MAX_MS };
      }, clock);
      const hooks = await source.current("hooks.waifucave.com");
      const push = await source.current("push.waifucave.com");
      expect(hooks?.value.reveal()).toContain(":hooks.waifucave.com:");
      expect(push?.value.reveal()).toContain(":push.waifucave.com:");
      expect((await source.current("hooks.waifucave.com"))?.generation).toBe(hooks?.generation);
      expect(minted).toEqual(["hooks.waifucave.com", "push.waifucave.com"]);
      // Shortly before it expires, a new one is minted.
      clock.advance(ACCOUNT_TOKEN_MAX_MS - ACCOUNT_TOKEN_RENEW_BEFORE_MS);
      expect((await source.current("hooks.waifucave.com"))!.generation).toBeGreaterThan(hooks!.generation);
      // After a 401, a newer one for that host alone.
      const before = minted.length;
      const again = await source.newer((await source.current("push.waifucave.com"))!.generation, "push.waifucave.com");
      expect(minted.length).toBe(before + 2);
      expect(again?.value.reveal()).toContain(":push.waifucave.com:");
      // A token that would live too long is refused.
      const greedy = mintedTokenSource(async () => ({ value: new Secret(VALUE), expiresAt: clock.now() + ACCOUNT_TOKEN_MAX_MS + 1 }), clock);
      expect(await greedy.current("hooks.waifucave.com")).toBeNull();
    });

    test("a headless computer never waits locked: systemd-creds where it works, else a key file labelled plaintext", () => {
      const linux = (over: Partial<KeyStoreProbe>): KeyStoreProbe => ({ os: "linux", secretService: "absent", interactive: false, systemdCreds: false, tpm: false, ...over });
      expect(secretKeySourceFor({ os: "windows", interactive: true, systemdCreds: false, tpm: true })).toEqual({ source: "credential-manager", tpm: false });
      expect(secretKeySourceFor(linux({ secretService: "unlocked", interactive: true }))).toEqual({ source: "secret-service", tpm: false });
      // A desktop keyring someone can unlock: the store waits locked.
      expect(secretKeySourceFor(linux({ secretService: "locked", interactive: true }))).toHaveProperty("locked");
      // A server or cloud computer with a locked or missing keyring falls back and runs on.
      expect(secretKeySourceFor(linux({ secretService: "locked", systemdCreds: true, tpm: true }))).toEqual({ source: "systemd-creds", tpm: true });
      expect(secretKeySourceFor(linux({ systemdCreds: true }))).toEqual({ source: "systemd-creds", tpm: false });
      expect(secretKeySourceFor(linux({}))).toEqual({ source: "key-file", tpm: false });
      // The label reaches Settings through the status (ComputerView.secrets).
      expect(encryptedFileStatus("key-file")).toEqual({ backend: "encrypted-file", keySource: "key-file", plaintext: true, state: "unlocked" });
      expect(encryptedFileStatus("systemd-creds", true)).toEqual({ backend: "encrypted-file", keySource: "systemd-creds", tpm: true, plaintext: false, state: "unlocked" });
      const store = make({ status: encryptedFileStatus("key-file") });
      expect(store.status().plaintext).toBe(true);
      store.lock("held for the test");
      expect(store.status()).toMatchObject({ keySource: "key-file", plaintext: true, state: "locked" });
    });

    test("names are checked", async () => {
      const store = make();
      expect(isContractError(await store.set(core("has space"), VALUE).catch((e: unknown) => e), "invalid")).toBe(true);
      expect(isContractError(await store.set(core("x".repeat(129)), VALUE).catch((e: unknown) => e), "invalid")).toBe(true);
    });
  });
}
