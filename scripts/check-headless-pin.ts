// The headless shell's pin follows the app's Electron (spec §12.1, plan §4 M-M2): where no app runs, the bots'
// browser is Chrome for Testing's headless shell, pinned by SHA-256 to the Chromium of the app's Electron, or to the
// nearest build of the same milestone when that exact build isn't published. Lane L keeps the pin in
// plugins/clover/plugins/browser/headless-shell.pins.json; this check holds it to the Electron in
// apps/desktop/package.json on every change, so an Electron upgrade can't land without moving it.
//
//   bun scripts/check-headless-pin.ts [--metadata <releases.json>]
//
// Electron's Chromium comes from Electron's release metadata (releases.electronjs.org, or a saved copy). Until lane L
// adds the pin file it warns and passes, so main stays green; once the file is there, any mismatch fails.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PIN_FILE = "plugins/clover/plugins/browser/headless-shell.pins.json";
export const ELECTRON_RELEASES = "https://releases.electronjs.org/releases.json";
/** The platform a server needs (the official image is Linux, spec §4); the others are welcome, not required. */
export const REQUIRED_PLATFORMS = ["linux64"] as const;
const PLATFORMS = ["linux64", "mac-arm64", "mac-x64", "win64", "win32"];

export interface HeadlessPin {
  electron: string;
  chromium: string;
  milestone: number;
  assets: Array<{ platform: string; url: string; sha256: string }>;
}

export const milestoneOf = (chromium: string): number => Number(chromium.split(".")[0]);

/** What's wrong with the pin against the app's Electron and that Electron's Chromium. */
export function pinProblems(pin: HeadlessPin, electron: string, electronChromium: string): string[] {
  const problems: string[] = [];
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
    console.log(`::warning::check-headless-pin: there is no ${PIN_FILE} yet (lane L's): nothing to check`);
    return 0;
  }
  const electron = (JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")) as { devDependencies?: Record<string, string> }).devDependencies?.electron;
  if (electron === undefined || !/^\d+\.\d+\.\d+$/.test(electron)) { console.error(`check-headless-pin: apps/desktop pins no exact Electron (${String(electron)})`); return 1; }
  let releases: unknown;
  const at = argv.indexOf("--metadata");
  try {
    releases = at >= 0 ? JSON.parse(readFileSync(argv[at + 1]!, "utf8")) : await (await fetch(ELECTRON_RELEASES)).json();
  } catch (err) {
    console.error(`check-headless-pin: couldn't read Electron's release metadata: ${(err as Error).message}`);
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
  const problems = pinProblems(pin, electron, chromium);
  for (const p of problems) console.error(`check-headless-pin: ${p}`);
  if (problems.length === 0) console.log(`check-headless-pin: the headless shell ${pin.chromium} follows Electron ${electron} (Chromium ${chromium})`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..")));
