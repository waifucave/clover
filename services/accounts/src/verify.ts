// Ed25519 signature checks with WebCrypto. A key or signature of the wrong length is simply not valid, and so isn't a
// key or an R that is small-order or non-canonical, or an S at or above the group order (../../shared/ed25519-strict.ts,
// the core's checks): WebCrypto's Ed25519 verify alone doesn't refuse those.
import { isStrictEd25519Point, isStrictEd25519Signature } from "../../shared/ed25519-strict";

export async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (!isStrictEd25519Point(publicKey) || !isStrictEd25519Signature(signature)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}
