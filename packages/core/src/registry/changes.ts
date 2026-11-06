// When the app asks again (spec §5.6): what a folder change since the tree last OK'd does. The registry keeps, with
// each OK, the tree's files and a fingerprint of what it runs and reaches (`OkSnapshot`); a change then
// * asks again (`asks-again`) when it hits a trigger (data turned into web or code; more capabilities, network
//   hosts, helper permissions, hook events, add-ons, `stdio` commands that fetch code, code children; adult content),
//   or changes what runs: any file that isn't data, a `stdio` server's `command`, `args` or `env`, a hook's or agent
//   backend's `command` or `args`, the `host`, `client` or `helper` fields, a field whose format is `program` or
//   `code`, or a setting's `default`;
// * waits alone (`card-styling`) when it changes only how the tree styles approval cards (§5.5);
// * applies at once (`applies`) otherwise: themes, layouts, CSS, Markdown, assets.
import type { Manifest, ManifestReport, TreeEntry, TreeReport } from "@waifucave/clover-plugin-sdk";
import { canonicalJson } from "@waifucave/clover-protocol";

/** What a change since the OK does (the fake's `FakePluginInput.change`). */
export type ChangeKind = "asks-again" | "applies" | "card-styling";

/** One plugin of the tree, as the OK saw it. */
export interface PluginFingerprint {
  class: "data" | "web" | "code";
  capabilities: string[];
  networkHosts: string[];
  helperPermissions: string[];
  hookEvents: string[];
  fetchesCode: string[];
  addons: boolean;
  adult: boolean;
  /** What runs, as canonical JSON: changed at all is a code change. */
  runs: string;
  /** The settings' defaults, as canonical JSON. */
  defaults: string;
}

/** The tree as its OK saw it, kept beside the OK (`plugins-state/oks/<id>.json`). */
export interface OkSnapshot {
  okHash: string;
  files: TreeEntry[];
  /** By plugin: `""` for the top-level plugin, the child's folder for a child. */
  plugins: Record<string, PluginFingerprint>;
  /** The files that style approval cards, and whether the tree places sealed frames. */
  cards: string;
}

/** The fields of a plugin point whose format is `program` or `code` (from its declaration), for the change rule. */
export type CodeFieldsOf = (point: string) => readonly string[];

/** Extensions of files that are data wherever they are (§5.6 "other data edits"); anything else is code. */
const DATA_EXTENSIONS = new Set([
  "json", "jsonc", "md", "markdown", "txt", "css", "csv", "yaml", "yml", "toml",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "heic",
  "woff", "woff2", "ttf", "otf",
  "vrm", "glb", "gltf", "bin", "moc3", "motion3", "exp3", "physics3", "pose3", "cdi3", "model3",
  "mp3", "wav", "ogg", "m4a", "flac", "opus", "mp4", "webm", "mov",
]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.indexOf(".", 1);
  return dot < 0 ? "" : name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

/** Whether a file is data: by its extension, and never with its executable bit set. Live2D's `*.motion3.json` and
 *  the like end in `json`, so they count by their last extension. */
export function isDataFile(entry: Pick<TreeEntry, "path" | "executable">): boolean {
  return !entry.executable && DATA_EXTENSIONS.has(extensionOf(entry.path));
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** What a manifest runs (§5.6): every field whose change is a code change. */
function runsOf(m: Manifest | undefined, codeFieldsOf: CodeFieldsOf): string {
  if (!m) return "";
  const c = m.contributes ?? {};
  const mcp = Object.entries(c.mcpServers ?? {})
    .filter(([, s]) => s.type === "stdio")
    .map(([name, s]) => ({ name, command: s.command, args: s.args ?? [], env: s.env ?? {} }));
  const hooks = (c.hooks ?? []).map((h) => ({ id: h.id, command: h.command, args: h.args, handler: h.handler }));
  const backends = (c.agentBackends ?? []).map((b) => ({ id: b.id, command: b.command, args: (b as { args?: unknown }).args }));
  const dotted: Record<string, unknown> = {};
  for (const [point, raw] of Object.entries(c as Record<string, unknown>)) {
    if (!point.includes(".")) continue;
    const fields = codeFieldsOf(point);
    if (fields.length === 0) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    dotted[point] = list.map((e) => Object.fromEntries(fields.map((f) => [f, (e as Record<string, unknown> | null)?.[f]])));
  }
  return canonicalJson({ host: m.host, client: m.client, helper: m.helper, mcp, hooks, backends, dotted });
}

function defaultsOf(m: Manifest | undefined): string {
  const settings = (m as { settings?: Record<string, { default?: unknown }> } | undefined)?.settings ?? {};
  return canonicalJson(Object.fromEntries(Object.entries(settings).map(([k, s]) => [k, s?.default])));
}

export function fingerprintOf(report: ManifestReport, codeFieldsOf: CodeFieldsOf): PluginFingerprint {
  const m = report.manifest;
  return {
    class: report.class,
    capabilities: sorted(report.capabilities),
    networkHosts: sorted(report.networkHosts),
    helperPermissions: sorted(report.helperPermissions),
    hookEvents: sorted((m?.contributes?.hooks ?? []).flatMap((h) => h.on)),
    fetchesCode: sorted(report.fetchesCode),
    addons: report.addons,
    adult: report.adult,
    runs: runsOf(m, codeFieldsOf),
    defaults: defaultsOf(m),
  };
}

/** The files that style approval cards (theme and `style` files), with the tree's flag. */
function cardsOf(tree: TreeReport, files: readonly TreeEntry[]): string {
  const styleFiles = new Set<string>();
  const add = (base: string, m: Manifest | undefined) => {
    for (const t of m?.contributes?.themes ?? []) styleFiles.add(`${base}${t.file.replace(/^\.\//, "")}`);
    for (const u of m?.contributes?.ui ?? []) if (u.style) styleFiles.add(`${base}${u.style.replace(/^\.\//, "")}`);
  };
  add("", tree.top.manifest);
  for (const c of tree.children) add(`plugins/${c.folder}/`, c.report.manifest);
  const approvals = [tree.top, ...tree.children.map((c) => c.report)].some((r) => r.capabilities.includes("approvals"));
  const styled = files.filter((f) => styleFiles.has(f.path)).map((f) => `${f.path}:${f.sha256}`).sort();
  return canonicalJson({ restyles: tree.restylesCards, approvals, styled: tree.restylesCards ? styled : [] });
}

/** The snapshot an OK keeps. */
export function okSnapshot(okHash: string, files: readonly TreeEntry[], tree: TreeReport, codeFieldsOf: CodeFieldsOf): OkSnapshot {
  const plugins: Record<string, PluginFingerprint> = { "": fingerprintOf(tree.top, codeFieldsOf) };
  for (const c of tree.children) plugins[c.folder] = fingerprintOf(c.report, codeFieldsOf);
  return { okHash, files: [...files], plugins, cards: cardsOf(tree, files) };
}

const CLASS_RANK = { data: 0, web: 1, code: 2 } as const;
const adds = (before: readonly string[], after: readonly string[]) => after.some((x) => !before.includes(x));

/** Whether a plugin's fingerprint hits a trigger or changes what runs. A new plugin in the tree (a child) asks again
 *  when it is code; a data child applies, like any data file. */
function pluginAsksAgain(before: PluginFingerprint | undefined, after: PluginFingerprint): boolean {
  if (!before) return after.class !== "data" || after.adult || after.addons || after.capabilities.length > 0
    || after.networkHosts.length > 0 || after.helperPermissions.length > 0 || after.hookEvents.length > 0;
  return CLASS_RANK[after.class] > CLASS_RANK[before.class]
    || adds(before.capabilities, after.capabilities)
    || adds(before.networkHosts, after.networkHosts)
    || adds(before.helperPermissions, after.helperPermissions)
    || adds(before.hookEvents, after.hookEvents)
    || adds(before.fetchesCode, after.fetchesCode)
    || (after.addons && !before.addons)
    || (after.adult && !before.adult)
    || after.runs !== before.runs
    || after.defaults !== before.defaults;
}

/** What the change from the OK'd tree to `now` does. */
export function classifyChange(ok: OkSnapshot, now: OkSnapshot): ChangeKind {
  if (now.okHash === ok.okHash) return "applies";
  const was = new Map(ok.files.map((f) => [f.path, f]));
  const is = new Map(now.files.map((f) => [f.path, f]));
  const touched: TreeEntry[] = [];
  for (const [path, f] of is) {
    const prior = was.get(path);
    if (!prior || prior.sha256 !== f.sha256 || prior.executable !== f.executable) touched.push(f);
  }
  for (const [path, f] of was) if (!is.has(path)) touched.push(f);
  // A file that isn't data, changed, added or removed, is a code change wherever it is (§5.6).
  if (touched.some((f) => !isDataFile(f))) return "asks-again";
  for (const [key, fp] of Object.entries(now.plugins)) if (pluginAsksAgain(ok.plugins[key], fp)) return "asks-again";
  if (now.cards !== ok.cards) return "card-styling";
  return "applies";
}
