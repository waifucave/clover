// One session's event log on disk (spec §3.2 "Event log and storage", §8.5 "Transcripts: append-only logs"). Owner:
// lane D.
//
// The log is NDJSON, one `SessionRecord` per line, in `seq` order from 0, append-only. The file is the truth: the host
// keeps only each record's byte offset in memory and reads records back on demand, so a bot's one long conversation
// (§6.3) never has to fit in memory. Each append opens, writes and closes the file, so nothing stays open between
// records (a temp home can always be removed, on Windows too), and the records that must survive a power cut (the
// inputs, turn ends and status changes) are flushed to the disk before the host acts on them.
//
// Loading repairs what a crash can leave: a last line with no newline is a write the process never finished, so it is
// dropped; any other line that doesn't parse, or breaks the `seq` order, ends the log there, after the whole file is
// copied aside as `<file>.corrupt-<time>`, so nothing is lost silently. An append that fails part way (a full disk, a
// failed flush) is cut off again before the error goes up, so the next record never follows half of one.
import {
  closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SessionRecord } from "../contracts/session-host";

const CHUNK_BYTES = 1 << 20;
const RECENT_RECORDS = 512;

/** The file calls an append makes, so a test can fail one part way. */
export interface AppendIo {
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  ftruncateSync(fd: number, length: number): void;
}

const FS_IO: AppendIo = { writeSync: (fd, b, o, l) => writeSync(fd, b, o, l), fsyncSync, ftruncateSync };

/** Writes one whole line at the end of the file whose good part is `size` bytes, flushed when `durable`; on any failure
 *  the file is cut back to `size` before the error goes up. */
export function appendLine(fd: number, line: Buffer, size: number, durable: boolean, io: AppendIo = FS_IO): void {
  let written = 0;
  try {
    while (written < line.length) written += io.writeSync(fd, line, written, line.length - written);
    if (durable) io.fsyncSync(fd);
  } catch (err) {
    try {
      io.ftruncateSync(fd, size);
    } catch {
      // The load's repair is the last resort: a torn or corrupt tail is cut there.
    }
    throw err;
  }
}

export interface LogLoadResult {
  records: number;
  /** What loading cut: a torn last line, or a corrupt line and everything after it (copied aside first). */
  repaired?: "torn-tail" | "corrupt";
}

export class SessionLogFile {
  readonly path: string;
  readonly #sessionId: string;
  readonly #warn: (message: string) => void;
  /** Where each record's line starts. */
  readonly #offsets: number[] = [];
  #size = 0;
  #dirReady = false;
  /** The records appended or read most recently, least recent first. */
  readonly #recent = new Map<number, SessionRecord>();

  constructor(path: string, sessionId: string, warn: (message: string) => void = () => {}) {
    this.path = path;
    this.#sessionId = sessionId;
    this.#warn = warn;
  }

  get length(): number {
    return this.#offsets.length;
  }

  /** Reads every good record in order, handing each to `each`, and repairs the tail (above). Call once, first. */
  load(each: (record: SessionRecord) => void): LogLoadResult {
    if (!existsSync(this.path)) return { records: 0 };
    let bad: { at: number; torn: boolean } | undefined;
    let size = 0;
    const fd = openSync(this.path, "r");
    try {
      size = fstatSync(fd).size;
      let pos = 0;
      let carry: Buffer = Buffer.alloc(0);
      /** The file offset of `carry`'s first byte. */
      let base = 0;
      scan: while (pos < size) {
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - pos));
        const n = readSync(fd, chunk, 0, chunk.length, pos);
        if (n <= 0) break;
        pos += n;
        const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        let start = 0;
        for (;;) {
          const nl = data.indexOf(10, start);
          if (nl < 0) break;
          const record = this.#parse(data.subarray(start, nl), this.#offsets.length);
          if (record === undefined) {
            bad = { at: base + start, torn: false };
            break scan;
          }
          this.#offsets.push(base + start);
          each(record);
          start = nl + 1;
        }
        carry = Buffer.from(data.subarray(start));
        base += start;
      }
      if (bad === undefined && carry.length > 0) bad = { at: base, torn: true };
    } finally {
      closeSync(fd);
    }
    this.#size = bad === undefined ? size : bad.at;
    this.#dirReady = true;
    if (bad === undefined) return { records: this.#offsets.length };
    if (!bad.torn) {
      const aside = `${this.path}.corrupt-${Date.now()}`;
      copyFileSync(this.path, aside);
      this.#warn(`session ${this.#sessionId}: its log had a corrupt line after record ${this.#offsets.length - 1}; the file was copied to ${aside} and the log ends at the last good record`);
    } else {
      this.#warn(`session ${this.#sessionId}: dropped an unfinished last line from its log (a crash during a write)`);
    }
    const out = openSync(this.path, "r+");
    try {
      ftruncateSync(out, bad.at);
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    return { records: this.#offsets.length, repaired: bad.torn ? "torn-tail" : "corrupt" };
  }

  /** Appends one record, whose `seq` must be the log's length. `durable` flushes it to the disk before returning. */
  append(record: SessionRecord, opts: { durable: boolean }): void {
    if (record.seq !== this.#offsets.length) throw new Error(`session ${this.#sessionId}: record ${record.seq} out of order (the log holds ${this.#offsets.length})`);
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (!this.#dirReady) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.#dirReady = true;
    }
    const fd = openSync(this.path, "a");
    try {
      appendLine(fd, line, this.#size, opts.durable);
    } finally {
      closeSync(fd);
    }
    this.#offsets.push(this.#size);
    this.#size += line.length;
    this.#remember(record);
  }

  /** Records `from` up to (not including) `to`, in order. */
  read(from: number, to: number = this.#offsets.length): SessionRecord[] {
    const lo = Math.max(0, from);
    const hi = Math.min(to, this.#offsets.length);
    if (lo >= hi) return [];
    const cached: SessionRecord[] = [];
    for (let seq = lo; seq < hi; seq++) {
      const r = this.#recent.get(seq);
      if (r === undefined) break;
      cached.push(r);
    }
    if (cached.length === hi - lo) return cached.map((r) => structuredClone(r));
    const start = this.#offsets[lo]!;
    const end = hi < this.#offsets.length ? this.#offsets[hi]! : this.#size;
    const buf = Buffer.alloc(end - start);
    const fd = openSync(this.path, "r");
    try {
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, start + got);
        if (n <= 0) throw new Error(`session ${this.#sessionId}: its log ended early`);
        got += n;
      }
    } finally {
      closeSync(fd);
    }
    const out: SessionRecord[] = [];
    let at = 0;
    for (let seq = lo; seq < hi; seq++) {
      const nl = buf.indexOf(10, at);
      const record = JSON.parse(buf.subarray(at, nl < 0 ? buf.length : nl).toString("utf8")) as SessionRecord;
      out.push(record);
      at = nl + 1;
    }
    for (const r of out.slice(-RECENT_RECORDS)) this.#remember(r);
    return out.map((r) => structuredClone(r));
  }

  #remember(record: SessionRecord): void {
    this.#recent.delete(record.seq);
    this.#recent.set(record.seq, structuredClone(record));
    while (this.#recent.size > RECENT_RECORDS) {
      const oldest = this.#recent.keys().next().value as number;
      this.#recent.delete(oldest);
    }
  }

  #parse(line: Buffer, seq: number): SessionRecord | undefined {
    let text = line.toString("utf8");
    if (text.endsWith("\r")) text = text.slice(0, -1);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const r = value as Partial<SessionRecord>;
    if (r.seq !== seq || r.sessionId !== this.#sessionId || typeof r.type !== "string" || typeof r.ts !== "number") return undefined;
    return value as SessionRecord;
  }
}
