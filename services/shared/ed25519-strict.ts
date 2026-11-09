// Strict Ed25519 encodings for waifucave's Workers: the same checks as the core's packages/core/src/identity/ed25519-strict.ts,
// copied here since a Worker bundles only `services/` (a core test checks the two agree, input for input). A point must
// be a canonical encoding (y below p, and never x = 0 with the sign bit set), lie on the curve, and not be of small
// order (8·P ≠ the identity); a signature's S must be below the group order L. RFC 8032 §5.1.3 and §5.1.7, with the
// small-order rule of libsodium's `crypto_sign_verify_detached`. Plain BigInt on public data: no constant time needed.

const P = (1n << 255n) - 19n;
/** The prime order of the main subgroup. */
export const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

const mod = (a: bigint): bigint => {
  const r = a % P;
  return r < 0n ? r + P : r;
};

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inv = (a: bigint): bigint => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
/** √−1 mod p. */
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/** The point a 32-byte encoding names, or null when it isn't a canonical encoding of a curve point. */
function decode(bytes: Uint8Array): { x: bigint; y: bigint } | null {
  if (bytes.byteLength !== 32) return null;
  const n = littleEndian(bytes);
  const sign = n >> 255n;
  const y = n & ((1n << 255n) - 1n);
  if (y >= P) return null;
  // x² = (y² − 1) / (d·y² + 1)
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  const v3 = (v * v % P) * v % P;
  let x = (u * v3 % P) * pow(u * (v3 * v3 % P) * v % P, (P - 5n) / 8n) % P;
  const vx2 = v * (x * x % P) % P;
  if (vx2 !== u) {
    if (vx2 !== mod(-u)) return null;
    x = x * SQRT_M1 % P;
  }
  if (x === 0n && sign === 1n) return null; // x = 0 has one encoding only
  if ((x & 1n) !== sign) x = P - x;
  return { x, y };
}

function double(pt: { x: bigint; y: bigint }): { x: bigint; y: bigint } {
  const { x, y } = pt;
  const xy = x * y % P;
  const k = D * xy % P * xy % P;
  return { x: mod(2n * xy) * inv(mod(1n + k)) % P, y: mod(y * y + x * x) * inv(mod(1n - k)) % P };
}

/** Whether 32 bytes are a canonical encoding of a curve point outside the small-order subgroup: what a public key and a
 *  signature's R must be. */
export function isStrictEd25519Point(bytes: Uint8Array): boolean {
  const pt = decode(bytes);
  if (!pt) return false;
  const eight = double(double(double(pt)));
  return !(eight.x === 0n && eight.y === 1n);
}

/** Whether a 64-byte signature's R is a strict point and its S is below the group order. */
export function isStrictEd25519Signature(signature: Uint8Array): boolean {
  if (signature.byteLength !== 64) return false;
  return littleEndian(signature.subarray(32)) < ED25519_L && isStrictEd25519Point(signature.subarray(0, 32));
}
