// Ed25519 signature checks with WebCrypto. A key or signature of the wrong length is simply not valid.

export async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}
