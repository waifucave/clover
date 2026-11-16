// MOSS Code's icons. The owner's Shards kit is the source (docs/moss-brand.md): its mark and app-icon SVGs live in
// assets/brand/moss-code/, and the kit's own icon files (.icns, .ico, the rounded PNGs, the web set) are committed
// where the build takes them, as SUPPLIED files: they are not drawn here, only held to their recorded hashes.
// Every other raster (the Dev app's icons, the tray, the web favicon) is drawn from the SVG sources by this script.
// Nothing it writes is edited by hand: change a source, run this, commit both.
//
//   bun scripts/brand-icons.ts                    write every drawn output, and assets/brand/moss-code/outputs.json
//   bun scripts/brand-icons.ts --check            write nothing; fail if an output differs from what it would write
//   bun scripts/brand-icons.ts --preview <png>    also draw a contact sheet of the set (not committed)
//
// One renderer, @resvg/resvg-js at exactly RESVG_VERSION (the lockfile's), so the same sources give the same bytes.
// outputs.json records each source's, each drawn output's and each supplied file's SHA-256; scripts/brand-icons.test.ts
// holds the committed files to it, so an output edited by hand or a source changed without a run fails on every OS.
import { Resvg } from "@resvg/resvg-js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

export const RESVG_VERSION = "2.6.2";

export const REPO = join(import.meta.dir, "..");
export const BRAND = join(REPO, "assets", "brand", "moss-code");
export const RECORD = join(BRAND, "outputs.json");

/** The kit's mark, by ground: the seam is the accent on the two coloured ones, one ink on the two plain ones. */
export const MARKS = ["on-dark", "on-light", "black", "white"] as const;
export type Mark = (typeof MARKS)[number];
/** The widths the mark is recut at (README of the kit): the gaps widen as the disc shrinks. */
export const CUT_WIDTHS = [16, 24, 40, 64] as const;
export const APP_ICONS = ["app-icon", "app-icon-rounded", "app-icon-paper"] as const;

/** Every source SVG, relative to BRAND. */
export const SOURCES: readonly string[] = [
  ...MARKS.map((m) => `mark/shards-mark-${m}.svg`),
  ...CUT_WIDTHS.flatMap((w) => MARKS.map((m) => `mark/small/shards-mark-${w}-${m}.svg`)),
  ...APP_ICONS.map((a) => `app-icon/${a}.svg`),
];
export const sourcePath = (rel: string) => join(BRAND, rel);

/** The cut that reads at `px` pixels wide (the kit's table). */
export function cutFor(px: number, mark: Mark): string {
  if (px >= 128) return `mark/shards-mark-${mark}.svg`;
  const w = px >= 56 ? 64 : px >= 32 ? 40 : px >= 20 ? 24 : 16;
  return `mark/small/shards-mark-${w}-${mark}.svg`;
}

/** A mark SVG's drawing: its viewBox and the path elements' `d` and fill. */
export function markShape(svg: string): { viewBox: string; paths: { fill: string; d: string }[] } {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  const paths = [...svg.matchAll(/<path fill="([^"]+)" d="([^"]+)"\s*\/>/g)].map((m) => ({ fill: m[1]!, d: m[2]! }));
  if (viewBox === undefined || paths.length === 0) throw new Error("a MOSS mark source has a viewBox and path elements");
  return { viewBox, paths };
}

/** A source's drawing without its <svg> and <title>. */
function body(svg: string): string {
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return inner.replace(/<title>[\s\S]*?<\/title>/, "").trim();
}

const svgOf = (viewBox: string, size: number, content: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${content}</svg>`;

/** As drawn: the source's own viewBox. */
const asDrawn = (src: string) => src;

/** Apple's macOS icon grid for a 1024-unit tile: the body is 824 px of the 1024 canvas, centred (a 100 px margin). */
const onMacGrid = (src: string) => svgOf("0 0 1024 1024", 1024, `<g transform="translate(100 100) scale(${824 / 1024})">${body(src)}</g>`);

/** A menu-bar template: the shape alone in black, its alpha the only thing macOS reads. */
const template = (src: string) => src.replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#000000"');

export interface PngJob { kind: "png"; out: string; from: string; size: number; draw: (src: string) => string }
export interface CopyJob { kind: "copy"; out: string; from: string }
export type Job = PngJob | CopyJob;

/** A file the kit supplies already made, committed as it came: `from` is its place in the kit's folders. */
export interface Supplied { out: string; from: string }

const DESKTOP = join(REPO, "apps", "desktop");
const RUNTIME = join(DESKTOP, "resources", "icons");
const WEB = join(REPO, "services", "web", "src", "icons");

/** Linux's PNG set (electron-builder's `linux.icon` folder, named `<n>x<n>.png`). */
export const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export const SUPPLIED: Supplied[] = [
  // The release app: the kit's icon for each platform.
  { out: join(DESKTOP, "build", "icon.icns"), from: "app-icon/macos/app.icns" },
  { out: join(DESKTOP, "build", "icon.ico"), from: "app-icon/windows/app.ico" },
  ...LINUX_SIZES.map((n): Supplied => ({ out: join(DESKTOP, "build", "icons", `${n}x${n}.png`), from: `app-icon/rounded/app-icon-${n}.png` })),
  // The web companion's set.
  { out: join(WEB, "favicon.svg"), from: "web/favicon.svg" },
  { out: join(WEB, "icon-192.png"), from: "web/icon-192.png" },
  { out: join(WEB, "icon-512.png"), from: "web/icon-512.png" },
  { out: join(WEB, "icon-maskable-512.png"), from: "web/maskable-512.png" },
  { out: join(WEB, "apple-touch-icon.png"), from: "web/apple-touch-icon.png" },
];

export const JOBS: Job[] = [
  // MOSS Code Dev (`bun run dev:app`, unpackaged): the kit's paper tile, so it is not mistaken for the release app.
  { kind: "png", out: join(RUNTIME, "dev-dock.png"), from: "app-icon/app-icon-paper.svg", size: 512, draw: onMacGrid },
  { kind: "png", out: join(RUNTIME, "dev-window.png"), from: "app-icon/app-icon-paper.svg", size: 256, draw: asDrawn },
  // The menu-bar template (macOS draws it in the bar's own colour): 18 pt and 16 pt, @1x and @2x.
  { kind: "png", out: join(RUNTIME, "trayTemplate.png"), from: cutFor(18, "black"), size: 18, draw: template },
  { kind: "png", out: join(RUNTIME, "trayTemplate@2x.png"), from: cutFor(36, "black"), size: 36, draw: template },
  { kind: "png", out: join(RUNTIME, "tray16Template.png"), from: cutFor(16, "black"), size: 16, draw: template },
  { kind: "png", out: join(RUNTIME, "tray16Template@2x.png"), from: cutFor(32, "black"), size: 32, draw: template },
  // The Windows and Linux tray, by the taskbar's theme: white on a dark one, black on a light one.
  { kind: "png", out: join(RUNTIME, "tray-on-dark.png"), from: cutFor(16, "white"), size: 16, draw: asDrawn },
  { kind: "png", out: join(RUNTIME, "tray-on-dark@2x.png"), from: cutFor(32, "white"), size: 32, draw: asDrawn },
  { kind: "png", out: join(RUNTIME, "tray-on-light.png"), from: cutFor(16, "black"), size: 16, draw: asDrawn },
  { kind: "png", out: join(RUNTIME, "tray-on-light@2x.png"), from: cutFor(32, "black"), size: 32, draw: asDrawn },
  // The web companion: its 32 px favicon is the tile at that size; its header's mark by the page's scheme.
  { kind: "png", out: join(WEB, "favicon-32.png"), from: "app-icon/app-icon-rounded.svg", size: 32, draw: asDrawn },
  { kind: "copy", out: join(WEB, "mark-light.svg"), from: "mark/shards-mark-on-light.svg" },
  { kind: "copy", out: join(WEB, "mark-dark.svg"), from: "mark/shards-mark-on-dark.svg" },
];

// ---- Rendering ----

function render(svg: string, size: number): Buffer {
  const image = new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } }).render();
  if (image.width !== size || image.height !== size) throw new Error(`rendered ${image.width}x${image.height}, not ${size}`);
  return Buffer.from(image.asPng());
}

// ---- The run ----

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const rel = (p: string) => relative(REPO, p).split("\\").join("/");

/** The SVG a PNG job renders, as it will be drawn. */
export const drawnSvg = (job: PngJob): string => job.draw(readFileSync(sourcePath(job.from), "utf8"));

export function produce(job: Job): Buffer {
  const src = readFileSync(sourcePath(job.from), "utf8");
  return job.kind === "png" ? render(job.draw(src), job.size) : Buffer.from(src, "utf8");
}

export interface OutputsRecord {
  renderer: string;
  sources: Record<string, string>;
  outputs: Record<string, { from: string; sha256: string }>;
  /** The kit's own files, as supplied: `from` is the file's place inside shards-icon-kit/. */
  supplied: Record<string, { from: string; sha256: string }>;
}

function main(argv: string[]): void {
  const version = (createRequire(join(REPO, "package.json"))("@resvg/resvg-js/package.json") as { version: string }).version;
  if (version !== RESVG_VERSION) throw new Error(`brand-icons: @resvg/resvg-js is ${version}; the record is drawn with ${RESVG_VERSION} (bun install from the lockfile)`);
  const check = argv.includes("--check");
  const previewAt = argv.indexOf("--preview");
  const record: OutputsRecord = { renderer: `@resvg/resvg-js ${RESVG_VERSION}`, sources: {}, outputs: {}, supplied: {} };
  for (const s of SOURCES) record.sources[rel(sourcePath(s))] = sha256(readFileSync(sourcePath(s)));
  for (const f of SUPPLIED) record.supplied[rel(f.out)] = { from: f.from, sha256: sha256(readFileSync(f.out)) };
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
    console.log(`brand-icons: ${JOBS.length} outputs and ${SUPPLIED.length} supplied files match their record`);
  } else {
    writeFileSync(RECORD, recordText);
    console.log(`brand-icons: wrote ${JOBS.length} outputs and ${rel(RECORD)} (${SUPPLIED.length} supplied files recorded)`);
  }
  if (previewAt >= 0) writePreview(argv[previewAt + 1]!);
}

/** A contact sheet of the set, for a person to look at: the drawn outputs and the app's own icons on light and dark ground. */
function writePreview(out: string): void {
  const cells: { label: string; png: Buffer; size: number; ground: string }[] = [];
  const add = (label: string, png: Buffer, size: number, ground: string) => cells.push({ label, png, size, ground });
  const by = (end: string) => JOBS.find((j) => rel(j.out).endsWith(end))!;
  const supplied = (end: string) => readFileSync(SUPPLIED.find((f) => rel(f.out).endsWith(end))!.out);
  add("Linux 256", supplied("icons/256x256.png"), 256, "#FFFFFF");
  add("Linux 256 on dark", supplied("icons/256x256.png"), 256, "#1E1E1E");
  add("MOSS Code Dev (Dock)", produce(by("dev-dock.png")), 256, "#ECECEC");
  add("MOSS Code Dev (Dock) on dark", produce(by("dev-dock.png")), 256, "#1E1E1E");
  add("Menu bar template @2x", produce(by("trayTemplate@2x.png")), 72, "#F6F6F6");
  add("Tray on dark @2x", produce(by("tray-on-dark@2x.png")), 64, "#202020");
  add("Tray on light @2x", produce(by("tray-on-light@2x.png")), 64, "#F3F3F3");
  add("PWA 512", supplied("icon-512.png"), 256, "#FFFFFF");
  add("PWA maskable 512", supplied("icon-maskable-512.png"), 256, "#FFFFFF");
  add("Touch icon 180", supplied("apple-touch-icon.png"), 180, "#FFFFFF");
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
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#FAFAF7"/><text x="16" y="38" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#222">MOSS Code icon set</text>${parts.join("")}</svg>`;
  writeFileSync(out, Buffer.from(new Resvg(sheet, { font: { loadSystemFonts: true } }).render().asPng()));
  console.log(`brand-icons: preview at ${out}`);
}

if (import.meta.main) main(process.argv.slice(2));
