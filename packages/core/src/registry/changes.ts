// When the app asks again (spec §5.6): what a folder change since the tree last OK'd does. The registry keeps, with
// each OK, the tree's files and a fingerprint of what it runs and reaches (`OkSnapshot`); a change then
// * asks again (`asks-again`) when it hits a trigger (data turned into web or code; more capabilities, network
//   hosts, helper permissions, hook events, add-ons, `stdio` commands that fetch code, code children; adult content),
//   or changes what runs: any file that isn't data, a `stdio` server's `command`, `args` or `env`, a hook's or agent
//   backend's `command` or `args`, the `host`, `client` or `helper` fields, a field whose format is `program` or
//   `code`, or a setting's `default`;
// * waits alone (`card-styling`) when it changes only how the tree styles approval cards (§5.5);
// * applies at once (`applies`) otherwise: themes, layouts, CSS, Markdown, assets.
import { posix } from "node:path";
import { MANIFEST_FILE, type Manifest, type ManifestReport, type TreeEntry, type TreeReport } from "@waifucave/clover-plugin-sdk";
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
  /** Where its keys and calls go, as canonical JSON: model endpoints, http servers' `url` and `headers`, web UI URLs. */
  reaches: string;
  /** Some host comes from its settings. */
  dynamicHosts: boolean;
}

/** The tree as its OK saw it, kept beside the OK (`plugins-state/oks/<id>.json`). */
export interface OkSnapshot {
  okHash: string;
  files: TreeEntry[];
  /** By plugin: `""` for the top-level plugin, the child's folder for a child. */
  plugins: Record<string, PluginFingerprint>;
  /** The files that style approval cards, and whether the tree places sealed frames. */
  cards: string;
  /** The tree's paths that a field of what runs names (a `stdio` server's script, a hook's file, an entry): code
   *  whatever their extension (#197's review). A folder counts with everything under it. */
  codePaths: string[];
}

/** The fields of a plugin point whose format is `program` or `code`, from its declaration (the catalog's for a
 *  well-known name, else its declarer's); undefined for a point with no declaration, whose entries count as code
 *  whole (#197's review). */
export type CodeFieldsOf = (point: string) => readonly string[] | undefined;

/** The code fields of a point's declaration: each top-level field whose schema holds a `program` or `code` format,
 *  at any depth. Undefined for no declaration (its entries count as code whole). */
export function codeFieldsFrom(decl: { fields?: unknown } | undefined): readonly string[] | undefined {
  if (decl === undefined) return undefined;
  const props = (decl.fields as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const holdsCode = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(holdsCode);
    if (v === null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    return o.format === "program" || o.format === "code" || Object.values(o).some(holdsCode);
  };
  return Object.entries(props).filter(([, v]) => holdsCode(v)).map(([k]) => k);
}

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

/** A tree path as a disk could read it, for matching what a run field names against the tree's files (#197's check 4):
 *  each name in Unicode NFC, without the trailing dots and spaces Windows drops or a `:stream`, case folded. */
export function treeKey(path: string): string {
  return path.normalize("NFC").split("/").map((seg) => seg.replace(/:.*$/, "").replace(/[. ]+$/, "").toLowerCase()).join("/");
}

/** A name that may be another file's on Windows: an 8.3 short name (`SERVER~1.TXT`) or a stream (`a.txt:x`). */
function aliasName(path: string): boolean {
  return path.split("/").some((seg) => /~\d/.test(seg) || seg.includes(":") || /[. ]$/.test(seg));
}

/** File names that steer how code is resolved, loaded or run (#234's review, F2), compared folded: the runtime reads
 *  them by name. */
const LOADER_CONFIG = [
  /^package\.json$/, /^tsconfig(\..+)?\.json$/, /^jsconfig(\..+)?\.json$/, /^bunfig\.toml$/, /^\.npmrc$/, /^\.env(\..*)?$/,
  /^deno\.jsonc?$/, /^import_map\.json$/, /^\.yarnrc(\.yml)?$/, /^\.pnpmfile\.cjs$/, /^\.babelrc(\.json)?$/, /^\.swcrc$/,
];

/** Whether a tree path names a file that steers how code loads, whatever folder it sits in. */
export function isLoaderConfig(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return LOADER_CONFIG.some((re) => re.test(name));
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
  // An agent backend runs what its whole entry says (lane K's ask): its command and args, its handler, its protocol
  // and its quirks file, which names the command and the env it gets. Only its display name is data.
  const backends = (c.agentBackends ?? []).map(({ name: _name, ...run }) => run);
  const dotted: Record<string, unknown> = {};
  for (const [point, raw] of Object.entries(c as Record<string, unknown>)) {
    if (!point.includes(".")) continue;
    const fields = codeFieldsOf(point);
    const list = Array.isArray(raw) ? raw : [raw];
    if (fields === undefined) dotted[point] = list; // no declaration: the whole entry counts as code
    else if (fields.length > 0) dotted[point] = list.map((e) => Object.fromEntries(fields.map((f) => [f, (e as Record<string, unknown> | null)?.[f]])));
  }
  return canonicalJson({ host: m.host, client: m.client, helper: m.helper, mcp, hooks, backends, dotted });
}

function defaultsOf(m: Manifest | undefined): string {
  const settings = (m as { settings?: Record<string, { default?: unknown }> } | undefined)?.settings ?? {};
  return canonicalJson(Object.fromEntries(Object.entries(settings).map(([k, s]) => [k, s?.default])));
}

/** Where a manifest's keys and calls go (§5.3): model endpoints, http servers' `url` and `headers`, web UI URLs. */
function reachesOf(m: Manifest | undefined): string {
  if (!m) return "";
  const c = m.contributes ?? {};
  return canonicalJson({
    models: (c.models ?? []).map((x) => ({ provider: x.provider, endpoint: x.endpoint })),
    http: Object.entries(c.mcpServers ?? {}).filter(([, x]) => x.type === "http").map(([name, x]) => ({ name, url: x.url, headers: x.headers })),
    web: (c.ui ?? []).map((u) => u.web?.url ?? null),
  });
}

/** Every string a field of what runs holds, for the paths it names. */
function runStrings(m: Manifest | undefined, codeFieldsOf: CodeFieldsOf): string[] {
  if (!m) return [];
  const out: string[] = [];
  const deep = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(deep);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(deep);
  };
  deep(m.host);
  deep(m.client);
  deep(m.helper);
  const c = m.contributes ?? {};
  for (const x of Object.values(c.mcpServers ?? {})) if (x.type === "stdio") deep([x.command, x.args, x.env]);
  for (const h of c.hooks ?? []) deep([h.command, h.args]);
  for (const { name: _name, ...run } of c.agentBackends ?? []) deep(run); // its quirks file too (lane K's ask)
  for (const [point, raw] of Object.entries(c as Record<string, unknown>)) {
    if (!point.includes(".")) continue;
    const fields = codeFieldsOf(point);
    const list = Array.isArray(raw) ? raw : [raw];
    if (fields === undefined) deep(list);
    else for (const e of list) for (const f of fields) deep((e as Record<string, unknown> | null)?.[f]);
  }
  return out;
}

/** The tree paths a string names (#197's check 2), lower-cased: each word with its wrappers taken off (`@`, `<`, `>`,
 *  brackets, quotes, `file://`, `${plugin}` and `./`), `//` collapsed and `..` resolved; a bare `${plugin}` or `.`
 *  names the whole plugin. `base` is a child's folder in the tree (`plugins/<folder>/`). */
function pathsNamed(strings: readonly string[], base: string, files: ReadonlySet<string>, folders: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  const whole = base === "" ? "" : treeKey(base.slice(0, -1));
  for (const s of strings) {
    for (const raw of s.split(/[\s=,;:"'`|&]+/)) {
      // `${plugin}` as one mark first, so taking the brackets off a word leaves it whole.
      let w = raw.replace(/\\/g, "/").replaceAll("${plugin}", "\u0000");
      for (let before = ""; before !== w;) {
        before = w;
        w = w.replace(/^(?:@|<|>|\(|\[|\{|file:\/\/)+/i, "").replace(/[)\]}>]+$/, "");
      }
      const at = w.indexOf("\u0000");
      if (at >= 0) w = w.slice(at + 1);
      w = w.replace(/^\/+/, at >= 0 ? "" : "/");
      if (w === "" || w === ".") {
        if (at >= 0 || raw === ".") out.add(whole);
        continue;
      }
      if (w.startsWith("/") || w.includes("${")) continue;
      const p = treeKey(posix.normalize(`${base}${w}`).replace(/\/+$/, ""));
      if (p === "." || p.startsWith("../") || p === "..") continue;
      // A word that looks like an 8.3 alias (`SERVER~1.TXT`, `LIB~1/x`) can name a file no listing shows by that name, so
      // the folder it sits in counts as code whole (#197's check 5).
      const segs = p.split("/");
      const alias = segs.findIndex((seg) => /~\d/.test(seg));
      if (alias >= 0) {
        const folder = segs.slice(0, alias).join("/");
        out.add(folder === "" ? whole : folder);
        continue;
      }
      if (files.has(p) || folders.has(p)) out.add(p);
    }
  }
  return [...out];
}

/** The folders of a manifest's `host`, `client` and `helper` parts (each path's folder; the plugin's own folder for
 *  an entry at its top), lower-cased: everything under them counts as code. */
function partDirs(m: Manifest | undefined, base: string): string[] {
  if (!m) return [];
  const out = new Set<string>();
  const paths: string[] = [];
  const deep = (v: unknown) => {
    if (typeof v === "string") paths.push(v);
    else if (Array.isArray(v)) v.forEach(deep);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(deep);
  };
  deep(m.host);
  deep(m.client);
  deep(m.helper);
  for (const raw of paths) {
    if (!raw.includes("/") && !raw.includes(".")) continue; // a word such as a runtime's name, not a path
    const p = treeKey(posix.normalize(`${base}${raw.replace(/\\/g, "/").replace(/^\.\//, "")}`));
    if (p.startsWith("..") || p.startsWith("/")) continue;
    const dir = posix.dirname(p);
    out.add(dir === "." ? (base === "" ? "" : treeKey(base.slice(0, -1))) : dir);
  }
  return [...out];
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
    reaches: reachesOf(m),
    dynamicHosts: report.dynamicHosts,
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
/** `loaderCode`: the files the tree's loader configs reach inside it (`loaderReach`), counted as code. */
export function okSnapshot(okHash: string, files: readonly TreeEntry[], tree: TreeReport, codeFieldsOf: CodeFieldsOf, loaderCode: readonly string[] = []): OkSnapshot {
  const plugins: Record<string, PluginFingerprint> = { "": fingerprintOf(tree.top, codeFieldsOf) };
  for (const c of tree.children) plugins[c.folder] = fingerprintOf(c.report, codeFieldsOf);
  const fileSet = new Set(files.map((f) => treeKey(f.path)));
  const folders = new Set(files.flatMap((f) => treeKey(f.path).split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const codePaths = new Set(pathsNamed(runStrings(tree.top.manifest, codeFieldsOf), "", fileSet, folders));
  for (const c of tree.children) for (const p of pathsNamed(runStrings(c.report.manifest, codeFieldsOf), `plugins/${c.folder}/`, fileSet, folders)) codePaths.add(p);
  for (const p of partDirs(tree.top.manifest, "")) codePaths.add(p);
  for (const c of tree.children) for (const p of partDirs(c.report.manifest, `plugins/${c.folder}/`)) codePaths.add(p);
  // Files that steer how code loads (#234's review, F2): a tsconfig `paths` entry, a package.json `imports` or `exports`
  // map, a bunfig preload, an .npmrc registry or a .env file can make the plugin's code run another file, without
  // their extension saying so. Wherever they sit in the tree, they are code.
  for (const k of fileSet) if (isLoaderConfig(k)) codePaths.add(k);
  // And what they reach through `extends`, `paths` and package maps (#234's review, F2).
  for (const p of loaderCode) codePaths.add(treeKey(p));
    // A plugin that brings an agent backend has every file of its folder counted as code (lane K, on #233): what the
  // agent runs with can name a file anywhere in it without a manifest field naming it (a quirks file's `envSet` value,
  // `NODE_OPTIONS=--require <file>`), so no edit there applies without a new OK.
  // The manifest itself stays out: its fields are judged one by one above (`runsOf`), so a display name still applies.
  const runsAgent = (m: Manifest | undefined) => (m?.contributes?.agentBackends?.length ?? 0) > 0;
  if (runsAgent(tree.top.manifest)) {
    const childDirs = tree.children.map((c) => treeKey(`plugins/${c.folder}`) + "/");
    for (const k of fileSet) if (k !== treeKey(MANIFEST_FILE) && !childDirs.some((d) => k.startsWith(d))) codePaths.add(k);
  }
  for (const c of tree.children) {
    if (!runsAgent(c.report.manifest)) continue;
    const dir = treeKey(`plugins/${c.folder}`) + "/";
    for (const k of fileSet) if (k.startsWith(dir) && k !== dir + treeKey(MANIFEST_FILE)) codePaths.add(k);
  }
  return { okHash, files: [...files], plugins, cards: cardsOf(tree, files), codePaths: [...codePaths].sort() };
}

const CLASS_RANK = { data: 0, web: 1, code: 2 } as const;
const adds = (before: readonly string[], after: readonly string[]) => after.some((x) => !before.includes(x));

/** Whether a plugin's fingerprint hits a trigger or changes what runs. A new plugin in the tree (a child) asks again
 *  when it is code; a data child applies, like any data file. */
function pluginAsksAgain(before: PluginFingerprint | undefined, after: PluginFingerprint): boolean {
  if (!before) return after.class !== "data" || after.adult || after.addons || after.capabilities.length > 0
    || after.networkHosts.length > 0 || after.helperPermissions.length > 0 || after.hookEvents.length > 0 || after.dynamicHosts;
  return CLASS_RANK[after.class] > CLASS_RANK[before.class]
    || adds(before.capabilities, after.capabilities)
    || adds(before.networkHosts, after.networkHosts)
    || adds(before.helperPermissions, after.helperPermissions)
    || adds(before.hookEvents, after.hookEvents)
    || adds(before.fetchesCode, after.fetchesCode)
    || (after.addons && !before.addons)
    || (after.adult && !before.adult)
    || after.runs !== before.runs
    || after.defaults !== before.defaults
    || after.reaches !== before.reaches
    || (after.dynamicHosts && !before.dynamicHosts);
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
  // A file that isn't data, changed, added or removed, is a code change wherever it is (§5.6); so is one a field of
  // what runs names, whatever its extension, or one inside a folder it names or a `host`, `client` or `helper` part's
  // folder (#197's review). Other data edits apply at once, as §5.6 promises. That is safe because the plugins folder
  // is fenced (the `plugins` kind, #197's check 2): sessions, agents and plugin code can't write a plugin's files, so a
  // data file there changes only by the user's own hand or an install's OK, never by a bot slipping code past the OK.
  const code = [...(ok.codePaths ?? []), ...now.codePaths];
  const named = (path: string) => {
    const p = treeKey(path);
    return code.some((c) => c === "" || p === c || p.startsWith(`${c}/`));
  };
  // A name a disk may read as another file's (an 8.3 short name, a stream, a trailing dot or space) counts as code.
  if (touched.some((f) => !isDataFile(f) || named(f.path) || aliasName(f.path))) return "asks-again";
  for (const [key, fp] of Object.entries(now.plugins)) if (pluginAsksAgain(ok.plugins[key], fp)) return "asks-again";
  if (now.cards !== ok.cards) return "card-styling";
  return "applies";
}
