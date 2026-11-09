// Flushes that survive a power cut (src/durable.ts): a file and a folder flush on every OS (on Windows the file is
// opened for writing, which FlushFileBuffers needs, and never truncated); F_FULLFSYNC falls back to fsync only where
// it isn't supported, and any other failure is an error.
import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flush, FULLFSYNC_UNSUPPORTED, syncDir, syncFile } from "../src/durable";

describe("durable flushes", () => {
  test("a file and its folder flush, and the file keeps its bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-durable-"));
    const f = join(dir, "clover-core.new");
    writeFileSync(f, "the binary");
    syncFile(f);
    syncDir(dir);
    expect(readFileSync(f, "utf8")).toBe("the binary");
  });

  test("F_FULLFSYNC: done; not supported here (ENOTSUP, ENOTTY, EINVAL) falls back to fsync; anything else throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-durable-"));
    const fd = openSync(join(dir, "f"), "w");
    try {
      flush(fd, () => ({ result: 0, errno: 0 }));
      for (const errno of FULLFSYNC_UNSUPPORTED) flush(fd, () => ({ result: -1, errno }));
      expect(() => flush(fd, () => ({ result: -1, errno: 5 /* EIO */ }))).toThrow("F_FULLFSYNC failed (errno 5)");
      flush(fd, null);
    } finally {
      closeSync(fd);
    }
  });
});
