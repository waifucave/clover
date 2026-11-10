// A tar writer for the tests: ustar headers by hand, so a test can make any entry a hostile archive might hold (a
// link, a device, `..`, a pax or GNU long name, a bad checksum) and gzip it.
import { gzipSync } from "node:zlib";

export interface TarEntry {
  path: string;
  data?: string | Uint8Array;
  /** `0` a file (default), `5` a folder, `1` a hard link, `2` a symlink, `3`/`4` devices, `6` a FIFO, `x` pax, `L` GNU. */
  type?: string;
  mode?: number;
  linkname?: string;
  /** Spoils the header's checksum. */
  badChecksum?: boolean;
}

const enc = new TextEncoder();

function header(e: TarEntry, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (at: number, len: number, text: string) => h.set(enc.encode(text).subarray(0, len), at);
  const oct = (at: number, len: number, n: number) => put(at, len, `${n.toString(8).padStart(len - 1, "0")}\0`);
  let name = e.path;
  let prefix = "";
  if (enc.encode(name).length > 100) {
    const cut = name.lastIndexOf("/", name.length - 1 - 0);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  put(0, 100, name);
  oct(100, 8, e.mode ?? (e.type === "5" ? 0o755 : 0o644));
  oct(108, 8, 0);
  oct(116, 8, 0);
  oct(124, 12, size);
  oct(136, 12, 0);
  put(156, 1, e.type ?? "0");
  if (e.linkname !== undefined) put(157, 100, e.linkname);
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  if (prefix !== "") put(345, 155, prefix);
  // The checksum: the header's bytes summed with its own field as spaces.
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  if (e.badChecksum) sum += 1;
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

export function tarOf(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const data = e.data === undefined ? new Uint8Array() : typeof e.data === "string" ? enc.encode(e.data) : e.data;
    parts.push(header(e, data.byteLength), data, new Uint8Array((512 - (data.byteLength % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export const tgz = (entries: readonly TarEntry[]): Uint8Array => gzipSync(tarOf(entries));

/** A pax header entry naming `path` for the entry after it. */
export function paxFor(path: string): TarEntry {
  const rec = (len: number) => `${len} path=${path}\n`;
  let len = rec(0).length;
  while (rec(len).length !== len) len = rec(len).length;
  return { path: "PaxHeader", type: "x", data: rec(len) };
}
