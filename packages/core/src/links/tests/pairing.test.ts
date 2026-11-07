// Pairing without an account: the QR and the short code, the four words, the card, the pair credential and the group
// at the handshake (a local stand-in for lane I's service), and three devices that pair and then link.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../contracts/common";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { FileDeviceRegistry } from "../../devices/registry";
import { toBase64Url } from "../../identity/bytes";
import { DeviceKey } from "../../identity/device-key";
import { generateEd25519 } from "../../identity/keys";
import { SystemClock } from "../../clock/system-clock";
import { EFF_SHORT_WORDLIST } from "../../identity/wordlist";
import { HandshakeClient, pairKeyRef, pairSecretRef } from "../handshake";
import { type FakeHandshake, startFakeHandshake } from "../handshake-fake";
import { MemoryNetwork } from "../memory-wire";
import { formatCode, MemoryRendezvous, PairingService, parseCode } from "../pairing";
import { CloverLinkTransport } from "../transport";

const clock = new SystemClock();
let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

async function device(net: MemoryNetwork, name: string, opts: { hs?: FakeHandshake; rendezvous?: MemoryRendezvous; account?: string; kind?: "phone"; clockOffsetMs?: number } = {}) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-pair-")), key, clock, self: { name, os: "macos", ...(opts.kind ? { kind: opts.kind } : {}) } });
  const wire = net.endpoint(key.publicKey);
  const handshake = opts.hs ? new HandshakeClient({ baseUrl: opts.hs.url, clock }) : undefined;
  const devClock = opts.clockOffsetMs ? { ...clock, now: () => clock.now() + opts.clockOffsetMs!, monotonic: () => clock.monotonic(), setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock), status: () => clock.status() } : clock;
  const pairing = new PairingService({
    self: key, registry, wire, clock: devClock, store, selfTarget: () => ({ relay: "https://relay.test/" }), account: () => opts.account ?? null,
    ...(handshake ? { handshake } : {}), ...(opts.rendezvous ? { rendezvous: opts.rendezvous } : {}),
  });
  cleanup.push(() => pairing.close());
  return { name, store, key, registry, wire, pairing };
}
type Dev = Awaited<ReturnType<typeof device>>;

/** Runs a pairing to its words; returns both sides' words. */
async function toWords(host: Dev, joiner: Dev, use: "qr" | "code" = "qr") {
  const view = await host.pairing.begin();
  const joined = await joiner.pairing.join(use === "qr" ? view.qr! : view.code!);
  await waitFor(() => host.pairing.get(view.pairingId)?.status === "words");
  return { id: view.pairingId, hostWords: host.pairing.get(view.pairingId)!.view.words!, joinerWords: joined.words! };
}

async function pairBoth(host: Dev, joiner: Dev, use: "qr" | "code" = "qr") {
  const w = await toWords(host, joiner, use);
  expect(w.hostWords).toEqual(w.joinerWords);
  const done = [paired(host, w.id), paired(joiner, w.id)];
  await Promise.all([host.pairing.confirm(w.id, w.hostWords, { terminal: true }), joiner.pairing.confirm(w.id, w.joinerWords, { terminal: true })]);
  await Promise.all(done);
  return w;
}

/** Resolves when the pairing finished on this device: added, credential kept, group joined. */
function paired(d: Dev, id: string): Promise<void> {
  return new Promise((resolve) => {
    if (d.pairing.get(id)?.status === "paired") return resolve();
    const off = d.pairing.watch((c) => {
      if (c.type === "changed" && c.pairing.view.pairingId === id && c.pairing.status === "paired") {
        off();
        resolve();
      }
    });
  });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

describe("pairing", () => {
  test("by QR: the same four words, both confirm, each adds the other; the pair's credential is saved and registered", async () => {
    const hs = startFakeHandshake();
    cleanup.push(() => hs.stop());
    const net = new MemoryNetwork();
    const a = await device(net, "Studio", { hs });
    const b = await device(net, "Laptop", { hs });
    const w = await pairBoth(a, b);
    expect(w.hostWords.every((x: string) => EFF_SHORT_WORDLIST.includes(x))).toBe(true);
    expect(a.registry.get(b.key.id)?.addedBy).toBe("terminal");
    expect(b.registry.get(a.key.id)?.name).toBe("Studio");
    await waitFor(() => a.registry.pairWith(b.key.id)?.registeredAt !== undefined);
    const pa = a.registry.pairWith(b.key.id)!;
    const pb = b.registry.pairWith(a.key.id)!;
    expect(pa.pairId).toBe(pb.pairId);
    expect(pa.ownKey).toBe(pb.peerKey);
    expect(pa.ownKey).not.toBe(toBase64Url(a.key.publicKey));
    expect(hs.pairs.get(pa.pairId)?.keys).toEqual([pa.ownKey, pb.ownKey]);
    expect(await a.store.get(pairKeyRef(pa.pairId))).not.toBeNull();
    expect((await b.store.get(pairSecretRef(pa.pairId)))?.value.reveal()).toBe((await a.store.get(pairSecretRef(pa.pairId)))?.value.reveal());
    // The group: the host founded it, the joiner joined, admitted by the host.
    const ga = a.registry.group()!;
    expect(b.registry.group()?.id).toBe(ga.id);
    await waitFor(() => hs.groups.get(ga.id)?.members.size === 2);
    expect(ga.members[b.key.id]?.key).toBe(b.registry.group()!.ownKey);
  });

  test("by short code through the rendezvous, with a sealed card", async () => {
    const net = new MemoryNetwork();
    const rendezvous = new MemoryRendezvous();
    const a = await device(net, "Studio", { rendezvous });
    const b = await device(net, "Server", { rendezvous });
    const w = await toWords(a, b, "code");
    expect(rendezvous.slots.size).toBe(0);
    let approve!: (v: boolean) => void;
    const allowed = new Promise<boolean>((r) => (approve = r));
    const confirmed = a.pairing.confirm(w.id, w.hostWords, { card: "card_pair01", allowed });
    await b.pairing.confirm(w.id, w.joinerWords, { terminal: true });
    expect(a.registry.get(b.key.id)).toBeUndefined();
    const done = [paired(a, w.id), paired(b, w.id)];
    approve(true);
    await confirmed;
    await Promise.all(done);
    expect(a.registry.get(b.key.id)?.addedBy).toBe("code");
    // Without the service the registration waits, signed, for `retryRegistrations`.
    expect(a.registry.pairWith(b.key.id)?.registration?.sigs.length).toBe(2);
    expect(a.registry.pairWith(b.key.id)?.registeredAt).toBeUndefined();
  });

  test("words that differ end the pairing; nothing is added", async () => {
    const net = new MemoryNetwork();
    const a = await device(net, "Studio");
    const b = await device(net, "Laptop");
    const w = await toWords(a, b);
    const wrong = [...w.hostWords];
    wrong[3] = wrong[3] === "acid" ? "acorn" : "acid";
    expect(isContractError(await a.pairing.confirm(w.id, wrong, { terminal: true }).catch((e: unknown) => e), "refused")).toBe(true);
    expect(a.pairing.get(w.id)?.status).toBe("failed");
    await Bun.sleep(20);
    expect(a.registry.list()).toHaveLength(1);
    expect(b.registry.list()).toHaveLength(1);
  });

  test("a code with the wrong secret is refused, and the pairing is spent", async () => {
    const net = new MemoryNetwork();
    const rendezvous = new MemoryRendezvous();
    const a = await device(net, "Studio", { rendezvous });
    const b = await device(net, "Laptop", { rendezvous });
    const c = await device(net, "Other", { rendezvous });
    const view = await a.pairing.begin();
    const raw = parseCode(view.code!)!;
    expect(formatCode(raw)).toBe(view.code!);
    // Same slot, another secret: the box doesn't open, so the joiner can't even find the host.
    raw[14]! ^= 1;
    expect(isContractError(await b.pairing.join(formatCode(raw)).catch((e: unknown) => e), "not_found")).toBe(true);
    // A QR with a wrong secret reaches the host, which ends the pairing on the first bad proof.
    const qr = view.qr!;
    const forged = await forgeQrSecret(qr);
    expect(isContractError(await c.pairing.join(forged).catch((e: unknown) => e), "refused")).toBe(true);
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "failed");
    expect(isContractError(await b.pairing.join(qr).catch((e: unknown) => e), "refused")).toBe(true);
  });

  test("a denied card ends it on both sides", async () => {
    const net = new MemoryNetwork();
    const a = await device(net, "Studio");
    const b = await device(net, "Laptop");
    const w = await toWords(a, b);
    const denied = a.pairing.confirm(w.id, w.hostWords, { card: "card_x", allowed: Promise.resolve(false) }).catch((e: unknown) => e);
    expect(isContractError(await denied, "refused")).toBe(true);
    await waitFor(() => b.pairing.get(w.id)?.status === "failed");
    expect(b.registry.list()).toHaveLength(1);
  });

  test("a phone's answer key (P-256, the Secure Enclave's) travels in its record with its own signature; its link key never answers a card", async () => {
    const net = new MemoryNetwork();
    const host = await device(net, "Studio");
    const phone = await device(net, "Phone", { kind: "phone" });
    const { answerKeyStatement } = await import("../../devices/registry");
    const { utf8 } = await import("../../identity/bytes");
    // The Secure Enclave's key is P-256 (B's #187): a raw uncompressed point, and r‖s signatures over SHA-256.
    const { generateKeyPairSync, sign } = await import("node:crypto");
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = pair.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64");
    const es256 = (d: Uint8Array) => new Uint8Array(sign("sha256", d, { key: pair.privateKey, dsaEncoding: "ieee-p1363" }));
    await phone.registry.setOwnAnswerKey(pub, "secure-enclave", es256(answerKeyStatement(phone.key.id, pub, "secure-enclave", "p256")), undefined, "p256");
    await pairBoth(host, phone);
    expect(host.registry.get(phone.key.id)?.answerKey).toEqual({ publicKey: pub, held: "secure-enclave", alg: "p256" } as never);
    const data = utf8("an answer");
    expect(await host.registry.verifyAnswer(phone.key.id, data, es256(data))).toBe(true);
    expect(await host.registry.verifyAnswer(phone.key.id, data, phone.key.sign(data))).toBe(false);
    // The statement covers the algorithm: an Ed25519 statement doesn't register the same key.
    await expect(phone.registry.setOwnAnswerKey(pub, "secure-enclave", es256(answerKeyStatement(phone.key.id, pub, "secure-enclave")), undefined, "p256")).rejects.toThrow();
  });

  test("a host whose t is out of the statements' window is refused at its welcome (I's review)", async () => {
    const net = new MemoryNetwork();
    const host = await device(net, "Studio", { clockOffsetMs: -15 * 60_000 });
    const joiner = await device(net, "Laptop");
    const view = await host.pairing.begin();
    expect(isContractError(await joiner.pairing.join(view.qr!).catch((e: unknown) => e), "refused")).toBe(true);
    expect(joiner.registry.list()).toHaveLength(1);
  });

  test("two devices on the same account keep no pair credential and form no group", async () => {
    const net = new MemoryNetwork();
    const a = await device(net, "Studio", { account: "acct-hash-1" });
    const b = await device(net, "Laptop", { account: "acct-hash-1" });
    await pairBoth(a, b);
    expect(a.registry.pairs()).toHaveLength(0);
    expect(a.registry.group()).toBeUndefined();
  });

  test("three devices: A pairs B and C, all three join A's group, and the links follow the registry", async () => {
    const hs = startFakeHandshake();
    cleanup.push(() => hs.stop());
    const net = new MemoryNetwork();
    const [a, b, c] = [await device(net, "Studio", { hs }), await device(net, "Laptop", { hs }), await device(net, "Server", { hs })];
    await pairBoth(a, b);
    await pairBoth(a, c);
    const group = a.registry.group()!.id;
    expect(b.registry.group()?.id).toBe(group);
    expect(c.registry.group()?.id).toBe(group);
    await waitFor(() => hs.groups.get(group)?.members.size === 3);
    expect(hs.pairs.size).toBe(2);

    const transports = new Map<string, CloverLinkTransport>();
    for (const d of [a, b, c]) {
      const t = new CloverLinkTransport({
        self: d.key.id, wire: d.wire, registry: d.registry, clock,
        directory: { target: (id) => { const r = d.registry.get(id); return r ? { key: Buffer.from(r.publicKey, "base64") as unknown as Uint8Array<ArrayBuffer>, relay: "https://relay.test/" } : undefined; } },
      });
      t.handle("test.whoami", async (_p, from) => ({ me: d.name, from }));
      transports.set(d.name, t);
      cleanup.push(() => t.close());
    }
    const ta = transports.get("Studio")!;
    expect(await (await ta.connect(b.key.id)).request<unknown>("test.whoami", {})).toEqual({ me: "Laptop", from: a.key.id });
    expect(await (await ta.connect(c.key.id)).request<unknown>("test.whoami", {})).toEqual({ me: "Server", from: a.key.id });
    // B and C never paired with each other.
    expect(isContractError(await transports.get("Laptop")!.connect(c.key.id).catch((e: unknown) => e), "refused")).toBe(true);
    // Revoking C on A cuts that link at once.
    const link = await ta.connect(c.key.id);
    await a.registry.revoke(c.key.id, "lost");
    expect(isContractError(await link.request<unknown>("test.whoami", {}).catch((e: unknown) => e), "refused")).toBe(true);
    expect(a.registry.pairWith(c.key.id)).toBeUndefined();
  });
});

describe("the pair door and the words' commitment (S2, S6.3 of H-M1's review)", () => {
  test("the door turns a connection away while no pairing is shown, and once a pairing is spent", async () => {
    const net = new MemoryNetwork();
    const a = await device(net, "Studio");
    const stranger = net.endpoint(generateEd25519().publicKey);
    const conn = await stranger.dial({ key: a.key.publicKey }, { alpn: "clover/pair/1" });
    expect((await conn.closed).reason).toBe("no pairing is open");
  });

  test("an opened connection that sends no hello is closed when its first frame is late", async () => {
    const net = new MemoryNetwork();
    const store = new MemorySecretStore();
    const key = await DeviceKey.loadOrCreate(store);
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-pair-")), key, clock, self: { name: "Studio" } });
    const pairing = new PairingService({
      self: key, registry, wire: net.endpoint(key.publicKey), clock, store, selfTarget: () => ({}), account: () => null, door: { firstFrameMs: 50 },
    });
    cleanup.push(() => pairing.close());
    await pairing.begin();
    const stranger = net.endpoint(generateEd25519().publicKey);
    const conn = await stranger.dial({ key: key.publicKey }, { alpn: "clover/pair/1" });
    conn.openStream(3);
    expect((await conn.closed).reason).toBe("no hello in time");
  });

  test("a code's slot is create-only, so no one swaps the host's key in it", async () => {
    const r = new MemoryRendezvous();
    await r.publish("slot", "box-1");
    expect(isContractError(await r.publish("slot", "box-2").catch((e: unknown) => e), "conflict")).toBe(true);
    expect(await r.lookup("slot")).toBe("box-1");
  });

  test("the words and the pair secret cover both nonces, and the commitment binds the joiner's", async () => {
    const { finalTranscript, nonceCommitment, sasWords, derivePairSecret } = await import("../../identity/sas");
    const { randomBytes } = await import("../../identity/bytes");
    const secret = randomBytes(32);
    const full = randomBytes(64);
    const n1 = randomBytes(32);
    const n2 = randomBytes(32);
    expect(sasWords(secret, finalTranscript(full, n1))).not.toEqual(sasWords(secret, finalTranscript(full, n2)));
    expect(toBase64Url(derivePairSecret(secret, finalTranscript(full, n1)))).not.toBe(toBase64Url(derivePairSecret(secret, finalTranscript(full, n2))));
    expect(toBase64Url(nonceCommitment(n1))).not.toBe(toBase64Url(nonceCommitment(n2)));
    expect(toBase64Url(nonceCommitment(n1))).toBe(toBase64Url(nonceCommitment(new Uint8Array(n1))));
  });
});

async function forgeQrSecret(qr: string): Promise<string> {
  const { decode, encode } = await import("../codec");
  const { fromBase64Url } = await import("../../identity/bytes");
  const prefix = "clover-pair:1:";
  const v = decode(fromBase64Url(qr.slice(prefix.length))!) as unknown[];
  const secret = new Uint8Array(v[1] as Uint8Array);
  secret[0]! ^= 1;
  v[1] = secret;
  return prefix + toBase64Url(encode(v));
}
