// The headless shell's pin follows the app's Electron (spec §12.1, plan §4 M-M2): where no app runs, the bots'
// browser is Chrome for Testing's headless shell, pinned by SHA-256 to the Chromium of the app's Electron, or to the
// nearest build of the same milestone when that exact build isn't published. Lane L keeps the pin in
// plugins/clover/plugins/browser/headless-shell.pins.json; this check holds it to the Electron in
// apps/desktop/package.json on every change, so an Electron upgrade can't land without moving it.
//
//   bun scripts/check-headless-pin.ts [--metadata <releases.json>] [--known-good <known-good-versions-with-downloads.json>]
//
// Electron's Chromium comes from Electron's release metadata (releases.electronjs.org), and what Chrome for Testing
// publishes from its known-good list (which also proves the pinned URLs exist); a saved copy of either can stand in.
// The pin is Electron's exact build. Only when Chrome for Testing doesn't publish that build is another allowed, and
// then it must be the nearest build of the same milestone that it does publish. The pin file is required once the
// headless browser is on main, which its integrity file (HEADLESS_MARKER, lane L's, arriving with the pin) marks;
// before that it warns and passes. (The browser plugin's folder is on main already, ahead of the headless shell, so
// it can't be the marker without turning main red.)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PIN_FILE = "plugins/clover/plugins/browser/headless-shell.pins.json";
/** Lane L's headless browser's integrity file: once it exists, so must the pin. */
export const HEADLESS_MARKER = "packages/core/src/browser/headless/integrity.json";
export const ELECTRON_RELEASES = "https://releases.electronjs.org/releases.json";
export const CFT_KNOWN_GOOD = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json";
const FETCH_TIMEOUT_MS = 30_000;

export interface KnownGood { versions: Array<{ version: string; downloads?: Record<string, Array<{ platform: string; url: string }>> }> }

const parts = (v: string): number[] => v.split(".").map(Number);

/**
 * The build the pin must name: Electron's own Chromium when Chrome for Testing publishes it, else the nearest
 * published build of the same milestone (by build and patch number), else none.
 */
export function wantedChromium(electronChromium: string, known: KnownGood): string | undefined {
  const listed = known.versions.map((v) => v.version);
  if (listed.includes(electronChromium)) return electronChromium;
  const [m, , b, p] = parts(electronChromium);
  const same = listed.filter((v) => parts(v)[0] === m);
  const distance = (v: string): number => { const [, , vb, vp] = parts(v); return Math.abs((vb! - b!) * 100_000 + (vp! - p!)); };
  return same.sort((x, y) => distance(x) - distance(y) || (x < y ? -1 : 1))[0];
}

/** The headless shell's published URL for a version and platform, or undefined. */
export function publishedUrl(known: KnownGood, version: string, platform: string): string | undefined {
  return known.versions.find((v) => v.version === version)?.downloads?.["chrome-headless-shell"]?.find((d) => d.platform === platform)?.url;
}
/** The platforms a server needs: the daemon's Linux targets, x64 and arm64 (the official image is Linux, spec §4). The
 *  others are welcome, not required. */
export const REQUIRED_PLATFORMS = ["linux64", "linux-arm64"] as const;
const PLATFORMS = ["linux64", "linux-arm64", "mac-arm64", "mac-x64", "win64", "win32"];

export interface HeadlessPin {
  electron: string;
  chromium: string;
  milestone: number;
  assets: Array<{ platform: string; url: string; sha256: string }>;
}

export const milestoneOf = (chromium: string): number => Number(chromium.split(".")[0]);

/** What's wrong with the pin against the app's Electron, that Electron's Chromium and what Chrome for Testing publishes. */
export function pinProblems(pin: HeadlessPin, electron: string, electronChromium: string, known: KnownGood): string[] {
  const problems: string[] = [];
  if (!Array.isArray(pin.assets)) return ["its assets are not a list"];
  const wanted = wantedChromium(electronChromium, known);
  if (wanted === undefined) problems.push(`Chrome for Testing publishes no build of milestone ${milestoneOf(electronChromium)}`);
  else if (pin.chromium !== wanted) problems.push(`it pins Chromium ${pin.chromium}, but it must be ${wanted}${wanted === electronChromium ? ", Electron's own build" : `, the nearest published build to Electron's ${electronChromium}`}`);
  if (pin.electron !== electron) problems.push(`the pin is for Electron ${pin.electron}, but the app has ${electron}: move the pin with the upgrade`);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(pin.chromium)) problems.push(`its chromium ${JSON.stringify(pin.chromium)} is not a full Chromium version`);
  else {
    if (pin.milestone !== milestoneOf(pin.chromium)) problems.push(`its milestone ${pin.milestone} is not its chromium's (${milestoneOf(pin.chromium)})`);
    // The same milestone as Electron's Chromium: that exact build, or the nearest of the milestone (spec §12.1).
    if (milestoneOf(pin.chromium) !== milestoneOf(electronChromium)) problems.push(`its chromium ${pin.chromium} is milestone ${milestoneOf(pin.chromium)}, but Electron ${electron} runs Chromium ${electronChromium} (milestone ${milestoneOf(electronChromium)})`);
  }
  if (!Array.isArray(pin.assets) || pin.assets.length === 0) problems.push("it pins no assets");
  const seen = new Set<string>();
  for (const a of pin.assets ?? []) {
    if (!PLATFORMS.includes(a.platform)) problems.push(`an asset's platform ${JSON.stringify(a.platform)} is not one of Chrome for Testing's`);
    if (seen.has(a.platform)) problems.push(`${a.platform} is pinned twice`);
    seen.add(a.platform);
    if (!/^[0-9a-f]{64}$/.test(a.sha256 ?? "")) problems.push(`${a.platform}'s sha256 is not a SHA-256`);
    const want = `https://storage.googleapis.com/chrome-for-testing-public/${pin.chromium}/${a.platform}/chrome-headless-shell-${a.platform}.zip`;
    if (a.url !== want) problems.push(`${a.platform}'s url is ${a.url}, not ${want}`);
    else if (publishedUrl(known, pin.chromium, a.platform) !== a.url) problems.push(`Chrome for Testing doesn't list ${a.url}`);
  }
  for (const p of REQUIRED_PLATFORMS) if (!seen.has(p)) problems.push(`it pins no ${p} build (the server image's)`);
  return problems;
}

/** Electron's Chromium, from its release metadata. */
export function electronChromium(releases: unknown, electron: string): string | undefined {
  if (!Array.isArray(releases)) return undefined;
  const r = (releases as Array<{ version?: string; chrome?: string }>).find((x) => x.version === electron);
  return typeof r?.chrome === "string" ? r.chrome : undefined;
}

export async function main(argv: readonly string[], root: string): Promise<number> {
  const file = join(root, ...PIN_FILE.split("/"));
  if (!existsSync(file)) {
    // Required once the headless browser is there: only before it is a missing pin a warning.
    if (existsSync(join(root, ...HEADLESS_MARKER.split("/")))) { console.error(`check-headless-pin: ${PIN_FILE} is missing, and the headless browser (${HEADLESS_MARKER}) needs it`); return 1; }
    console.log(`::warning::check-headless-pin: there is no ${PIN_FILE} yet (lane L's): nothing to check`);
    return 0;
  }
  const electron = (JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")) as { devDependencies?: Record<string, string> }).devDependencies?.electron;
  if (electron === undefined || !/^\d+\.\d+\.\d+$/.test(electron)) { console.error(`check-headless-pin: apps/desktop pins no exact Electron (${String(electron)})`); return 1; }
  const load = async (flag: string, url: string): Promise<unknown> => {
    const at = argv.indexOf(flag);
    if (at >= 0) return JSON.parse(readFileSync(argv[at + 1]!, "utf8"));
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  };
  let releases: unknown;
  let known: KnownGood;
  try {
    releases = await load("--metadata", ELECTRON_RELEASES);
    known = (await load("--known-good", CFT_KNOWN_GOOD)) as KnownGood;
    if (!Array.isArray(known?.versions)) throw new Error("Chrome for Testing's known-good list has no versions");
  } catch (err) {
    console.error(`check-headless-pin: couldn't read the release metadata: ${(err as Error).message}`);
    return 1;
  }
  const chromium = electronChromium(releases, electron);
  if (chromium === undefined) { console.error(`check-headless-pin: Electron's metadata has no Chromium for ${electron}`); return 1; }
  let pin: HeadlessPin;
  try {
    pin = JSON.parse(readFileSync(file, "utf8")) as HeadlessPin;
  } catch (err) {
    console.error(`check-headless-pin: ${PIN_FILE} is not JSON: ${(err as Error).message}`);
    return 1;
  }
  const problems = pinProblems(pin, electron, chromium, known);
  for (const p of problems) console.error(`check-headless-pin: ${p}`);
  if (problems.length === 0) console.log(`check-headless-pin: the headless shell ${pin.chromium} follows Electron ${electron} (Chromium ${chromium})`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..")));
