// A Live2D model's `.zip`, extracted by Clover itself (the controller's ruling R5): Mochi2D's archive reader has no size
// cap, so it never sees the archive. Each entry is inflated as a stream and counted as it comes, and the moment the real
// inflated bytes pass the file's cap (or what is left of the model's) the stream is cancelled; a size the archive
// declares is only an early refusal, never trusted. Every entry is checked against its CRC-32. Mochi2D gets the
// extracted files, in memory, as it gets a folder's.
//
// Stored (0) and deflated (8) entries only; no encryption, no ZIP64. Names are decoded as the archive's tool wrote them:
// UTF-8 when flagged or valid, else the first of Shift_JIS, GB18030, EUC-KR and Big5 that decodes every name (Live2D
// models often come from tools that write a local code page), else Windows-1252.

import { crc32 } from "./crc32";
import { Live2dRefusal } from "./validate";

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  /** What the directory says it inflates to: an early refusal only. */
  declaredSize: number;
  localOffset: number;
}

const FALLBACK_ENCODINGS = ["shift_jis", "gb18030", "euc-kr", "big5"] as const;

function damaged(detail: string): Live2dRefusal {
  return new Live2dRefusal("archive", detail);
}

function decodeNames(raw: { bytes: Uint8Array; utf8: boolean }[]): string[] {
  const tryAll = (encoding: string): string[] | null => {
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(encoding, { fatal: true });
    } catch {
      return null;
    }
    try {
      return raw.map((r) => decoder.decode(r.bytes));
    } catch {
      return null;
    }
  };
  if (raw.every((r) => r.utf8)) return tryAll("utf-8") ?? raw.map((r) => new TextDecoder("utf-8").decode(r.bytes));
  for (const encoding of ["utf-8", ...FALLBACK_ENCODINGS]) {
    const names = tryAll(encoding);
    if (names) return names;
  }
  return raw.map((r) => new TextDecoder("windows-1252").decode(r.bytes));
}

/** The archive's directory: its entries, names decoded, folders left out. Throws for an archive it can't read. */
export function zipEntries(bytes: Uint8Array, maxEntries = 4096): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw damaged("the archive has no central directory");
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw damaged("the archive is ZIP64");
  if (offset + size > bytes.length) throw damaged("the archive's directory lies past its end");
  if (count > maxEntries) throw new Live2dRefusal("too-many-files", `the archive holds ${count} entries`);
  const raw: { bytes: Uint8Array; utf8: boolean }[] = [];
  const entries: Omit<ZipEntry, "name">[] = [];
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw damaged("the archive's directory is damaged");
    const flags = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (at + 46 + nameLength > bytes.length) throw damaged("the archive's directory is damaged");
    const entry = {
      method: view.getUint16(at + 10, true),
      flags,
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      declaredSize: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    };
    if (entry.compressedSize === 0xffffffff || entry.declaredSize === 0xffffffff || entry.localOffset === 0xffffffff) throw damaged("an archive entry is ZIP64");
    raw.push({ bytes: bytes.subarray(at + 46, at + 46 + nameLength), utf8: (flags & 0x800) !== 0 });
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  const names = decodeNames(raw);
  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    const name = names[i]!.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    if (name.endsWith("/") || name === "" || seen.has(name)) return;
    seen.add(name);
    out.push({ ...e, name });
  });
  return out;
}

/** Inflates `data`, never past `cap` real bytes: the stream is cancelled the moment it passes. */
export async function inflateCapped(data: Uint8Array, cap: number, what: string): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // Not awaited before reading: the stream hands its output back as it goes.
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new Live2dRefusal("too-large", `${what} inflates past ${cap} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Live2dRefusal) throw error;
    throw damaged(`${what} does not inflate`);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export interface ZipArchive {
  readonly names: readonly string[];
  /** Each entry's declared inflated size, in `names`' order. */
  readonly declared: readonly number[];
  /** One entry's bytes, never more than `cap` real bytes, checked against its CRC-32. */
  read(name: string, cap: number): Promise<Uint8Array>;
}

export function openZip(bytes: Uint8Array, maxEntries?: number): ZipArchive {
  const entries = new Map(zipEntries(bytes, maxEntries).map((e) => [e.name, e]));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    names: [...entries.keys()],
    declared: [...entries.values()].map((e) => e.declaredSize),
    async read(name, cap) {
      const e = entries.get(name);
      if (!e) throw new Live2dRefusal("missing", `${name} is not in the archive`);
      if (e.flags & 0x1) throw damaged(`${name} is encrypted`);
      if (e.declaredSize > cap) throw new Live2dRefusal("too-large", `${name} says it is ${e.declaredSize} bytes, over ${cap}`);
      const local = e.localOffset;
      if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw damaged(`${name}'s header is damaged`);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + e.compressedSize > bytes.length) throw damaged(`${name} lies past the archive's end`);
      const data = bytes.subarray(start, start + e.compressedSize);
      let out: Uint8Array;
      if (e.method === 0) {
        if (data.byteLength > cap) throw new Live2dRefusal("too-large", `${name} is over ${cap} bytes`);
        out = data.slice();
      } else if (e.method === 8) out = await inflateCapped(data, cap, name);
      else throw damaged(`${name} uses a compression this app does not read (${e.method})`);
      if (crc32(out) !== e.crc) throw damaged(`${name} fails its checksum`);
      return out;
    },
  };
}

/** The settings file to load from an archive: the shallowest `*.model3.json`, then the first by name. */
export function settingsIn(names: readonly string[]): string | null {
  const candidates = names.filter((n) => n.toLowerCase().endsWith(".model3.json"));
  candidates.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return candidates[0] ?? null;
}
