// Clover's icons, every raster drawn from the eight source SVGs in assets/brand/clover/ (docs/clover-brand.md says
// which variant goes where). Nothing it writes is edited by hand: change a source, run this, commit both.
//
//   bun scripts/brand-icons.ts                    write every output, and assets/brand/clover/outputs.json
//   bun scripts/brand-icons.ts --check            write nothing; fail if an output differs from what it would write
//   bun scripts/brand-icons.ts --preview <png>    also draw a contact sheet of the set (not committed)
//
// One renderer, @resvg/resvg-js at exactly RESVG_VERSION (the lockfile's), so the same sources give the same bytes;
// the containers are written here, byte by byte, with nothing taken from the machine: the .icns (PNG entries, Apple's
// types for 16 to 1024 at @1x and @2x), the .ico (BMP entries to 128 px, PNG at 256, Windows' classic layout) and the
// PNGs. outputs.json records each source's and each output's SHA-256; scripts/brand-icons.test.ts holds the committed
// files to it, so an output edited by hand or a source changed without a run fails on every OS.
import { Resvg } from "@resvg/resvg-js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

export const RESVG_VERSION = "2.6.2";

export const REPO = join(import.meta.dir, "..");
export const BRAND = join(REPO, "assets", "brand", "clover");
export const RECORD = join(BRAND, "outputs.json");

export const VARIANTS = [
  "white-on-green",
  "green-on-white",
  "green-on-transparent",
  "green-on-dark",
  "white-on-transparent",
  "white-on-dark",
  "dark-on-white",
  "dark-on-transparent",
] as const;
export type Variant = (typeof VARIANTS)[number];

export const sourcePath = (v: Variant) => join(BRAND, `clover-${v}.svg`);

/** The clover's one path, as every source draws it: its `d` and its transform. */
export function cloverPath(svg: string): { d: string; transform: string; fill: string } {
  const m = svg.match(/<path\s+fill="([^"]+)"\s+transform="([^"]+)"\s+d="([^"]+)"\s*\/>/);
  if (m === null) throw new Error("a Clover source has exactly one <path fill transform d />");
  return { fill: m[1]!, transform: m[2]!, d: m[3]!.replace(/\s+/g, " ").trim() };
}

/** A source's drawing (its plate and the clover) without its <svg> and <title>, on the 200 by 200 viewBox. */
function body(svg: string): string {
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return inner.replace(/<title>[\s\S]*?<\/title>/, "").trim();
}

const svgOf = (viewBox: number, content: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${viewBox}" height="${viewBox}" viewBox="0 0 ${viewBox} ${viewBox}">${content}</svg>`;

/** As drawn: the 200 viewBox at `size` px (Windows, Linux, the web). */
const asDrawn = (src: string) => src;

/** Apple's macOS icon grid: on a 1024 canvas the rounded-square body is 824 px, centred (a 100 px margin), so the
 *  icon sits in the Dock at the size of every other app's. Smaller sizes scale the same grid. */
const onMacGrid = (src: string) => svgOf(1024, `<g transform="translate(100 100) scale(4.12)">${body(src)}</g>`);

/** A menu-bar template: the shape alone in black, its alpha the only thing macOS reads. */
const template = (src: string) => svgOf(200, body(src).replace(/fill="#[0-9A-Fa-f]{6}"/, 'fill="#000000"'));

/** Maskable (a PWA's, and iOS's touch icon): the plate full bleed, square, and the clover inside the 80 % safe circle. */
const maskable = (src: string) => {
  const plate = body(src).match(/<rect[^>]*fill="(#[0-9A-Fa-f]{6})"/)?.[1];
  if (plate === undefined) throw new Error("a maskable icon needs a plated source");
  const path = body(src).replace(/<rect[^>]*\/>/, "").trim();
  return svgOf(200, `<rect width="200" height="200" fill="${plate}"/><g transform="translate(30 30) scale(0.7)">${path}</g>`);
};

export interface PngJob { kind: "png"; out: string; from: Variant; size: number; draw: (src: string) => string }
export interface IcnsJob { kind: "icns"; out: string; from: Variant }
export interface IcoJob { kind: "ico"; out: string; from: Variant; sizes: number[] }
export interface CopyJob { kind: "copy"; out: string; from: Variant }
export type Job = PngJob | IcnsJob | IcoJob | CopyJob;

const DESKTOP = join(REPO, "apps", "desktop");
const RUNTIME = join(DESKTOP, "resources", "icons");
const WEB = join(REPO, "services", "web", "src", "icons");

/** Linux's PNG set (electron-builder's `linux.icon` folder, named `<n>x<n>.png`). */
export const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export const JOBS: Job[] = [
  // The release app: white on green.
  { kind: "icns", out: join(DESKTOP, "build", "icon.icns"), from: "white-on-green" },
  { kind: "ico", out: join(DESKTOP, "build", "icon.ico"), from: "white-on-green", sizes: ICO_SIZES },
  ...LINUX_SIZES.map((n): PngJob => ({ kind: "png", out: join(DESKTOP, "build", "icons", `${n}x${n}.png`), from: "white-on-green", size: n, draw: asDrawn })),
  // Clover Dev (`bun run dev:app`, unpackaged): green on dark, its Dock icon on the grid and its window icon as drawn.
  { kind: "png", out: join(RUNTIME, "dev-dock.png"), from: "green-on-dark", size: 512, draw: onMacGrid },
  { kind: "png", out: join(RUNTIME, "dev-window.png"), from: "green-on-dark", size: 256, draw: asDrawn },
  // The menu-bar template (macOS draws it in the bar's own colour): 18 pt and 16 pt, @1x and @2x.
  { kind: "png", out: join(RUNTIME, "trayTemplate.png"), from: "dark-on-transparent", size: 18, draw: template },
  { kind: "png", out: join(RUNTIME, "trayTemplate@2x.png"), from: "dark-on-transparent", size: 36, draw: template },
  { kind: "png", out: join(RUNTIME, "tray16Template.png"), from: "dark-on-transparent", size: 16, draw: template },
  { kind: "png", out: join(RUNTIME, "tray16Template@2x.png"), from: "dark-on-transparent", size: 32, draw: template },
  // The Windows and Linux tray, by the taskbar's theme: white on a dark one, dark on a light one.
  { kind: "png", out: join(RUNTIME, "tray-on-dark.png"), from: "white-on-transparent", size: 16, draw: asDrawn },
  { kind: "png", out: join(RUNTIME, "tray-on-dark@2x.png"), from: "white-on-transparent", size: 32, draw: asDrawn },
  { kind: "png", out: join(RUNTIME, "tray-on-light.png"), from: "dark-on-transparent", size: 16, draw: asDrawn },
  { kind: "png", out: join(RUNTIME, "tray-on-light@2x.png"), from: "dark-on-transparent", size: 32, draw: asDrawn },
  // The web companion: white on green; its header's mark by the page's scheme.
  { kind: "copy", out: join(WEB, "favicon.svg"), from: "white-on-green" },
  { kind: "png", out: join(WEB, "favicon-32.png"), from: "white-on-green", size: 32, draw: asDrawn },
  { kind: "png", out: join(WEB, "icon-192.png"), from: "white-on-green", size: 192, draw: asDrawn },
  { kind: "png", out: join(WEB, "icon-512.png"), from: "white-on-green", size: 512, draw: asDrawn },
  { kind: "png", out: join(WEB, "icon-maskable-512.png"), from: "white-on-green", size: 512, draw: maskable },
  { kind: "png", out: join(WEB, "apple-touch-icon.png"), from: "white-on-green", size: 180, draw: maskable },
  { kind: "copy", out: join(WEB, "mark-green.svg"), from: "green-on-transparent" },
  { kind: "copy", out: join(WEB, "mark-white.svg"), from: "white-on-transparent" },
];

// ---- Rendering ----

function render(svg: string, size: number): { png: Buffer; rgba: Buffer } {
  const image = new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } }).render();
  if (image.width !== size || image.height !== size) throw new Error(`rendered ${image.width}x${image.height}, not ${size}`);
  return { png: Buffer.from(image.asPng()), rgba: Buffer.from(image.pixels) };
}

// ---- .icns: PNG entries, by Apple's OSType for each pixel size and scale ----

export const ICNS_TYPES: readonly { type: string; px: number }[] = [
  { type: "icp4", px: 16 },
  { type: "ic11", px: 32 }, // 16@2x
  { type: "icp5", px: 32 },
  { type: "ic12", px: 64 }, // 32@2x
  { type: "ic07", px: 128 },
  { type: "ic13", px: 256 }, // 128@2x
  { type: "ic08", px: 256 },
  { type: "ic14", px: 512 }, // 256@2x
  { type: "ic09", px: 512 },
  { type: "ic10", px: 1024 }, // 512@2x
];

function icns(svg: string): Buffer {
  const cache = new Map<number, Buffer>();
  const entries = ICNS_TYPES.map(({ type, px }) => {
    let png = cache.get(px);
    if (png === undefined) cache.set(px, (png = render(svg, px).png));
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

// ---- .ico: BMP (32-bit BGRA, straight alpha) below 256, PNG at 256 ----

function bmpEntry(rgba: Buffer, size: number): Buffer {
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // the colour rows and the mask's
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4; // bottom-up
      const a = rgba[s + 3]!;
      // resvg's pixels are premultiplied; a BMP icon's are not.
      const un = (c: number) => (a === 0 ? 0 : Math.min(255, Math.round((c * 255) / a)));
      pixels[d] = un(rgba[s + 2]!);
      pixels[d + 1] = un(rgba[s + 1]!);
      pixels[d + 2] = un(rgba[s]!);
      pixels[d + 3] = a;
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico(svg: string, sizes: number[]): Buffer {
  const images = sizes.map((n) => {
    const r = render(svg, n);
    return n >= 256 ? r.png : bmpEntry(r.rgba, n);
  });
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((n, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(n >= 256 ? 0 : n, 0);
    e.writeUInt8(n >= 256 ? 0 : n, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i]!.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i]!.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images]);
}

// ---- The run ----

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const rel = (p: string) => relative(REPO, p).split("\\").join("/");

/** The SVG a PNG job renders, as it will be drawn. */
export const drawnSvg = (job: PngJob): string => job.draw(readFileSync(sourcePath(job.from), "utf8"));

export function produce(job: Job): Buffer {
  const src = readFileSync(sourcePath(job.from), "utf8");
  switch (job.kind) {
    case "png":
      return render(job.draw(src), job.size).png;
    case "icns":
      return icns(onMacGrid(src));
    case "ico":
      return ico(asDrawn(src), job.sizes);
    case "copy":
      return Buffer.from(src, "utf8");
  }
}

export interface OutputsRecord {
  renderer: string;
  sources: Record<string, string>;
  outputs: Record<string, { from: string; sha256: string }>;
}

function main(argv: string[]): void {
  const version = (createRequire(join(REPO, "package.json"))("@resvg/resvg-js/package.json") as { version: string }).version;
  if (version !== RESVG_VERSION) throw new Error(`brand-icons: @resvg/resvg-js is ${version}; the record is drawn with ${RESVG_VERSION} (bun install from the lockfile)`);
  const check = argv.includes("--check");
  const previewAt = argv.indexOf("--preview");
  const record: OutputsRecord = { renderer: `@resvg/resvg-js ${RESVG_VERSION}`, sources: {}, outputs: {} };
  for (const v of VARIANTS) record.sources[rel(sourcePath(v))] = sha256(readFileSync(sourcePath(v)));
  const stale: string[] = [];
  for (const job of JOBS) {
    const bytes = produce(job);
    record.outputs[rel(job.out)] = { from: rel(sourcePath(job.from)), sha256: sha256(bytes) };
    if (check) {
      if (!existsSync(job.out) || sha256(readFileSync(job.out)) !== sha256(bytes)) stale.push(rel(job.out));
    } else {
      mkdirSync(dirname(job.out), { recursive: true });
      writeFileSync(job.out, bytes);
    }
  }
  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  if (check) {
    if (!existsSync(RECORD) || readFileSync(RECORD, "utf8") !== recordText) stale.push(rel(RECORD));
    if (stale.length > 0) {
      console.error(`brand-icons: out of date (run bun scripts/brand-icons.ts):\n  ${stale.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`brand-icons: ${JOBS.length} outputs match their sources`);
  } else {
    writeFileSync(RECORD, recordText);
    console.log(`brand-icons: wrote ${JOBS.length} outputs and ${rel(RECORD)}`);
  }
  if (previewAt >= 0) writePreview(argv[previewAt + 1]!);
}

/** A contact sheet of the set, for a person to look at: every output on light and dark ground. */
function writePreview(out: string): void {
  const cells: { label: string; png: Buffer; size: number; ground: string }[] = [];
  const add = (label: string, job: Job, ground: string, size?: number) => {
    const bytes = job.kind === "png" ? produce(job) : render(job.kind === "icns" ? onMacGrid(readFileSync(sourcePath(job.from), "utf8")) : readFileSync(sourcePath(job.from), "utf8"), 256).png;
    cells.push({ label, png: bytes, size: size ?? (job.kind === "png" ? job.size : 256), ground });
  };
  const by = (end: string) => JOBS.find((j) => rel(j.out).endsWith(end))!;
  add("macOS .icns (1024 grid)", by("build/icon.icns"), "#ECECEC");
  add("macOS .icns on dark", by("build/icon.icns"), "#1E1E1E");
  add("Windows .ico (as drawn)", by("build/icon.ico"), "#F3F3F3");
  add("Linux 256", by("icons/256x256.png"), "#FFFFFF");
  add("Clover Dev (Dock)", by("dev-dock.png"), "#ECECEC", 256);
  add("Clover Dev (Dock) on dark", by("dev-dock.png"), "#1E1E1E", 256);
  add("Menu bar template @2x", by("trayTemplate@2x.png"), "#F6F6F6", 72);
  add("Tray on dark @2x", by("tray-on-dark@2x.png"), "#202020", 64);
  add("Tray on light @2x", by("tray-on-light@2x.png"), "#F3F3F3", 64);
  add("PWA 512", by("icon-512.png"), "#FFFFFF", 256);
  add("PWA maskable 512", by("icon-maskable-512.png"), "#FFFFFF", 256);
  add("Touch icon 180", by("apple-touch-icon.png"), "#FFFFFF", 180);
  const cols = 4;
  const cw = 300;
  const ch = 330;
  const rows = Math.ceil(cells.length / cols);
  const parts = cells.map((c, i) => {
    const x = (i % cols) * cw;
    const y = 60 + Math.floor(i / cols) * ch;
    const s = Math.min(c.size, 256);
    return `<rect x="${x + 10}" y="${y}" width="${cw - 20}" height="${ch - 40}" rx="12" fill="${c.ground}" stroke="#D0D0D0"/>` +
      `<image x="${x + (cw - s) / 2}" y="${y + (ch - 40 - s) / 2}" width="${s}" height="${s}" href="data:image/png;base64,${c.png.toString("base64")}"/>` +
      `<text x="${x + cw / 2}" y="${y + ch - 16}" font-family="Helvetica, Arial, sans-serif" font-size="15" text-anchor="middle" fill="#222">${c.label}</text>`;
  });
  const w = cols * cw;
  const h = 60 + rows * ch;
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#FAFAF7"/><text x="16" y="38" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="bold" fill="#111">Clover icon set (scripts/brand-icons.ts)</text>${parts.join("")}</svg>`;
  writeFileSync(out, Buffer.from(new Resvg(sheet, { font: { loadSystemFonts: true } }).render().asPng()));
  console.log(`brand-icons: preview at ${out}`);
}

if (import.meta.main) main(process.argv.slice(2));
