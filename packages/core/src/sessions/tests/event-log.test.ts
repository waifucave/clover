// The event log's append (../event-log.ts): a write that fails part way, or a flush that fails, leaves the file as it
// was, so the next record never follows half of one, and the next load keeps every record.
import { afterEach, expect, test } from "bun:test";
import { closeSync, fsyncSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../../contracts/session-host";
import { appendLine, SessionLogFile, type AppendIo } from "../event-log";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const record = (seq: number): SessionRecord => ({ type: "status", status: "idle", seq, sessionId: "b_alpha", ts: 1_000 + seq }) as SessionRecord;

/** The real calls, except that a write stops half way and then fails (a full disk), or the flush fails. */
function failing(how: "write" | "flush"): AppendIo {
  let writes = 0;
  return {
    writeSync: (fd, buffer, offset, length) => {
      if (how === "write" && writes++ > 0) throw new Error("ENOSPC: no space left on device");
      return writeSync(fd, buffer, offset, how === "write" ? Math.ceil(length / 2) : length);
    },
    fsyncSync: (fd) => {
      if (how === "flush") throw new Error("EIO: i/o error");
      fsyncSync(fd);
    },
    ftruncateSync,
  };
}

test("an append that fails part way, or whose flush fails, is cut back off; the next record and the next load are whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "clover-d-log-"));
  dirs.push(dir);
  const path = join(dir, "b_alpha.ndjson");
  const log = new SessionLogFile(path, "b_alpha");
  log.append(record(0), { durable: true });
  const good = readFileSync(path);

  for (const how of ["write", "flush"] as const) {
    const fd = openSync(path, "a");
    try {
      expect(() => appendLine(fd, Buffer.from(`${JSON.stringify(record(1))}\n`), good.length, true, failing(how))).toThrow(how === "write" ? "ENOSPC" : "EIO");
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path).equals(good)).toBe(true);
  }

  log.append(record(1), { durable: true });
  log.append(record(2), { durable: false });
  const warnings: string[] = [];
  const again = new SessionLogFile(path, "b_alpha", (m) => warnings.push(m));
  const seqs: number[] = [];
  expect(again.load((r) => seqs.push(r.seq))).toEqual({ records: 3 });
  expect(seqs).toEqual([0, 1, 2]);
  expect(warnings).toEqual([]);
});
