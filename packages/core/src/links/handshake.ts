// The client of the waifucave handshake (services/handshake/PROTOCOL.md, wire format v1; lane I owns the service and
// the format). It introduces paired devices to each other: each device's addresses, a "dial now", and the lease, for
// a pair or group of account-less devices (owner decisions 81 and 85) or the devices of one account.
//
// Lane H's choices the format leaves to it:
// * Keys are fresh per pair and per group (the format's recommendation): the service can't link a device's pairs to
//   its link key or to each other. Their seeds are device items in the secret store (`pairKeyRef`, `groupKeyRef`).
// * The pair secret S is derived at pairing from the pairing secret and the transcript (identity/sas.ts), and the pair
//   id from S, so both devices hold the same ones without sending them.
// * `t` is per key and scope: `max(now, last + 1)`, and one mutation at a time per scope, as the format asks.
import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { ContractError } from "../contracts/common";
import type { SecretRef } from "../contracts/secret-store";
import { type Bytes, concat, fromBase64Url, fromUtf8, own, randomBytes, toBase64Url, utf8 } from "../identity/bytes";
import type { Ed25519Key } from "../identity/keys";

export const HANDSHAKE_PREFIX = "clover-handshake-v1";
export const HANDSHAKE_AUDIENCE = "handshake.waifucave.com";

export type HandshakeKind = "addr" | "dial" | "signal";

/** The secret-store items of one pair's and one group's keys (device items: they never sync). */
export const pairKeyRef = (pair: string): SecretRef => ({ owner: { kind: "device" }, name: `pair:${pair}:sign` });
export const pairSecretRef = (pair: string): SecretRef => ({ owner: { kind: "device" }, name: `pair:${pair}:secret` });
export const groupKeyRef = (group: string): SecretRef => ({ owner: { kind: "device" }, name: `group:${group}:sign` });

// ---- statements (PROTOCOL.md "Statements") ----

export const pairStatement = (pair: string, keys: readonly [string, string], t: number): Bytes =>
  utf8([`${HANDSHAKE_PREFIX} pair`, pair, keys[0], keys[1], String(t)].join("\n"));
export const groupStatement = (group: string, key: string, t: number): Bytes =>
  utf8([`${HANDSHAKE_PREFIX} group`, group, key, String(t)].join("\n"));
export const joinStatement = (group: string, key: string, t: number): Bytes =>
  utf8([`${HANDSHAKE_PREFIX} join`, group, key, String(t)].join("\n"));
export const admitStatement = (group: string, key: string, t: number): Bytes =>
  utf8([`${HANDSHAKE_PREFIX} admit`, group, key, String(t)].join("\n"));
/** A voter's agreement to remove a member other than itself (PROTOCOL.md "Group recovery", proposed). */
export const removeStatement = (group: string, key: string, t: number): Bytes =>
  utf8([`${HANDSHAKE_PREFIX} remove`, group, key, String(t)].join("\n"));

// ---- group recovery (PROTOCOL.md "Group recovery", lane I's proposal adopted for H-M2) ----

/** A member votes once it has been in the group this long, or at once if a quorum of voters admitted it. */
export const VOTE_AFTER_MS = 72 * 3600_000;
/** How far back a quorum's removal of a member undoes the changes it signed. */
export const ROLLBACK_MS = 7 * 86_400_000;
/** The voters a change to another member needs: a majority of the `v` voters other than its target. */
export const quorumOf = (v: number): number => Math.floor(v / 2) + 1;
/** How long a statement's `t` stays within the service's window (10 minutes), less a margin for the round trip. */
export const STATEMENT_FRESH_MS = 9 * 60_000;

/** A member as the group's read shows it. `votesFrom` is when it starts voting (null: never, as for a key whose
 *  admission is still unsettled); `admittedBy` the members whose admits let it in. */
export interface GroupMember {
  key: string;
  joinedAt: number;
  votesFrom?: number | null;
  admittedBy?: string[];
}

/** A join: the new key's own statement and the admits of members (one is v1's `by`/`bysig`). */
export interface GroupJoin {
  key: string;
  t: number;
  sig: string;
  by?: string;
  bysig?: string;
  admits?: { by: string; sig: string }[];
}

/** What a signed request's `sig` covers (PROTOCOL.md "Signed requests"). */
export function requestStatement(method: string, pathAndQuery: string, t: number, body: Uint8Array): Bytes {
  const digest = toBase64Url(new Uint8Array(createHash("sha256").update(body).digest()));
  return utf8([`${HANDSHAKE_PREFIX} request`, method.toUpperCase(), pathAndQuery, String(t), digest].join("\n"));
}

export function authorizationHeader(key: Ed25519Key, method: string, pathAndQuery: string, t: number, body: Uint8Array): string {
  const sig = key.sign(requestStatement(method, pathAndQuery, t, body));
  return `Clover-Sig key=${toBase64Url(key.publicKey)}, t=${t}, sig=${toBase64Url(sig)}`;
}

// ---- boxes (PROTOCOL.md "Boxes", pair scope) ----

export interface BoxContext {
  /** The pair id (base64url) or the account's `sub`. */
  scope: string;
  from: string;
  to: string;
  kind: HandshakeKind;
  /** A record's generation; absent for a message. */
  gen?: number;
}

function boxAad(c: BoxContext): Bytes {
  const lines = [`${HANDSHAKE_PREFIX} box`, c.scope, c.from, c.to, c.kind];
  if (c.gen !== undefined) lines.push(String(c.gen));
  return utf8(lines.join("\n"));
}

/** K = HKDF-SHA256(ikm = S, salt = the pair id's 16 bytes, info = `clover handshake v1 box`). */
export function pairBoxKey(pairSecret: Uint8Array, pairId: string): Bytes {
  const salt = fromBase64Url(pairId);
  if (!salt || salt.length !== 16) throw new ContractError("invalid", "a pair id is 16 bytes");
  return own(new Uint8Array(hkdfSync("sha256", pairSecret, salt, utf8("clover handshake v1 box"), 32)));
}

export function sealPairBox(key: Uint8Array, c: BoxContext, plaintext: unknown): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(boxAad(c));
  const body = concat(cipher.update(utf8(JSON.stringify(plaintext))), cipher.final(), cipher.getAuthTag());
  return toBase64Url(concat(nonce, body));
}

/** The plaintext, or undefined for a box that doesn't open under this context. */
export function openPairBox(key: Uint8Array, c: BoxContext, box: string): unknown {
  const bytes = fromBase64Url(box);
  if (!bytes || bytes.length < 12 + 16) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(boxAad(c));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = concat(decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final());
    return JSON.parse(fromUtf8(plain));
  } catch {
    return undefined;
  }
}

/** The `addr` plaintext (lane H owns its fields). */
export interface AddrPlaintext {
  v: 1;
  at: number;
  lan?: string[];
  stun?: string[];
  mapped?: string[];
  mapping?: "same" | "varies" | "unknown";
  relay?: string;
  node?: string;
}

// ---- the client ----

export class HandshakeError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number, readonly body?: Record<string, unknown>) {
    super(`handshake: ${status} ${code}`);
    this.name = "HandshakeError";
  }
}

export interface LeaseRecord {
  holder: string | null;
  epoch: number;
  expiresAt: number | null;
}

export interface PairRead {
  pair: string;
  keys: [string, string];
  peer: { online: boolean };
  records: { from: string; kind: HandshakeKind; gen: number; expiresAt: number; box: string }[];
}

export interface InboxMessage {
  id: string;
  from: string;
  kind: HandshakeKind;
  at: number;
  expiresAt: number;
  box: string;
}

export interface HandshakeClientOptions {
  /** `https://handshake.waifucave.com`, or a local service in tests. */
  baseUrl: string;
  clock: { now(): number };
  fetch?: (req: Request) => Promise<Response>;
}

/** A signing key in one scope: its last `t`, and a queue so its mutations go one at a time. */
interface Signer {
  key: Ed25519Key;
  last: number;
  queue: Promise<unknown>;
}

export class HandshakeClient {
  readonly #base: string;
  readonly #clock: { now(): number };
  readonly #fetch: (req: Request) => Promise<Response>;
  readonly #signers = new Map<string, Signer>();

  constructor(opts: HandshakeClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#clock = opts.clock;
    this.#fetch = opts.fetch ?? ((req) => fetch(req));
  }

  /** A fresh `t` for a statement (registration and joins carry their own, signed). */
  now(): number {
    return Math.floor(this.#clock.now());
  }

  // ---- pairs ----

  /** Registers a pair, signed by both devices; true for a new one, false when it was there already. */
  async registerPair(body: { pair: string; keys: [string, string]; t: number; sigs: [string, string] }): Promise<boolean> {
    const res = await this.#send("POST", "/v1/pairs", body);
    return res.status === 201;
  }

  async readPair(pair: string, key: Ed25519Key): Promise<PairRead> {
    return (await this.#signed(`pair:${pair}`, key, "GET", `/v1/pairs/${pair}`)).json() as Promise<PairRead>;
  }

  /** Ends a pair at the service, after §8.1's local revoke. A pair already ended counts as ended. */
  async endPair(pair: string, key: Ed25519Key): Promise<void> {
    try {
      await this.#signed(`pair:${pair}`, key, "DELETE", `/v1/pairs/${pair}`);
    } catch (err) {
      if (err instanceof HandshakeError && (err.status === 410 || err.status === 404)) return;
      throw err;
    }
  }

  /** Publishes this device's latest record of a kind; false when the service holds a newer one. */
  async putRecord(pair: string, key: Ed25519Key, kind: HandshakeKind, body: { gen: number; ttl: number; box: string }): Promise<boolean> {
    try {
      await this.#signed(`pair:${pair}`, key, "PUT", `/v1/pairs/${pair}/records/${kind}`, body);
      return true;
    } catch (err) {
      if (err instanceof HandshakeError && err.code === "stale") return false;
      throw err;
    }
  }

  async sendMessage(pair: string, key: Ed25519Key, body: { kind: HandshakeKind; ttl: number; box: string }): Promise<{ id: string; delivered: boolean }> {
    return (await this.#signed(`pair:${pair}`, key, "POST", `/v1/pairs/${pair}/messages`, body)).json() as Promise<{ id: string; delivered: boolean }>;
  }

  async inbox(pair: string, key: Ed25519Key): Promise<InboxMessage[]> {
    const res = (await (await this.#signed(`pair:${pair}`, key, "POST", `/v1/pairs/${pair}/inbox`, undefined)).json()) as { messages: InboxMessage[] };
    return res.messages;
  }

  async pairTicket(pair: string, key: Ed25519Key): Promise<{ url: string; expiresAt: number }> {
    return (await this.#signed(`pair:${pair}`, key, "POST", `/v1/pairs/${pair}/tickets`, undefined)).json() as Promise<{ url: string; expiresAt: number }>;
  }

  // ---- groups ----

  async createGroup(body: { group: string; key: string; t: number; sig: string }): Promise<boolean> {
    return (await this.#send("POST", "/v1/groups", body)).status === 201;
  }

  async joinGroup(group: string, body: GroupJoin): Promise<boolean> {
    return (await this.#send("POST", `/v1/groups/${group}/members`, body)).status === 201;
  }

  /** Removes a member: itself with its own signature alone, another with the removes of a quorum of voters
   *  (`quorum`; refused `403 no_quorum` short of one). */
  async removeGroupMember(group: string, signer: Ed25519Key, member: string, quorum?: { t: number; removes: { by: string; sig: string }[] }): Promise<void> {
    try {
      await this.#signed(`group:${group}`, signer, "DELETE", `/v1/groups/${group}/members/${member}`, quorum);
    } catch (err) {
      if (err instanceof HandshakeError && (err.status === 410 || err.status === 404)) return;
      throw err;
    }
  }

  async readGroup(group: string, key: Ed25519Key): Promise<{ group: string; members: GroupMember[]; lease: LeaseRecord }> {
    return (await this.#signed(`group:${group}`, key, "GET", `/v1/groups/${group}`)).json() as Promise<{ group: string; members: GroupMember[]; lease: LeaseRecord }>;
  }

  /** The group's lease (PROTOCOL.md "Groups and the lease"). A refusal answers `conflict` with the current lease. */
  async lease(group: string, key: Ed25519Key, body: LeaseOpBody): Promise<LeaseRecord> {
    try {
      return ((await (await this.#signed(`group:${group}`, key, "POST", `/v1/groups/${group}/lease`, body)).json()) as { lease: LeaseRecord }).lease;
    } catch (err) {
      throw heldConflict(err);
    }
  }

  // ---- the account channel (devices with an account) ----

  /** `GET /v1/accounts/self`: the account's other online devices, the records addressed to this one, and the lease. */
  async readAccount(token: string): Promise<{ online: string[]; records: unknown[]; lease: LeaseRecord }> {
    return (await this.#send("GET", "/v1/accounts/self", undefined, { authorization: `Bearer ${token}` })).json() as Promise<{ online: string[]; records: unknown[]; lease: LeaseRecord }>;
  }

  /** This device's latest record of a kind for another device of the account; false when the service holds a newer one. */
  async putAccountRecord(token: string, to: string, kind: HandshakeKind, body: { gen: number; ttl: number; box: string }): Promise<boolean> {
    try {
      await this.#send("PUT", `/v1/accounts/self/records/${kind}/${encodeURIComponent(to)}`, body, { authorization: `Bearer ${token}` });
      return true;
    } catch (err) {
      if (err instanceof HandshakeError && err.code === "stale") return false;
      throw err;
    }
  }

  async sendAccountMessage(token: string, body: { to: string; kind: HandshakeKind; ttl: number; box: string }): Promise<{ id: string; delivered: boolean }> {
    return (await this.#send("POST", "/v1/accounts/self/messages", body, { authorization: `Bearer ${token}` })).json() as Promise<{ id: string; delivered: boolean }>;
  }

  async accountInbox(token: string): Promise<InboxMessage[]> {
    return ((await (await this.#send("POST", "/v1/accounts/self/inbox", undefined, { authorization: `Bearer ${token}` })).json()) as { messages: InboxMessage[] }).messages;
  }

  async accountTicket(token: string): Promise<{ url: string; expiresAt: number }> {
    return (await this.#send("POST", "/v1/accounts/self/tickets", undefined, { authorization: `Bearer ${token}` })).json() as Promise<{ url: string; expiresAt: number }>;
  }

  /** The account's lease; its holder is a device id. A refusal answers `conflict` with the current lease. */
  async accountLease(token: string, body: LeaseOpBody): Promise<LeaseRecord> {
    try {
      return ((await (await this.#send("POST", "/v1/accounts/self/lease", body, { authorization: `Bearer ${token}` })).json()) as { lease: LeaseRecord }).lease;
    } catch (err) {
      throw heldConflict(err);
    }
  }

  // ---- the wire ----

  async #send(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const bytes = body === undefined ? new Uint8Array(0) : utf8(JSON.stringify(body));
    const req = new Request(`${this.#base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(method === "GET" ? {} : { body: bytes }),
    });
    const res = await this.#fetch(req);
    if (res.ok) return res;
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
    const retry = Number(res.headers.get("retry-after") ?? "");
    throw new HandshakeError(res.status, typeof parsed?.error === "string" ? parsed.error : "unknown", Number.isFinite(retry) && retry > 0 ? retry : undefined, parsed);
  }

  /** A signed request: `t` is after the key's last in this scope, and mutations go one at a time per key. A `replay`
   *  answer (another client of the same key got ahead) is retried once with a fresh `t`. */
  async #signed(scope: string, key: Ed25519Key, method: string, path: string, body?: unknown): Promise<Response> {
    const id = `${scope}|${toBase64Url(key.publicKey)}`;
    let signer = this.#signers.get(id);
    if (!signer) {
      signer = { key, last: 0, queue: Promise.resolve() };
      this.#signers.set(id, signer);
    }
    const s = signer;
    const run = async (): Promise<Response> => {
      for (let attempt = 0; ; attempt++) {
        const t = Math.max(this.now(), s.last + 1);
        s.last = t;
        const bytes = body === undefined ? new Uint8Array(0) : utf8(JSON.stringify(body));
        try {
          return await this.#send(method, path, body, { authorization: authorizationHeader(key, method, path, t, bytes) });
        } catch (err) {
          if (attempt === 0 && err instanceof HandshakeError && err.code === "replay") continue;
          throw err;
        }
      }
    };
    if (method === "GET") return run();
    const next = s.queue.then(run, run);
    s.queue = next.catch(() => undefined);
    return next;
  }
}

/** A key's public half as the service names members. */
export const memberKey = (key: Ed25519Key): string => toBase64Url(key.publicKey);

export type LeaseOp = "acquire" | "renew" | "release" | "takeover";
export interface LeaseOpBody {
  op: LeaseOp;
  epoch: number;
  /** Seconds, 10–300. */
  ttl?: number;
}

/** A `409 held` as the contracts' `conflict`, carrying the lease the service holds. */
function heldConflict(err: unknown): unknown {
  if (err instanceof HandshakeError && err.code === "held" && err.body?.lease) return new ContractError("conflict", "the lease is held", { lease: err.body.lease });
  return err;
}
