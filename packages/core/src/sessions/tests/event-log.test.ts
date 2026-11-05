// The event log (../event-log.ts): appends land at the log's known end and only after a load; a failed write is cut
// back off, and a failed flush makes the log read-only; a bad line in the middle is a lost record, not the end of the
// log; a line over the cap is never held whole; a long field is cut to fit.
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, constants, ftruncateSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../../contracts/session-host";
import { appendLine, FlushError, LOST_EVENT_TYPE, MAX_RECORD_BYTES, SessionLogFile, shrinkRecord, type AppendIo } from "../event-log";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function logPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "clover-d-log-"));
  dirs.push(dir);
  return join(dir, "b_alpha.ndjson");
}

const record = (seq: number, text = `m${seq}`): SessionRecord =>
  ({ type: "driver", event: { type: "assistant_message", text }, seq, sessionId: "b_alpha", ts: 1_000 + seq }) as SessionRecord;
const line = (seq: number) => `${JSON.stringify(record(seq))}\n`;

function loaded(path: string, warnings: string[] = []): { log: SessionLogFile; seqs: number[]; result: ReturnType<SessionLogFile["load"]> } {
  const log = new SessionLogFile(path, "b_alpha", (m) => warnings.push(m));
  const seqs: number[] = [];
  const result = log.load((r) => seqs.push(r.seq));
  return { log, seqs, result };
}

/** The real calls, except that a write stops half way and then fails (a full disk), or the flush fails. */
function failing(how: "write" | "flush" | "write-and-cut"): AppendIo {
  let writes = 0;
  return {
    writeSync: (fd, buffer, offset, length, position) => {
      if (how !== "flush" && writes++ > 0) throw new Error("ENOSPC: no space left on device");
      return writeSync(fd, buffer, offset, how === "flush" ? length : Math.ceil(length / 2), position);
    },
    syncFile: () => {
      if (how === "flush") throw new Error("EIO: i/o error");
    },
    ftruncateSync: (fd, length) => {
      if (how === "write-and-cut") throw new Error("EIO: can't cut either");
      ftruncateSync(fd, length);
    },
  };
}

describe("appending", () => {
  test("a log takes records only once it was loaded, so a new session never writes after an old log's lines", () => {
    const path = logPath();
    writeFileSync(path, line(0) + line(1));
    const log = new SessionLogFile(path, "b_alpha");
    expect(() => log.append(record(0), { durable: true })).toThrow("before it was loaded");
    log.load();
    log.append(record(2), { durable: true });
    expect(loaded(path).seqs).toEqual([0, 1, 2]);
  });

  test("a write that fails part way is cut back off; if even that fails, the next record overwrites it", () => {
    const path = logPath();
    const log = loaded(path).log;
    log.append(record(0), { durable: true });
    const good = readFileSync(path);
    for (const how of ["write", "write-and-cut"] as const) {
      const fd = openSync(path, constants.O_WRONLY);
      try {
        expect(() => appendLine(fd, Buffer.from(line(1)), good.length, true, failing(how))).toThrow("ENOSPC");
      } finally {
        closeSync(fd);
      }
      if (how === "write") expect(readFileSync(path).equals(good)).toBe(true);
    }
    // The half record the failed cut left is written over at the log's known end.
    log.append(record(1), { durable: true });
    log.append(record(2), { durable: false });
    const warnings: string[] = [];
    const again = loaded(path, warnings);
    expect(again.seqs).toEqual([0, 1, 2]);
    expect(again.result.repaired).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("a failed flush makes the log read-only for the rest of the process", () => {
    const path = logPath();
    const log = loaded(path).log;
    log.append(record(0), { durable: true });
    const fd = openSync(path, constants.O_WRONLY);
    try {
      expect(() => appendLine(fd, Buffer.from(line(1)), readFileSync(path).length, true, failing("flush"))).toThrow(FlushError);
    } finally {
      closeSync(fd);
    }
  });

  test("a record over the cap is refused, and the host's cut makes it fit", () => {
    const path = logPath();
    const log = loaded(path).log;
    const big = record(0, "x".repeat(MAX_RECORD_BYTES));
    expect(() => log.append(big, { durable: false })).toThrow(`over ${MAX_RECORD_BYTES}`);
    const bytes = Buffer.byteLength(JSON.stringify(big)) + 1;
    const cut = shrinkRecord(big, bytes)!;
    expect(cut).toMatchObject({ type: "driver", event: { type: "assistant_message", truncated: true } });
    expect((cut as unknown as { event: { text: string } }).event.text.length).toBe(64 * 1024 + 1);
    log.append(cut, { durable: false });
    expect(loaded(path).seqs).toEqual([0]);
    expect(shrinkRecord(record(1), 100)).toBeUndefined();
  });
});

describe("loading", () => {
  test("a bad line in the middle is a lost record: the log goes on, and is rewritten once with a placeholder", () => {
    const path = logPath();
    const lines = Array.from({ length: 1_000 }, (_, i) => line(i));
    lines[10] = `${lines[10]!.slice(0, 20)}\u0000garbage\n`;
    writeFileSync(path, lines.join(""));
    const warnings: string[] = [];
    const first = loaded(path, warnings);
    expect(first.result).toEqual({ records: 1_000, lost: 1 });
    expect(first.seqs).toHaveLength(999);
    expect(first.log.read(9, 12).map((r) => (r.type === "driver" ? r.event.type : r.type))).toEqual(["assistant_message", LOST_EVENT_TYPE, "assistant_message"]);
    expect(first.log.read(10, 11)[0]).toMatchObject({ seq: 10, ts: 1_009 });
    expect(warnings.join("\n")).toContain("1 unreadable record(s) in the middle");
    expect(readdirSync(join(path, "..")).filter((f) => f.includes(".corrupt-"))).toHaveLength(1);
    // The rewrite settles it: the next load is clean, and the log takes the next record.
    first.log.append(record(1_000), { durable: true });
    const later: string[] = [];
    const second = loaded(path, later);
    expect(second.result).toEqual({ records: 1_001 });
    expect(later).toEqual([]);
  });

  test("a line that was no record at all is dropped from the middle; bad lines at the end are cut", () => {
    const path = logPath();
    writeFileSync(path, line(0) + "{not a record}\n" + line(1) + line(2) + "bad\n" + "worse\n");
    const warnings: string[] = [];
    const { seqs, result } = loaded(path, warnings);
    expect(seqs).toEqual([0, 1, 2]);
    expect(result).toEqual({ records: 3, repaired: "corrupt" });
    expect(readFileSync(path, "utf8")).toBe(line(0) + line(1) + line(2));
    expect(warnings.join("\n")).toContain("1 line(s) in the middle that were no record");
  });

  test("a line longer than any record is never held whole: it is lost, and loading costs no more than the cap", () => {
    const path = logPath();
    const huge = `{"type":"driver","event":{"type":"tool_result","text":"${"y".repeat(3 * MAX_RECORD_BYTES)}"},"seq":1,"sessionId":"b_alpha","ts":1}\n`;
    writeFileSync(path, line(0) + huge + line(2));
    const before = process.memoryUsage().rss;
    const { seqs, result, log } = loaded(path);
    expect(process.memoryUsage().rss - before).toBeLessThan(6 * MAX_RECORD_BYTES);
    expect(seqs).toEqual([0, 2]);
    expect(result).toEqual({ records: 3, lost: 1 });
    expect(log.read(1, 2)[0]).toMatchObject({ type: "driver", event: { type: LOST_EVENT_TYPE } });
  });

  test("a torn last line is dropped without a copy", () => {
    const path = logPath();
    writeFileSync(path, line(0) + line(1).slice(0, 15));
    const warnings: string[] = [];
    expect(loaded(path, warnings).result).toEqual({ records: 1, repaired: "torn-tail" });
    expect(readdirSync(join(path, "..")).some((f) => f.includes(".corrupt-"))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(line(0));
  });
});
