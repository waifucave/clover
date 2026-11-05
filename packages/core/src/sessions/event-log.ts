// One session's event log on disk (spec §3.2 "Event log and storage", §8.5 "Transcripts: append-only logs"). Owner:
// lane D.
//
// The log is NDJSON, one `SessionRecord` per line, in `seq` order from 0, append-only. The file is the truth: the host
// keeps only each record's byte offset in memory and reads records back on demand, a page at a time, so a bot's one
// long conversation (§6.3) never has to fit in memory. Each append opens, writes and closes the file, so nothing stays
// open between records (a temp home can always be removed, on Windows too). The records that must survive a power
// cut (inputs, turn boundaries, status changes) are flushed to the drive itself before the host acts on them
// (durable-io.ts), and the folder too when the append created the file.
//
// * **Appends land at the log's known end.** Each record is written at the byte offset after the last good one, never
//   in append mode, so a write that failed part way (a full disk) can't put the next record after half of one; the
//   half is cut back off at once, and if even that fails, the next record overwrites it. A log is appended to only
//   after it was loaded, so a new session never writes after an old log's lines.
// * **A failed flush makes the log read-only** for the rest of the process: what the drive holds is unknown then, and
//   the next start's load is the one that can tell.
// * **No record is larger than `MAX_RECORD_BYTES`**: the host cuts long fields before recording (`shrinkRecord`).
// * **Loading repairs, and cuts only the tail.** A last line with no newline is a write that never finished, and is
//   dropped. A bad line (one that doesn't parse, breaks the `seq` order, or is longer than any record can be) followed
//   by good lines whose `seq` goes on is a lost record: the log keeps loading, and the file is rewritten once with a
//   placeholder in its place (`LOST_EVENT_TYPE`), and without lines that were no record at all. Bad lines with no good
//   line after them are cut. Either way the whole file is first copied aside as `<file>.corrupt-<time>`, so nothing is
//   lost silently. A line is scanned in pieces and joined once, and only up to the cap, so one huge line costs no more
//   than the cap to load.
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, copyFileSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SessionRecord } from "../contracts/session-host";
import { syncDir, syncFile } from "./durable-io";

/** The largest line a log holds, its newline included. */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
/** What a lost record reads back as: a runtime event no reader projects or counts. */
export const LOST_EVENT_TYPE = "record_lost";

const CHUNK_BYTES = 1 << 20;
const RECENT_RECORDS = 512;
/** How much one read of a range takes from the file at most. */
const READ_WINDOW_BYTES = 8 * 1024 * 1024;

export interface LogLoadResult {
  records: number;
  /** Records in the middle that couldn't be read: read back as placeholders. */
  lost?: number;
  /** What loading cut: a torn last line, or bad lines at the end (copied aside first). */
  repaired?: "torn-tail" | "corrupt";
}

/** The file calls an append makes, so a test can fail one part way. */
export interface AppendIo {
  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  syncFile(fd: number): void;
  ftruncateSync(fd: number, length: number): void;
}

const FS_IO: AppendIo = { writeSync: (fd, b, o, l, p) => writeSync(fd, b, o, l, p), syncFile, ftruncateSync };

/** A failed flush: the log takes no more records in this process. */
export class FlushError extends Error {}

/** A record over `MAX_RECORD_BYTES`; the host cuts it (`shrinkRecord`) and appends it again. */
export class RecordTooLargeError extends Error {
  constructor(readonly bytes: number, seq: number) {
    super(`record ${seq} is ${bytes} bytes, over ${MAX_RECORD_BYTES}`);
  }
}

/** Writes one whole line at byte `size`, the end of the file's good part, flushed when `durable`. A failed write is
 *  cut back to `size` before the error goes up; a failed flush is a `FlushError`. */
export function appendLine(fd: number, line: Buffer, size: number, durable: boolean, io: AppendIo = FS_IO): void {
  let written = 0;
  try {
    while (written < line.length) written += io.writeSync(fd, line, written, line.length - written, size + written);
  } catch (err) {
    try {
      io.ftruncateSync(fd, size);
    } catch {
      // The next append writes at `size` over it, and a load drops what is left as a torn line.
    }
    throw err;
  }
  if (!durable) return;
  try {
    io.syncFile(fd);
  } catch (err) {
    throw new FlushError(`the drive didn't confirm the write: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export class SessionLogFile {
  readonly path: string;
  readonly #sessionId: string;
  readonly #warn: (message: string) => void;
  /** Where each record's line starts. */
  #offsets: number[] = [];
  #size = 0;
  #loaded = false;
  #exists = false;
  #broken: string | undefined;
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

  /** Why the log takes no more records, after a failed flush. */
  get broken(): string | undefined {
    return this.#broken;
  }

  /** Reads every good record in order, handing each to `each`, and repairs the file (above). Call once, first. */
  load(each: (record: SessionRecord) => void = () => {}): LogLoadResult {
    if (this.#loaded) throw new Error(`session ${this.#sessionId}: its log is loaded already`);
    this.#loaded = true;
    if (!existsSync(this.path)) return { records: 0 };
    this.#exists = true;
    /** Bad lines since the last good one: lost if a good line follows, the tail if not. */
    let bad: number[] = [];
    /** Where each record's line ends (its newline), and the lost records, with the time of the record before each. */
    const ends: number[] = [];
    const lost = new Map<number, number>();
    let garbage = 0;
    let lastTs = 0;
    let size = 0;
    let lineStart = 0;
    let parts: Buffer[] = [];
    let partBytes = 0;
    const line = (end: number, tail: Buffer) => {
      const length = partBytes + tail.length;
      const record = length <= MAX_RECORD_BYTES ? this.#parse(parts.length === 0 ? tail : Buffer.concat([...parts, tail])) : undefined;
      const good = this.#offsets.length;
      if (record !== undefined && record.seq >= good && record.seq <= good + bad.length) {
        // The bad lines before it held `record.seq - good` records; any others were not records at all.
        for (let seq = good; seq < record.seq; seq++) {
          lost.set(seq, lastTs);
          this.#offsets.push(bad[seq - good]!);
          ends.push(-1);
        }
        garbage += bad.length - (record.seq - good);
        bad = [];
        this.#offsets.push(lineStart);
        ends.push(end);
        lastTs = record.ts;
        each(record);
      } else bad.push(lineStart);
      lineStart = end + 1;
      parts = [];
      partBytes = 0;
    };
    const fd = openSync(this.path, "r");
    try {
      size = fstatSync(fd).size;
      let pos = 0;
      while (pos < size) {
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - pos));
        const n = readSync(fd, chunk, 0, chunk.length, pos);
        if (n <= 0) break;
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(10, start);
          if (nl < 0 || nl >= n) break;
          line(pos + nl, chunk.subarray(start, nl));
          start = nl + 1;
        }
        if (start < n) {
          // Part of a line that goes on in the next chunk; past the cap it is kept no more, only counted.
          if (partBytes + (n - start) <= MAX_RECORD_BYTES) parts.push(chunk.subarray(start, n));
          else parts = [];
          partBytes += n - start;
        }
        pos += n;
      }
    } finally {
      closeSync(fd);
    }
    const torn = partBytes > 0;
    const middle = lost.size > 0 || garbage > 0;
    const cutAt = bad.length > 0 ? bad[0]! : torn ? lineStart : undefined;
    this.#size = cutAt ?? size;
    let repaired: LogLoadResult["repaired"];
    if (bad.length > 0 || middle) {
      const aside = `${this.path}.corrupt-${Date.now()}`;
      copyFileSync(this.path, aside);
      const what = [
        ...(lost.size > 0 ? [`${lost.size} unreadable record(s) in the middle, kept as lost`] : []),
        ...(garbage > 0 ? [`${garbage} line(s) in the middle that were no record`] : []),
        ...(bad.length > 0 ? [`${bad.length} bad line(s) at its end, cut`] : []),
      ].join(", ");
      this.#warn(`session ${this.#sessionId}: its log had ${what}; the file was copied to ${aside} first`);
      if (bad.length > 0) repaired = "corrupt";
    }
    if (repaired === undefined && torn) {
      this.#warn(`session ${this.#sessionId}: dropped an unfinished last line from its log (a crash during a write)`);
      repaired = "torn-tail";
    }
    if (middle) this.#rewrite(ends, lost);
    else if (cutAt !== undefined) {
      const out = openSync(this.path, "r+");
      try {
        ftruncateSync(out, cutAt);
        syncFile(out);
      } finally {
        closeSync(out);
      }
    }
    return { records: this.#offsets.length, ...(lost.size > 0 ? { lost: lost.size } : {}), ...(repaired === undefined ? {} : { repaired }) };
  }

  /** Writes the log again with only its records: each good line as it was, a placeholder for each lost one. */
  #rewrite(ends: number[], lost: ReadonlyMap<number, number>): void {
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const offsets: number[] = [];
    let size = 0;
    const out = openSync(tmp, "wx", 0o600);
    try {
      for (let seq = 0; seq < this.#offsets.length; seq++) {
        const lostTs = lost.get(seq);
        const line = lostTs !== undefined
          ? Buffer.from(`${JSON.stringify({ type: "driver", event: { type: LOST_EVENT_TYPE }, seq, sessionId: this.#sessionId, ts: lostTs })}\n`, "utf8")
          : this.#bytes(this.#offsets[seq]!, ends[seq]! + 1);
        offsets.push(size);
        appendLine(out, line, size, false);
        size += line.length;
      }
      syncFile(out);
    } catch (err) {
      closeSync(out);
      rmSync(tmp, { force: true });
      throw err;
    }
    closeSync(out);
    renameSync(tmp, this.path);
    syncDir(dirname(this.path));
    this.#offsets = offsets;
    this.#size = size;
  }

  /** Appends one record, whose `seq` must be the log's length. `durable` flushes it to the drive before returning. */
  append(record: SessionRecord, opts: { durable: boolean }): void {
    if (!this.#loaded) throw new Error(`session ${this.#sessionId}: its log is appended to before it was loaded`);
    if (this.#broken !== undefined) throw new Error(`session ${this.#sessionId}: its log takes no more records: ${this.#broken}`);
    if (record.seq !== this.#offsets.length) throw new Error(`session ${this.#sessionId}: record ${record.seq} out of order (the log holds ${this.#offsets.length})`);
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (line.length > MAX_RECORD_BYTES) throw new RecordTooLargeError(line.length, record.seq);
    const creating = !this.#exists;
    if (creating) mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT, 0o600);
    try {
      appendLine(fd, line, this.#size, opts.durable || creating);
    } catch (err) {
      if (err instanceof FlushError) this.#broken = err.message;
      throw err;
    } finally {
      closeSync(fd);
    }
    if (creating) {
      this.#exists = true;
      syncDir(dirname(this.path));
      syncDir(dirname(dirname(this.path)));
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
    const out: SessionRecord[] = [];
    let seq = lo;
    while (seq < hi) {
      const known = this.#recent.get(seq);
      if (known !== undefined) {
        out.push(structuredClone(known));
        seq++;
        continue;
      }
      // A window of records with nothing cached among them, up to READ_WINDOW_BYTES.
      let last = seq;
      const startByte = this.#offsets[seq]!;
      while (last + 1 < hi && !this.#recent.has(last + 1) && this.#endOf(last + 1) - startByte <= READ_WINDOW_BYTES) last++;
      const buf = this.#bytes(startByte, this.#endOf(last));
      for (let s = seq; s <= last; s++) {
        const at = this.#offsets[s]! - startByte;
        const nl = buf.indexOf(10, at);
        const record = JSON.parse(buf.subarray(at, nl < 0 ? buf.length : nl).toString("utf8")) as SessionRecord;
        this.#remember(record);
        out.push(structuredClone(record));
      }
      seq = last + 1;
    }
    return out;
  }

  /** Where record `seq`'s line ends: the next record's start, or the file's good end. */
  #endOf(seq: number): number {
    return seq + 1 < this.#offsets.length ? this.#offsets[seq + 1]! : this.#size;
  }

  #bytes(start: number, end: number): Buffer {
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
    return buf;
  }

  #remember(record: SessionRecord): void {
    this.#recent.delete(record.seq);
    this.#recent.set(record.seq, structuredClone(record));
    while (this.#recent.size > RECENT_RECORDS) {
      const oldest = this.#recent.keys().next().value as number;
      this.#recent.delete(oldest);
    }
  }

  #parse(line: Buffer): SessionRecord | undefined {
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
    if (!Number.isSafeInteger(r.seq) || r.sessionId !== this.#sessionId || typeof r.type !== "string" || typeof r.ts !== "number") return undefined;
    return value as SessionRecord;
  }
}

/** The longest a string field stays in a record that would be over the cap. */
const SHRUNK_STRING_CHARS = 64 * 1024;

/** A record's body cut to fit `MAX_RECORD_BYTES`: its long strings shortened (marked `…`, and `truncated: true` on the
 *  body or its event), or, if that isn't enough, a runtime event reduced to its type. Undefined when it fits. */
export function shrinkRecord<T extends { type: string }>(body: T, bytes: number): T | undefined {
  if (bytes <= MAX_RECORD_BYTES) return undefined;
  const cut = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > SHRUNK_STRING_CHARS ? `${v.slice(0, SHRUNK_STRING_CHARS)}…` : v;
    if (Array.isArray(v)) return v.map(cut);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
    return v;
  };
  const shrunk = cut(body) as T & { event?: { type: string; [k: string]: unknown }; truncated?: boolean };
  if (shrunk.type === "driver" && shrunk.event !== undefined) shrunk.event = { ...shrunk.event, truncated: true };
  else shrunk.truncated = true;
  if (Buffer.byteLength(JSON.stringify(shrunk)) + 512 <= MAX_RECORD_BYTES) return shrunk;
  if (shrunk.type === "driver" && shrunk.event !== undefined) return { ...shrunk, event: { type: shrunk.event.type, truncated: true } };
  throw new Error(`a ${body.type} record of ${bytes} bytes can't be cut to fit the log`);
}
