import { describe, expect, test } from "bun:test";

describe("the layer frame and its document agree on a colour scheme", () => {
  test("root.css's frame says what layer.css's document says (a mismatch paints an opaque dark canvas behind a transparent surface)", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const root = readFileSync(join(import.meta.dir, "../src/core/root.css"), "utf8");
    const layer = readFileSync(join(import.meta.dir, "../src/layer/layer.css"), "utf8");
    const frame = /#clover-stage > iframe \{[^}]*color-scheme:\s*([^;}]+)/.exec(root)?.[1]?.trim();
    const document_ = /:root \{ color-scheme:\s*([^;}]+)/.exec(layer)?.[1]?.trim();
    expect(frame).toBeDefined();
    expect(frame).toBe(document_);
  });
});
