// The account service's wire (PROTOCOL.md): lane H's proposal in the core's identity/account.ts, as built here. The
// statements must stay byte-for-byte what H's AccountClient signs.

import { utf8 } from "../../shared/encoding";

export const registerStatement = (account: string, device: string, t: number): Uint8Array =>
  utf8(["clover-account-v1 register", account, device, String(t)].join("\n"));

export const mintStatement = (account: string, audience: string, device: string, t: number): Uint8Array =>
  utf8(["clover-account-v1 mint", account, audience, device, String(t)].join("\n"));

/** The device kinds and systems of the protocol's `DeviceKind` and `Os` (packages/protocol). */
export const DEVICE_KINDS = ["desktop", "server", "cloud", "phone", "browser"] as const;
export const OSES = ["macos", "windows", "linux"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export type Os = (typeof OSES)[number];

/** A device id as lane B's `deviceIdFor` makes it: lowercase base32 of 20 bytes. */
export const DEVICE_ID_RE = /^[a-z2-7]{32}$/;
/** A Supabase user id (the account): what the services accept as `sub`. */
export const ACCOUNT_RE = /^[\x21-\x7e]{1,128}$/;
/** An Ed25519 signature, 64 bytes, base64url. */
export const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

export const LIMITS = {
  /** How far a statement's `t` (ms) may be from the service's clock. */
  statementWindowMs: 10 * 60_000,
  /** The longest an account token lives (the core refuses longer: `ACCOUNT_TOKEN_MAX_MS`). */
  maxTokenSeconds: 300,
  /** Devices an account may have that aren't revoked, and rows kept with the revoked ones. */
  maxDevices: 64,
  maxRows: 256,
  /** A device name, in code points. */
  maxName: 64,
  maxBodyBytes: 16 * 1024,
} as const;

export interface AccountDevice {
  id: string;
  /** The device's Ed25519 link key, standard base64 (as the core's DeviceKey gives it). */
  publicKey: string;
  /** Its X25519 key for the handshake's account-scope boxes, base64url. */
  boxKey: string;
  name: string;
  kind: DeviceKind;
  os?: Os;
  addedAt: number;
  revokedAt?: number;
}

/** Lane B's `deviceIdFor` (packages/core/src/contracts/device-registry.ts), which the id must equal. */
export async function deviceIdFor(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey as Uint8Array<ArrayBuffer>)).slice(0, 20);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
