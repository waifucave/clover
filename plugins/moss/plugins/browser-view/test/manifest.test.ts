import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "moss.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The capability catalog's names (the SDK's generated catalog, so a capability the catalog adds is known here at once). */
const CAPABILITIES = new Set<string>((JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "packages", "plugin-sdk", "generated", "catalog.json"), "utf8")) as { capabilities: { name: string }[] }).capabilities.map((c) => c.name));

describe("moss.json (spec §5.9, format 1)", () => {
  test("a child of `moss`: no id of its own, a name, format 1", () => {
    expect(manifest.manifest).toBe(1);
    expect(manifest.id).toBeUndefined();
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
  });

  test("its client entry exists, and a plugin with code names its plugin-API range", () => {
    expect(existsSync(join(root, manifest.client.entry))).toBe(true);
    expect(typeof manifest.engines?.moss).toBe("string");
  });

  test("fills the panel spot keyed browser with the container, and asks for the browser capability", () => {
    expect(manifest.name).toBe("Browser");
    expect(manifest.capabilities).toEqual(["browser"]);
    expect(manifest.contributes.ui).toEqual([{ spot: "panel", key: "browser", title: "Browser", component: "BrowserPanel" }]);
  });

  test("asks only for capabilities the spec defines", () => {
    for (const c of manifest.capabilities ?? []) {
      expect(CAPABILITIES.has(c) || c.startsWith("call:") || c.startsWith("network:")).toBe(true);
    }
  });

  test("the package is named for the child", () => {
    expect(pkg.name).toBe("@waifucave/moss-plugin-browser-view");
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
});
