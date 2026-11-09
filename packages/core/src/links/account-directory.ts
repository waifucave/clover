// Where a signed-in peer is (B2 of H-M1's review; services/handshake/PROTOCOL.md "The account channel"): the devices
// of one waifucave account find each other through the handshake's account channel, as account-less pairs do through
// their pair channels (handshake-directory.ts). Each device publishes an `addr` record to each other device of the
// account, sealed to that device's X25519 key from the account's device list (HPKE, "Boxes"), sends a "dial now"
// before it dials, and opens the account's socket so records, "dial now" and the lease arrive at once.
//
// The service sees device ids, sizes and timing, never an address: a record opens only for the device it was sealed
// to, under an `aad` naming the account, both devices, the kind and the record's generation.
import type { DeviceRecord } from "../contracts/device-registry";
import type { FileDeviceRegistry } from "../devices/registry";
import type { AccountClient } from "../identity/account";
import { type BoxKey, sealToBoxKey } from "../identity/box-key";
import { type Bytes, fromBase64, fromBase64Url, fromUtf8, utf8 } from "../identity/bytes";
import { publicKeyFromBase64 } from "../identity/keys";
import type { NatMapping } from "./dial-policy";
import { type AddrPlaintext, HANDSHAKE_AUDIENCE, HANDSHAKE_PREFIX, type HandshakeClient, type HandshakeKind, type LeaseRecord } from "./handshake";
import type { PeerDirectory } from "./transport";
import type { DialTarget } from "./wire";

export interface AccountRecordFrame {
  from: string;
  kind: string;
  gen: number;
  expiresAt?: number;
  box: string;
}

export interface AccountMessageFrame {
  id?: string;
  from: string;
  kind: string;
  at: number;
  expiresAt?: number;
  box: string;
}

export interface AccountDirectoryOptions {
  registry: FileDeviceRegistry;
  account: Pick<AccountClient, "accountId" | "tokens">;
  client: HandshakeClient;
  boxKey: BoxKey;
  clock: { now(): number };
  localAddr(): Promise<Omit<AddrPlaintext, "v" | "at">>;
  onDialNow?(peer: string): void;
  /** The account's lease, as the socket pushes it (the main computer's lease follows it). */
  onLease?(lease: LeaseRecord): void;
  /** Another device of the account came online or went offline (a hint to dial, or to sync the device list). */
  onPresence?(device: string, online: boolean): void;
  cacheMs?: number;
  ttlSeconds?: number;
  log?(line: string): void;
}

/** The `aad` lines of an account-scope box (PROTOCOL.md "Boxes"). */
export function accountBoxAad(c: { account: string; from: string; to: string; kind: HandshakeKind; gen?: number }): Bytes {
  const lines = [`${HANDSHAKE_PREFIX} box`, c.account, c.from, c.to, c.kind];
  if (c.gen !== undefined) lines.push(String(c.gen));
  return utf8(lines.join("\n"));
}

export class AccountDirectory implements PeerDirectory {
  readonly #o: AccountDirectoryOptions;
  readonly #addr = new Map<string, { at: number; addr: AddrPlaintext }>();
  #lastRead = Number.NEGATIVE_INFINITY;

  constructor(o: AccountDirectoryOptions) {
    this.#o = o;
  }

  /** Whether `device` is found this way: a device on the account's device list, whether it came in by the account or
   *  was paired by code first (the list gave it its box key, `syncAccountDevices`), not an account-less pair. */
  covers(device: string): boolean {
    const d = this.#o.registry.get(device);
    return d !== undefined && d.revokedAt === undefined && d.id !== this.#o.registry.self().id && (d.addedBy === "account" || this.#o.registry.boxKey(d.id) !== undefined);
  }

  async target(device: string): Promise<DialTarget | undefined> {
    const d = this.#o.registry.get(device);
    if (!d || d.revokedAt !== undefined) return undefined;
    // A link key Clover dials is a strict Ed25519 point (identity/ed25519-strict.ts).
    const key = publicKeyFromBase64(d.publicKey);
    if (!key) return undefined;
    // "Dial now", so the peer dials back at once (S1): both directions race, and the first through wins.
    void this.dialNow(device).catch(() => undefined);
    const addr = await this.addr(device).catch(() => undefined);
    if (!addr) return { key };
    return {
      key,
      ...(addr.lan?.length ? { lan: addr.lan } : {}),
      ...(addr.stun?.length || addr.mapped?.length ? { direct: [...(addr.stun ?? []), ...(addr.mapped ?? [])] } : {}),
      ...(addr.relay ? { relay: addr.relay } : {}),
    };
  }

  mapping(device: string): NatMapping {
    return this.#addr.get(device)?.addr.mapping ?? "unknown";
  }

  /** The peer's latest `addr`, read from the account channel when the cached one is old. */
  async addr(device: string): Promise<AddrPlaintext | undefined> {
    const hit = this.#addr.get(device);
    if (hit && this.#o.clock.now() - hit.at < (this.#o.cacheMs ?? 30_000)) return hit.addr;
    if (this.#o.clock.now() - this.#lastRead >= 1_000) await this.read();
    return this.#addr.get(device)?.addr;
  }

  /** Reads every record addressed to this device, and the lease. */
  async read(): Promise<void> {
    const token = await this.#token();
    const r = await this.#o.client.readAccount(token);
    this.#lastRead = this.#o.clock.now();
    for (const rec of r.records as AccountRecordFrame[]) await this.takeRecord(rec);
    if (r.lease) this.#o.onLease?.(r.lease);
  }

  /** Publishes this device's addresses to every other device of the account that lists a box key. */
  async publish(): Promise<number> {
    const account = await this.#o.account.accountId();
    if (account === null) return 0;
    const token = await this.#token();
    const local = await this.#o.localAddr();
    const self = this.#o.registry.self().id;
    let n = 0;
    for (const d of this.#peers()) {
      const box = this.#o.registry.boxKey(d.id);
      const to = box ? fromBase64Url(box) : null;
      if (!to) continue;
      // One device's failure (a key that won't seal, a record the service refused) leaves the others their address.
      try {
        const gen = Math.floor(this.#o.clock.now());
        const plain: AddrPlaintext = { v: 1, at: gen, ...local };
        const sealed = sealToBoxKey(to, accountBoxAad({ account, from: self, to: d.id, kind: "addr", gen }), utf8(JSON.stringify(plain)));
        if (await this.#o.client.putAccountRecord(token, d.id, "addr", { gen, ttl: this.#o.ttlSeconds ?? 900, box: sealed })) n++;
      } catch (err) {
        this.#o.log?.(`[account] no address for ${d.id}: ${(err as Error).message}`);
      }
    }
    return n;
  }

  /** Asks a device of the account to dial now. */
  async dialNow(device: string): Promise<boolean> {
    const account = await this.#o.account.accountId();
    const box = this.#o.registry.boxKey(device);
    const to = box ? fromBase64Url(box) : null;
    if (account === null || !to || !this.covers(device)) return false;
    const token = await this.#token();
    const at = Math.floor(this.#o.clock.now());
    const plain = { v: 1, at, addr: { v: 1, at, ...(await this.#o.localAddr()) } };
    let sealed: string;
    try {
      sealed = sealToBoxKey(to, accountBoxAad({ account, from: this.#o.registry.self().id, to: device, kind: "dial" }), utf8(JSON.stringify(plain)));
    } catch {
      return false; // a box key that won't seal: no dial
    }
    return (await this.#o.client.sendAccountMessage(token, { to: device, kind: "dial", ttl: 30, box: sealed })).delivered;
  }

  /** Reads this device's inbox; a "dial now" in it calls `onDialNow`. */
  async poll(): Promise<string[]> {
    const token = await this.#token();
    const asked: string[] = [];
    for (const m of await this.#o.client.accountInbox(token)) if (await this.takeMessage(m)) asked.push(m.from);
    return asked;
  }

  /** A record the socket pushed or a read returned. */
  async takeRecord(rec: AccountRecordFrame): Promise<void> {
    if (rec.kind !== "addr" || !this.covers(rec.from)) return;
    const account = await this.#o.account.accountId();
    if (account === null) return;
    const plain = this.#open(rec.box, { account, from: rec.from, to: this.#o.registry.self().id, kind: "addr", gen: rec.gen }) as AddrPlaintext | undefined;
    if (!plain || plain.v !== 1 || typeof plain.at !== "number") return;
    const prev = this.#addr.get(rec.from);
    if (prev && prev.addr.at > plain.at) return;
    this.#addr.set(rec.from, { at: this.#o.clock.now(), addr: plain });
  }

  /** A message the socket pushed or the inbox held; true for a fresh "dial now". */
  async takeMessage(m: AccountMessageFrame): Promise<boolean> {
    if (m.kind !== "dial" || !this.covers(m.from)) return false;
    const account = await this.#o.account.accountId();
    if (account === null) return false;
    const plain = this.#open(m.box, { account, from: m.from, to: this.#o.registry.self().id, kind: "dial" }) as { at?: number; addr?: AddrPlaintext } | undefined;
    if (!plain || typeof plain.at !== "number" || this.#o.clock.now() - plain.at > 60_000) return false;
    if (plain.addr && plain.addr.v === 1) this.#addr.set(m.from, { at: this.#o.clock.now(), addr: plain.addr });
    this.#o.onDialNow?.(m.from);
    return true;
  }

  /** Takes one frame of the account's socket. */
  async takeFrame(f: Record<string, unknown>): Promise<void> {
    if (f.t === "record") await this.takeRecord(f as unknown as AccountRecordFrame);
    else if (f.t === "message") await this.takeMessage(f as unknown as AccountMessageFrame);
    else if ((f.t === "lease" || f.t === "hello") && f.lease) this.#o.onLease?.(f.lease as LeaseRecord);
    else if (f.t === "presence" && typeof f.device === "string" && typeof f.online === "boolean") this.#o.onPresence?.(f.device, f.online);
  }

  /** A ticket for the account's socket. */
  async ticket(): Promise<string> {
    return (await this.#o.client.accountTicket(await this.#token())).url;
  }

  #open(box: string, aad: Parameters<typeof accountBoxAad>[0]): unknown {
    const bytes = this.#o.boxKey.open(box, accountBoxAad(aad));
    if (!bytes) return undefined;
    try {
      return JSON.parse(fromUtf8(bytes));
    } catch {
      return undefined;
    }
  }

  #peers(): DeviceRecord[] {
    const self = this.#o.registry.self().id;
    return this.#o.registry.list().filter((d) => d.id !== self && this.covers(d.id));
  }

  async #token(): Promise<string> {
    const t = await this.#o.account.tokens.current(HANDSHAKE_AUDIENCE);
    if (!t) throw new Error("no account token for the handshake");
    return t.value.reveal();
  }
}
