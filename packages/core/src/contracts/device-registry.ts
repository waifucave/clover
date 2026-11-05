// Contract: DeviceRegistry (spec §8.1 "Identity and accounts", §5.5 "Only sealed buttons answer", §9.1 computers).
// Owner: lane H.
//
// Every installation has its own Ed25519 key in the OS secret store. With a waifucave account, signing in is enough to
// add a device (the account is the root of trust); without one, devices pair by code or QR plus the 4-word check.
// Adding or revoking a device is a sensitive change: a sealed card, unless the user does it in their own terminal.
// Revoking a device cuts its links at once and starts a guided rotation of the keys already synced to it.
//
// The registry is also where signatures are checked: a paired device answers a card by signing it with its key, and
// `verify` refuses a revoked device's signature.
import type { DeviceKind, Os } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

export interface DeviceRecord {
  id: string;
  name: string;
  kind: DeviceKind;
  os?: Os;
  /** Runs clover-core: a computer in the tree that can take over (§6.4, §9.1). */
  runsCore: boolean;
  /** Its folder-tree name, for a device that runs clover-core. */
  computer?: string;
  hasDisplay?: boolean;
  /** Its Ed25519 public key, raw 32 bytes, base64. */
  publicKey: string;
  addedAt: number;
  /** How it was added, from the core's own record. */
  addedBy: PairingProof["via"];
  revokedAt?: number;
  lastSeenAt?: number;
}

/** How a device was introduced. */
export type PairingProof =
  /** The waifucave account's handshake: signing in is enough (§8.1). */
  | { via: "account"; account: string }
  /** No account: a code or QR, confirmed by the 4-word check, then the user's sealed card. */
  | { via: "code"; card: string }
  /** The user added it in their own terminal (§5.1: no card). */
  | { via: "terminal" }
  /** This device itself, at install. */
  | { via: "self" };

export type DeviceChange = { type: "added" | "changed"; device: DeviceRecord } | { type: "revoked"; id: string; reason?: string };

export interface DeviceRegistry {
  self(): DeviceRecord;
  /** Devices still paired, this one included. */
  list(): DeviceRecord[];
  /** Revoked devices too, with `revokedAt`. */
  get(id: string): DeviceRecord | undefined;
  add(device: Omit<DeviceRecord, "addedAt" | "addedBy" | "revokedAt">, proof: PairingProof): Promise<DeviceRecord>;
  /** Cuts its links at once (§8.1). Refused for this device itself. */
  revoke(id: string, reason?: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  /** Whether `signature` is the device's Ed25519 signature over `data`; false for an unknown or revoked device. */
  verify(id: string, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
  watch(fn: (change: DeviceChange) => void): Unsubscribe;
}

/** A device id: lowercase base32 of the first 20 bytes of SHA-256 over its public key; lane H may choose another
 *  encoding within `DeviceId`'s `^[a-z0-9]{16,64}$`. */
export async function deviceIdFor(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey as Uint8Array<ArrayBuffer>)).slice(0, 20);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
