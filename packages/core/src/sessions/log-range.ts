// A seq-ranged read of a session log (`SessionStore.readRange`): the events after a seq, a page at a time, without
// reading or parsing the lines before it. Owner: lane D (the archive's `archive.history`).
//
// A session's log is ascending in seq (the store appends `last_seq + 1`, and a synced page lands gapless after it), so
// the page's first line is found by bisecting the file's bytes: each probe parses ONE line, so a page costs
// O(log size) probe lines plus the page's own. A line that doesn't parse (a crash's cut tail, a corrupt record) is
// skipped, as `readGoodLines` skips it.
//
// No line is ever read whole when it is longer than `maxOne`: a line is read at most `maxOne + 1` bytes at a time, and
// a longer one (a huge record, or a corrupt run with no newline) is only scanned for its end in fixed chunks, never
// allocated. Its seq comes from its head (the store writes `{"seq":N,` first, the event schema's own key order); one
// without a readable seq there is skipped like a line that doesn't parse. The reader remembers each long line and
// each newline-free stretch it has scanned, so the bisect's later probes never read them again.
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
  /** A line longer than this is never returned, nor read whole: the page reports it as `oversized`, alone, so the
   *  caller can say it was left out and page on past it. */
  maxOne: number;
  /** Filled with how many bytes the read took from the file (tests and diagnostics: the bisect's cost). */
  stats?: { scanned: number };
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
    const io = new LineReader(fd, size, o.maxOne);
    if (o.stats !== undefined) o.stats.scanned = 0;
    const done = <T,>(out: T): T => {
      if (o.stats !== undefined) o.stats.scanned = io.scanned;
      return out;
    };
    const first = io.firstAfter(afterSeq);
    const events: SessionEvent[] = [];
    let used = 0;
    let at = first ?? size;
    while (at < size && events.length < o.limit) {
      const line = io.line(at);
      if (line.long !== undefined) {
        const seq = line.long.seq;
        if (seq !== undefined && seq > afterSeq) {
          if (events.length > 0) break;
          return done({ events, oversized: { seq, bytes: line.long.bytes }, more: line.end < size });
        }
      } else {
        const raw = jsonOf(line.bytes);
        const seq = seqIn(raw);
        if (seq !== undefined && seq > afterSeq) {
          if (events.length > 0 && used + line.bytes.length > o.maxBytes) break;
          const event = SessionEvent.safeParse(raw);
          if (event.success) {
            events.push(event.data);
            used += line.bytes.length;
          }
        }
      }
      at = line.end;
    }
    return done({ events, more: at < size });
  } finally {
    closeSync(fd);
  }
}

/** A line: its bytes (no newline), or, when it is longer than the cap, only its length and the seq its head names. */
type Line = { bytes: Buffer; long?: undefined; end: number } | { bytes?: undefined; long: { seq?: number; bytes: number }; end: number };

/** Only stretches this long are remembered: shorter ones cost less to read again than to look up. */
const REMEMBER_RUN = CHUNK;
/** How much of a long line's head is read for its seq. */
const HEAD = 64;
const HEAD_SEQ = /^\{"seq":(\d{1,15})[,}]/;

class LineReader {
  readonly #buf = Buffer.alloc(CHUNK);
  /** Lines longer than the cap, by their start. */
  readonly #long = new Map<number, Line & { long: object }>();
  /** Newline-free stretches already scanned: from any position in [from, to) the next newline is at `nl` (or there is
   *  none before the file's end, `nl` = size), and the next line starts at `to`. */
  readonly #runs: { from: number; to: number; nl: number }[] = [];
  /** Bytes read from the file so far. */
  scanned = 0;
  constructor(private readonly fd: number, private readonly size: number, private readonly cap: number) {}

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

  /** The line starting at `start`, read at most `cap + 1` bytes: whole when it fits, else its length and head's seq. */
  line(start: number): Line {
    const known = this.#long.get(start);
    if (known !== undefined) return known;
    // Read a chunk at a time, growing the buffer only as the line goes on, and never past `cap + 1` bytes.
    const want = Math.min(this.cap + 1, this.size - start);
    let buf = Buffer.allocUnsafe(Math.min(CHUNK, want));
    let got = 0;
    while (got < want) {
      if (got === buf.length) {
        const bigger = Buffer.allocUnsafe(Math.min(buf.length * 2, want));
        buf.copy(bigger, 0, 0, got);
        buf = bigger;
      }
      const n = readSync(this.fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      this.scanned += n;
      const nl = buf.subarray(got, got + n).indexOf(NL);
      if (nl >= 0) return { bytes: buf.subarray(0, got + nl), end: start + got + nl + 1 };
      got += n;
    }
    if (got <= this.cap) return { bytes: buf.subarray(0, got), end: start + got };
    // Longer than the cap: find its end without holding it, and remember it.
    const at = this.#newlineFrom(start + got);
    const end = Math.min(this.size, at + 1);
    const m = HEAD_SEQ.exec(buf.subarray(0, Math.min(HEAD, got)).toString("latin1"));
    const seq = m === null ? undefined : Number(m[1]);
    const long = { long: { ...(seq === undefined ? {} : { seq }), bytes: at - start }, end };
    this.#long.set(start, long);
    this.#runs.push({ from: start + 1, to: end, nl: at });
    return long;
  }

  /** The first good line starting at or after `pos`. */
  goodLineFrom(pos: number): { start: number; end: number; seq: number } | undefined {
    let start = this.#lineStartAtOrAfter(pos);
    while (start < this.size) {
      const line = this.line(start);
      const seq = line.long !== undefined ? line.long.seq : seqIn(jsonOf(line.bytes));
      if (seq !== undefined) return { start, end: line.end, seq };
      start = line.end;
    }
    return undefined;
  }

  #lineStartAtOrAfter(pos: number): number {
    if (pos <= 0) return 0;
    const run = this.#runAt(pos);
    if (run !== undefined) return run.to;
    const one = Buffer.alloc(1);
    const n = readSync(this.fd, one, 0, 1, pos - 1);
    this.scanned += Math.max(0, n);
    if (n === 1 && one[0] === NL) return pos;
    const at = this.#newlineFrom(pos);
    const to = Math.min(this.size, at + 1);
    // The bytes from pos-1 up to the newline hold none, so every position in that stretch starts its line at `to`.
    if (at - pos >= REMEMBER_RUN) this.#runs.push({ from: pos, to, nl: at });
    return to;
  }

  #runAt(pos: number): { from: number; to: number; nl: number } | undefined {
    return this.#runs.find((r) => r.from <= pos && pos < r.to);
  }

  /** The offset of the first newline at or after `from`, or the file's size when there is none (fixed chunks; a
   *  stretch already scanned is skipped, never read again). */
  #newlineFrom(from: number): number {
    let p = from;
    while (p < this.size) {
      const run = this.#runAt(p);
      if (run !== undefined) return run.nl;
      // Stop the chunk where a known stretch begins, so the next turn skips it.
      let stop = Math.min(this.size, p + CHUNK);
      for (const r of this.#runs) if (r.from > p && r.from < stop) stop = r.from;
      const n = readSync(this.fd, this.#buf, 0, stop - p, p);
      if (n <= 0) break;
      this.scanned += n;
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
