// This desktop's answer key (decision 91, lane H's ask): made once and kept in the OS's protected store, registered
// with the core under the app's signature over lane H's statement, and never written down in the clear. The tests use
// a vault in memory and a stand-in for safeStorage: never the real Keychain, Credential Manager or Secret Service.
import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_ERR, RpcCallError } from "../src/main/protocol/client";
import { AnswerKey, answerKeyRotateStatement, answerKeyStatement, memoryVault, safeStorageVault, type SafeStorageLike } from "../src/main/answer-key";
import { CloverApprovalBroker } from "../../../packages/core/src/approvals/broker";
import { FakeClock } from "../../../packages/core/src/contracts/fakes/clock";
import { MemorySecretStore } from "../../../packages/core/src/contracts/fakes/secret-store";
import { answerKeyRotateStatement as coreRotateStatement, FileDeviceRegistry } from "../../../packages/core/src/devices/registry";
import { devicesMethods, type DevicesMethodsDeps } from "../../../packages/core/src/devices/rpc";
import { DeviceKey } from "../../../packages/core/src/identity/device-key";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const verifier = (publicKey: string) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey, "base64")]), format: "der", type: "spki" });

/** A stand-in for safeStorage: what it writes isn't the plain text. */
const fakeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from([...Buffer.from(plain)].map((b) => b ^ 0x5a)),
  decryptString: (enc) => Buffer.from([...enc].map((b) => b ^ 0x5a)).toString(),
};

describe("the answer key", () => {
  test("registered with the core under the app's signature over lane H's statement", async () => {
    const key = new AnswerKey(memoryVault("app-keychain"));
    const calls: { method: string; params: { publicKey: string; held: string; signature: string } }[] = [];
    const client = { request: async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: params as never });
      return { ok: true } as T;
    } };
    const ok = await key.register(client, "dev_laptop");
    expect(ok).toBe(true);
    const p = calls[0]!.params;
    expect(calls[0]!.method).toBe("device.answerKey.set");
    expect(p.held).toBe("app-keychain");
    expect(Buffer.from(p.publicKey, "base64")).toHaveLength(32);
    expect(verify(null, Buffer.from(answerKeyStatement("dev_laptop", p.publicKey, "app-keychain")), verifier(p.publicKey), Buffer.from(p.signature, "base64"))).toBe(true);
    // The statement is lane H's, byte for byte.
    expect(new TextDecoder().decode(answerKeyStatement("dev_laptop", "AAAA", "none"))).toBe("clover/answer-key/1\ndev_laptop\nAAAA\nnone");
  });

  test("made once and kept: the same key across starts; the file holds only what the OS's key encrypted", () => {
    const file = join(mkdtempSync(join(tmpdir(), "clover-answer-key-")), "answer-key");
    const first = new AnswerKey(safeStorageVault(file, fakeStorage, "darwin")).publicKey();
    const again = new AnswerKey(safeStorageVault(file, fakeStorage, "darwin")).publicKey();
    expect(again).toBe(first);
    const raw = readFileSync(file);
    // Not the key's base64, nor its DER.
    expect(raw.toString()).not.toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(raw.includes(Buffer.from("302e020100300506032b6570", "hex"))).toBe(false);
  });

  test("only macOS's Keychain keeps it from plugin code; elsewhere the core hears so", () => {
    expect(safeStorageVault("/x", fakeStorage, "darwin").held).toBe("app-keychain");
    expect(safeStorageVault("/x", fakeStorage, "win32").held).toBe("none");
    expect(safeStorageVault("/x", fakeStorage, "linux").held).toBe("none");
  });

  test("the user is never asked for their presence or identity to hold or to use the key (the owner's decision, E-M2)", () => {
    // The holder names: none of them is a prompt-gated one on this side; a Windows Hello key credential and a TPM or
    // Secure Enclave key with a user-presence ACL would ask. What the app holds is safeStorage's Keychain item / DPAPI
    // / Secret Service, which keep it at rest with no ACL, and the stores' names for the core stay honest above.
    const labels = (["darwin", "win32", "linux"] as const).map((p) => safeStorageVault("/x", fakeStorage, p).held);
    expect(labels).not.toContain("hello");
    expect(labels).not.toContain("tpm");
    // Loading, saving (over a made key) and signing stay free of anything the OS would ask about.
    const file = join(mkdtempSync(join(tmpdir(), "clover-answer-key-")), "answer-key");
    const vault = safeStorageVault(file, fakeStorage, "win32");
    const key = new AnswerKey(vault);
    expect(key.sign(new Uint8Array([1, 2, 3]))).toHaveLength(64);
    vault.save(new Uint8Array(key.sign(new Uint8Array([4]))));
    expect(key.publicKey()).toHaveLength(44);
    expect(vault.held).toBe("none");
  });

  test("a core that refuses (an older one, a device that isn't a desktop) is said and not fatal; nothing secret in the line", async () => {
    const lines: string[] = [];
    const key = new AnswerKey(memoryVault(), (l) => lines.push(l));
    expect(await key.register({ request: async () => { throw new Error("no device.answerKey.set"); } }, "dev_x")).toBe(false);
    expect(lines).toEqual(["answer key: not registered (no device.answerKey.set)"]);
    expect(lines.join("\n")).not.toContain(key.publicKey().slice(0, 12));
  });
});

describe("replacing the answer key, against the core's own handler", () => {
  async function core() {
    const clock = new FakeClock();
    const device = await DeviceKey.loadOrCreate(new MemorySecretStore());
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-e-akr-")), key: device, clock, self: { name: "Studio", os: "macos" } });
    const broker = new CloverApprovalBroker({ clock });
    const m = devicesMethods({ registry, clock, answerKeyRotation: () => ({ broker, computer: "Studio" }) } as unknown as DevicesMethodsDeps);
    const hooks: {
      beforeCardGet?: () => Promise<void>;
      lose?: (method: string, params: unknown) => boolean;
      onSet?: (params: { publicKey: string }) => Promise<"timeout" | undefined>;
    } = {};
    // The app's client: device.answerKey.set through the core's handler, card.get from the broker (lane C's method).
    const client = {
      request: async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === "card.get") {
          await hooks.beforeCardGet?.();
          const r = broker.get((params as { id: string }).id);
          if (!r) throw new RpcCallError(-32004, `no card ${(params as { id: string }).id}`);
          return { card: r.card, ...(r.outcome ? { outcome: r.outcome } : {}) } as T;
        }
        if (method === "device.answerKey.set" && hooks.onSet && (await hooks.onSet(params as { publicKey: string })) === "timeout") {
          throw new RpcCallError(CLIENT_ERR.TIMEOUT, `${method} took longer than 10000 ms`);
        }
        if (hooks.lose?.(method, params)) {
          await m[method]!(params, { caller: { kind: "user", client: "app" } }).catch(() => undefined);
          throw new RpcCallError(CLIENT_ERR.TIMEOUT, `${method} took longer than 15000 ms`);
        }
        return (await m[method]!(params, { caller: { kind: "user", client: "app" } })) as T;
      },
    };
    const answer = (card: string, optionId: "approve" | "deny") => {
      const c = broker.get(card)!.card;
      return broker.answer(card, { optionId, hash: c.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card)!, input: "click", at: clock.now() } }, { role: "app" });
    };
    const held = () => registry.self().answerKey?.publicKey;
    const waitHeld = async (key: string) => {
      for (let i = 0; i < 200 && held() !== key; i++) await Bun.sleep(5);
      expect(held()).toBe(key);
    };
    return { clock, id: device.id, registry, broker, client, answer, held, waitHeld, hooks, now: () => clock.now() };
  }

  /** A staged key's public half, as the core sees it. */
  const stagedPublic = (vault: ReturnType<typeof memoryVault>) => {
    const st = vault.loadStaged()!;
    const der = createPublicKey(createPrivateKey({ key: Buffer.from(st.secret), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
    return Buffer.from(der.subarray(der.length - 32)).toString("base64");
  };

  test("the hand-over statement is lane H's, byte for byte", () => {
    expect(Buffer.from(answerKeyRotateStatement("dev", "AAAA", "BBBB", 7))).toEqual(Buffer.from(coreRotateStatement("dev", "AAAA", "BBBB", 7)));
  });

  test("the new key is staged before the ask; the card's yes promotes it, and a restart reads it", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    expect(await key.register(c.client, c.id)).toBe(true);
    const first = key.publicKey();
    const started = await key.rotate(c.client, c.id, c.clock.now());
    expect(started).toEqual({ card: expect.any(String) });
    const card = (started as { card: string }).card;
    // Staged, naming its card, before any yes; the current key still signs and stays registered.
    expect(vault.loadStaged()?.card).toBe(card);
    expect(key.pendingCard).toBe(card);
    expect(key.publicKey()).toBe(first);
    expect(c.held()).toBe(first);
    expect(await c.answer(card, "approve")).toBe("accepted");
    expect(await key.resolved(c.client, c.id, card, "approved")).toBe(true);
    const next = key.publicKey();
    expect(next).not.toBe(first);
    expect(c.held()).toBe(next);
    expect(vault.loadStaged()).toBeUndefined();
    const again = new AnswerKey(vault, undefined, { now: c.now });
    expect(again.publicKey()).toBe(next);
    expect(await again.register(c.client, c.id)).toBe(true);
  });

  test("a crash after the yes, or a yes on the phone while the app was away: the next connection adopts the staged key", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const before = new AnswerKey(vault, undefined, { now: c.now });
    await before.register(c.client, c.id);
    const { card } = (await before.rotate(c.client, c.id, c.clock.now())) as { card: string };
    const staged = stagedPublic(vault);
    // The yes comes while the app isn't there to see card_resolved (it crashed, or was offline).
    expect(await c.answer(card, "approve")).toBe("accepted");
    await c.waitHeld(staged);
    // A new start (the old instance is gone), on its next connection: the core holds the staged key, which is taken.
    const after = new AnswerKey(vault, undefined, { now: c.now });
    expect(await after.register(c.client, c.id)).toBe(true);
    expect(after.publicKey()).toBe(staged);
    expect(vault.loadStaged()).toBeUndefined();
    // And the same instance, reconnecting after missing the event, adopts it the same way.
    const c2 = await core();
    const v2 = memoryVault("app-keychain");
    const k2 = new AnswerKey(v2, undefined, { now: c2.now });
    await k2.register(c2.client, c2.id);
    const r2 = (await k2.rotate(c2.client, c2.id, c2.clock.now())) as { card: string };
    const s2 = stagedPublic(v2);
    await c2.answer(r2.card, "approve");
    await c2.waitHeld(s2);
    expect(await k2.register(c2.client, c2.id)).toBe(true);
    expect(k2.publicKey()).toBe(s2);
  });

  test("a vault that can't store the new key fails the rotation: no card, nothing changes", async () => {
    const c = await core();
    const vault = { ...memoryVault("app-keychain"), saveStaged: () => { throw new Error("store unavailable"); } };
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    const first = key.publicKey();
    expect(await key.rotate(c.client, c.id, c.clock.now())).toEqual({ refused: expect.stringContaining("couldn't be stored") });
    expect(c.broker.cards()).toEqual([]);
    expect(c.held()).toBe(first);
    expect(key.publicKey()).toBe(first);
  });

  test("a no, or another card's outcome, keeps the current key and discards the staged one", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    const first = key.publicKey();
    const { card } = (await key.rotate(c.client, c.id, c.clock.now())) as { card: string };
    expect(await key.resolved(c.client, c.id, "card_someotherone", "approved")).toBe(false);
    expect(key.pendingCard).toBe(card);
    expect(await c.answer(card, "deny")).toBe("accepted");
    expect(await key.resolved(c.client, c.id, card, "denied")).toBe(false);
    expect(vault.loadStaged()).toBeUndefined();
    expect(key.publicKey()).toBe(first);
    expect(c.held()).toBe(first);
  });

  test("an orphaned card expires after 10 minutes; the next connection discards the staged key", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    const first = key.publicKey();
    const { card } = (await key.rotate(c.client, c.id, c.clock.now())) as { card: string };
    c.clock.advance(10 * 60 * 1000);
    for (let i = 0; i < 100 && c.broker.get(card)?.outcome === undefined; i++) await Bun.sleep(5);
    expect(c.broker.get(card)?.outcome).toBe("cancelled");
    // The app restarts having missed it: its next connection finds the card over and drops the staged key.
    const after = new AnswerKey(vault, undefined, { now: c.now });
    expect(await after.register(c.client, c.id)).toBe(true);
    expect(vault.loadStaged()).toBeUndefined();
    expect(after.publicKey()).toBe(first);
    expect(c.held()).toBe(first);
  });

  test("a hand-over the core refuses (a stale one) is said, shows no card, and leaves nothing staged", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    const first = key.publicKey();
    const r = await key.rotate(c.client, c.id, c.clock.now() - 60 * 60 * 1000);
    expect(r).toEqual({ refused: expect.stringContaining("too old") });
    expect(vault.loadStaged()).toBeUndefined();
    expect(key.publicKey()).toBe(first);
    expect(c.broker.cards()).toEqual([]);
  });

  test("a lost reply keeps the new key staged: the card the core showed anyway, once approved, is adopted", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    // The core takes the request and shows its card; the reply never reaches the app.
    c.hooks.lose = (method, params) => method === "device.answerKey.set" && (params as { rotation?: unknown }).rotation !== undefined;
    expect(await key.rotate(c.client, c.id, c.clock.now())).toEqual({ refused: expect.stringContaining("took longer") });
    c.hooks.lose = undefined;
    expect(vault.loadStaged()).toBeDefined();
    const [card] = c.broker.cards();
    expect(card).toBeDefined();
    const staged = stagedPublic(vault);
    await c.answer(card!.id, "approve");
    await c.waitHeld(staged);
    expect(await key.register(c.client, c.id)).toBe(true);
    expect(key.publicKey()).toBe(staged);
    expect(vault.loadStaged()).toBeUndefined();
  });

  test("a yes landing between the first look and card.get is adopted, never dropped", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    const { card } = (await key.rotate(c.client, c.id, c.clock.now())) as { card: string };
    const staged = stagedPublic(vault);
    // On the next connection, after the app's first look (the core still held the old key), the user says yes.
    c.hooks.beforeCardGet = async () => {
      c.hooks.beforeCardGet = undefined;
      await c.answer(card, "approve");
      await c.waitHeld(staged);
    };
    expect(await key.register(c.client, c.id)).toBe(true);
    expect(key.publicKey()).toBe(staged);
    expect(c.held()).toBe(staged);
    expect(vault.loadStaged()).toBeUndefined();
  });

  test("a replacement already waiting is never overwritten: a second rotate is refused until it's over", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    const { card } = (await key.rotate(c.client, c.id, c.clock.now())) as { card: string };
    const staged = vault.loadStaged();
    expect(await key.rotate(c.client, c.id, c.clock.now())).toEqual({ refused: "a replacement already waits on its card" });
    expect(vault.loadStaged()).toEqual(staged);
    expect(c.broker.cards().map((x) => x.id)).toEqual([card]);
    // Once it's over (a no), a new one starts.
    await c.answer(card, "deny");
    expect(await key.rotate(c.client, c.id, c.clock.now())).toEqual({ card: expect.any(String) });
  });

  test("a staged key whose card the app never learned is dropped only once no card can approve it", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    const first = key.publicKey();
    // The request never reached the core (closed before it was sent): staged, no card anywhere.
    const lost = { request: async () => { throw new RpcCallError(CLIENT_ERR.CLOSED, "the connection closed"); } };
    expect(await key.rotate(lost, c.id, c.clock.now())).toEqual({ refused: "the connection closed" });
    expect(vault.loadStaged()).toBeDefined();
    expect(await key.register(c.client, c.id)).toBe(true);
    expect(vault.loadStaged()).toBeDefined();
    c.clock.advance(11 * 60 * 1000 + 1);
    expect(await key.register(c.client, c.id)).toBe(true);
    expect(vault.loadStaged()).toBeUndefined();
    expect(key.publicKey()).toBe(first);
  });

  test("an over-age staged key whose looks get no answer survives, and the next connection adopts it", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    const { card } = (await key.rotate(c.client, c.id, c.clock.now())) as { card: string };
    const staged = stagedPublic(vault);
    // The phone says yes at minute 9, while the app is away: the core holds the staged key.
    c.clock.advance(9 * 60 * 1000);
    expect(await c.answer(card, "approve")).toBe("accepted");
    await c.waitHeld(staged);
    // The app comes back at minute 12, past the age rule, and every look at the staged key times out.
    c.clock.advance(3 * 60 * 1000);
    let looks = 0;
    c.hooks.onSet = async (p) => (p.publicKey === staged ? (looks++, "timeout") : undefined);
    expect(await key.rotate(c.client, c.id, c.clock.now())).toEqual({ refused: "a replacement already waits on its card" });
    expect(await key.resolved(c.client, c.id, card, "cancelled")).toBe(false);
    expect(looks).toBeGreaterThanOrEqual(2);
    // Never dropped on a look that got no answer.
    expect(vault.loadStaged()).toBeDefined();
    // The next connection with answers adopts it.
    c.hooks.onSet = undefined;
    expect(await key.register(c.client, c.id)).toBe(true);
    expect(key.publicKey()).toBe(staged);
    expect(vault.loadStaged()).toBeUndefined();
  });

  test("rotate() adopts a staged key the core already holds, then hands over from it", async () => {
    const c = await core();
    const vault = memoryVault("app-keychain");
    const key = new AnswerKey(vault, undefined, { now: c.now });
    await key.register(c.client, c.id);
    const first = (await key.rotate(c.client, c.id, c.clock.now())) as { card: string };
    const staged = stagedPublic(vault);
    // The yes the app missed.
    await c.answer(first.card, "approve");
    await c.waitHeld(staged);
    const second = await key.rotate(c.client, c.id, c.clock.now());
    // The core took the new hand-over, so it came from the key it holds: the adopted one.
    expect(second).toEqual({ card: expect.any(String) });
    expect(key.publicKey()).toBe(staged);
    expect(stagedPublic(vault)).not.toBe(staged);
  });

  test("the OS store keeps the staged key in its own file, and promotes it by a rename over the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-e-akr-vault-"));
    const vault = safeStorageVault(join(dir, "answer-key"), fakeStorage, "darwin");
    vault.save(new Uint8Array([1, 2, 3]));
    vault.saveStaged({ secret: new Uint8Array([4, 5, 6]), at: 7, card: "card_abc" });
    expect(readFileSync(join(dir, "answer-key.staged")).toString()).not.toContain("card_abc");
    expect(vault.loadStaged()).toEqual({ secret: new Uint8Array([4, 5, 6]), at: 7, card: "card_abc" });
    expect(vault.load()).toEqual(new Uint8Array([1, 2, 3]));
    vault.promoteStaged();
    expect(vault.load()).toEqual(new Uint8Array([4, 5, 6]));
    expect(vault.loadStaged()).toBeUndefined();
  });
});
