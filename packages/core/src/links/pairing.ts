// Pairing without an account (spec §8.1): a code or QR, the 4-word check on both devices, then the user's sealed card
// (or their own terminal). It runs over its own ALPN (`clover/pair/1`), the one door that takes a key the registry
// doesn't know; the link's ALPN refuses unpaired keys.
//
// The QR carries the pairing's id and 32-byte secret, the host's link key and where to reach it. The short code a
// user can type carries 40 bits naming a rendezvous slot and 80 bits of secret; the host's key and addresses wait in
// the slot, sealed under the code's secret, so the service that holds the slot can't swap the host's key.
//
// The exchange, one framed CBOR message each way per step on one stream:
//   joiner → host  ["hello", {pairingId, device, pairKey, groupKey, group, account, answerKeyProof?, commit, proof}]
//   host → joiner  ["welcome", {device, pairKey, groupKey, group, fresh, t, account, answerKeyProof?, nonce, proof}] or ["refused", {reason}]
//   `device.answerKey` ({publicKey, held, alg?}) is the device's answer key (a phone's own, item 91), and `answerKeyProof` that
//   key's signature over `answerKeyStatement` (base64); both are in the transcript, the record canonically.
//   joiner → host  ["reveal", {nonce}], the nonce `commit` committed to; both show the words only after it
//   both, when their user confirms the words (and their card is approved): ["confirm", {pairSig, admit?}]
// Each device adds the other once both confirms have crossed. The words and the pair secret cover both nonces
// (identity/sas.ts).
//
// The pair door (`clover/pair/1`) is the one that takes an unknown key, so it is kept narrow: a connection is turned
// away unless this device shows a pairing, its first frame must come within `FIRST_FRAME_MS`, and at most
// `MAX_DOOR_ATTEMPTS` run at once.
//
// Items 81 and 85: when either device has no account, each saves a credential for the pair: a fresh signing key
// (never the link key), the pair secret S the handshake's boxes are sealed with, and the registration both signed.
// Devices without an account also form one group per user for the lease: the host's group if it has one, else the
// joiner's, else a new one the host founds; the device not yet in it joins, admitted by the other.
import { createHash, hkdfSync } from "node:crypto";
import { AnswerKeyHolder, type PairingView as PairingViewSchema } from "@waifucave/clover-protocol";
import type { z } from "zod";
import type { Clock } from "../contracts/clock";
import { ContractError, isContractError, Listeners, type Unsubscribe } from "../contracts/common";
import { deviceIdFor, type DeviceRecord, type PairingProof } from "../contracts/device-registry";
import type { SecretStore } from "../contracts/secret-store";
import { type Bytes, constantTimeEqual, fromBase64, fromBase64Url, own, randomBytes, toBase64, toBase64Url, utf8 } from "../identity/bytes";
import type { DeviceKey } from "../identity/device-key";
import { type AnswerKeyAlg, answerKeyBytes, type Ed25519Key, ed25519FromSecret, generateEd25519, verifyEd25519, verifyKeySignature } from "../identity/keys";
import type { TokenRefusal } from "../computers/cloud";
import {
  canonicalRecord, derivePairId, derivePairSecret, finalTranscript, fullTranscript, joinerTranscript, nonceCommitment, PAIR_NONCE_BYTES,
  PAIR_PROOF_HOST, PAIR_PROOF_JOINER, type PairSide, pairProof, sasWords, verifyPairProof,
} from "../identity/sas";
import { type AnswerKeyRecord, answerKeyStatement, type FileDeviceRegistry, type GroupRecord } from "../devices/registry";
import { decode, encode } from "./codec";
import { FrameReader, frame } from "./frames";
import {
  admitStatement, groupKeyRef, groupStatement, type HandshakeClient, joinStatement, openPairBox, pairKeyRef, pairSecretRef, STATEMENT_FRESH_MS,
  pairStatement, sealPairBox,
} from "./handshake";
import { ALPN_PAIR, CLOSE_NORMAL, CLOSE_PROTOCOL, type DialTarget, type WireConn, type WireEndpoint, type WireStream, WIRE_PRIORITY } from "./wire";

type PairingView = z.infer<typeof PairingViewSchema>;

export const PAIRING_TTL_MS = 10 * 60_000;
const QR_PREFIX = "clover-pair:1:";
/** A cloud computer's join ticket (§9.2): the main computer's pairing offer, signed with its link key. */
const TICKET_PREFIX = "clover-join:1:";
/** How long a join ticket works: as long as the single-use token it travels with (`PairingTokens`, an hour). */
export const TICKET_TTL_MS = 60 * 60_000;
const STEP_TIMEOUT_MS = 30_000;
/** How long an incoming pairing connection has to send its hello. */
const FIRST_FRAME_MS = 10_000;
/** How many incoming pairing connections may be under way at once. */
const MAX_DOOR_ATTEMPTS = 4;

/** Where a short code's slot lives: the handshake service's rendezvous (a request to lane I), or a stand-in. */
export interface PairingRendezvous {
  publish(slot: string, box: string, ttlSeconds: number): Promise<void>;
  lookup(slot: string): Promise<string | undefined>;
  remove(slot: string): Promise<void>;
}

/** A stand-in for the service's rendezvous. Like it, a slot is create-only: a box already there is never replaced, so
 *  no one can swap the host's key and addresses for their own. */
export class MemoryRendezvous implements PairingRendezvous {
  readonly slots = new Map<string, string>();
  async publish(slot: string, box: string): Promise<void> {
    if (this.slots.has(slot)) throw new ContractError("conflict", "the slot is taken");
    this.slots.set(slot, box);
  }
  async lookup(slot: string): Promise<string | undefined> {
    return this.slots.get(slot);
  }
  async remove(slot: string): Promise<void> {
    this.slots.delete(slot);
  }
}

/** Cloud computers at the pair door (§9.2 "Safety": pairing tokens work once). On the main computer: whether it is the
 *  main computer now (the lease's, never a setting), the door's check of a VM's token, bound to the device the link
 *  authenticated (`CloudPoint.claim`), and the token used once the VM paired (`CloudPoint.paired`). */
export interface PairingCloud {
  isMain(): boolean;
  claim(token: string, device: string): { computer: string } | { refused: TokenRefusal };
  paired(token: string, device: string): Promise<unknown>;
}

/** What the joining VM is told when the main's door refuses its token, by why (never the token itself). */
const TOKEN_REFUSED: Record<TokenRefusal, string> = {
  unknown: "the pairing token isn't one the main computer made",
  expired: "the pairing token has expired",
  used: "the pairing token was used already",
  "other-device": "the pairing token was presented by another device first",
};

/** The statement a join ticket's signature covers: its pairing, the pinned key, its expiry, the computer it is for, and
 *  (by hash only) the pairing's secret. */
function ticketStatement(id: string, hostKey: Uint8Array, expiresAt: number, computer: string, secret: Uint8Array): Bytes {
  const digest = createHash("sha256").update(secret).digest("base64url");
  return utf8(["clover-join-ticket-v1", id, toBase64Url(hostKey), String(expiresAt), computer, digest].join("\n"));
}

/** How a confirm is approved: in the user's own terminal (no card), or by a sealed card the caller opened. */
export type PairApproval = { terminal: true } | { card: string; allowed: Promise<boolean> };

export type PairingStatus = "waiting" | "words" | "confirmed" | "paired" | "failed" | "cancelled";

export interface PairingState {
  view: PairingView;
  role: "host" | "joiner";
  status: PairingStatus;
  peer?: DeviceRecord;
  error?: string;
}

export type PairingChange = { type: "changed"; pairing: PairingState } | { type: "removed"; pairingId: string };

interface Side {
  key: Bytes;
  record: Omit<DeviceRecord, "addedAt" | "addedBy">;
  pairKey: Bytes;
  groupKey: Bytes;
  group: string | null;
  account: string | null;
}

interface Pending {
  id: string;
  role: "host" | "joiner";
  secret: Bytes;
  expiresAt: number;
  status: PairingStatus;
  view: PairingView;
  slot?: string;
  // Generated for this pairing, kept only if it completes.
  pairKey: Ed25519Key;
  groupKey: Ed25519Key;
  groupKeyIsNew: boolean;
  /** This side's nonce (S2), and the joiner's commitment to its nonce as the host received it. */
  nonce: Bytes;
  peerCommit?: Bytes;
  // Known once hello and welcome crossed.
  peer?: Side;
  transcript?: Bytes;
  words?: string[];
  t?: number;
  group?: string;
  fresh?: boolean;
  stream?: WireStream;
  conn?: WireConn;
  ownConfirm?: { pairSig: Bytes; admit?: Bytes };
  peerConfirm?: { pairSig: Bytes; admit?: Bytes };
  proof?: PairingProof;
  /** A cloud computer's pairing (§9.2): the computer the ticket is for; on the joiner, its token; on the host, the token
   *  its door claimed. Confirmed by the token, with no words to compare (a VM has no user at it). */
  cloud?: { computer: string; token?: string };
  error?: string;
  done?: Promise<void>;
  waiters: ((m: unknown[]) => void)[];
}

export interface PairingServiceOptions {
  self: DeviceKey;
  registry: FileDeviceRegistry;
  wire: WireEndpoint;
  clock: Pick<Clock, "now">;
  store: Pick<SecretStore, "get" | "set" | "delete">;
  /** Where this device is reached, for the QR and the code's slot. */
  selfTarget(): Omit<DialTarget, "key">;
  /** The account this device is signed in with, as an opaque hash both sides compare; null without one. */
  account(): string | null;
  handshake?: HandshakeClient;
  rendezvous?: PairingRendezvous;
  ttlMs?: number;
  /** The pair door's limits, for tests: the first frame's deadline and how many attempts run at once. */
  door?: { firstFrameMs?: number; maxAttempts?: number };
  /** This device moved from its group into the host's in a confirmed pairing (R18): the old group's record, for the
   *  group keeper to ask the old group's computers to follow, each by its own card. */
  onMerged?(old: GroupRecord, via: string): void;
  /** Cloud computers: join tickets and tokens at the door (the main computer's side). Without it, none is issued and
   *  every token is refused. */
  cloud?: PairingCloud;
}

export class PairingService {
  readonly #o: PairingServiceOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Listeners<PairingChange>();
  readonly #off: Unsubscribe;
  #doorAttempts = 0;

  constructor(opts: PairingServiceOptions) {
    this.#o = opts;
    this.#off = opts.wire.onIncoming(ALPN_PAIR, (conn) => void this.#accept(conn));
  }

  watch(fn: (c: PairingChange) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  list(): PairingState[] {
    return [...this.#pending.values()].map((p) => this.#state(p));
  }

  get(pairingId: string): PairingState | undefined {
    const p = this.#pending.get(pairingId);
    return p ? this.#state(p) : undefined;
  }

  /** Shows a code and QR for another device to join (`device.pair.begin`). */
  async begin(): Promise<PairingView> {
    const id = toBase64Url(randomBytes(16));
    const expiresAt = this.#o.clock.now() + (this.#o.ttlMs ?? PAIRING_TTL_MS);
    const target = this.#o.selfTarget();
    let secret: Bytes;
    let code: string | undefined;
    let slot: string | undefined;
    if (this.#o.rendezvous) {
      const raw = randomBytes(15);
      slot = toBase64Url(raw.subarray(0, 5));
      secret = codeSecret(raw.subarray(5));
      code = formatCode(raw);
      const box = sealPairBox(rendezvousKey(raw.subarray(5)), rendezvousContext(slot), {
        v: 1, id, key: toBase64Url(this.#o.self.publicKey), relay: target.relay ?? null, direct: target.direct ?? [], lan: target.lan ?? [], expiresAt,
      });
      await this.#o.rendezvous.publish(slot, box, Math.ceil((expiresAt - this.#o.clock.now()) / 1000));
    } else {
      secret = randomBytes(32);
    }
    const qr = QR_PREFIX + toBase64Url(encode([id, secret, this.#o.self.publicKey, target.relay ?? null, [...(target.direct ?? [])], [...(target.lan ?? [])], expiresAt]));
    const view: PairingView = { pairingId: id, qr, expiresAt, ...(code ? { code } : {}) };
    const p = this.#newPending(id, "host", secret, expiresAt, view, slot);
    this.#emit(p);
    return { ...view };
  }

  /** Joins another device's pairing by its code or QR (`device.pair.join`): dials it, and both show the same words. */
  async join(input: string): Promise<PairingView> {
    return this.#joinOffer(await this.#parse(input.trim()));
  }

  /** A cloud computer's join ticket (§9.2), for the VM it is made for: the main computer's pairing, signed with its
   *  link key, which the VM pins. Only the main computer issues one (the lease's, never a setting); it works for
   *  `TICKET_TTL_MS`, alongside the single-use token minted for the same computer. Synchronous: it goes straight into
   *  the VM's cloud-init. */
  issueTicket(computer: string, ttlMs = TICKET_TTL_MS): string {
    if (!this.#o.cloud?.isMain()) throw new ContractError("refused", "only the main computer issues a join ticket");
    const id = toBase64Url(randomBytes(16));
    const expiresAt = this.#o.clock.now() + ttlMs;
    const secret = randomBytes(32);
    const target = this.#o.selfTarget();
    const sig = this.#o.self.sign(ticketStatement(id, this.#o.self.publicKey, expiresAt, computer, secret));
    const view: PairingView = { pairingId: id, expiresAt };
    const p = this.#newPending(id, "host", secret, expiresAt, view);
    p.cloud = { computer };
    this.#emit(p);
    return TICKET_PREFIX + toBase64Url(encode([id, secret, this.#o.self.publicKey, target.relay ?? null, [...(target.direct ?? [])], [...(target.lan ?? [])], expiresAt, computer, sig]));
  }

  /** A VM joins the main computer with its join ticket and single-use token (§9.2): the ticket's key is pinned (the
   *  link proves the host holds it, and the ticket must be signed by it), the token goes in the hello, and both sides
   *  confirm by the token, with no words to compare. Resolves once paired. */
  async joinTicket(ticket: string, token: string): Promise<void> {
    const offer = parseTicket(ticket.trim());
    const own = this.#o.registry.self();
    if (own.computer !== offer.computer) throw new ContractError("refused", `the join ticket is for ${offer.computer}, not this computer`);
    await this.#joinOffer(offer, { computer: offer.computer, token });
    // Paired once both confirms crossed; the host's may still be on its way.
    await new Promise<void>((resolve, reject) => {
      let off: Unsubscribe = () => undefined;
      const timer = setTimeout(() => settle(new ContractError("timeout", "the main computer didn't confirm")), STEP_TIMEOUT_MS);
      const settle = (err?: Error) => {
        clearTimeout(timer);
        off();
        if (err) reject(err);
        else resolve();
      };
      const check = () => {
        const p = this.#pending.get(offer.id);
        if (p?.status === "paired") settle();
        else if (!p || p.status === "failed" || p.status === "cancelled") settle(new ContractError("refused", p?.error ?? "the pairing ended"));
      };
      off = this.watch(check);
      check();
    });
  }

  async #joinOffer(offer: { id: string; secret: Bytes; hostKey: Bytes; relay?: string; direct: string[]; lan: string[]; expiresAt: number }, cloud?: { computer: string; token: string }): Promise<PairingView> {
    if (offer.expiresAt <= this.#o.clock.now()) throw new ContractError("refused", "the pairing has expired");
    if (offer.hostKey.length !== 32) throw new ContractError("invalid", "not a pairing code");
    if (toBase64(offer.hostKey) === this.#o.self.publicKeyBase64) throw new ContractError("invalid", "this is this device's own pairing");
    const view: PairingView = { pairingId: offer.id, expiresAt: offer.expiresAt };
    const p = this.#newPending(offer.id, "joiner", offer.secret, offer.expiresAt, view);
    if (cloud) p.cloud = cloud;
    const conn = await this.#o.wire.dial({ key: offer.hostKey, ...(offer.relay ? { relay: offer.relay } : {}), direct: offer.direct, lan: offer.lan }, { alpn: ALPN_PAIR, timeoutMs: STEP_TIMEOUT_MS }).catch((err: unknown) => {
      this.#fail(p, "the other device can't be reached");
      throw new ContractError("offline", "the other device can't be reached", { cause: String(err) });
    });
    p.conn = conn;
    const stream = conn.openStream(WIRE_PRIORITY.control);
    this.#bind(p, stream);
    await this.#loadGroupKey(p);
    const own = this.#ownSide(p);
    const commit = nonceCommitment(p.nonce);
    const joinerPart = joinerTranscript(p.id, offer.hostKey, sideForTranscript(own), commit);
    // The host's door turns a connection away when it shows no pairing (or is busy): a refusal, not a lost network.
    const turnedAway = (err: unknown): never => {
      this.#fail(p, "the other device isn't showing this pairing");
      throw isContractError(err, "timeout") ? err : new ContractError("refused", p.error!);
    };
    await this.#send(p, ["hello", {
      v: 1, pairingId: p.id, device: own.record, pairKey: own.pairKey, groupKey: own.groupKey, group: own.group, account: own.account,
      ...this.#answerKeyProof(), commit, proof: pairProof(p.secret, PAIR_PROOF_JOINER, joinerPart),
      // The token rides only to the key the ticket pinned, inside the link's encryption, after the pairing's proof.
      ...(cloud ? { cloudToken: cloud.token } : {}),
    }]).catch(turnedAway);
    const reply = await this.#next(p).catch(turnedAway);
    if (reply[0] === "refused") {
      this.#fail(p, String((reply[1] as { reason?: string })?.reason ?? "refused"));
      throw new ContractError("refused", p.error ?? "the other device refused");
    }
    if (reply[0] !== "welcome") return this.#protocol(p);
    const w = reply[1] as Record<string, unknown>;
    const host = this.#readSide(w, conn.peerKey);
    if (!host || toBase64(conn.peerKey) !== toBase64(offer.hostKey) || (await deviceIdFor(conn.peerKey)) !== host.record.id) return this.#protocol(p);
    if (typeof w.t !== "number" || typeof w.group !== "string" || typeof w.fresh !== "boolean") return this.#protocol(p);
    // The host's `t` dates the statements both sign, its admit of this device among them: an old one is refused, so a
    // host holding another device's old admit can't replay it here (I's review).
    if (Math.abs(w.t - this.#o.clock.now()) > STATEMENT_FRESH_MS) {
      this.#fail(p, "the other device's clock is too far off (or it replayed an old pairing)");
      conn.close(CLOSE_PROTOCOL, "stale t");
      throw new ContractError("refused", p.error!);
    }
    if (!(w.nonce instanceof Uint8Array) || w.nonce.length !== PAIR_NONCE_BYTES) return this.#protocol(p);
    const transcript = fullTranscript(joinerPart, sideForTranscript(host, false), { t: w.t, group: w.group, nonce: w.nonce });
    if (!(w.proof instanceof Uint8Array) || !verifyPairProof(p.secret, PAIR_PROOF_HOST, transcript, w.proof)) {
      this.#fail(p, "the other device doesn't hold the pairing's secret");
      conn.close(CLOSE_PROTOCOL, "bad proof");
      throw new ContractError("refused", p.error!);
    }
    p.peer = host;
    p.t = w.t;
    p.group = w.group;
    p.fresh = w.fresh;
    // The host's side is fixed now: reveal the nonce it couldn't see, then both show the words.
    await this.#send(p, ["reveal", { nonce: p.nonce }]);
    this.#agreed(p, finalTranscript(transcript, p.nonce));
    if (p.cloud) await this.#confirmByToken(p);
    return { ...p.view };
  }

  /** The user saw the same words on both devices (`device.pair.confirm`). The device is added once both confirmed. */
  async confirm(pairingId: string, words: readonly string[], approval: PairApproval): Promise<void> {
    const p = this.#pending.get(pairingId);
    if (!p) throw new ContractError("not_found", `no pairing ${pairingId}`);
    if (p.status !== "words" || !p.words || !p.peer) throw new ContractError("conflict", "the pairing isn't showing its words");
    if (words.length !== 4 || words.some((w, i) => w.toLowerCase() !== p.words![i])) {
      this.#fail(p, "the words don't match");
      p.conn?.close(CLOSE_PROTOCOL, "words differ");
      throw new ContractError("refused", "the words don't match: pair again");
    }
    if ("card" in approval) {
      p.status = "confirmed";
      this.#emit(p);
      const allowed = await approval.allowed;
      if (!allowed) {
        await this.#send(p, ["cancel"]).catch(() => undefined);
        this.#fail(p, "the card was denied");
        p.conn?.close(CLOSE_NORMAL, "denied");
        throw new ContractError("refused", "the card was denied");
      }
      p.proof = { via: "code", card: approval.card };
    } else {
      p.proof = { via: "terminal" };
    }
    await this.#confirmed(p);
  }

  /** A cloud computer's pairing is confirmed by its token (the host's door checked it), on both sides at once. */
  async #confirmByToken(p: Pending): Promise<void> {
    if (!p.cloud || p.status !== "words") return;
    p.proof = { via: "cloud-token", computer: p.cloud.computer };
    try {
      await this.#confirmed(p);
    } catch (err) {
      this.#fail(p, err instanceof Error ? err.message : "the pairing failed");
      throw err;
    }
  }

  async #confirmed(p: Pending): Promise<void> {
    if (!p.peer) throw new ContractError("conflict", "the pairing isn't showing its words");
    if ((p.status as PairingStatus) === "failed" || (p.status as PairingStatus) === "cancelled") throw new ContractError("refused", p.error ?? "the pairing ended");
    p.status = "confirmed";
    const needsPair = this.#needsPair(p);
    const mineIsHost = p.role === "host";
    const keys = this.#pairKeys(p);
    const pairSig = needsPair ? p.pairKey.sign(pairStatement(keys.pairId, keys.ordered, p.t!)) : new Uint8Array(0);
    let admit: Bytes | undefined;
    if (this.#groupExchange(p) && !this.#isNewcomer(p)) {
      if (p.fresh && mineIsHost) await this.#foundGroup(p);
      admit = p.groupKey.sign(admitStatement(p.group!, toBase64Url(p.peer.groupKey), p.t!));
    }
    p.ownConfirm = { pairSig: own(pairSig), ...(admit ? { admit } : {}) };
    await this.#send(p, ["confirm", { pairSig, ...(admit ? { admit } : {}) }]);
    this.#emit(p);
    if (p.peerConfirm) await this.#finish(p);
  }

  async cancel(pairingId: string): Promise<void> {
    const p = this.#pending.get(pairingId);
    if (!p) return;
    if (p.status !== "paired") {
      await this.#send(p, ["cancel"]).catch(() => undefined);
      p.status = "cancelled";
      p.conn?.close(CLOSE_NORMAL, "cancelled");
    }
    this.#remove(p);
  }

  async close(): Promise<void> {
    this.#off();
    for (const p of [...this.#pending.values()]) await this.cancel(p.id);
  }

  // ---- the host's side ----

  async #accept(conn: WireConn): Promise<void> {
    // The door is shut while this device shows no pairing, and takes only a few attempts at once.
    const open = [...this.#pending.values()].some((p) => p.role === "host" && p.status === "waiting" && p.expiresAt > this.#o.clock.now());
    if (!open || this.#doorAttempts >= (this.#o.door?.maxAttempts ?? MAX_DOOR_ATTEMPTS)) {
      conn.close(CLOSE_NORMAL, open ? "busy" : "no pairing is open");
      return;
    }
    this.#doorAttempts++;
    try {
      await this.#acceptOne(conn);
    } finally {
      this.#doorAttempts--;
    }
  }

  async #acceptOne(conn: WireConn): Promise<void> {
    const deadline = setTimeout(() => conn.close(CLOSE_PROTOCOL, "no hello in time"), this.#o.door?.firstFrameMs ?? FIRST_FRAME_MS);
    const stream = await new Promise<WireStream | undefined>((resolve) => {
      const off = conn.onStream((s) => {
        off();
        resolve(s);
      });
      void conn.closed.then(() => resolve(undefined));
    });
    if (!stream) {
      clearTimeout(deadline);
      return;
    }
    const reader = new FrameReader(64 * 1024);
    // Frames after the hello wait here until `#bind` takes the stream over.
    const early: Uint8Array[] = [];
    let got = false;
    let offData: Unsubscribe | undefined;
    const first = await new Promise<unknown[] | undefined>((resolve) => {
      offData = stream.onData((chunk) => {
        if (got) return void early.push(chunk);
        try {
          const frames = reader.push(chunk);
          // The joiner sends nothing after its hello until the welcome: a second frame is a protocol error.
          if (frames.length > 1) resolve(undefined);
          else if (frames.length === 1) {
            got = true;
            resolve(decode(frames[0]!) as unknown[]);
          }
        } catch {
          resolve(undefined);
        }
      });
      stream.onFin(() => resolve(undefined));
      stream.onReset(() => resolve(undefined));
      void conn.closed.then(() => resolve(undefined));
    });
    clearTimeout(deadline);
    offData?.();
    const refuse = (reason: string) => {
      void stream.write(frame(encode(["refused", { reason }]))).catch(() => undefined);
      stream.finish();
      setTimeout(() => conn.close(CLOSE_NORMAL, reason), 50);
    };
    if (!Array.isArray(first) || first[0] !== "hello" || typeof first[1] !== "object" || first[1] === null) return refuse("not a pairing");
    const h = first[1] as Record<string, unknown>;
    const p = typeof h.pairingId === "string" ? this.#pending.get(h.pairingId) : undefined;
    if (!p || p.role !== "host") return refuse("no such pairing");
    if (p.status !== "waiting") return refuse("the pairing is taken");
    if (p.expiresAt <= this.#o.clock.now()) {
      this.#fail(p, "expired");
      return refuse("the pairing has expired");
    }
    const joiner = this.#readSide(h, conn.peerKey);
    if (!joiner || (await deviceIdFor(conn.peerKey)) !== joiner.record.id) return refuse("the device record doesn't match its key");
    if (this.#o.registry.get(joiner.record.id)?.revokedAt !== undefined) return refuse("this device was revoked: pair it with a new key");
    if (this.#o.registry.get(joiner.record.id)) return refuse("already paired");
    if (!(h.commit instanceof Uint8Array) || h.commit.length !== 32) return refuse("not a pairing");
    // A cloud computer's pairing takes its token, and an ordinary one never does.
    if ((p.cloud !== undefined) !== (typeof h.cloudToken === "string")) return refuse(p.cloud ? "a join ticket's pairing needs its token" : "not a cloud pairing");
    const joinerPart = joinerTranscript(p.id, this.#o.self.publicKey, sideForTranscript(joiner), h.commit);
    if (!(h.proof instanceof Uint8Array) || !verifyPairProof(p.secret, PAIR_PROOF_JOINER, joinerPart, h.proof)) {
      // One wrong proof ends the pairing, so a short code can't be guessed at online.
      this.#fail(p, "a device tried the pairing without its secret");
      return refuse("bad proof");
    }
    if (p.cloud) {
      // §9.2: only the main computer takes a VM in, and only the computer its token was made for, under that name. The
      // token is bound to the device the link authenticated: presented by any other device, it is refused.
      if (!this.#o.cloud?.isMain()) {
        this.#fail(p, "this computer isn't the main computer any more");
        return refuse("this computer isn't the main computer");
      }
      if (!joiner.record.runsCore || joiner.record.computer !== p.cloud.computer) {
        this.#fail(p, `a device that isn't ${p.cloud.computer} presented its ticket`);
        return refuse(`the join ticket is for ${p.cloud.computer}`);
      }
      const claim = this.#o.cloud.claim(h.cloudToken as string, joiner.record.id);
      if ("refused" in claim) {
        this.#fail(p, TOKEN_REFUSED[claim.refused]);
        return refuse(TOKEN_REFUSED[claim.refused]);
      }
      if (claim.computer !== p.cloud.computer) {
        this.#fail(p, "the pairing token was made for another computer");
        return refuse("the pairing token was made for another computer");
      }
      p.cloud = { computer: p.cloud.computer, token: h.cloudToken as string };
    }
    p.conn = conn;
    this.#bind(p, stream, reader, early);
    p.peer = joiner;
    await this.#loadGroupKey(p);
    const mine = this.#ownSide(p);
    const hostGroup = this.#o.registry.group()?.id ?? null;
    p.group = hostGroup ?? joiner.group ?? toBase64Url(randomBytes(16));
    p.fresh = hostGroup === null && joiner.group === null;
    p.t = Math.floor(this.#o.clock.now());
    const transcript = fullTranscript(joinerPart, sideForTranscript(mine, false), { t: p.t, group: p.group, nonce: p.nonce });
    p.peerCommit = own(h.commit);
    await this.#send(p, ["welcome", {
      v: 1, device: mine.record, ...this.#answerKeyProof(), pairKey: mine.pairKey, groupKey: mine.groupKey, group: p.group, fresh: p.fresh, t: p.t, account: mine.account,
      nonce: p.nonce, proof: pairProof(p.secret, PAIR_PROOF_HOST, transcript),
    }]);
    if (p.slot) void this.#o.rendezvous?.remove(p.slot).catch(() => undefined);
    // The joiner reveals the nonce it committed to; only then are the words fixed.
    let reveal: unknown[];
    try {
      reveal = await this.#next(p);
    } catch {
      this.#fail(p, "the other device went away");
      conn.close(CLOSE_NORMAL, "no reveal");
      return;
    }
    const nonce = (reveal[1] as { nonce?: unknown } | undefined)?.nonce;
    if (reveal[0] !== "reveal" || !(nonce instanceof Uint8Array) || nonce.length !== PAIR_NONCE_BYTES || !constantTimeEqual(nonceCommitment(nonce), p.peerCommit)) {
      this.#fail(p, "the other device's nonce doesn't match its commitment");
      conn.close(CLOSE_PROTOCOL, "bad reveal");
      return;
    }
    this.#agreed(p, finalTranscript(transcript, nonce));
    if (p.cloud) await this.#confirmByToken(p).catch(() => undefined);
  }

  // ---- both sides ----

  #agreed(p: Pending, transcript: Bytes): void {
    p.transcript = transcript;
    p.words = sasWords(p.secret, transcript);
    p.status = "words";
    p.view = { ...p.view, words: p.words };
    this.#emit(p);
    void this.#pump(p);
  }

  async #loadGroupKey(p: Pending): Promise<void> {
    const g = this.#o.registry.group();
    if (g) {
      const stored = await this.#o.store.get(groupKeyRef(g.id));
      if (stored) {
        p.groupKey = ed25519FromSecret(stored.value);
        p.groupKeyIsNew = false;
      }
    }
  }

  /** Reads what the peer sends after the words: its confirm, or a cancel. */
  async #pump(p: Pending): Promise<void> {
    for (;;) {
      let m: unknown[];
      try {
        m = await this.#next(p, p.expiresAt - this.#o.clock.now() + STEP_TIMEOUT_MS);
      } catch {
        if (p.status !== "paired") this.#fail(p, p.error ?? "the other device went away");
        return;
      }
      if (m[0] === "cancel") {
        this.#fail(p, "the other device cancelled");
        p.conn?.close(CLOSE_NORMAL, "cancelled");
        return;
      }
      if (m[0] !== "confirm" || typeof m[1] !== "object" || m[1] === null) {
        this.#fail(p, "protocol");
        p.conn?.close(CLOSE_PROTOCOL, "protocol");
        return;
      }
      const c = m[1] as { pairSig?: unknown; admit?: unknown };
      if (!(c.pairSig instanceof Uint8Array) || (c.admit !== undefined && !(c.admit instanceof Uint8Array))) {
        this.#fail(p, "protocol");
        return;
      }
      const keys = this.#pairKeys(p);
      if (this.#needsPair(p) && !verifyEd25519(p.peer!.pairKey, pairStatement(keys.pairId, keys.ordered, p.t!), c.pairSig)) {
        this.#fail(p, "the other device's pair signature is wrong");
        return;
      }
      if (this.#groupExchange(p) && this.#isNewcomer(p)) {
        if (!(c.admit instanceof Uint8Array) || !verifyEd25519(p.peer!.groupKey, admitStatement(p.group!, toBase64Url(p.groupKey.publicKey), p.t!), c.admit)) {
          this.#fail(p, "the other device's group admission is wrong");
          return;
        }
      }
      p.peerConfirm = { pairSig: own(c.pairSig), ...(c.admit instanceof Uint8Array ? { admit: own(c.admit) } : {}) };
      if (p.ownConfirm) await this.#finish(p);
      return;
    }
  }

  /** Both confirmed: add the device, keep the pair's credential and join the group. */
  async #finish(p: Pending): Promise<void> {
    if (p.done) return p.done;
    p.done = (async () => {
      const peer = p.peer!;
      await this.#o.registry.add(peer.record, p.proof!);
      // The VM is in: its token is used, bound to the device that presented it (§9.2).
      if (p.role === "host" && p.cloud?.token !== undefined) {
        const token = p.cloud.token;
        delete p.cloud.token;
        void this.#o.cloud?.paired(token, peer.record.id).catch(() => undefined);
      }
      if (this.#needsPair(p)) {
        const keys = this.#pairKeys(p);
        await this.#o.store.set(pairKeyRef(keys.pairId), p.pairKey.seed(), { synced: false });
        await this.#o.store.set(pairSecretRef(keys.pairId), toBase64(keys.secret), { synced: false });
        const sigs: [string, string] = p.role === "host"
          ? [toBase64Url(p.ownConfirm!.pairSig), toBase64Url(p.peerConfirm!.pairSig)]
          : [toBase64Url(p.peerConfirm!.pairSig), toBase64Url(p.ownConfirm!.pairSig)];
        this.#o.registry.addPair({
          pairId: keys.pairId, peer: peer.record.id, ownKey: toBase64Url(p.pairKey.publicKey), peerKey: toBase64Url(peer.pairKey),
          registration: { t: p.t!, keys: keys.ordered, sigs },
        });
        if (this.#o.handshake) {
          try {
            await this.#o.handshake.registerPair({ pair: keys.pairId, keys: keys.ordered, t: p.t!, sigs });
            this.#o.registry.markPairRegistered(keys.pairId);
          } catch {
            // Kept with its signatures: `retryRegistrations` sends it again.
          }
        }
      }
      if (this.#groupExchange(p)) {
        const peerGroupKey = toBase64Url(peer.groupKey);
        if (this.#isNewcomer(p)) {
          // A merge (R18): both groups were in the transcript the user checked, and the host's survives. This device
          // takes its key along (`from`), and the service moves it out of the old group. It votes at once only if the
          // host's admit is the host group's quorum (a one-voter group's); a vote never carries across groups.
          const old = this.#o.registry.group();
          await this.#o.store.set(groupKeyRef(p.group!), p.groupKey.seed(), { synced: false });
          const mine = toBase64Url(p.groupKey.publicKey);
          const join = {
            key: mine, t: p.t!, sig: toBase64Url(p.groupKey.sign(joinStatement(p.group!, mine, p.t!, old?.id))), by: peerGroupKey, bysig: toBase64Url(p.peerConfirm!.admit!),
            ...(old ? { from: old.id } : {}),
          };
          let joined = false;
          if (this.#o.handshake) {
            try {
              await this.#o.handshake.joinGroup(p.group!, join);
              joined = true;
            } catch {
              // Kept below with its signatures: `retryRegistrations` sends it again.
            }
          }
          if (old && !joined) {
            // A merge the service didn't take: this device stays in its own group (it never leaves on a join that
            // isn't in), and the user can pair again.
            if (old.id !== p.group) await this.#o.store.delete(groupKeyRef(p.group!));
          } else {
            if (old) {
              // The service moved the key already; a service that didn't takes its own removal.
              await this.#o.handshake!.removeGroupMember(old.id, p.groupKey, mine).catch(() => undefined);
              if (old.id !== p.group) await this.#o.store.delete(groupKeyRef(old.id));
              this.#o.registry.leaveGroup("moved");
            }
            this.#o.registry.setGroup({
              id: p.group!, joinedAt: this.#o.clock.now(), ownKey: mine, members: {},
              ...(joined ? {} : { pendingJoin: { ...join, via: peer.record.id } }),
            });
            if (old) this.#o.onMerged?.(old, peer.record.id);
          }
          // The host's key is bound here only once the service took the join it admitted (I's review): otherwise the
          // possession-proved `link.group.info` binds it later.
          if (joined) this.#o.registry.addGroupMember(peer.record.id, peerGroupKey);
        } else {
          this.#o.registry.addGroupMember(peer.record.id, peerGroupKey);
        }
      }
      p.status = "paired";
      this.#emit(p);
      p.stream?.finish();
      setTimeout(() => p.conn?.close(CLOSE_NORMAL, "paired"), 100);
      setTimeout(() => this.#remove(p), 1000);
    })();
    return p.done;
  }

  /** The founder creates a new group at the service before it admits the other device. */
  async #foundGroup(p: Pending): Promise<void> {
    if (this.#o.registry.group()?.id === p.group) return;
    await this.#o.store.set(groupKeyRef(p.group!), p.groupKey.seed(), { synced: false });
    const mine = toBase64Url(p.groupKey.publicKey);
    const create = { group: p.group!, key: mine, t: p.t!, sig: toBase64Url(p.groupKey.sign(groupStatement(p.group!, mine, p.t!))) };
    this.#o.registry.setGroup({ id: p.group!, joinedAt: this.#o.clock.now(), ownKey: mine, members: {}, ...(this.#o.handshake ? {} : { pendingCreate: create }) });
    p.groupKeyIsNew = false;
    if (this.#o.handshake) {
      try {
        await this.#o.handshake.createGroup(create);
      } catch {
        this.#o.registry.setGroup({ ...this.#o.registry.group()!, pendingCreate: create });
      }
    }
  }

  /** Sends the registrations and group requests the service didn't take at pairing time (it was unreachable). A
   *  statement's `t` must be within 10 minutes of the service's clock; an older one needs fresh signatures over the
   *  link (H-M2). */
  async retryRegistrations(): Promise<void> {
    const hs = this.#o.handshake;
    if (!hs) return;
    for (const pr of this.#o.registry.pairs()) {
      if (pr.registeredAt !== undefined || pr.endedAt !== undefined || !pr.registration) continue;
      try {
        await hs.registerPair({ pair: pr.pairId, keys: pr.registration.keys, t: pr.registration.t, sigs: pr.registration.sigs });
        this.#o.registry.markPairRegistered(pr.pairId);
      } catch {
        // next time
      }
    }
    const g = this.#o.registry.group();
    if (g?.pendingCreate) {
      try {
        await hs.createGroup(g.pendingCreate);
        const { pendingCreate: _c, ...rest } = this.#o.registry.group()!;
        this.#o.registry.setGroup(rest);
      } catch {
        // next time
      }
    }
    const g2 = this.#o.registry.group();
    if (g2?.pendingJoin) {
      try {
        const { via: _via, ...join } = g2.pendingJoin;
        await hs.joinGroup(g2.id, join);
        const { pendingJoin: _j, ...rest } = this.#o.registry.group()!;
        this.#o.registry.setGroup(rest);
      } catch {
        // next time
      }
    }
  }

  // ---- helpers ----

  #needsPair(p: Pending): boolean {
    const mine = this.#o.account();
    return mine === null || p.peer?.account === null || p.peer?.account !== mine;
  }

  /** A group forms between two devices that both have no account (R17). Two in different groups merge into the
   *  host's (R18): both group ids are in the transcript whose words the user checked. */
  #groupExchange(p: Pending): boolean {
    return this.#o.account() === null && p.peer?.account === null;
  }

  #isNewcomer(p: Pending): boolean {
    return this.#o.registry.group()?.id !== p.group && !(p.fresh && p.role === "host");
  }

  #pairKeys(p: Pending): { pairId: string; secret: Bytes; ordered: [string, string] } {
    const secret = derivePairSecret(p.secret, p.transcript!);
    const pairId = toBase64Url(derivePairId(secret));
    const mine = toBase64Url(p.pairKey.publicKey);
    const theirs = toBase64Url(p.peer!.pairKey);
    return { pairId, secret, ordered: p.role === "host" ? [mine, theirs] : [theirs, mine] };
  }

  /** This device's answer key's registration, beside its record, when it has one. */
  #answerKeyProof(): { answerKeyProof?: string } {
    const reg = this.#o.registry.ownAnswerKeyProof()?.registration;
    return reg ? { answerKeyProof: reg } : {};
  }

  #ownSide(p: Pending): Side {
    const self = this.#o.registry.self();
    const { addedAt: _a, addedBy: _b, revokedAt: _r, lastSeenAt: _l, ...record } = self;
    return {
      key: this.#o.self.publicKey, record, pairKey: own(p.pairKey.publicKey), groupKey: own(p.groupKey.publicKey),
      group: this.#o.registry.group()?.id ?? null, account: this.#o.account(),
    };
  }

  #readSide(m: Record<string, unknown>, key: Bytes): Side | undefined {
    const d = m.device as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object") return undefined;
    if (typeof d.id !== "string" || typeof d.name !== "string" || typeof d.kind !== "string" || typeof d.runsCore !== "boolean" || typeof d.publicKey !== "string") return undefined;
    if (d.publicKey !== toBase64(key)) return undefined;
    if (!(m.pairKey instanceof Uint8Array) || m.pairKey.length !== 32 || !(m.groupKey instanceof Uint8Array) || m.groupKey.length !== 32) return undefined;
    if (m.group !== null && typeof m.group !== "string") return undefined;
    if (m.account !== null && typeof m.account !== "string") return undefined;
    // A device's answer key travels in its record (a phone's own, item 91; the link key never answers a card), with the
    // registration statement signed by that key: the record is in the transcript the user checks.
    let answerKey: DeviceRecord["answerKey"];
    if (d.answerKey !== undefined) {
      const ak = d.answerKey as { publicKey?: unknown; held?: unknown; alg?: unknown };
      if (ak?.alg !== undefined && ak.alg !== "ed25519" && ak.alg !== "p256") return undefined;
      const alg: AnswerKeyAlg = (ak?.alg as AnswerKeyAlg | undefined) ?? "ed25519";
      const proof = typeof m.answerKeyProof === "string" ? fromBase64(m.answerKeyProof) : null;
      const raw = typeof ak?.publicKey === "string" ? answerKeyBytes(alg, ak.publicKey) : null;
      if (!raw || typeof ak.held !== "string" || !AnswerKeyHolder.safeParse(ak.held).success || !proof) return undefined;
      // With the key's own algorithm: a phone's Secure Enclave key is P-256 (B's #187).
      if (!verifyKeySignature(alg, raw, answerKeyStatement(d.id, ak.publicKey as string, ak.held, alg), proof)) return undefined;
      answerKey = { publicKey: ak.publicKey as string, held: ak.held as NonNullable<DeviceRecord["answerKey"]>["held"], ...(alg === "p256" ? { alg } : {}) } as AnswerKeyRecord;
    }
    const record: Side["record"] = {
      id: d.id, name: d.name, kind: d.kind as DeviceRecord["kind"], runsCore: d.runsCore, publicKey: d.publicKey,
      ...(typeof d.os === "string" ? { os: d.os as DeviceRecord["os"] } : {}),
      ...(typeof d.computer === "string" ? { computer: d.computer } : {}),
      ...(typeof d.hasDisplay === "boolean" ? { hasDisplay: d.hasDisplay } : {}),
      ...(answerKey ? { answerKey } : {}),
    };
    return { key, record, pairKey: own(m.pairKey), groupKey: own(m.groupKey), group: m.group as string | null, account: m.account as string | null };
  }

  #newPending(id: string, role: "host" | "joiner", secret: Bytes, expiresAt: number, view: PairingView, slot?: string): Pending {
    const p: Pending = {
      id, role, secret, expiresAt, status: "waiting", view, pairKey: generateEd25519(), groupKey: generateEd25519(), groupKeyIsNew: true,
      nonce: randomBytes(PAIR_NONCE_BYTES),
      waiters: [], ...(slot ? { slot } : {}),
    };
    this.#pending.set(id, p);
    return p;
  }

  #bind(p: Pending, stream: WireStream, reader = new FrameReader(64 * 1024), early: readonly Uint8Array[] = []): void {
    p.stream = stream;
    const queue: unknown[][] = [];
    const deliver = (m: unknown[]) => {
      const w = p.waiters.shift();
      if (w) w(m);
      else queue.push(m);
    };
    (p as Pending & { queue: unknown[][] }).queue = queue;
    const take = (chunk: Uint8Array) => {
      try {
        for (const f of reader.push(chunk)) {
          const m = decode(f);
          if (Array.isArray(m)) deliver(m);
        }
      } catch {
        stream.reset(1);
      }
    };
    for (const c of early) take(c);
    stream.onData(take);
    const end = () => deliver(["__end"]);
    stream.onFin(end);
    stream.onReset(end);
  }

  async #next(p: Pending, timeoutMs = STEP_TIMEOUT_MS): Promise<unknown[]> {
    const queue = (p as Pending & { queue?: unknown[][] }).queue ?? [];
    const m = queue.shift() ?? (await new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        p.waiters.splice(p.waiters.indexOf(waiter), 1);
        reject(new ContractError("timeout", "the other device didn't answer"));
      }, Math.max(1000, timeoutMs));
      const waiter = (x: unknown[]) => {
        clearTimeout(timer);
        resolve(x);
      };
      p.waiters.push(waiter);
    }));
    if (m[0] === "__end") throw new ContractError("closed", "the other device went away");
    return m;
  }

  async #send(p: Pending, m: unknown[]): Promise<void> {
    if (!p.stream) throw new ContractError("closed", "no pairing stream");
    await p.stream.write(frame(encode(m)));
  }

  #protocol(p: Pending): never {
    this.#fail(p, "the other device answered something that isn't a pairing");
    p.conn?.close(CLOSE_PROTOCOL, "protocol");
    throw new ContractError("refused", p.error!);
  }

  #fail(p: Pending, reason: string): void {
    if (p.status === "paired" || p.status === "failed" || p.status === "cancelled") return;
    p.status = "failed";
    p.error = reason;
    if (p.slot) void this.#o.rendezvous?.remove(p.slot).catch(() => undefined);
    this.#emit(p);
  }

  #remove(p: Pending): void {
    if (this.#pending.get(p.id) !== p) return;
    this.#pending.delete(p.id);
    this.#listeners.emit({ type: "removed", pairingId: p.id });
  }

  #state(p: Pending): PairingState {
    return {
      view: { ...p.view }, role: p.role, status: p.status,
      ...(p.peer && p.status !== "waiting" ? { peer: { ...p.peer.record, addedAt: 0, addedBy: p.proof?.via ?? "code" } } : {}),
      ...(p.error ? { error: p.error } : {}),
    };
  }

  #emit(p: Pending): void {
    this.#listeners.emit({ type: "changed", pairing: this.#state(p) });
  }

  async #parse(input: string): Promise<{ id: string; secret: Bytes; hostKey: Bytes; relay?: string; direct: string[]; lan: string[]; expiresAt: number }> {
    if (input.startsWith(QR_PREFIX)) {
      const bytes = fromBase64Url(input.slice(QR_PREFIX.length));
      let v: unknown;
      try {
        v = bytes ? decode(bytes) : undefined;
      } catch {
        v = undefined;
      }
      if (!Array.isArray(v) || v.length !== 7) throw new ContractError("invalid", "not a pairing code");
      const [id, secret, hostKey, relay, direct, lan, expiresAt] = v as [unknown, unknown, unknown, unknown, unknown, unknown, unknown];
      if (typeof id !== "string" || !(secret instanceof Uint8Array) || secret.length !== 32 || !(hostKey instanceof Uint8Array) || typeof expiresAt !== "number") throw new ContractError("invalid", "not a pairing code");
      return {
        id, secret: own(secret), hostKey: own(hostKey), ...(typeof relay === "string" ? { relay } : {}),
        direct: Array.isArray(direct) ? direct.filter((x): x is string => typeof x === "string") : [],
        lan: Array.isArray(lan) ? lan.filter((x): x is string => typeof x === "string") : [], expiresAt,
      };
    }
    const raw = parseCode(input);
    if (!raw) throw new ContractError("invalid", "not a pairing code");
    if (!this.#o.rendezvous) throw new ContractError("refused", "a short code needs the handshake service; scan the QR instead");
    const slot = toBase64Url(raw.subarray(0, 5));
    const box = await this.#o.rendezvous.lookup(slot);
    const offer = box === undefined ? undefined : (openPairBox(rendezvousKey(raw.subarray(5)), rendezvousContext(slot), box) as Record<string, unknown> | undefined);
    if (!offer || typeof offer.id !== "string" || typeof offer.key !== "string" || typeof offer.expiresAt !== "number") throw new ContractError("not_found", "no pairing has this code: check it, or start again");
    const hostKey = fromBase64Url(offer.key);
    if (!hostKey) throw new ContractError("invalid", "not a pairing code");
    return {
      id: offer.id, secret: codeSecret(raw.subarray(5)), hostKey, ...(typeof offer.relay === "string" ? { relay: offer.relay } : {}),
      direct: Array.isArray(offer.direct) ? (offer.direct as string[]) : [], lan: Array.isArray(offer.lan) ? (offer.lan as string[]) : [],
      expiresAt: offer.expiresAt,
    };
  }
}

/** A side as the transcript has it. The joiner's group is its own; the host's is the group the welcome names, which
 *  the transcript holds already (`fullTranscript`'s `group`), so a merge's two groups are both in what the user checks. */
function sideForTranscript(s: Side, withGroup = true): PairSide {
  return { key: s.key, record: canonicalRecord(s.record), pairKey: s.pairKey, groupKey: s.groupKey, group: withGroup ? s.group : null };
}

// ---- the short code: 15 bytes in Crockford base32, six groups of four ----

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function formatCode(raw: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of raw) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out.match(/.{1,4}/g)!.join("-");
}

export function parseCode(code: string): Bytes | undefined {
  const clean = code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{24}$/.test(clean)) return undefined;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | CROCKFORD.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return out.length === 15 ? own(new Uint8Array(out)) : undefined;
}

function codeSecret(part: Uint8Array): Bytes {
  return own(new Uint8Array(hkdfSync("sha256", part, new Uint8Array(0), utf8("clover/pair-code-secret/1"), 32)));
}

function rendezvousKey(part: Uint8Array): Bytes {
  return own(new Uint8Array(hkdfSync("sha256", part, new Uint8Array(0), utf8("clover/pair-rendezvous/1"), 32)));
}

function rendezvousContext(slot: string) {
  return { scope: slot, from: "host", to: "joiner", kind: "signal" as const };
}

/** A join ticket, read and checked: signed by the key it pins, for the computer it names. */
function parseTicket(input: string): { id: string; secret: Bytes; hostKey: Bytes; relay?: string; direct: string[]; lan: string[]; expiresAt: number; computer: string } {
  if (!input.startsWith(TICKET_PREFIX)) throw new ContractError("invalid", "not a join ticket");
  const bytes = fromBase64Url(input.slice(TICKET_PREFIX.length));
  let v: unknown;
  try {
    v = bytes ? decode(bytes) : undefined;
  } catch {
    v = undefined;
  }
  if (!Array.isArray(v) || v.length !== 9) throw new ContractError("invalid", "not a join ticket");
  const [id, secret, hostKey, relay, direct, lan, expiresAt, computer, sig] = v as unknown[];
  if (typeof id !== "string" || !(secret instanceof Uint8Array) || secret.length !== 32 || !(hostKey instanceof Uint8Array) || hostKey.length !== 32
    || typeof expiresAt !== "number" || typeof computer !== "string" || !(sig instanceof Uint8Array)) throw new ContractError("invalid", "not a join ticket");
  // The pinned key must have signed it: a ticket whose key was swapped, or one another key made, is refused.
  if (!verifyEd25519(hostKey, ticketStatement(id, hostKey, expiresAt, computer, secret), sig)) throw new ContractError("refused", "the join ticket isn't signed by the computer it pins");
  return {
    id, secret: own(secret), hostKey: own(hostKey), ...(typeof relay === "string" ? { relay } : {}),
    direct: Array.isArray(direct) ? direct.filter((x): x is string => typeof x === "string") : [],
    lan: Array.isArray(lan) ? lan.filter((x): x is string => typeof x === "string") : [], expiresAt, computer,
  };
}
