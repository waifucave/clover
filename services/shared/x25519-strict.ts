// A copy of packages/core/src/identity/x25519-strict.ts for the Workers and the web page, which don't import the core.
// The core's test checks that the two agree.

// Strict X25519 public keys (RFC 7748 §5 and §6.1, with the low-order rule of libsodium's `crypto_scalarmult`): what a
// box key must be before Clover takes it or seals to it. Its u-coordinate is a canonical encoding (below p, and the high
// bit clear, which X25519 itself would ignore), and it isn't of low order: eight times the point, by x-only doubling on
// the Montgomery curve (the formula holds on the curve and on its twist alike, both of which X25519 accepts), is not the
// point at infinity. A key of low order gives an all-zero shared secret whatever the other side's key is.
//
// Plain BigInt on public data: no constant time needed.
//
// services/shared/x25519-strict.ts is a copy of this file for the Workers and the web page (its header, then this file
// byte for byte); identity/tests/x25519-strict.test.ts fails when the two differ, so change both together.

const P = (1n << 255n) - 19n;
const A24 = 121666n; // (A + 2) / 4, A = 486662

function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/** Projective x-only doubling: (X : Z) to 2·(X : Z), on y² = x³ + A·x² + x and its twist. */
function double(x: bigint, z: bigint): [bigint, bigint] {
  const a = (x + z) % P;
  const b = (x - z + P) % P;
  const aa = a * a % P;
  const bb = b * b % P;
  const c = (aa - bb + P) % P; // 4·X·Z
  return [aa * bb % P, c * ((bb + A24 * c) % P) % P];
}

/** Whether 32 bytes are a canonical X25519 public key outside the low-order points. */
export function isStrictX25519PublicKey(bytes: Uint8Array): boolean {
  if (bytes.byteLength !== 32) return false;
  if ((bytes[31]! & 0x80) !== 0) return false;
  const u = littleEndian(bytes);
  if (u >= P) return false;
  let [x, z] = [u, 1n];
  for (let i = 0; i < 3; i++) [x, z] = double(x, z);
  return z !== 0n;
}
