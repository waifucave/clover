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
