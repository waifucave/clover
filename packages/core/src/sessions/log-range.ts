// A seq-ranged read of a session log (`SessionStore.readRange`): the events after a seq, a page at a time, without
// reading or parsing the lines before it. Owner: lane D (the archive's `archive.history`).
//
// A session's log is ascending in seq (the store appends `last_seq + 1`, and a synced page lands gapless after it), so
// the page's first line is found by bisecting the file's bytes: each probe parses ONE line, so a page costs
// O(log size) probe lines plus the page's own. A line that doesn't parse (a crash's cut tail, a corrupt record) is
// skipped, as `readGoodLines` skips it.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { SessionEvent } from "@waifucave/clover-protocol";

const CHUNK = 64 * 1024;
const NL = 0x0a;

export interface LogRangeOptions {
  /** At most this many events. */
  limit: number;
  /** The page's soft byte budget: a page stops before the line that would take it past this (a page always holds at
   *  least one event, unless that event is `oversized`). */
  maxBytes: number;
  /** A line longer than this is never returned: the page reports it as `oversized`, alone, so the caller can say it
   *  was left out and page on past it. */
  maxOne: number;
}

export interface LogRange {
  events: SessionEvent[];
  /** The first line after `afterSeq`, when it is longer than `maxOne` (then `events` is empty). */
  oversized?: { seq: number; bytes: number };
  /** Whether the log goes on past this page. */
  more: boolean;
}

export function readLogRange(path: string, afterSeq: number, o: LogRangeOptions): LogRange {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const io = new LineReader(fd, size);
    const first = io.firstAfter(afterSeq);
    const events: SessionEvent[] = [];
    let used = 0;
    let at = first ?? size;
    while (at < size && events.length < o.limit) {
      const { bytes, end } = io.line(at);
      const raw = jsonOf(bytes);
      const seq = seqIn(raw);
      if (seq !== undefined && seq > afterSeq) {
        if (bytes.length > o.maxOne) {
          if (events.length > 0) break;
          return { events, oversized: { seq, bytes: bytes.length }, more: end < size };
        }
        if (events.length > 0 && used + bytes.length > o.maxBytes) break;
        const event = SessionEvent.safeParse(raw);
        if (event.success) {
          events.push(event.data);
          used += bytes.length;
        }
      }
      at = end;
    }
    return { events, more: at < size };
  } finally {
    closeSync(fd);
  }
}

class LineReader {
  readonly #buf = Buffer.alloc(CHUNK);
  constructor(private readonly fd: number, private readonly size: number) {}

  /** The byte offset of the first good line whose seq is past `afterSeq`, or undefined when none is. */
  firstAfter(afterSeq: number): number | undefined {
    let lo = 0;
    let hi = this.size;
    let best: number | undefined;
    // Invariant: every good line starting before `lo` has seq <= afterSeq, and the first line past it starts at `best`
    // or at a line start in [lo, hi).
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const probe = this.goodLineFrom(mid);
      if (probe === undefined) {
        hi = mid;
      } else if (probe.seq > afterSeq) {
        best = probe.start;
        hi = mid;
      } else {
        lo = probe.end;
      }
    }
    return best;
  }

  /** The line starting at `start`: its bytes (no newline) and where the next starts. */
  line(start: number): { bytes: Buffer; end: number } {
    const nl = this.#newlineFrom(start);
    const bytes = Buffer.alloc(nl - start);
    let got = 0;
    while (got < bytes.length) {
      const n = readSync(this.fd, bytes, got, bytes.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return { bytes: bytes.subarray(0, got), end: Math.min(this.size, nl + 1) };
  }

  /** The first good line starting at or after `pos`. */
  goodLineFrom(pos: number): { start: number; end: number; seq: number } | undefined {
    let start = this.#lineStartAtOrAfter(pos);
    while (start < this.size) {
      const { bytes, end } = this.line(start);
      const seq = seqIn(jsonOf(bytes));
      if (seq !== undefined) return { start, end, seq };
      start = end;
    }
    return undefined;
  }

  #lineStartAtOrAfter(pos: number): number {
    if (pos <= 0) return 0;
    const one = Buffer.alloc(1);
    if (readSync(this.fd, one, 0, 1, pos - 1) === 1 && one[0] === NL) return pos;
    return Math.min(this.size, this.#newlineFrom(pos) + 1);
  }

  /** The offset of the first newline at or after `from`, or the file's size when there is none. */
  #newlineFrom(from: number): number {
    let p = from;
    while (p < this.size) {
      const n = readSync(this.fd, this.#buf, 0, Math.min(CHUNK, this.size - p), p);
      if (n <= 0) break;
      const i = this.#buf.subarray(0, n).indexOf(NL);
      if (i >= 0) return p + i;
      p += n;
    }
    return this.size;
  }
}

function jsonOf(bytes: Buffer): unknown {
  if (bytes.length === 0) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

function seqIn(raw: unknown): number | undefined {
  const seq = typeof raw === "object" && raw !== null ? (raw as { seq?: unknown }).seq : undefined;
  return typeof seq === "number" && Number.isSafeInteger(seq) ? seq : undefined;
}
