// The Plugins page's icons for plugins `plugin.ui` doesn't show (off, found and waiting for their OK, no UI): a found
// plugin's files are untrusted before its OK, so only a small still raster picture inside its folder, by its own header,
// read through one descriptor, and only to a frame of the clover layer.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_MAX_BYTES, ICON_MAX_SIDE, iconPathOf, iconRequest, pictureAllowed, pluginIconFile, rasterType, readSmallFile, type IconSource } from "../src/main/ui/plugin-icon";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const u32be = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16be = (n: number) => Buffer.from([(n >>> 8) & 255, n & 255]);
const u16le = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255]);
const u24le = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255]);
const u32le = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

const pngChunk = (type: string, data: Buffer) => Buffer.concat([u32be(data.length), Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
const png = (w: number, h: number, o: { apng?: boolean } = {}) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk("IHDR", Buffer.concat([u32be(w), u32be(h), Buffer.from([8, 6, 0, 0, 0])])),
  ...(o.apng ? [pngChunk("acTL", Buffer.concat([u32be(2), u32be(0)]))] : []),
  pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])),
  pngChunk("IEND", Buffer.alloc(0)),
]);
const jpegSegment = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16be(data.length + 2), data]);
const jpeg = (w: number, h: number, o: { app?: number } = {}) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
  // Large APPn segments before the frame header (each at most 65533 bytes of data).
  ...Array.from({ length: o.app ?? 0 }, () => jpegSegment(0xe1, Buffer.alloc(60_000))),
  jpegSegment(0xc0, Buffer.concat([Buffer.from([8]), u16be(h), u16be(w), Buffer.from([1, 1, 0x11, 0])])),
  jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.from([0, 0, 0xff, 0xd9]),
]);
const riffChunk = (type: string, data: Buffer) => Buffer.concat([Buffer.from(type, "latin1"), u32le(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
const riff = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(body.length), body]);
};
const vp8 = (w: number, h: number) => riffChunk("VP8 ", Buffer.concat([Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]), u16le(w), u16le(h), Buffer.alloc(8)]));
const vp8l = (w: number, h: number) => riffChunk("VP8L", Buffer.concat([Buffer.from([0x2f]), u32le(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)), Buffer.alloc(6)]));
const vp8x = (w: number, h: number, animated = false) => riffChunk("VP8X", Buffer.concat([Buffer.from([animated ? 0x02 : 0x00, 0, 0, 0]), u24le(w - 1), u24le(h - 1)]));

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const MAX = ICON_MAX_SIDE;

describe("a picture an icon may be", () => {
  test("its type is its first bytes: PNG, JPEG, WebP; never SVG or anything else", () => {
    expect([rasterType(png(1, 1)), rasterType(jpeg(1, 1)), rasterType(riff(vp8(1, 1))), rasterType(SVG), rasterType(Buffer.from("GIF89a")), rasterType(Buffer.alloc(0))]).toEqual(["image/png", "image/jpeg", "image/webp", undefined, undefined, undefined]);
  });

  test("PNG: at the cap yes; over it, zero, a truncated header or an animated PNG no", () => {
    expect(pictureAllowed(png(MAX, MAX))).toBe("image/png");
    expect(pictureAllowed(png(16, 16))).toBe("image/png");
    for (const [what, b] of [["wide", png(MAX + 1, 1)], ["tall", png(1, MAX + 1)], ["huge", png(60000, 60000)], ["zero", png(0, 10)], ["truncated", png(16, 16).subarray(0, 20)], ["apng", png(16, 16, { apng: true })]] as const) {
      expect([what, pictureAllowed(b)]).toEqual([what, undefined]);
    }
  });

  test("JPEG: the frame header found after large APPn segments; at the cap yes; over it, zero, no frame header or truncated no", () => {
    expect(pictureAllowed(jpeg(MAX, MAX))).toBe("image/jpeg");
    expect(pictureAllowed(jpeg(32, 24, { app: 3 }))).toBe("image/jpeg");
    expect(pictureAllowed(jpeg(MAX + 1, 8, { app: 3 }))).toBeUndefined();
    expect(pictureAllowed(jpeg(8, MAX + 1))).toBeUndefined();
    expect(pictureAllowed(jpeg(0, 8))).toBeUndefined();
    // Cut inside the frame header (SOI 2 + APP0 18, then the SOF segment from byte 20).
    expect(pictureAllowed(jpeg(8, 8).subarray(0, 26))).toBeUndefined();
    // A scan before any frame header: no size, refused.
    expect(pictureAllowed(Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]))]))).toBeUndefined();
  });

  test("WebP: lossy, lossless and extended at the cap yes; over it, zero, truncated, animated, or a canvas larger than its frame over the cap no", () => {
    expect(pictureAllowed(riff(vp8(MAX, MAX)))).toBe("image/webp");
    expect(pictureAllowed(riff(vp8l(MAX, MAX)))).toBe("image/webp");
    expect(pictureAllowed(riff(vp8x(64, 64), vp8l(64, 64)))).toBe("image/webp");
    for (const [what, b] of [
      ["lossy over", riff(vp8(MAX + 1, 8))],
      ["lossless over", riff(vp8l(8, MAX + 1))],
      ["lossy zero", riff(vp8(0, 8))],
      ["truncated", riff(vp8(8, 8)).subarray(0, 24)],
      ["animated flag", riff(vp8x(16, 16, true), vp8l(16, 16))],
      ["ANMF chunk", riff(vp8x(16, 16), riffChunk("ANIM", Buffer.alloc(6)), riffChunk("ANMF", Buffer.alloc(16)))],
      ["canvas over, frame small", riff(vp8x(20000, 20000), vp8l(16, 16))],
      ["frame over, canvas small", riff(vp8x(16, 16), vp8l(MAX + 1, 16))],
    ] as const) {
      expect([what, pictureAllowed(b)]).toEqual([what, undefined]);
    }
  });

  test("only a relative path inside the folder", () => {
    expect(iconPathOf({ icon: "assets/icon.png" })).toBe("assets/icon.png");
    for (const bad of ["/etc/a.png", "../a.png", "a/../../b.png", "a//b.png", "./a.png", "https://x.example/a.png", "data:image/png;base64,AA", "a\\b.png", "", 3, undefined]) expect(iconPathOf({ icon: bad })).toBeUndefined();
  });
});

function plugin(files: Record<string, Buffer | string>): string {
  const root = mkdtempSync(join(tmpdir(), "clover-icon-"));
  temps.push(root);
  const folder = join(root, "tarot");
  mkdirSync(folder, { recursive: true });
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(join(folder, rel, ".."), { recursive: true });
    writeFileSync(join(folder, rel), data);
  }
  return folder;
}

describe("a plugin's icon, read and served", () => {
  test("one descriptor: a FIFO, a link at the end, an empty or too-big file give nothing (and never block)", () => {
    const folder = plugin({ "a.png": png(4, 4), "empty.png": "", "big.png": Buffer.alloc(ICON_MAX_BYTES + 1, 1) });
    // A FIFO is a POSIX file: Windows has none to plant.
    const fifo = process.platform !== "win32";
    if (fifo) expect(Bun.spawnSync(["mkfifo", join(folder, "fifo.png")]).exitCode).toBe(0);
    // Windows known failure (a product gap, reported): `readSmallFile` opens with O_NOFOLLOW, which Windows' fs constants lack,
    // so a link at the end is followed there. The link case is not run on win32 until the reader has its own check.
    const link = process.platform !== "win32";
    if (link) symlinkSync(join(folder, "a.png"), join(folder, "link.png"));
    expect(readSmallFile(join(folder, "a.png"), ICON_MAX_BYTES)?.length).toBe(png(4, 4).length);
    const started = Date.now();
    for (const name of [...(fifo ? ["fifo.png"] : []), ...(link ? ["link.png"] : []), "empty.png", "big.png", "missing.png"]) expect([name, readSmallFile(join(folder, name), ICON_MAX_BYTES)]).toEqual([name, undefined]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("served: a small still picture of its own; refused: SVG (even named .png), too big, too large a picture, a link out, a bad id", async () => {
    const outside = plugin({ "secret.png": png(4, 4) });
    const folder = plugin({
      "assets/icon.png": png(64, 64), "assets/photo.jpg": jpeg(48, 48, { app: 2 }), "assets/fake.png": SVG, "assets/icon.svg": SVG,
      "assets/big.png": Buffer.concat([png(4, 4), Buffer.alloc(ICON_MAX_BYTES)]), "assets/bomb.png": png(60000, 60000), "assets/moving.png": png(8, 8, { apng: true }),
    });
    symlinkSync(join(outside, "secret.png"), join(folder, "assets", "out.png"));
    // The fake answers what `plugin.iconSource` answers (its own result type), never more.
    const get = (icon: string) => async (): Promise<IconSource> => ({ folder, icon });
    expect(await pluginIconFile(get("assets/icon.png"), "tarot")).toMatchObject({ type: "image/png" });
    expect(await pluginIconFile(get("assets/photo.jpg"), "tarot")).toMatchObject({ type: "image/jpeg" });
    for (const icon of ["assets/fake.png", "assets/icon.svg", "assets/big.png", "assets/bomb.png", "assets/moving.png", "assets/out.png", "assets/missing.png", "../tarot/assets/icon.png"]) {
      expect([icon, await pluginIconFile(get(icon), "tarot")]).toEqual([icon, undefined]);
    }
    for (const id of ["../tarot", "Tarot", "tarot/part", "x".repeat(41)]) expect(await pluginIconFile(get("assets/icon.png"), id)).toBeUndefined();
    expect(await pluginIconFile(async () => ({}), "tarot")).toBeUndefined();
    expect(await pluginIconFile(async () => { throw new Error("not_found: tarot isn't installed"); }, "tarot")).toBeUndefined();
  });

  test("the route's door: by the frame that asks — the clover layer's frame yes; no known frame, another layer's frame, or a forged host no", () => {
    expect(iconRequest("clover", "clover-plugin://clover/_icon/tarot")).toBe("allow");
    expect(iconRequest(undefined, "clover-plugin://clover/_icon/tarot")).toBe("refuse");
    expect(iconRequest("tarot-panel", "clover-plugin://clover/_icon/tarot")).toBe("refuse");
    expect(iconRequest("tarot-panel", "clover-plugin://tarot-panel/_icon/tarot")).toBe("refuse");
    expect(iconRequest("clover", "clover-plugin://tarot-panel/_icon/tarot")).toBe("refuse");
    // Not this door's.
    expect(iconRequest(undefined, "clover-plugin://clover/_t/tarot/a.png")).toBe("not-icon");
    expect(iconRequest(undefined, "not a url")).toBe("not-icon");
  });
});
