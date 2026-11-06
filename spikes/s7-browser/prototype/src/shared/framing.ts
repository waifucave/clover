// The link's binary framing, shared by the pages and the tests: [u32 header length, little-endian][header JSON][payload].
// Pure: no DOM, Node or Bun APIs.

export function frame(header: Record<string, unknown>, payload: Uint8Array): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + payload.length);
  new DataView(out.buffer).setUint32(0, h.length, true);
  out.set(h, 4);
  out.set(payload, 4 + h.length);
  return out;
}

export function unframe(buf: ArrayBuffer): { header: Record<string, unknown>; payload: Uint8Array } {
  const n = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as Record<string, unknown>;
  return { header, payload: new Uint8Array(buf, 4 + n) };
}
