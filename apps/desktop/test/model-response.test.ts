// A bot's avatar model file on `/_t/`: streamed with its length, and refused above the limit before it is read.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_MAX_BYTES, modelResponse } from "../src/main/ui/files";

const dir = mkdtempSync(join(tmpdir(), "clover-model-"));
const H = { "X-Content-Type-Options": "nosniff" };

describe("a bot's avatar model file", () => {
  test("is streamed with its length and type", async () => {
    const file = join(dir, "a.vrm");
    writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    const r = modelResponse(file, "application/octet-stream", H);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("4");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  test("above the limit is refused with 413 and a sentence, without reading it", async () => {
    const file = join(dir, "big.vrm");
    writeFileSync(file, Buffer.alloc(2048));
    const r = modelResponse(file, "application/octet-stream", H, 1024);
    expect(r.status).toBe(413);
    expect(await r.text()).toContain("the most it can be is");
    expect(MODEL_MAX_BYTES).toBe(96 * 1024 * 1024);
  });

  test("a file that is not there is a 404", () => {
    expect(modelResponse(join(dir, "none.vrm"), "application/octet-stream", H).status).toBe(404);
  });
});
