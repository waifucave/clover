// Where an account-less peer is (item 81): its latest `addr` record at the handshake, sealed under the pair's secret,
// and its "dial now". The link transport asks `target(device)`; this device publishes its own addresses to each of its
// pairs, sends a "dial now" before a dial, and dials back when a peer's arrives. A pair the service doesn't know yet
// (or a service that can't be reached) still gets a target: the peer's key alone, which the link sidecar resolves
// through n0's address lookup, the fallback only account-less devices publish to (relay URL only).
import type { SecretStore } from "../contracts/secret-store";
import type { FileDeviceRegistry, PairRecord } from "../devices/registry";
import { type Bytes, fromBase64 } from "../identity/bytes";
import { type Ed25519Key, ed25519FromSecret, publicKeyFromBase64 } from "../identity/keys";
import type { NatMapping } from "./dial-policy";
import {
  type AddrPlaintext, type HandshakeClient, openPairBox, pairBoxKey, pairKeyRef, pairSecretRef, sealPairBox,
} from "./handshake";
import type { PeerDirectory } from "./transport";
import type { DialTarget } from "./wire";

export interface HandshakeDirectoryOptions {
  registry: FileDeviceRegistry;
  store: Pick<SecretStore, "get">;
  client: HandshakeClient;
  clock: { now(): number };
  /** This device's addresses now (the link sidecar's bound sockets, STUN answers, home relay). */
  localAddr(): Promise<Omit<AddrPlaintext, "v" | "at">>;
  /** A peer asked to be dialled now. */
  onDialNow?(peer: string): void;
  /** How long a fetched record is used before it is fetched again. */
  cacheMs?: number;
  ttlSeconds?: number;
}

interface PairKeys {
  sign: Ed25519Key;
  box: Bytes;
}

export class HandshakeDirectory implements PeerDirectory {
  readonly #o: HandshakeDirectoryOptions;
  readonly #cache = new Map<string, { at: number; addr: AddrPlaintext | undefined }>();
  readonly #keys = new Map<string, PairKeys>();

  constructor(opts: HandshakeDirectoryOptions) {
    this.#o = opts;
  }

  async target(device: string): Promise<DialTarget | undefined> {
    const d = this.#o.registry.get(device);
    if (!d || d.revokedAt !== undefined) return undefined;
    // A link key Clover dials is a strict Ed25519 point (identity/ed25519-strict.ts).
    const key = publicKeyFromBase64(d.publicKey);
    if (!key) return undefined;
    // "Dial now", so the peer dials back at once (S1): both directions race, and the first through wins.
    if (this.#pair(device)?.registeredAt !== undefined) void this.dialNow(device).catch(() => undefined);
    const addr = await this.addr(device).catch(() => undefined);
    if (!addr) return { key };
    return {
      key,
      ...(addr.lan?.length ? { lan: addr.lan } : {}),
      ...(addr.stun?.length || addr.mapped?.length ? { direct: [...(addr.stun ?? []), ...(addr.mapped ?? [])] } : {}),
      ...(addr.relay ? { relay: addr.relay } : {}),
    };
  }

  /** The peer's NAT mapping, from its last record: what the dial policy weighs. */
  mapping(device: string): NatMapping {
    return this.#cache.get(device)?.addr?.mapping ?? "unknown";
  }

  /** The peer's latest `addr` plaintext, fetched when the cached one is old. */
  async addr(device: string): Promise<AddrPlaintext | undefined> {
    const hit = this.#cache.get(device);
    if (hit && this.#o.clock.now() - hit.at < (this.#o.cacheMs ?? 30_000)) return hit.addr;
    const pair = this.#pair(device);
    if (!pair) return undefined;
    const keys = await this.#pairKeys(pair);
    const read = await this.#o.client.readPair(pair.pairId, keys.sign);
    const rec = read.records.filter((r) => r.kind === "addr" && r.from === pair.peerKey).sort((a, b) => b.gen - a.gen)[0];
    const addr = rec ? this.#openAddr(pair, keys, rec.gen, rec.box) : undefined;
    this.#cache.set(device, { at: this.#o.clock.now(), addr });
    return addr;
  }

  /** Takes a record the socket pushed. */
  takeRecord(device: string, rec: { from: string; kind: string; gen: number; box: string }): void {
    const pair = this.#pair(device);
    const keys = pair ? this.#keys.get(pair.pairId) : undefined;
    if (!pair || !keys || rec.kind !== "addr" || rec.from !== pair.peerKey) return;
    const addr = this.#openAddr(pair, keys, rec.gen, rec.box);
    if (addr) this.#cache.set(device, { at: this.#o.clock.now(), addr });
  }

  /** Publishes this device's addresses to every registered pair. */
  async publish(): Promise<number> {
    const local = await this.#o.localAddr();
    let n = 0;
    for (const pair of this.#o.registry.pairs()) {
      if (pair.endedAt !== undefined || pair.registeredAt === undefined) continue;
      const keys = await this.#pairKeys(pair);
      const gen = Math.floor(this.#o.clock.now());
      const plain: AddrPlaintext = { v: 1, at: gen, ...local };
      const box = sealPairBox(keys.box, { scope: pair.pairId, from: pair.ownKey, to: pair.peerKey, kind: "addr", gen }, plain);
      if (await this.#o.client.putRecord(pair.pairId, keys.sign, "addr", { gen, ttl: this.#o.ttlSeconds ?? 900, box })) n++;
    }
    return n;
  }

  /** Asks a peer to dial now (both dial, and again about 100 ms later). */
  async dialNow(device: string): Promise<boolean> {
    const pair = this.#pair(device);
    if (!pair || pair.registeredAt === undefined) return false;
    const keys = await this.#pairKeys(pair);
    const at = Math.floor(this.#o.clock.now());
    const box = sealPairBox(keys.box, { scope: pair.pairId, from: pair.ownKey, to: pair.peerKey, kind: "dial" }, { v: 1, at, addr: { v: 1, at, ...(await this.#o.localAddr()) } });
    return (await this.#o.client.sendMessage(pair.pairId, keys.sign, { kind: "dial", ttl: 30, box })).delivered;
  }

  /** Reads every pair's inbox; a "dial now" in it calls `onDialNow`. */
  async poll(): Promise<string[]> {
    const asked: string[] = [];
    for (const pair of this.#o.registry.pairs()) {
      if (pair.endedAt !== undefined || pair.registeredAt === undefined) continue;
      const keys = await this.#pairKeys(pair);
      for (const m of await this.#o.client.inbox(pair.pairId, keys.sign)) {
        if (this.takeMessage(pair.peer, m)) asked.push(pair.peer);
      }
    }
    return asked;
  }

  /** Takes a message the socket pushed or the inbox held; true for a fresh "dial now". */
  takeMessage(device: string, m: { from: string; kind: string; at: number; box: string }): boolean {
    const pair = this.#pair(device);
    const keys = pair ? this.#keys.get(pair.pairId) : undefined;
    if (!pair || !keys || m.from !== pair.peerKey || m.kind !== "dial") return false;
    const plain = openPairBox(keys.box, { scope: pair.pairId, from: pair.peerKey, to: pair.ownKey, kind: "dial" }, m.box) as { at?: number; addr?: AddrPlaintext } | undefined;
    if (!plain || typeof plain.at !== "number" || this.#o.clock.now() - plain.at > 60_000) return false;
    if (plain.addr) this.#cache.set(device, { at: this.#o.clock.now(), addr: plain.addr });
    this.#o.onDialNow?.(device);
    return true;
  }

  /** Opens the pair's socket, so the peer's records and "dial now" arrive at once instead of on the next poll.
   *  Returns the close function; the socket pings every 30 s as the format asks. */
  async connectSocket(device: string, onClosed?: (code: number) => void): Promise<() => void> {
    const pair = this.#pair(device);
    if (!pair || pair.registeredAt === undefined) throw new Error("no registered pair with that device");
    const keys = await this.#pairKeys(pair);
    const { url } = await this.#o.client.pairTicket(pair.pairId, keys.sign);
    const ws = new WebSocket(url);
    const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (f.t === "record") this.takeRecord(device, f as { from: string; kind: string; gen: number; box: string });
      else if (f.t === "message") this.takeMessage(device, f as { from: string; kind: string; at: number; box: string });
    });
    let closedByUs = false;
    ws.addEventListener("close", (ev) => {
      clearInterval(ping);
      if (!closedByUs) onClosed?.(ev.code);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("the handshake socket didn't open")), { once: true });
    });
    return () => {
      closedByUs = true;
      clearInterval(ping);
      ws.close(1000, "done");
    };
  }

  #openAddr(pair: PairRecord, keys: PairKeys, gen: number, box: string): AddrPlaintext | undefined {
    const plain = openPairBox(keys.box, { scope: pair.pairId, from: pair.peerKey, to: pair.ownKey, kind: "addr", gen }, box) as AddrPlaintext | undefined;
    return plain && plain.v === 1 && typeof plain.at === "number" ? plain : undefined;
  }

  #pair(device: string): PairRecord | undefined {
    return this.#o.registry.pairWith(device);
  }

  async #pairKeys(pair: PairRecord): Promise<PairKeys> {
    const hit = this.#keys.get(pair.pairId);
    if (hit) return hit;
    const sign = await this.#o.store.get(pairKeyRef(pair.pairId));
    const secret = await this.#o.store.get(pairSecretRef(pair.pairId));
    const raw = secret ? fromBase64(secret.value.reveal()) : null;
    if (!sign || !raw) throw new Error("the pair's keys are missing");
    const keys = { sign: ed25519FromSecret(sign.value), box: pairBoxKey(raw, pair.pairId) };
    this.#keys.set(pair.pairId, keys);
    return keys;
  }
}
