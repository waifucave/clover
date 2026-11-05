import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { extractAll, listEntries } from "../src/cft/unzip.ts";

interface E { name: string; data?: Uint8Array; mode?: number; deflate?: boolean }

/** A minimal zip writer (made on "Unix", so modes travel in the external attributes). */
function makeZip(entries: E[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.data ?? new Uint8Array();
    const comp = e.deflate ? deflateRawSync(data) : data;
    const crc = Bun.hash.crc32(data) >>> 0;
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, e.deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lh.set(name, 30);
    local.push(lh, comp);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, (3 << 8) | 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, e.deflate ? 8 : 0, true); cv.setUint32(16, crc, true); cv.setUint32(20, comp.length, true);
    cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((e.mode ?? 0o100644) << 16) >>> 0, true); cv.setUint32(42, offset, true); ch.set(name, 46);
    central.push(ch);
    offset += lh.length + comp.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const parts = [...local, ...central, eocd];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "s7-unzip-")); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const crc = (d: Uint8Array) => Bun.hash.crc32(d);
const text = (s: string) => new TextEncoder().encode(s);

describe("zip reader", () => {
  test("files, modes, dirs and an inside symlink", () => {
    const big = text("x".repeat(10_000));
    const zip = makeZip([
      { name: "browser/", mode: 0o040755 },
      { name: "browser/chrome", data: text("#!/bin/sh\necho hi\n"), mode: 0o100755, deflate: true },
      { name: "browser/big.txt", data: big, deflate: true },
      { name: "browser/Versions/1/lib", data: text("lib") },
      { name: "browser/Versions/Current", data: text("1"), mode: 0o120755 },
    ]);
    expect(listEntries(zip).map((e) => e.name)).toContain("browser/chrome");
    const d = tmp();
    const s = extractAll(zip, d, crc);
    expect(s.files).toBe(3);
    expect(s.symlinks).toBe(1);
    expect(readFileSync(join(d, "browser/big.txt"), "utf8").length).toBe(10_000);
    if (process.platform !== "win32") expect(statSync(join(d, "browser/chrome")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(d, "browser/Versions/Current")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(d, "browser/Versions/Current"))).toBe("1");
  });

  test("refuses an entry that climbs out", () => {
    const d = tmp();
    expect(() => extractAll(makeZip([{ name: "../evil", data: text("x") }]), d, crc)).toThrow(/outside/);
    expect(existsSync(join(d, "..", "evil"))).toBe(false);
  });

  test("refuses a symlink that points out, and an entry written through one", () => {
    expect(() => extractAll(makeZip([{ name: "a/link", data: text("../../etc"), mode: 0o120777 }]), tmp(), crc)).toThrow(/symlink outside/);
    const zip = makeZip([
      { name: "a/b/", mode: 0o040755 },
      { name: "a/up", data: text("b"), mode: 0o120777 },
      { name: "a/up/ok", data: text("fine: up -> b stays inside") },
    ]);
    expect(() => extractAll(zip, tmp(), crc)).not.toThrow();
  });

  test("a CRC mismatch is an error", () => {
    const zip = makeZip([{ name: "f", data: text("hello"), deflate: false }]);
    zip[30 + 1] = "X".charCodeAt(0); // corrupt the stored data ("hello" → "hXllo")
    expect(() => extractAll(zip, tmp(), crc)).toThrow(/CRC/);
  });
});
