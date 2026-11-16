// MOSS Code's icons (scripts/brand-icons.ts, docs/moss-brand.md): the sources are the owner's Shards kit SVGs, every
// drawn output is the one the script drew from them and every supplied file is the kit's own (outputs.json's hashes,
// so a file edited by hand or a source changed without a run fails here), each container holds the sizes its
// platform wants, and every place that wears the mark names a file that is there.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APP_ICONS, BRAND, CUT_WIDTHS, ICO_SIZES, JOBS, LINUX_SIZES, MARKS, RECORD, REPO, SOURCES, SUPPLIED, cutFor, drawnSvg, markShape, rel, sha256, sourcePath, type OutputsRecord, type PngJob } from "./brand-icons";

const record = JSON.parse(readFileSync(RECORD, "utf8")) as OutputsRecord;
const job = (end: string) => JOBS.find((j) => rel(j.out).endsWith(end))!;
const supplied = (end: string) => SUPPLIED.find((j) => rel(j.out).endsWith(end))!;

function pngSize(b: Buffer): [number, number] {
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("the sources", () => {
  test("the kit's SVGs, and nothing else, in the brand folder", () => {
    const found = [
      ...readdirSync(join(BRAND, "mark")).filter((f) => f.endsWith(".svg")).map((f) => `mark/${f}`),
      ...readdirSync(join(BRAND, "mark", "small")).map((f) => `mark/small/${f}`),
      ...readdirSync(join(BRAND, "app-icon")).map((f) => `app-icon/${f}`),
    ];
    expect(found.sort()).toEqual([...SOURCES].sort());
    expect(readdirSync(BRAND).sort()).toEqual(["app-icon", "mark", "outputs.json"]);
  });

  test("plain shapes only, in the kit's colours: no script, style, link, image or foreign content", () => {
    const colours = ["#E5A72E", "#F6F4EE", "#1B1D2B", "#111111", "#FFFFFF", "#161A33"];
    for (const s of SOURCES) {
      const svg = readFileSync(sourcePath(s), "utf8");
      expect([s, /<script|<style|<image|<foreignObject|href=|url\(|\son[a-z]+=/i.test(svg)]).toEqual([s, false]);
      expect(svg.match(/<(?!\/)([a-z]+)/g)!.map((t) => t.slice(1)).filter((t) => !["svg", "title", "rect", "path", "g"].includes(t))).toEqual([]);
      for (const colour of svg.match(/#[0-9A-Fa-f]{6}/g)!) expect([s, colours.includes(colour.toUpperCase())]).toEqual([s, true]);
    }
  });

  test("every mark has one cut at full size and one at each small width, for each ground", () => {
    expect(MARKS).toEqual(["on-dark", "on-light", "black", "white"]);
    for (const m of MARKS) {
      expect(existsSync(sourcePath(`mark/shards-mark-${m}.svg`))).toBe(true);
      for (const w of CUT_WIDTHS) expect(existsSync(sourcePath(`mark/small/shards-mark-${w}-${m}.svg`))).toBe(true);
      expect(markShape(readFileSync(sourcePath(`mark/shards-mark-${m}.svg`), "utf8")).viewBox).toBe("86 86 828 828");
    }
    for (const a of APP_ICONS) expect(markShape(readFileSync(sourcePath(`app-icon/${a}.svg`), "utf8")).viewBox).toBe("0 0 1024 1024");
  });

  test("the small cut is chosen by the pixels the disc is drawn at (the kit's table)", () => {
    expect([cutFor(256, "black"), cutFor(128, "black"), cutFor(64, "black"), cutFor(40, "black"), cutFor(24, "black"), cutFor(16, "black")]).toEqual([
      "mark/shards-mark-black.svg",
      "mark/shards-mark-black.svg",
      "mark/small/shards-mark-64-black.svg",
      "mark/small/shards-mark-40-black.svg",
      "mark/small/shards-mark-24-black.svg",
      "mark/small/shards-mark-16-black.svg",
    ]);
  });
});

describe("the outputs", () => {
  test("outputs.json names every source, every drawn output and every supplied file, with today's hashes", () => {
    expect(record.renderer).toBe("@resvg/resvg-js 2.6.2");
    expect(record.sources).toEqual(Object.fromEntries(SOURCES.map((s) => [rel(sourcePath(s)), sha256(readFileSync(sourcePath(s)))])));
    expect(Object.keys(record.outputs).sort()).toEqual(JOBS.map((j) => rel(j.out)).sort());
    expect(Object.keys(record.supplied).sort()).toEqual(SUPPLIED.map((j) => rel(j.out)).sort());
    for (const j of JOBS) {
      expect([rel(j.out), existsSync(j.out)]).toEqual([rel(j.out), true]);
      expect([rel(j.out), sha256(readFileSync(j.out))]).toEqual([rel(j.out), record.outputs[rel(j.out)]!.sha256]);
      expect(record.outputs[rel(j.out)]!.from).toBe(rel(sourcePath(j.from)));
    }
    for (const f of SUPPLIED) {
      expect([rel(f.out), existsSync(f.out)]).toEqual([rel(f.out), true]);
      expect([rel(f.out), sha256(readFileSync(f.out))]).toEqual([rel(f.out), record.supplied[rel(f.out)]!.sha256]);
      expect(record.supplied[rel(f.out)]!.from).toBe(f.from);
    }
  });

  test("every drawn PNG is the size its job says", () => {
    for (const j of JOBS.filter((x): x is PngJob => x.kind === "png")) expect([rel(j.out), pngSize(readFileSync(j.out))]).toEqual([rel(j.out), [j.size, j.size]]);
  });

  test("the supplied .icns holds PNG entries from 32 to 1024 px, and the supplied .ico the sizes Windows wants", () => {
    const b = readFileSync(supplied("build/icon.icns").out);
    expect(b.subarray(0, 4).toString("latin1")).toBe("icns");
    expect(b.readUInt32BE(4)).toBe(b.length);
    const sizes = new Set<number>();
    for (let at = 8; at < b.length; ) {
      const type = b.subarray(at, at + 4).toString("latin1");
      const len = b.readUInt32BE(at + 4);
      if (type !== "TOC ") {
        const data = b.subarray(at + 8, at + len);
        if (data.subarray(0, 4).toString("hex") === "89504e47") sizes.add(pngSize(data)[0]);
      }
      at += len;
    }
    expect([...sizes].sort((x, y) => x - y)).toEqual([32, 64, 128, 256, 512, 1024]);

    const ico = readFileSync(supplied("build/icon.ico").out);
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, ICO_SIZES.length]);
    expect(ICO_SIZES.map((_, i) => ico.readUInt8(6 + 16 * i) || 256)).toEqual(ICO_SIZES);
  });

  test("Linux's set is <n>x<n>.png from 16 to 512, each the size it says", () => {
    expect(readdirSync(join(REPO, "apps/desktop/build/icons")).sort()).toEqual(LINUX_SIZES.map((n) => `${n}x${n}.png`).sort());
    for (const n of LINUX_SIZES) expect(pngSize(readFileSync(join(REPO, `apps/desktop/build/icons/${n}x${n}.png`)))).toEqual([n, n]);
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

  test("the in-app mark is the kit's single-colour path, and wears Night on light themes and Paper on dark ones", () => {
    const { paths } = markShape(readFileSync(sourcePath("mark/shards-mark-white.svg"), "utf8"));
    expect(paths.length).toBe(1);
    for (const file of ["plugins/moss/plugins/sidebar/client/icons.tsx", "plugins/moss/plugins/conversation/client/icons.tsx", "plugins/moss/plugins/plugin-index/client/icons.tsx"]) {
      const source = readFileSync(join(REPO, file), "utf8");
      expect([file, source.match(/MOSS_MARK_PATH =\s*"([^"]+)"/)?.[1]]).toEqual([file, paths[0]!.d]);
      expect(source).toContain('viewBox="86 86 828 828"');
    }
    const text = JSON.stringify(JSON.parse(readFileSync(join(REPO, "plugins/moss/plugins/base-theme/theme.json"), "utf8")));
    expect(text.match(/"plugin\.moss\.mark":"(#[0-9A-F]{6})"/g)).toEqual(['"plugin.moss.mark":"#161A33"', '"plugin.moss.mark":"#F6F4EE"']);
  });
});
