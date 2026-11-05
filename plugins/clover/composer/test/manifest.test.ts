import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "clover.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Spec §5.4's capabilities (plus the two families). */
const CAPABILITIES = new Set([
  "conversation.read", "conversation.post", "memory.read", "bots.read", "routines.read", "computers.read",
  "computers.control", "approvals", "files", "browser", "usage.read", "logs.read", "notify", "audio",
]);

describe("clover.json (spec §5.9, format 1)", () => {
  test("a child of `clover`: no id of its own, a name, format 1", () => {
    expect(manifest.manifest).toBe(1);
    expect(manifest.id).toBeUndefined();
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
  });

  test("its client entry exists, and a plugin with code names its plugin-API range", () => {
    expect(existsSync(join(root, manifest.client.entry))).toBe(true);
    expect(typeof manifest.engines?.clover).toBe("string");
  });

  test("asks only for capabilities the spec defines", () => {
    for (const c of manifest.capabilities ?? []) {
      expect(CAPABILITIES.has(c) || c.startsWith("call:") || c.startsWith("network:")).toBe(true);
    }
  });

  test("the package is named for the child", () => {
    expect(pkg.name).toBe("@waifucave/clover-plugin-composer");
    expect(pkg.private).toBe(true);
  });
});
