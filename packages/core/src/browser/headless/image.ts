// The pixel size of a screenshot, read from its own header (PNG's IHDR, JPEG's SOF, WebP's VP8/VP8L/VP8X), so a
// picture is only ever handed over as what it really is. Pure.

export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, n: number): string => String.fromCharCode(...bytes.subarray(at, at + n));
  // PNG: the signature, then IHDR's width and height.
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // JPEG: the first start-of-frame marker's height and width.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const len = dv.getUint16(at + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { height: dv.getUint16(at + 5), width: dv.getUint16(at + 7) };
      at += 2 + len;
    }
    return undefined;
  }
  // WebP: RIFF, then one of its three chunk kinds.
  if (bytes.length >= 32 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return { width: 1 + (dv.getUint32(24, true) & 0xffffff), height: 1 + (dv.getUint32(27, true) & 0xffffff) };
    if (kind === "VP8L") {
      const b = dv.getUint32(21, true);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff) };
    }
    if (kind === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
  }
  return undefined;
}
