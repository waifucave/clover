// The page's icons (docs/moss-brand.md): the favicon, the touch icon and the manifest's icons, the Shards tile, and
// the header's mark by the page's scheme. Every file they name is one scripts/brand-icons.ts draws or records in src/icons.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "..", "src");
const html = readFileSync(join(src, "index.html"), "utf8");
const manifest = JSON.parse(readFileSync(join(src, "manifest.webmanifest"), "utf8")) as {
  name: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};
const at = (url: string) => join(src, url.replace(/^\//, ""));

/** A PNG's width and height, from its header. */
function pngSize(path: string): [number, number] {
  const b = readFileSync(path);
  expect(b.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("the page's icons", () => {
  test("the page names a favicon (SVG, and a PNG for the rest), a touch icon and the manifest, and each is there", () => {
    const linked = [...html.matchAll(/<link rel="(icon|apple-touch-icon|manifest)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(linked).toEqual([
      ["icon", "/icons/favicon.svg"],
      ["icon", "/icons/favicon-32.png"],
      ["apple-touch-icon", "/icons/apple-touch-icon.png"],
      ["manifest", "/manifest.webmanifest"],
    ]);
    for (const [, href] of linked) expect(existsSync(at(href!))).toBe(true);
    expect(pngSize(at("/icons/favicon-32.png"))).toEqual([32, 32]);
    expect(pngSize(at("/icons/apple-touch-icon.png"))).toEqual([180, 180]);
    // The favicon is the kit's tile: the mark on Night.
    expect(readFileSync(at("/icons/favicon.svg"), "utf8")).toContain('rx="230.4" fill="#161A33"');
  });

  test("the manifest: MOSS's name, its Night, and icons at 192 and 512 (one maskable), each the size it says", () => {
    expect(manifest.name).toBe("MOSS");
    expect(manifest.theme_color).toBe("#161A33");
    expect(manifest.icons.filter((i) => i.purpose === "maskable").map((i) => i.src)).toEqual(["/icons/icon-maskable-512.png"]);
    for (const icon of manifest.icons) {
      expect(existsSync(at(icon.src))).toBe(true);
      if (icon.type === "image/png") {
        const [w, h] = pngSize(at(icon.src));
        expect(`${w}x${h}`).toBe(icon.sizes);
      }
    }
  });

  test("the header's mark: the on-light cut on a light page, the on-dark cut on a dark one", () => {
    expect(html).toContain('<img class="mark mark--light" src="/icons/mark-light.svg" alt="" />');
    expect(html).toContain('<img class="mark mark--dark" src="/icons/mark-dark.svg" alt="" />');
    expect(readFileSync(at("/icons/mark-light.svg"), "utf8")).toContain('fill="#1B1D2B"');
    expect(readFileSync(at("/icons/mark-dark.svg"), "utf8")).toContain('fill="#F6F4EE"');
    const css = readFileSync(join(src, "style.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*\.mark--light \{ display: none; \}\s*\.mark--dark \{ display: inline; \}/);
  });
});
