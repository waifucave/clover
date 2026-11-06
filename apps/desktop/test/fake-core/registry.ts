// What the fake daemon's `plugin.ui` hands the app: the `clover` tree read from its manifests (found wherever lane M's
// layout puts the children), Alpha as a bot with its tab's theme, and any extra plugin folders (the tests' third-party
// fixtures). Lane B's registry (B-M1) makes the real one.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface FakeView {
  pluginId: string;
  treeHash: string;
  layer: string;
  assetBase: string;
  clientEntry?: string;
  ui: Record<string, unknown>[];
  themes: { id: string; file: string }[];
  locales: { lang: string; file: string }[];
  bots: "all" | string[];
  // Fields asked of lane B for `UiPluginView`.
  source?: "bundled" | "installed" | "dev";
  enabledAt?: number;
  capabilities?: string[];
  isBot?: boolean;
  botTheme?: string;
  name?: string;
  css?: string[];
}

export const REPO = join(import.meta.dir, "..", "..", "..", "..");
const ZERO = `sha256:${"0".repeat(64)}`;

interface Manifest {
  id?: string;
  name?: string;
  client?: { entry?: string; css?: string[] };
  capabilities?: string[];
  contributes?: { ui?: Record<string, unknown>[]; themes?: { id: string; file: string }[] };
}

function read(dir: string): Manifest | undefined {
  const file = join(dir, "clover.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Manifest) : undefined;
}

/** Every child of `clover` with UI or themes, by its folder's name. */
export function cloverChildren(root = join(REPO, "plugins", "clover"), depth = 0): { name: string; dir: string; manifest: Manifest }[] {
  const out: { name: string; dir: string; manifest: Manifest }[] = [];
  if (depth > 3 || !existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifest = read(dir);
    if (manifest !== undefined && (manifest.contributes?.ui !== undefined || manifest.contributes?.themes !== undefined)) out.push({ name, dir, manifest });
    out.push(...cloverChildren(dir, depth + 1));
  }
  return out;
}

export function cloverViews(): FakeView[] {
  return cloverChildren().map(({ name, dir, manifest }, i) => ({
    pluginId: `clover/${name}`,
    treeHash: ZERO,
    layer: "clover",
    assetBase: dir,
    ...(manifest.client?.entry !== undefined ? { clientEntry: manifest.client.entry } : {}),
    ui: manifest.contributes?.ui ?? [],
    themes: manifest.contributes?.themes ?? [],
    locales: [],
    bots: "all",
    source: "bundled",
    enabledAt: i,
    capabilities: manifest.capabilities ?? [],
    css: manifest.client?.css ?? [],
  }));
}

/** Alpha: a bot, data only, with its tab's theme (its folder is the plugin's, as the registry hands it over: the
 *  theme's own paths are relative to it). */
export function alphaView(): FakeView {
  const dir = join(REPO, "plugins", "alpha");
  return { pluginId: "alpha", treeHash: ZERO, layer: "alpha", assetBase: dir, ui: [], themes: existsSync(join(dir, "tab", "theme.json")) ? [{ id: "alpha", file: "tab/theme.json" }] : [], locales: [], bots: "all", source: "bundled", enabledAt: 100, isBot: true, botTheme: "alpha", name: "Alpha" };
}

/** A plugin folder of the tests' own, installed by the user. */
export function folderView(dir: string, enabledAt = 1000): FakeView {
  const m = read(dir)!;
  const id = m.id ?? basename(dir);
  return {
    pluginId: id,
    treeHash: ZERO,
    layer: id.replace(/\//g, "--"),
    assetBase: dir,
    ...(m.client?.entry !== undefined ? { clientEntry: m.client.entry } : {}),
    ui: m.contributes?.ui ?? [],
    themes: m.contributes?.themes ?? [],
    locales: [],
    bots: "all",
    source: "installed",
    enabledAt,
    capabilities: m.capabilities ?? [],
    css: m.client?.css ?? [],
  };
}

export const FIXTURES = join(import.meta.dir, "..", "fixtures", "plugins");
