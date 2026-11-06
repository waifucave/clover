import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestFindings } from "../../shell/runtime/manifest-check";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "clover.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Spec §5.4's capabilities (plus the two families), and lane B's `terminal` and `devices.read`. */
const CAPABILITIES = new Set([
  "conversation.read", "conversation.post", "memory.read", "bots.read", "routines.read", "computers.read",
  "computers.control", "approvals", "files", "browser", "usage.read", "logs.read", "notify", "audio",
  // Lane B's, beyond the spec's list: the terminal (F's request) and the devices list.
  "terminal", "devices.read",
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
    expect(pkg.name).toBe("@waifucave/clover-plugin-archive");
    expect(pkg.private).toBe(true);
  });

  test("client.css names stylesheets that exist, and the entry imports none (lane B: they load before the components)", () => {
    expect(manifest.client.css.length).toBeGreaterThan(0);
    for (const css of manifest.client.css) expect(existsSync(join(root, css))).toBe(true);
    expect(readFileSync(join(root, manifest.client.entry), "utf8")).not.toMatch(/import\s+["'][^"']+\.css["']/);
  });

  test("each ui entry names a component the entry exports, and declares spots with props", async () => {
    const entry = await import(join(root, manifest.client.entry));
    for (const ui of manifest.contributes.ui) {
      expect([ui.component, typeof entry[ui.component]]).toEqual([ui.component, "function"]);
      for (const [name, decl] of Object.entries(ui.declares ?? {})) {
        expect([name, typeof (decl as { props?: unknown }).props]).toEqual([name, "object"]);
      }
    }
  });

  test("lane B's validator finds nothing it would report, loaded as a bundled part of clover", () => {
    expect(manifestFindings(root)).toEqual([]);
  });
});
