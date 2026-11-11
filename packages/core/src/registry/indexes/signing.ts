// Signing the official plugin index and its revocation list (spec §5.1; the owner's answer A, 2026-11-11): the owner
// holds the Ed25519 key in his login keychain; the app ships only its public half (`OFFICIAL_INDEX.keys`). This module
// is the part that signs and checks; reaching the keychain is the script's (`scripts/plugin-index-key.ts`), through
// `KeySource`, so a test signs with a key it made and never touches a keychain.
//
// * What is signed: the file's exact bytes, as they will be served. The signature is Ed25519 over those bytes, one line
//   of base64 in `<file>.sig` beside it (`parseSignatureFile` reads it). Any change after signing, a trailing newline
//   included, needs a new signature.
// * Before signing, the file must be an index or a revocation list Clover reads (format 1), with `issued` and a `seq`
//   above the one last published (the replay check: a client refuses a lower one).
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { IndexSchema, parseSignatureFile, RevocationsSchema } from "@waifucave/clover-plugin-sdk";
import { verifySigned } from "./client";

/** Where the 32-byte seed comes from (the login keychain, in the script). It is never printed or written to disk. */
export interface KeySource {
  seed(): Promise<Uint8Array>;
}

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function privateKeyOf(seed: Uint8Array) {
  if (seed.byteLength !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
}

/** The public key (hex), for `OFFICIAL_INDEX.keys`. */
export function publicKeyHex(seed: Uint8Array): string {
  const spki = createPublicKey(privateKeyOf(seed)).export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32).toString("hex");
}

export type SignedKind = "index" | "revocations";

/** Checks a file is one Clover reads, and gives back its kind and `seq`. Throws why not. */
export function checkSignable(bytes: Uint8Array, o: { after?: number } = {}): { kind: SignedKind; seq: number; issued: string } {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("the file isn't UTF-8 JSON");
  }
  const kind: SignedKind = (value as { revocations?: unknown })?.revocations === 1 ? "revocations" : "index";
  const r = (kind === "index" ? IndexSchema : RevocationsSchema).safeParse(value);
  if (!r.success) throw new Error(`the file isn't a ${kind === "index" ? "plugin index" : "revocation list"} Clover reads: ${r.error.issues[0]?.message ?? "invalid"}`);
  if (o.after !== undefined && r.data.seq <= o.after) throw new Error(`its seq (${r.data.seq}) must be above the last one published (${o.after})`);
  return { kind, seq: r.data.seq, issued: r.data.issued };
}

/** Signs a file's exact bytes: the `.sig` file's text (one line of base64), checked against the key before it is
 *  given back. */
export async function signFile(bytes: Uint8Array, key: KeySource, o: { after?: number } = {}): Promise<{ sig: string; publicKey: string; kind: SignedKind; seq: number }> {
  const checked = checkSignable(bytes, o);
  const seed = await key.seed();
  try {
    const sig = `${sign(null, bytes, privateKeyOf(seed)).toString("base64")}\n`;
    const publicKey = publicKeyHex(seed);
    if (parseSignatureFile(sig) === null || !verifySigned(bytes, sig, [publicKey])) throw new Error("the signature doesn't check");
    return { sig, publicKey, kind: checked.kind, seq: checked.seq };
  } finally {
    seed.fill(0);
  }
}

/** A keychain service or account name the tool takes: letters, digits, `.`, `_` and `-` only, since it goes into the
 *  line `security -i` reads (no space, quote or newline can start another command or flag there). */
export function keychainName(value: string | undefined, flag: string): string {
  if (value === undefined || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error(`${flag} takes letters, digits, '.', '_' and '-' only`);
  return value;
}

/** `sign`'s replay floor: `--after <seq>` (the seq last published) or `--first` (nothing published yet), never neither,
 *  so the seq check is never skipped by leaving a flag out. */
export function signFloor(args: readonly string[]): { after?: number } {
  const at = args.indexOf("--after");
  const first = args.includes("--first");
  if (at !== -1 && first) throw new Error("give --after <seq> or --first, not both");
  if (first) return {};
  if (at === -1) throw new Error("give --after <the seq last published>, or --first for the first copy ever published");
  const text = args[at + 1];
  const after = text === undefined || !/^\d+$/.test(text) ? Number.NaN : Number(text);
  if (!Number.isSafeInteger(after)) throw new Error("--after takes the seq last published (a whole number)");
  return { after };
}

/** The keychain item's text (the seed in base64) as the 32-byte seed. The decoded buffer is zeroed once copied; the
 *  base64 string itself can't be (JavaScript strings are immutable), so it is only dropped. */
export function seedFromBase64(text: string): Uint8Array {
  const decoded = Buffer.from(text.trim(), "base64");
  try {
    if (decoded.byteLength !== 32) throw new Error("the keychain item isn't a 32-byte Ed25519 seed in base64");
    return new Uint8Array(decoded);
  } finally {
    decoded.fill(0);
  }
}

/** What `create` says when the keychain doesn't take the key: never `security`'s own output, only its exit code. */
export function keychainRefused(exitCode: number | null): string {
  return `the keychain refused the key (security exited with ${exitCode ?? "a signal"})`;
}
