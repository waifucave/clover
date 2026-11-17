// The fake agent's report file is read while the agent (another process) is still appending to it.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReport } from "../testing/harness";

const dir = mkdtempSync(join(tmpdir(), "report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readReport", () => {
  test("a line still being written (its newline not there yet) is left for the next look, never a parse error", () => {
    const file = join(dir, "a.ndjson");
    writeFileSync(file, `${JSON.stringify({ type: "answer", kind: "reject_once" })}\n{"type":"answer","kind":"reje`);
    expect(readReport(file)).toEqual([{ type: "answer", kind: "reject_once" }]);
    appendFileSync(file, `ct_once"}\n`);
    expect(readReport(file).map((r) => r.type)).toEqual(["answer", "answer"]);
  });

  test("no file yet reads as no reports, and a whole file reads whole", () => {
    expect(readReport(join(dir, "none.ndjson"))).toEqual([]);
    const file = join(dir, "b.ndjson");
    writeFileSync(file, `{"type":"started"}\n{"type":"blocked"}\n`);
    expect(readReport(file).map((r) => r.type)).toEqual(["started", "blocked"]);
  });
});
