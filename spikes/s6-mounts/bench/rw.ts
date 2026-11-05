#!/usr/bin/env bun
// Workload processes for the S6 checks. Each prints one JSON line and exits non-zero on error,
// so the harness sees what a program would see.
//
//   bun rw.ts read <file>                 read the whole file in 1 MiB chunks
//   bun rw.ts write <file> <MiB>          write MiB of data in 1 MiB chunks, then fsync
//   bun rw.ts copy <from-dir> <to-dir>    copy a tree file by file (cp -r)
//   bun rw.ts make <file> <MiB>           make a test file (setup)

import * as fs from "node:fs";
import * as path from "node:path";

const [mode, a, b] = process.argv.slice(2);
const t0 = performance.now();
let bytes = 0;
let files = 0;
const done = (extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ok: true, ms: performance.now() - t0, bytes, files, ...extra }));
const failed = (e: any) => {
  console.log(JSON.stringify({ ok: false, ms: performance.now() - t0, bytes, files, code: e?.code, message: String(e?.message ?? e) }));
  process.exit(1);
};

try {
  if (mode === "read") {
    const fd = fs.openSync(a!, "r");
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      bytes += n;
    }
    fs.closeSync(fd);
    done();
  } else if (mode === "write" || mode === "make") {
    const mib = Number(b);
    const fd = fs.openSync(a!, "w");
    const buf = Buffer.alloc(1 << 20, 0x5a);
    for (let i = 0; i < mib; i++) {
      buf.writeUInt32LE(i, 0);
      fs.writeSync(fd, buf, 0, buf.length, null);
      bytes += buf.length;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    done();
  } else if (mode === "copy") {
    const walk = (from: string, to: string) => {
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, e.name);
        const d = path.join(to, e.name);
        if (e.isDirectory()) walk(s, d);
        else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
        else { const data = fs.readFileSync(s); fs.writeFileSync(d, data); bytes += data.length; files++; }
      }
    };
    walk(a!, b!);
    done();
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (e) { failed(e); }
