// The Plugins page's icons for plugins `plugin.ui` doesn't show (off, found and waiting for their OK, no UI): a found
// plugin's files are untrusted before its OK, so only a raster picture inside its folder, by its first bytes, capped.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_MAX_BYTES, iconPathOf, pluginIconFile, rasterType } from "../src/main/ui/plugin-icon";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function plugin(files: Record<string, Buffer | string>): string {
  const root = mkdtempSync(join(tmpdir(), "clover-icon-"));
  temps.push(root);
  const folder = join(root, "tarot");
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(join(folder, rel, ".."), { recursive: true });
    writeFileSync(join(folder, rel), data);
  }
  mkdirSync(folder, { recursive: true });
  return folder;
}

describe("a plugin's icon for the Plugins page", () => {
  test("its type is its first bytes: PNG, JPEG, WebP; never SVG or anything else", () => {
    expect([rasterType(PNG), rasterType(JPEG), rasterType(WEBP), rasterType(SVG), rasterType(Buffer.from("GIF89a")), rasterType(Buffer.alloc(0))]).toEqual(["image/png", "image/jpeg", "image/webp", undefined, undefined, undefined]);
  });

  test("only a relative path inside the folder", () => {
    expect(iconPathOf({ icon: "assets/icon.png" })).toBe("assets/icon.png");
    for (const bad of ["/etc/a.png", "../a.png", "a/../../b.png", "a//b.png", "./a.png", "https://x.example/a.png", "data:image/png;base64,AA", "a\\b.png", "", 3, undefined]) expect(iconPathOf({ icon: bad })).toBeUndefined();
  });

  test("served: a raster picture of its own; refused: SVG (even named .png), too big, a link out, another id's, a bad id", async () => {
    const outside = plugin({ "secret.png": PNG });
    const folder = plugin({ "assets/icon.png": PNG, "assets/fake.png": SVG, "assets/icon.svg": SVG, "assets/big.png": Buffer.concat([PNG, Buffer.alloc(ICON_MAX_BYTES)]), "assets/photo.jpg": JPEG });
    symlinkSync(join(outside, "secret.png"), join(folder, "assets", "out.png"));
    const get = (icon: string) => async () => ({ folder, manifest: { icon } });
    expect(await pluginIconFile(get("assets/icon.png"), "tarot")).toMatchObject({ type: "image/png" });
    expect(await pluginIconFile(get("assets/photo.jpg"), "tarot")).toMatchObject({ type: "image/jpeg" });
    for (const icon of ["assets/fake.png", "assets/icon.svg", "assets/big.png", "assets/out.png", "assets/missing.png", "../tarot/assets/icon.png"]) {
      expect([icon, await pluginIconFile(get(icon), "tarot")]).toEqual([icon, undefined]);
    }
    for (const id of ["../tarot", "Tarot", "tarot/part", "x".repeat(41)]) expect(await pluginIconFile(get("assets/icon.png"), id)).toBeUndefined();
    // A plugin the core doesn't know, or a refused read: none.
    expect(await pluginIconFile(async () => undefined, "tarot")).toBeUndefined();
    expect(await pluginIconFile(async () => { throw new Error("not_found: tarot isn't installed"); }, "tarot")).toBeUndefined();
  });
});
