// Clover's icons (scripts/brand-icons.ts, docs/clover-brand.md): the eight sources are the clover's one plain path,
// every committed output is the one the script drew from them (outputs.json's hashes, so an output edited by hand or
// a source changed without a run fails here), each container holds the sizes its platform wants, and every place
// that wears the mark names a file that is there.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BRAND, ICNS_TYPES, ICO_SIZES, JOBS, LINUX_SIZES, RECORD, REPO, VARIANTS, cloverPath, drawnSvg, rel, sha256, sourcePath, type OutputsRecord, type PngJob } from "./brand-icons";

const record = JSON.parse(readFileSync(RECORD, "utf8")) as OutputsRecord;
const job = (end: string) => JOBS.find((j) => rel(j.out).endsWith(end))!;

function pngSize(b: Buffer): [number, number] {
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("the sources", () => {
  test("eight SVGs, each the same clover path on a 200 viewBox, in Clover's three colours, and nothing else in them", () => {
    expect(readdirSync(BRAND).filter((f) => f.endsWith(".svg")).sort()).toEqual(VARIANTS.map((v) => `clover-${v}.svg`).sort());
    const paths = new Set<string>();
    for (const v of VARIANTS) {
      const svg = readFileSync(sourcePath(v), "utf8");
      expect(svg).toContain('viewBox="0 0 200 200"');
      // Plain shapes only: no script, style, link, image or foreign content.
      expect(svg).not.toMatch(/<script|<style|<image|<foreignObject|href=|url\(|on[a-z]+=/i);
      expect(svg.match(/<(?!\/)([a-z]+)/g)!.map((t) => t.slice(1)).filter((t) => !["svg", "title", "rect", "path"].includes(t))).toEqual([]);
      for (const colour of svg.match(/#[0-9A-Fa-f]{6}/g)!) expect(["#3D7655", "#191919", "#FFFFFF"]).toContain(colour);
      const p = cloverPath(svg);
      paths.add(`${p.transform}|${p.d}`);
      const [fg, , bg] = v.split("-");
      expect(p.fill).toBe({ white: "#FFFFFF", green: "#3D7655", dark: "#191919" }[fg!]!);
      if (bg === "transparent") expect(svg).not.toContain("<rect");
      else expect(svg).toContain(`<rect width="200" height="200" rx="40" fill="${{ white: "#FFFFFF", green: "#3D7655", dark: "#191919" }[bg!]}" />`);
    }
    expect(paths.size).toBe(1);
  });
});

describe("the outputs", () => {
  test("outputs.json names every source and every output, with today's hashes: nothing edited by hand, nothing stale", () => {
    expect(record.renderer).toBe("@resvg/resvg-js 2.6.2");
    expect(record.sources).toEqual(Object.fromEntries(VARIANTS.map((v) => [rel(sourcePath(v)), sha256(readFileSync(sourcePath(v)))])));
    expect(Object.keys(record.outputs).sort()).toEqual(JOBS.map((j) => rel(j.out)).sort());
    for (const j of JOBS) {
      expect([rel(j.out), existsSync(j.out)]).toEqual([rel(j.out), true]);
      expect([rel(j.out), sha256(readFileSync(j.out))]).toEqual([rel(j.out), record.outputs[rel(j.out)]!.sha256]);
      expect(record.outputs[rel(j.out)]!.from).toBe(rel(sourcePath(j.from)));
    }
  });

  test("every PNG is the size its job says", () => {
    for (const j of JOBS.filter((x): x is PngJob => x.kind === "png")) expect([rel(j.out), pngSize(readFileSync(j.out))]).toEqual([rel(j.out), [j.size, j.size]]);
  });

  test("the .icns: Apple's ten PNG entries, 16 to 1024 at @1x and @2x, white on green on the macOS grid", () => {
    const b = readFileSync(job("build/icon.icns").out);
    expect(b.subarray(0, 4).toString("latin1")).toBe("icns");
    expect(b.readUInt32BE(4)).toBe(b.length);
    const found: { type: string; px: number }[] = [];
    for (let at = 8; at < b.length; ) {
      const len = b.readUInt32BE(at + 4);
      found.push({ type: b.subarray(at, at + 4).toString("latin1"), px: pngSize(b.subarray(at + 8, at + len))[0] });
      at += len;
    }
    expect(found).toEqual([...ICNS_TYPES]);
    expect(job("build/icon.icns").from).toBe("white-on-green");
  });

  test("the .ico: 16 to 256, BMP entries with straight alpha below 256 and PNG at 256", () => {
    const b = readFileSync(job("build/icon.ico").out);
    expect([b.readUInt16LE(0), b.readUInt16LE(2), b.readUInt16LE(4)]).toEqual([0, 1, ICO_SIZES.length]);
    ICO_SIZES.forEach((n, i) => {
      const e = 6 + 16 * i;
      expect(b.readUInt8(e) || 256).toBe(n);
      const data = b.subarray(b.readUInt32LE(e + 12), b.readUInt32LE(e + 12) + b.readUInt32LE(e + 8));
      if (n === 256) {
        expect(pngSize(data)).toEqual([256, 256]);
        return;
      }
      expect([data.readUInt32LE(0), data.readInt32LE(4), data.readInt32LE(8), data.readUInt16LE(14)]).toEqual([40, n, n * 2, 32]);
      // The corners are the plate's transparent outside. From 48 px, where a pixel is clear of the edges' blending,
      // the centre is the clover's white and the plate's green is there unpremultiplied (B, G, R order).
      const px = (x: number, y: number) => [...data.subarray(40 + ((n - 1 - y) * n + x) * 4, 40 + ((n - 1 - y) * n + x) * 4 + 4)];
      expect(px(0, 0)[3]).toBe(0);
      if (n < 48) return;
      expect(px(n / 2, n / 2)).toEqual([255, 255, 255, 255]);
      expect(px(Math.round(n * 0.1), Math.round(n / 2))).toEqual([0x55, 0x76, 0x3d, 255]);
    });
  });

  test("Linux's set is <n>x<n>.png from 16 to 512", () => {
    expect(readdirSync(join(REPO, "apps/desktop/build/icons")).sort()).toEqual(LINUX_SIZES.map((n) => `${n}x${n}.png`).sort());
  });

  test("the menu-bar templates are the shape alone, in black: macOS reads only their alpha", () => {
    for (const end of ["trayTemplate.png", "trayTemplate@2x.png", "tray16Template.png", "tray16Template@2x.png"]) {
      const svg = drawnSvg(job(end) as PngJob);
      expect([...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1])).toEqual(["#000000"]);
      expect(svg).not.toContain("<rect");
    }
  });
});

describe("where the mark is worn", () => {
  test("the app's packages name the release icons (electron-builder's icon keys)", () => {
    const config = Bun.YAML.parse(readFileSync(join(REPO, "apps/desktop/electron-builder.yml"), "utf8")) as Record<string, { icon?: string }>;
    expect([config.mac!.icon, config.win!.icon, config.linux!.icon]).toEqual(["build/icon.icns", "build/icon.ico", "build/icons"]);
    for (const p of [config.mac!.icon!, config.win!.icon!, config.linux!.icon!]) expect(existsSync(join(REPO, "apps/desktop", p))).toBe(true);
  });

  test("the in-app mark is the sources' path, and wears green on light themes and white on dark ones", () => {
    const { d, transform } = cloverPath(readFileSync(sourcePath("green-on-transparent"), "utf8"));
    for (const file of ["plugins/clover/plugins/sidebar/client/icons.tsx", "plugins/clover/plugins/conversation/client/icons.tsx"]) {
      const source = readFileSync(join(REPO, file), "utf8");
      expect([file, source.match(/CLOVER_MARK_PATH =\s*"([^"]+)"/)?.[1]]).toEqual([file, d]);
      expect(source).toContain(`transform="${transform}"`);
      expect(source).toContain('viewBox="0 0 200 200"');
    }
    const theme = JSON.parse(readFileSync(join(REPO, "plugins/clover/plugins/base-theme/theme.json"), "utf8")) as { tokens: Record<string, string>; dark?: { tokens?: Record<string, string> } } & Record<string, unknown>;
    const text = JSON.stringify(theme);
    expect(text.match(/"plugin\.clover\.mark":"(#[0-9A-F]{6})"/g)).toEqual(['"plugin.clover.mark":"#3D7655"', '"plugin.clover.mark":"#FFFFFF"']);
  });
});
