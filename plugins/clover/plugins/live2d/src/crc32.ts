// CRC-32 (ISO 3309, the one PNG and ZIP use).

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  return crc32Final(crc32Update(CRC32_START, bytes));
}

/** The running form, for data that arrives in chunks: start, update with each chunk, then final. */
export const CRC32_START = 0xffffffff;

export function crc32Update(c: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}

export function crc32Final(c: number): number {
  return (c ^ 0xffffffff) >>> 0;
}
