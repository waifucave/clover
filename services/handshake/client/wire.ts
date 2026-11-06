// The handshake's wire format v1 (services/handshake/PROTOCOL.md) as constants and shapes, shared by the service and
// its clients. Plain TypeScript with no runtime dependencies: it runs in Workers, Bun and browsers alike.

export const PREFIX = "clover-handshake-v1";

/** 16 random bytes, base64url: a pair or group id. */
export const SCOPE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** An Ed25519 public key, 32 bytes, base64url. */
export const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** An Ed25519 signature, 64 bytes, base64url. */
export const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
/** A device id in the account channel (the account token's `dev`). */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A short pairing code's rendezvous slot: 5 bytes (40 bits of the code), base64url. Canonical: the last character
 *  carries 4 bits and two zero bits. */
export const SLOT_RE = /^[A-Za-z0-9_-]{6}[AEIMQUYcgkosw048]$/;
/** The token that removes a rendezvous slot: 16 to 32 random bytes, base64url, chosen by the host at `PUT`. */
export const SLOT_TOKEN_RE = /^[A-Za-z0-9_-]{22,43}$/;

export type ScopeKind = "pair" | "group" | "account";

export type Kind = "addr" | "dial" | "signal";

export interface KindRule {
  as: "record" | "message";
  /** Seconds. */
  maxTtl: number;
  defaultTtl: number;
  /** Decoded bytes. */
  maxBox: number;
}

export const KINDS: Readonly<Record<Kind, KindRule>> = {
  addr: { as: "record", maxTtl: 3600, defaultTtl: 900, maxBox: 4096 },
  dial: { as: "message", maxTtl: 60, defaultTtl: 30, maxBox: 4096 },
  signal: { as: "message", maxTtl: 120, defaultTtl: 60, maxBox: 8192 },
};

export function isKind(value: unknown): value is Kind {
  return typeof value === "string" && Object.hasOwn(KINDS, value);
}

export const LIMITS = {
  maxBodyBytes: 16 * 1024,
  statementWindowMs: 10 * 60_000,
  requestWindowMs: 120_000,
  queuedPerRecipient: 16,
  membersPerGroup: 32,
  ticketTtlMs: 60_000,
  presenceStaleMs: 90_000,
  tombstoneMs: 30 * 24 * 3600_000,
  /** The longest an account token lasts, plus skew: how long a revoked device is refused. */
  revocationKeepMs: 24 * 3600_000 + 10 * 60_000,
  /** The longest an account-channel socket stays open before it must be opened again with a fresh token. */
  accountSocketMaxMs: 24 * 3600_000,
  lease: { minTtl: 10, maxTtl: 300, defaultTtl: 60 },
  /** Group recovery: how long an admitted member waits for its vote, and how far back a rollback reaches. */
  recovery: { voteDelayMs: 72 * 3600_000, rollbackMs: 7 * 24 * 3600_000 },
  /** A short code's slot: seconds it may live (a pairing lasts 10 minutes), and its sealed box's decoded bytes. */
  rendezvous: { maxTtl: 600, maxBox: 4096 },
} as const;

export const CLOSE = {
  replaced: 4000,
  ended: 4003,
  protocol: 4008,
  stale: 4009,
  reauth: 4010,
} as const;

export const PING = "ping";
export const PONG = "pong";

export type LeaseOp = "acquire" | "renew" | "release" | "takeover";

export interface LeaseView {
  holder: string | null;
  epoch: number;
  expiresAt: number;
}

export interface RecordView {
  from: string;
  kind: Kind;
  gen: number;
  expiresAt: number;
  box: string;
}

export interface MessageView {
  id: string;
  from: string;
  kind: Kind;
  at: number;
  expiresAt: number;
  box: string;
}

export interface MemberView {
  key: string;
  joinedAt: number;
  /** Groups: when the member's vote starts (PROTOCOL.md, "Group recovery"); at or before now, it votes. */
  votesFrom?: number;
  /** Groups: the member that admitted it; absent for the founder. */
  admittedBy?: string;
}

/** The group's recovery key voted in a change: `by` is the member that sent it, `target` the key it changed. */
export interface RecoveryUse {
  change: "admit" | "remove" | "recovery";
  target: string | null;
  by: string;
  at: number;
}

/** What the service sends on a socket. */
export type ServiceFrame =
  | { t: "hello"; v: 1; scope: "pair"; peer: { online: boolean } }
  | {
      t: "hello";
      v: 1;
      scope: "group";
      lease: LeaseView;
      members: MemberView[];
      recovery: boolean;
      /** The last time the recovery key voted, within 7 days, for a member that was offline then. */
      recoveryUsed?: RecoveryUse;
    }
  | { t: "hello"; v: 1; scope: "account"; online: string[]; lease: LeaseView }
  | ({ t: "record" } & RecordView)
  | ({ t: "message" } & MessageView)
  | { t: "presence"; online: boolean; device?: string }
  | { t: "lease"; lease: LeaseView }
  | { t: "members"; members: MemberView[]; recovery: boolean }
  /** The group's recovery key voted in a change: the surviving device shows a card. */
  | ({ t: "recovery" } & RecoveryUse)
  | { t: "bye"; reason: "replaced" | "ended" | "stale" | "reauth" };

// ---- what gets signed ----

/** The pair statement both devices sign at registration. */
export function pairStatement(pair: string, keyA: string, keyB: string, t: number): string {
  return [`${PREFIX} pair`, pair, keyA, keyB, String(t)].join("\n");
}

export function groupStatement(group: string, key: string, t: number): string {
  return [`${PREFIX} group`, group, key, String(t)].join("\n");
}

export function joinStatement(group: string, key: string, t: number): string {
  return [`${PREFIX} join`, group, key, String(t)].join("\n");
}

export function admitStatement(group: string, key: string, t: number): string {
  return [`${PREFIX} admit`, group, key, String(t)].join("\n");
}

/** A co-signer's vote to remove `key` from a group; `keep` is the admitted keys the rollback leaves in (PROTOCOL.md,
 *  "Group recovery"), sorted and comma-joined. */
export function removeStatement(group: string, key: string, t: number, keep: readonly string[] = []): string {
  return [`${PREFIX} remove`, group, key, String(t), [...keep].sort().join(",")].join("\n");
}

/** A vote to set (or, with null, clear) a group's recovery key. */
export function recoveryStatement(group: string, key: string | null, t: number): string {
  return [`${PREFIX} recovery`, group, key ?? "", String(t)].join("\n");
}

/** What a signed request's `sig` covers. `bodyHash` is base64url of SHA-256 over the body bytes (or zero bytes). */
export function requestSigningString(method: string, pathAndQuery: string, t: number, bodyHash: string): string {
  return [`${PREFIX} request`, method.toUpperCase(), pathAndQuery, String(t), bodyHash].join("\n");
}

export function authorizationHeader(key: string, t: number, sig: string): string {
  return `Clover-Sig key=${key}, t=${t}, sig=${sig}`;
}

export function parseAuthorization(value: string | null): { key: string; t: number; sig: string } | null {
  if (!value) return null;
  const match = /^Clover-Sig key=([A-Za-z0-9_-]{43}), t=(\d{1,16}), sig=([A-Za-z0-9_-]{86})$/.exec(value);
  if (!match) return null;
  const t = Number(match[2]);
  if (!Number.isSafeInteger(t)) return null;
  return { key: match[1]!, t, sig: match[3]! };
}

/** The additional data a box is sealed with (PROTOCOL.md, "Boxes"). */
export function boxAad(scope: string, from: string, to: string, kind: Kind, gen?: number): string {
  const lines = [`${PREFIX} box`, scope, from, to, kind];
  if (gen !== undefined) lines.push(String(gen));
  return lines.join("\n");
}

export const BOX_INFO = "clover handshake v1 box";
