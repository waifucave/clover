// Validating a manifest without running anything (spec §5.1 "Formats", §5.4 "Point schemas", §5.6 "`clover plugin
// validate`", §5.9 "Checked before anything runs"). `validateManifest` checks one `clover.json`; `validateTree` (tree.ts)
// reads a whole plugin folder through a reader, children and referenced files included. Both return what
// `clover plugin validate` prints: the class, contributions, declared points, network hosts, helper permissions,
// capabilities, tool names, settings and findings, and `describeOk` gives the OK's text.
//
// What a finding refuses (§5.1, §5.4): an error in the manifest's envelope refuses the plugin; an unknown key in
// `contributes` refuses that contribution; an entry that fails its point's schema refuses that entry, and the rest of
// the plugin runs. A child that fails is invalid alone (`validateTree`).
import type { z } from "zod";
import {
  BUNDLED_BOT_PLUGIN, BUNDLED_ROOT_PLUGIN, isPluginId, type ValidationIssue,
} from "@waifucave/clover-protocol";
import { capabilityOkText, isCapability, parseCapability, parseSettingHost } from "../catalogs/capabilities";
import { TOOL_HOOK_EVENTS, type HookEvent } from "../catalogs/hooks";
import { hookReadsStdinAsScript } from "./hook-command";
import { CORE_POINTS, CORE_POINT_NAMES, WELL_KNOWN_POINT_NAMES, dataPointInfo } from "../catalogs/points";
import { OWN_PANEL_KEY_RE, SAME_ON_EVERY_TAB, SPOT_NAMES, botsOffer, foldTitle, isOwnPanelKey, isReservedPluginName, spotInfo } from "../catalogs/spots";
import { holdsBot, marksAppParts, pluginParts, skillItem } from "./parts";
import { treePathProblem } from "../formats/tree-hash";
import { parseJsonc } from "../jsonc";
import { isRange, satisfies } from "../semver";
import { FORMATS, MANIFEST_FILE, PLUGIN_API_VERSION } from "../version";
import { DOTTED_POINT_NAME_RE, NAMESPACE_RE, POINT_NAME_RE } from "./fields";
import { checkArgsSchema } from "./args";
import { TEXT_EDITING_KEYS } from "./keys";
import { hookOptionEnvName, parseInterpolation, SETTING_FED_PARTS, usesSecretFiles, usesSecrets } from "./interpolation";
import { fetchesCodeAtRunTime, toolWireName } from "./names";
import { CORE_CONTRIBUTION_KEYS, CORE_CONTRIBUTION_SCHEMAS, ManifestSchema, isToolKey, type CoreContributionKey } from "./schema";
import type { Manifest, PointDecl } from "./types";

/** Environment names a plugin's server never sets (the core refuses them too, `refuseReservedPluginEnv`). Matched
 *  without case: Windows' environment names are case-insensitive, and a manifest runs on every OS. */
export const RESERVED_ENV = /^(CLOVER_|BUN_|LD_|DYLD_|NODE_(?!(ENV|NO_WARNINGS)$))/i;

export type PluginClassName = "data" | "web" | "code";

export interface DeclaredPoint {
  name: string;
  /** `host`, or the entry that declares it (`ui/0`, `triggers/1`, `bot`). */
  by: string;
  shape: PointDecl["shape"];
  spot: boolean;
  wellKnown: boolean;
}

export interface ManifestReport {
  /** No finding refuses the plugin. */
  ok: boolean;
  /** `<id>`, or `<parent>/<folder>` for a child; undefined when the manifest names none. */
  id: string | undefined;
  namespace: string | undefined;
  /** The manifest with refused contributions and entries left out; undefined when the plugin is refused. */
  manifest: Manifest | undefined;
  class: PluginClassName;
  /** Each kept contribution's point and how many entries it has. */
  contributions: { point: string; entries: number }[];
  declares: DeclaredPoint[];
  /** The hosts its components can reach (§5.3): its `network:` hosts and the host of every `url` field. */
  networkHosts: string[];
  /** A `url` field's host is filled at run time (`${setting:…}`), so not every host is listed. */
  dynamicHosts: boolean;
  helperPermissions: string[];
  capabilities: string[];
  /** Tools the manifest names, as the model sees them (`mcp__<namespace>__<Tool>`). */
  toolNames: string[];
  settings: string[];
  /** `stdio` commands that fetch code when they run (`npx`, `uvx`, …), which the OK flags (§5.6). */
  fetchesCode: string[];
  /** Each server's tools it declares read-only (`readOnly`), which the OK names; `network` for a server that reaches
   *  the network itself (an http server). */
  readOnlyTools: { server: string; tools: string[]; network: boolean }[];
  /** Each server's tools it declares display-only (`contained`), which the OK names. */
  containedTools: { server: string; tools: string[]; network: boolean }[];
  /** Each server's tools it declares as a web search (`webSearch`) or a page fetch (`webFetch`), which the OK names with a
   *  warning (R1: no door checks a plugin's id). */
  webTools: { server: string; search: string[]; fetch: string[]; browser?: string[] }[];
  /** `stdio` servers given a secret through their environment (`${secret:…}` in `env`), which the OK discloses: macOS
   *  lets any process of the same user read another's environment, and a third-party server's program can't be signed
   *  to hide it (the controller's ruling on #377). */
  envSecrets: string[];
  /** It declares programs of its own (a `stdio` server, a helper, or a Node host, Clover's own plugins only), which
   *  Clover's load guard doesn't hold to the plugin's folder: the OK says so (#234's check 3). */
  ownPrograms: boolean;
  /** Its host half runs in a process of its own that runs programs (`host.programs`), fenced to its own folders and
   *  the files the user picks: the OK says so. */
  hostPrograms: boolean;
  /** Programs of the user's its host half runs outside the sandbox, and folders of the user's it reads
   *  (`host.outside`, P5), as its manifest names them: the OK names each with a warning. */
  outside: { programs: string[]; read: string[] };
  addons: boolean;
  adult: boolean;
  bot: boolean;
  /** It places sealed frames (the `approvals` capability), so it styles approval cards (§5.5); a theme or `style` file
   *  that sets `card.*` tokens does too, which `validateTree` adds (`TreeReport.restylesCards`). */
  restylesCards: boolean;
  issues: ValidationIssue[];
}

export interface ValidateOptions {
  /** The folder's name: a top-level id must equal it (§5.1). */
  folderName?: string;
  /** For a child plugin: its top-level plugin's id and namespace. */
  parent?: { id: string; namespace: string };
  /** The app's own plugins (`clover`, `alpha` and their children) may use the reserved names. */
  bundled?: boolean;
  /** The plugin API the app has; default `PLUGIN_API_VERSION`. */
  apiVersion?: string;
  /** The file name findings name; default `clover.json`. */
  file?: string;
}

type Seg = string | number;
type Refuses = ValidationIssue["refuses"];

/** A JSON pointer: `/contributes/models/0/auth`. */
export function jsonPointer(path: readonly Seg[]): string {
  return path.map((s) => `/${String(s).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

class Findings {
  readonly list: ValidationIssue[] = [];
  constructor(private readonly file: string) {}
  error(refuses: Exclude<Refuses, "none">, code: string, path: readonly Seg[], message: string): void {
    this.list.push({ severity: "error", refuses, code, message, file: this.file, path: jsonPointer(path) });
  }
  warn(code: string, path: readonly Seg[], message: string): void {
    this.list.push({ severity: "warning", refuses: "none", code, message, file: this.file, path: jsonPointer(path) });
  }
  refusesPlugin(): boolean {
    return this.list.some((i) => i.severity === "error" && i.refuses === "plugin");
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface FlatIssue { path: Seg[]; message: string }

/** Zod's issues as one list, picking the most specific branch of a union. */
export function flattenZodIssues(error: z.ZodError, base: readonly Seg[] = []): FlatIssue[] {
  const out: FlatIssue[] = [];
  const visit = (issue: z.core.$ZodIssue, prefix: readonly Seg[]) => {
    const here = [...prefix, ...(issue.path as Seg[])];
    if (issue.code === "invalid_union" && "errors" in issue && Array.isArray(issue.errors) && issue.errors.length > 0) {
      let best = issue.errors[0]!;
      let bestScore = -Infinity;
      for (const branch of issue.errors) {
        const depth = Math.max(0, ...branch.map((i) => i.path.length));
        const score = depth * 1000 - branch.length;
        if (score > bestScore) {
          best = branch;
          bestScore = score;
        }
      }
      for (const sub of best) visit(sub, here);
      return;
    }
    out.push({ path: here, message: issue.message });
  };
  for (const issue of error.issues) visit(issue, base);
  return out;
}

function schemaFindings(f: Findings, refuses: Exclude<Refuses, "none">, error: z.ZodError, base: readonly Seg[]): void {
  for (const i of flattenZodIssues(error, base)) f.error(refuses, "schema", i.path, i.message);
}

/** A manifest path's lexical problem (§5.9: relative, with `/`, resolving inside the folder), or null. A leading
 *  `./` is allowed. The real path, symlinks included, is checked where the folder is read. */
export function manifestPathProblem(path: string, allowGlob = false): string | null {
  const p = path.startsWith("./") ? path.slice(2) : path;
  const problem = treePathProblem(p);
  if (problem) return problem;
  if (!allowGlob && /[*?[\]{}]/.test(p)) return "glob characters";
  return null;
}

/** Every `format: "path"` field of the manifest, with where it is and what refusing it stops. */
function collectPaths(m: Record<string, unknown>): { path: Seg[]; value: string; refuses: Exclude<Refuses, "none">; glob: boolean }[] {
  const out: { path: Seg[]; value: string; refuses: Exclude<Refuses, "none">; glob: boolean }[] = [];
  const add = (path: Seg[], value: unknown, refuses: Exclude<Refuses, "none">, glob = false) => {
    if (typeof value === "string") out.push({ path, value, refuses, glob });
  };
  add(["icon"], m.icon, "plugin");
  if (isObject(m.host)) add(["host", "entry"], m.host.entry, "plugin");
  if (isObject(m.client)) {
    add(["client", "entry"], m.client.entry, "plugin");
    if (Array.isArray(m.client.css)) m.client.css.forEach((p, i) => add(["client", "css", i], p, "plugin"));
  }
  if (isObject(m.helper) && isObject(m.helper.bin)) for (const [k, v] of Object.entries(m.helper.bin)) add(["helper", "bin", k], v, "plugin");
  const c = isObject(m.contributes) ? m.contributes : {};
  if (isObject(c.bot)) {
    const b = c.bot;
    for (const k of ["instructions", "layout", "greeting", "memory"]) add(["contributes", "bot", k], b[k], "contribution");
    if (isObject(b.avatar)) {
      add(["contributes", "bot", "avatar", "file"], b.avatar.file, "contribution");
      add(["contributes", "bot", "avatar", "portrait"], b.avatar.portrait, "contribution");
    }
  }
  const list = (key: string) => (Array.isArray(c[key]) ? (c[key] as unknown[]) : []);
  list("models").forEach((e, i) => isObject(e) && add(["contributes", "models", i, "catalog"], e.catalog, "entry"));
  list("skills").forEach((e, i) => add(typeof e === "string" ? ["contributes", "skills", i] : ["contributes", "skills", i, "path"], skillItem(e)?.path, "entry", true));
  list("agents").forEach((e, i) => (typeof e === "string" ? add(["contributes", "agents", i], e, "entry") : isObject(e) && add(["contributes", "agents", i, "instructions"], e.instructions, "entry")));
  list("themes").forEach((e, i) => isObject(e) && add(["contributes", "themes", i, "file"], e.file, "entry"));
  list("locales").forEach((e, i) => isObject(e) && add(["contributes", "locales", i, "file"], e.file, "entry"));
  list("ui").forEach((e, i) => {
    if (!isObject(e)) return;
    add(["contributes", "ui", i, "style"], e.style, "entry");
    if (isObject(e.web)) add(["contributes", "ui", i, "web", "entry"], e.web.entry, "entry");
    for (const k of ["icon"]) add(["contributes", "ui", i, k], e[k], "entry");
  });
  if (isObject(c.mcpServers)) for (const [name, s] of Object.entries(c.mcpServers)) if (isObject(s)) add(["contributes", "mcpServers", name, "instructions"], s.instructions, "entry");
  return out;
}

function hostOf(url: string): { host?: string; dynamic: boolean } {
  const m = /^https?:\/\/([^/?#]*)/i.exec(url);
  if (!m) return { dynamic: false };
  const authority = m[1]!.replace(/^[^@]*@/, "");
  if (authority.includes("${")) return { dynamic: true };
  try {
    const u = new URL(url.replace(/\$\{[^}]*\}/g, "x"));
    const port = u.port !== "" ? `:${u.port}` : "";
    return { host: `${u.hostname.toLowerCase()}${port}`, dynamic: false };
  } catch {
    return { dynamic: false };
  }
}

/** Checks a value that may hold interpolation (§5.9); `secrets` says whether `${secret:…}` may appear, `secretFiles`
 *  whether `${secretFile:…}` may (a stdio server's `env` and `args`). */
function checkInterpolated(f: Findings, path: Seg[], value: unknown, secrets: boolean, secretFiles = false): boolean {
  if (typeof value !== "string") return true;
  const parsed = parseInterpolation(value);
  if (!parsed.ok) {
    f.error("entry", "interpolation", path, parsed.error);
    return false;
  }
  if (!secrets && usesSecrets(parsed.parts)) {
    f.error("entry", "secret_outside_env", path, "secrets may appear only in `env` and `headers`");
    return false;
  }
  if (!secretFiles && usesSecretFiles(parsed.parts)) {
    f.error("entry", "secret_file_outside_stdio", path, "a secret's file may appear only in a stdio server's `env` and `args`");
    return false;
  }
  return true;
}

function checkSetting(f: Findings, key: string, s: Record<string, unknown>): void {
  const at = ["settings", key];
  const type = s.type as string;
  const options = Array.isArray(s.options) ? s.options.map((o) => (typeof o === "string" ? o : isObject(o) ? String(o.value) : "")) : undefined;
  if (type === "enum" && (!options || options.length === 0)) f.error("plugin", "setting_options", at, "an `enum` setting needs `options`");
  if (type !== "enum" && s.options !== undefined) f.warn("setting_options", at, "`options` applies only to an `enum` setting");
  if (type !== "number" && (s.min !== undefined || s.max !== undefined)) f.warn("setting_range", at, "`min` and `max` apply only to a `number` setting");
  if (s.default === undefined) return;
  if (type === "secret") {
    f.error("plugin", "setting_secret_default", [...at, "default"], "a secret has no default: secrets go to the credential store only");
    return;
  }
  const d = s.default;
  const ok = type === "number" ? typeof d === "number" && (s.min === undefined || d >= (s.min as number)) && (s.max === undefined || d <= (s.max as number))
    : type === "boolean" ? typeof d === "boolean"
    : type === "enum" ? typeof d === "string" && (options ?? []).includes(d)
    : typeof d === "string";
  if (!ok) f.error("plugin", "setting_default", [...at, "default"], `the default doesn't fit a \`${type}\` setting`);
}

/** A declaration as JSON with sorted keys, to tell one spot's repeats apart. */
function canonicalDecl(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalDecl).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalDecl((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** Checks a point declaration (§5.4): names, the prefix rule, well-known declarations and who may declare a spot. */
function checkDeclares(f: Findings, topId: string | undefined, declares: unknown, by: Seg[], declarer: { ui?: Record<string, unknown> }, refuses: Exclude<Refuses, "none">, seen: Map<string, string>, out: DeclaredPoint[]): void {
  if (!isObject(declares)) return;
  for (const [name, d] of Object.entries(declares)) {
    if (!isObject(d)) continue;
    const at = [...by, "declares", name];
    if (!POINT_NAME_RE.test(name)) {
      f.error(refuses, "point_name", at, `"${name}" is not a point name`);
      continue;
    }
    if (CORE_POINT_NAMES.has(name)) {
      f.error(refuses, "point_declares_core", at, `"${name}" is one of the core's points; no plugin declares it`);
      continue;
    }
    const wellKnown = WELL_KNOWN_POINT_NAMES.has(name);
    const spot = d.props !== undefined;
    if (wellKnown) {
      const s = spotInfo(name);
      const dp = dataPointInfo(name);
      const shape = s?.shape ?? dp?.shape;
      if (d.shape !== shape || spot !== (s !== undefined)) {
        f.error(refuses, "point_declares_well_known", at, `"${name}" is a well-known name; declare it with the catalog's declaration (a ${s ? "UI spot" : "point"}, ${shape})`);
        continue;
      }
    } else if (topId === undefined || !name.startsWith(`${topId}.`)) {
      f.error(refuses, "point_name", at, `a new point's name starts with the plugin's id and a dot ("${topId ?? "<id>"}.…")`);
      continue;
    } else if (!spot && !DOTTED_POINT_NAME_RE.test(name)) {
      f.error(refuses, "point_name", at, "a point filled with a `contributes` key has a dot in its name");
      continue;
    }
    if (spot && !(declarer.ui && typeof declarer.ui.component === "string")) {
      f.error(refuses, "spot_declarer", at, "a UI spot (a declaration with `props`) is declared only by a `ui` entry with a `component`");
      continue;
    }
    // One at a time (§5.4): Settings' picker is titled by the point's own title, and a single point takes one filler
    // already. A well-known name's comes from the catalog, whatever the declarer wrote.
    if (!wellKnown && d.oneAtATime === true) {
      if (d.shape === "single") {
        f.error(refuses, "point_one_single", [...at, "oneAtATime"], `"${name}" is a single point, which takes one filler already; oneAtATime is for a list or keyed point`);
        continue;
      }
      // A UI spot draws every filler (\`Spot\`): one drawn at a time isn't the app's yet, so a spot can't say it.
      if (spot) {
        f.error(refuses, "point_one_spot", [...at, "oneAtATime"], `"${name}" is a UI spot, which draws every filler; oneAtATime is for a data point (your component reads \`points.active\` and draws the one)`);
        continue;
      }
      if (d.title === undefined) {
        f.error(refuses, "point_one_title", [...at, "title"], `"${name}" takes one filler at a time: give it a title, which Settings' picker shows ("Voice", "Stage")`);
        continue;
      }
    }
    const where = jsonPointer(at);
    // A UI spot may be declared on several of a plugin's entries (lane F: its panel and its Files view both declare
    // `file.preview`), each a place the spot shows, all with the same declaration; any other point is declared once.
    const key = spot ? `${name}\u0000${canonicalDecl(d)}` : undefined;
    if (seen.has(name) && !(spot && seen.get(`${name}\u0000spot`) === key)) {
      f.error(refuses, "point_duplicate", at, `"${name}" is declared twice (also at ${seen.get(name)})${spot ? " with another declaration" : ""}`);
      continue;
    }
    // A data point of the plugin's own that names no fields: its declarer reads each contributor's whole entry value
    // (`points.entries` narrows an entry to the declared `fields.properties` only when there are some).
    if (!spot && !wellKnown && !(isObject(d.fields) && isObject(d.fields.properties) && Object.keys(d.fields.properties).length > 0)) {
      f.warn("point_fields", [...at, "fields"], `"${name}" names no fields (\`fields.properties\`): its declarer reads whatever each contributor's entry holds; name the fields it reads`);
    }
    if (!seen.has(name)) seen.set(name, where);
    if (key !== undefined) seen.set(`${name}\u0000spot`, key);
    out.push({ name, by: by.length === 1 ? String(by[0]) : by.slice(1).join("/"), shape: d.shape as PointDecl["shape"], spot, wellKnown });
  }
}

/** The report of a plugin refused before its manifest could be read. */
export function refusedReport(issues: ValidationIssue[], id?: string, namespace?: string): ManifestReport {
  return {
    ok: false, id, namespace, manifest: undefined, class: "data", contributions: [], declares: [], networkHosts: [], dynamicHosts: false,
    helperPermissions: [], capabilities: [], toolNames: [], settings: [], fetchesCode: [], readOnlyTools: [], containedTools: [], webTools: [], envSecrets: [], ownPrograms: false, hostPrograms: false, outside: { programs: [], read: [] }, addons: false, adult: false, bot: false, restylesCards: false, issues,
  };
}

/** Validates one `clover.json`, given as text (JSON with comments) or as parsed JSON. */
export function validateManifest(input: unknown, opts: ValidateOptions = {}): ManifestReport {
  const f = new Findings(opts.file ?? MANIFEST_FILE);
  const empty = (): ManifestReport => refusedReport(f.list);

  let raw = input;
  if (typeof input === "string") {
    const parsed = parseJsonc(input);
    if (!parsed.ok) {
      f.error("plugin", "jsonc", [], `not JSON: ${parsed.error.message} (line ${parsed.error.line}, column ${parsed.error.column})`);
      return empty();
    }
    raw = parsed.value;
  }
  if (!isObject(raw)) {
    f.error("plugin", "schema", [], "the manifest is not a JSON object");
    return empty();
  }

  // The format comes first: a newer one is refused with "needs a newer Clover" (§5.1).
  const format = raw.manifest;
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
    f.error("plugin", "manifest_format", ["manifest"], `\`manifest\` must be ${FORMATS.manifest}`);
    return empty();
  }
  if (format > FORMATS.manifest) {
    f.error("plugin", "needs_newer_clover", ["manifest"], `manifest format ${format} needs a newer Clover (this one reads format ${FORMATS.manifest})`);
    return empty();
  }

  // The envelope: everything but `contributes`.
  const { contributes: rawContributes, ...top } = raw;
  const topParsed = ManifestSchema.omit({ contributes: true }).safeParse(top);
  if (!topParsed.success) schemaFindings(f, "plugin", topParsed.error, []);

  const isChild = opts.parent !== undefined;
  const folder = opts.folderName;
  const declaredId = typeof top.id === "string" ? top.id : undefined;
  let id: string | undefined;
  let namespace: string | undefined;
  if (isChild) {
    if (declaredId !== undefined) f.error("plugin", "child_id", ["id"], "a child takes its id from its folder; leave `id` out");
    if (top.namespace !== undefined) f.error("plugin", "namespace_child", ["namespace"], "a child shares its top-level plugin's namespace");
    if (top.version !== undefined) f.warn("version_child", ["version"], "a child inherits its top-level plugin's version; this one is ignored");
    if (top.adult !== undefined) f.error("plugin", "adult_child", ["adult"], "`adult` covers the whole tree; set it on the top-level plugin");
    if (folder !== undefined && !isPluginId(folder)) f.error("plugin", "child_folder", [], `the folder "${folder}" is not a plugin id`);
    id = folder !== undefined ? `${opts.parent!.id}/${folder}` : undefined;
    namespace = opts.parent!.namespace;
  } else {
    if (declaredId === undefined) f.error("plugin", "id_missing", ["id"], "a top-level plugin needs an `id`, equal to its folder's name");
    else if (folder !== undefined && declaredId !== folder) {
      f.error("plugin", "id_mismatch", ["id"], `the folder is "${folder}" but the id is "${declaredId}"; rename the folder to its id`);
    }
    if (top.enabledByDefault !== undefined) f.error("plugin", "enabled_by_default_top", ["enabledByDefault"], "`enabledByDefault` is for child plugins");
    id = declaredId;
    namespace = typeof top.namespace === "string" ? top.namespace : declaredId;
  }
  const topId = isChild ? opts.parent!.id : declaredId;
  if (!opts.bundled) {
    if (!isChild && (declaredId === BUNDLED_ROOT_PLUGIN || declaredId === BUNDLED_BOT_PLUGIN)) {
      f.error("plugin", "id_reserved", ["id"], `"${declaredId}" is one of the plugins Clover ships`);
    }
    if (namespace === BUNDLED_ROOT_PLUGIN) f.error("plugin", "namespace_reserved", ["namespace"], "the namespace `clover` is reserved for the plugins Clover ships");
  }
  // A plugin named like a reserved title would label its tab with it (#179's review): "Needs you" and "Clover" are
  // Clover's own (lane G's ask).
  if (topId !== BUNDLED_ROOT_PLUGIN && typeof top.name === "string" && isReservedPluginName(top.name)) {
    f.error("plugin", "name_reserved", ["name"], `"${top.name}" is a name only Clover's own plugins have`);
  }

  // "Not available in this build yet" is Clover's word about its own plugins: another plugin can't wear it (it would
  // read as Clover's own state, and the plugin's author would expect it to stop a plugin the registry would start).
  if (top.availability !== undefined && topId !== BUNDLED_ROOT_PLUGIN) {
    f.error("plugin", "availability_bundled_only", ["availability"], "only the plugins Clover ships can be marked not available yet");
  }

  const capabilities = Array.isArray(top.capabilities) ? top.capabilities.filter((c): c is string => typeof c === "string") : [];
  capabilities.forEach((c, i) => {
    if (!isCapability(c)) f.error("plugin", "capability_unknown", ["capabilities", i], `"${c}" is not a capability (see the catalog)`);
    else if (c === "approvals.all" && !capabilities.includes("approvals")) f.error("plugin", "capability_needs", ["capabilities", i], "`approvals.all` needs `approvals` too");
    else if (capabilities.indexOf(c) !== i) f.warn("capability_duplicate", ["capabilities", i], `"${c}" is listed twice`);
  });

  if (isObject(top.settings)) for (const [k, s] of Object.entries(top.settings)) if (isObject(s)) checkSetting(f, k, s);
  // A helper (a native program the plugin host would start and supervise) isn't in this version: nothing starts one, so
  // a plugin that relies on it would never work. Refused, saying what to use instead (the controller's ruling).
  if (top.helper !== undefined) {
    f.error("plugin", "helper_not_supported", ["helper"], "a helper isn't supported: run a program from the host half (`host.process: \"own\"` with `host.programs: true`), or as a `stdio` MCP server");
  }
  // A host half runs under Bun, where Clover's load guard holds it to its folder (#234's check 3, the controller's
  // ruling). Bun runs Node-style code (`node:` modules, npm packages), and a program of its own runs from a host half
  // with `host.programs` or as a `stdio` server, which the OK covers. Node isn't supported for any plugin: Clover's own
  // cloud model plugins run on Bun in a process of their own too (lane A's code adapters).
  if (isObject(top.host) && top.host.runtime === "node") {
    f.error("plugin", "host_runtime_node", ["host", "runtime"], "node is not supported: a plugin's host runs under Bun, which runs Node-style code (`node:` modules, npm packages), so leave out `runtime`; a program of its own runs with `host.programs` (in a process of its own) or as a `stdio` server");
  }

  // A host half that runs programs does so from a process of its own, whose fence is its alone (the coordinator's
  // ruling): a worker shares its process, and its fence, with the plugin host's other workers.
  if (isObject(top.host) && top.host.programs === true && top.host.process !== "own") {
    f.error("plugin", "host_programs_own_process", ["host", "programs"], "a host half that runs programs runs in a process of its own: add `\"process\": \"own\"` beside it");
  }
  // The OK card that says so is the top plugin's: a child's host may not run programs.
  if (isChild && isObject(top.host) && top.host.programs === true) {
    f.error("plugin", "host_programs_top_only", ["host", "programs"], "only a top-level plugin's host runs programs; move it to the top plugin");
  }
  // P5: programs and folders of the user's outside the sandbox, each named (the OK card lists them).
  const outsideField = isObject(top.host) && isObject(top.host.outside) ? top.host.outside : undefined;
  if (outsideField !== undefined && isChild) {
    f.error("plugin", "outside_top_only", ["host", "outside"], "only a top-level plugin names programs and folders outside its sandbox; move it to the top plugin");
  }
  // Its own process: the folders it reads go in that process's fence alone, never a shared one's.
  if (outsideField !== undefined && isObject(top.host) && top.host.process !== "own") {
    f.error("plugin", "outside_own_process", ["host", "outside"], "a host half that names programs or folders outside its sandbox runs in a process of its own: add `\"process\": \"own\"` beside it");
  }
  if (outsideField !== undefined) {
    (Array.isArray(outsideField.programs) ? outsideField.programs as unknown[] : []).forEach((p, i) => {
      if (typeof p !== "string" || !outsideProgramOk(p)) f.error("plugin", "outside_program_invalid", ["host", "outside", "programs", i], `"${String(p)}" isn't a program: a name found on the PATH (letters, digits, ".", "_", "+", "-") or an absolute path, with no ".."`);
    });
    (Array.isArray(outsideField.read) ? outsideField.read as unknown[] : []).forEach((p, i) => {
      if (typeof p !== "string" || !outsideFolderOk(p)) f.error("plugin", "outside_folder_invalid", ["host", "outside", "read", i], `"${String(p)}" isn't a folder it may read: "~/" and a folder, or an absolute path below the disk's top folders (not "/Users" or "/Volumes" themselves, nothing under "/System"), with no ".."; never the whole home or the whole disk`);
    });
  }

  // A built plugin (`built: true`) names JavaScript modules only: TypeScript would mean the build didn't run.
  if (top.built === true && opts.bundled !== true) {
    f.error("plugin", "built_not_bundled", ["built"], "only the plugins Clover ships are built by its release; this plugin can't say it is");
  }
  if (top.built === true) {
    const js = (p: unknown) => typeof p !== "string" || /\.(?:js|mjs)$/.test(p);
    if (isObject(top.host) && !js(top.host.entry)) f.error("plugin", "built_entry", ["host", "entry"], `a built plugin's host entry is a .js module, not "${String(top.host.entry)}"`);
    if (isObject(top.client) && !js(top.client.entry)) f.error("plugin", "built_entry", ["client", "entry"], `a built plugin's client entry is a .js module, not "${String(top.client.entry)}"`);
  }

  // Paths stay inside the folder (§5.9), lexically.
  const refusedPaths = new Set<string>();
  for (const p of collectPaths(raw)) {
    const problem = manifestPathProblem(p.value, p.glob);
    if (problem) {
      f.error(p.refuses, "path_escape", p.path, `"${p.value}" has ${problem}; paths are relative to the plugin folder, with /`);
      refusedPaths.add(jsonPointer(p.path));
    }
  }

  const endpointSettings = new Set(isObject(top.settings) ? Object.keys(top.settings) : []);
  // A model's endpoint may name the plugin's settings, never its secrets (lane A's ask, §5.9 `Model.endpoint`). Its
  // scheme and authority are written out: no userinfo, and a host that takes labels from settings follows a declared
  // `network:` host's rule (whole labels, the last two fixed, never under a shared-hosting suffix) and is one of them
  // (#187's review), so the plugin's key reaches only the hosts its OK names.
  const settingNetworkHosts = new Set(capabilities.filter((c) => c.startsWith("network:") && c.includes("${")).map((c) => c.slice("network:".length)));
  (isObject(rawContributes) && Array.isArray(rawContributes.models) ? rawContributes.models : []).forEach((model: unknown, i: number) => {
    const url = isObject(model) && isObject(model.endpoint) ? model.endpoint.baseUrl : undefined;
    if (typeof url !== "string") return;
    const at: Seg[] = ["contributes", "models", i, "endpoint", "baseUrl"];
    // Every finding here refuses the model entry: it leaves the cleaned manifest (#187's check 2).
    const refuse = (code: string, message: string) => {
      f.error("entry", code, at, message);
      refusedPaths.add(jsonPointer(at));
    };
    const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1];
    if (authority === undefined) return void refuse("endpoint_host", "an endpoint starts with its scheme and host, `https://<host>/…`");
    if (authority.includes("@")) return void refuse("endpoint_host", "an endpoint's URL has no user name or password in it");
    if (!url.includes("${")) return;
    const parsed = parseInterpolation(url);
    if (!parsed.ok) return void refuse("interpolation", parsed.error);
    for (const part of parsed.parts) {
      if (part.kind === "text") continue;
      if (part.kind !== "setting") refuse("interpolation", "an endpoint names only the plugin's settings, `${setting:<key>}`");
      else if (!endpointSettings.has(part.key)) refuse("interpolation", `\${setting:${part.key}} names no setting of this plugin`);
    }
    if (!authority.includes("${")) return;
    if (parseSettingHost(authority) === null) {
      return void refuse("endpoint_host", "a host from the plugin's settings takes whole labels, keeps its last two labels fixed, and is never under a shared-hosting suffix");
    }
    if (!settingNetworkHosts.has(authority)) {
      refuse("endpoint_host", `the endpoint's host ${authority} isn't one of the plugin's \`network:\` hosts`);
    }
  });

  // contributes, key by key.
  const hasHost = isObject(top.host);
  const hasClient = isObject(top.client);
  const isBot = isObject(rawContributes) && rawContributes.bot !== undefined;
  const botName = isBot && isObject(rawContributes.bot)
    ? (typeof rawContributes.bot.name === "string" ? rawContributes.bot.name : isObject(rawContributes.bot.name) && typeof rawContributes.bot.name.en === "string" ? rawContributes.bot.name.en : undefined)
    : undefined;
  const kept: Record<string, unknown> = {};
  const declared: DeclaredPoint[] = [];
  const seenDecl = new Map<string, string>();
  if (isObject(top.host)) checkDeclares(f, topId, top.host.declares, ["host"], {}, "plugin", seenDecl, declared);

  const refusedPathUnder = (at: Seg[]) => {
    const prefix = jsonPointer(at);
    for (const p of refusedPaths) if (p === prefix || p.startsWith(`${prefix}/`)) return true;
    return false;
  };

  if (rawContributes !== undefined && !isObject(rawContributes)) {
    f.error("plugin", "schema", ["contributes"], "`contributes` must be an object");
  } else if (isObject(rawContributes)) {
    for (const [key, value] of Object.entries(rawContributes)) {
      const at: Seg[] = ["contributes", key];
      if ((CORE_CONTRIBUTION_KEYS as string[]).includes(key)) {
        const result = checkCoreContribution(f, key as CoreContributionKey, value, at, { hasHost, hasClient, isBot, botName, topId, capabilities, id, namespace, bundled: opts.bundled === true, seenDecl, declared, refusedPathUnder });
        if (result !== undefined) kept[key] = result;
      } else if (DOTTED_POINT_NAME_RE.test(key)) {
        const result = checkPluginPointValue(f, key, value, at, { hasHost });
        if (result !== undefined) kept[key] = result;
      } else {
        f.error("contribution", "unknown_contribution", at, `"${key}" is no point; a point another plugin declares has a dot in its name`);
      }
    }
  }

  // A bot's theme is one of this plugin's own themes (§5.9); a typo never refuses the bot, whose tab then uses the
  // base theme.
  if (isObject(kept.bot) && typeof kept.bot.theme === "string") {
    const themes = Array.isArray(kept.themes) ? (kept.themes as { id: string }[]).map((t) => t.id) : [];
    if (!themes.includes(kept.bot.theme)) f.warn("theme_ref", ["contributes", "bot", "theme"], `"${kept.bot.theme}" is none of this plugin's themes; the tab uses the base theme`);
  }

  // A bot's voice was once set here: an older bot still loads, the field ignored (a plugin gives its bot a default voice
  // on Clover Voice's point instead).
  if (isObject(kept.bot) && kept.bot.voice !== undefined) {
    f.warn("bot_voice", ["contributes", "bot", "voice"], "a bot's voice is no longer set here and this is ignored; give your bot a default voice with `clover.voice.defaults` (Clover Voice's point), which the user's own choice overrides");
    delete (kept.bot as Record<string, unknown>).voice;
  }

  // Tool names are unique within a top-level plugin and contain no `__` (§5.9, §6.7).
  const toolNames: string[] = [];
  if (isObject(kept.mcpServers) && namespace !== undefined) {
    const seenTools = new Map<string, string>();
    for (const [server, s] of Object.entries(kept.mcpServers)) {
      if (!isObject(s) || !isObject(s.tools)) continue;
      for (const tool of Object.keys(s.tools)) {
        if (tool === "*") continue;
        const wire = toolWireName(namespace, tool);
        if (seenTools.has(wire)) f.error("plugin", "tool_duplicate", ["contributes", "mcpServers", server, "tools", tool], `${wire} is also a tool of ${seenTools.get(wire)}`);
        else seenTools.set(wire, server);
        toolNames.push(wire);
      }
    }
  }

  const contributes = kept as NonNullable<Manifest["contributes"]>;
  const manifestOut = { ...(topParsed.success ? topParsed.data : (top as Record<string, unknown>)), ...(rawContributes !== undefined ? { contributes } : {}) } as Manifest;
  const klass = classify(manifestOut);

  // engines.clover is required when the plugin has code, and must take in this app's plugin API (§5.1).
  const engines = isObject(top.engines) && typeof top.engines.clover === "string" ? top.engines.clover : undefined;
  const apiVersion = opts.apiVersion ?? PLUGIN_API_VERSION;
  if (engines === undefined) {
    if (klass === "code") f.error("plugin", "engines_missing", ["engines"], "a plugin with code needs `engines.clover`, the plugin-API range it was written for");
  } else if (!isRange(engines)) {
    f.error("plugin", "engines_range", ["engines", "clover"], `"${engines}" is not a semver range`);
  } else if (!satisfies(apiVersion, engines)) {
    f.error("plugin", "engines_excludes_api", ["engines", "clover"], `needs plugin API ${engines}; this Clover has ${apiVersion}`);
  }
  if (top.platforms !== undefined && klass !== "code") f.warn("platforms_no_code", ["platforms"], "`platforms` limits where code runs, and this plugin has none");

  const hosts = new Set<string>();
  let dynamicHosts = false;
  const settingKeys = new Set(isObject(top.settings) ? Object.keys(top.settings) : []);
  capabilities.forEach((c, i) => {
    const p = parseCapability(c);
    if (p?.kind !== "network") return;
    hosts.add(`${p.wildcard ? "*." : ""}${p.host}${p.port !== undefined ? `:${p.port}` : ""}`);
    if (!p.settings) return;
    dynamicHosts = true;
    for (const key of p.settings) if (!settingKeys.has(key)) f.error("plugin", "interpolation", ["capabilities", i], `\${setting:${key}} names no setting of this plugin`);
  });
  // A sign-in the core runs is the clover tree's alone (lane A's ask), at the top level as in entries.
  (Array.isArray(top.auth) ? top.auth : []).forEach((a: unknown, i: number) => {
    if (isObject(a) && a.method === "core" && topId !== BUNDLED_ROOT_PLUGIN) {
      f.error("plugin", "auth_core_bundled_only", ["auth", i, "method"], "a sign-in the core runs is only for the plugins Clover ships");
    }
  });
  for (const url of urlFields(manifestOut)) {
    const h = hostOf(url);
    if (h.dynamic) dynamicHosts = true;
    else if (h.host) hosts.add(h.host);
  }

  const fetchesCode: string[] = [];
  if (isObject(contributes.mcpServers)) {
    for (const s of Object.values(contributes.mcpServers)) {
      if (s.type === "stdio" && typeof s.command === "string" && fetchesCodeAtRunTime(s.command, s.args ?? [])) {
        fetchesCode.push([s.command, ...(s.args ?? [])].join(" "));
      }
    }
  }

  const readOnlyTools: { server: string; tools: string[]; network: boolean }[] = [];
  const containedTools: { server: string; tools: string[]; network: boolean }[] = [];
  const webTools: { server: string; search: string[]; fetch: string[]; browser?: string[] }[] = [];
  if (isObject(contributes.mcpServers)) {
    for (const [name, s] of Object.entries(contributes.mcpServers)) {
      if (Array.isArray(s.readOnly) && s.readOnly.length > 0) readOnlyTools.push({ server: name, tools: [...new Set(s.readOnly as string[])].sort(), network: serverReachesNetwork(s) });
      if (Array.isArray(s.contained) && s.contained.length > 0) containedTools.push({ server: name, tools: [...new Set(s.contained as string[])].sort(), network: serverReachesNetwork(s) });
      // One tool, one class: a tool both lists name is neither.
      const both = Array.isArray(s.readOnly) && Array.isArray(s.contained) ? (s.contained as string[]).filter((t) => (s.readOnly as string[]).includes(t)) : [];
      if (both.length > 0) f.error("plugin", "tool_in_both_lists", ["contributes", "mcpServers", name, "contained"], `${[...new Set(both)].sort().join(", ")} can't be both read-only and display-only: list each tool in one of them`);
      // The web lists (R1): how the approvals judge a call, named on the card. One tool, one class; a search needs a
      // `network:` capability, a page fetch `network:public` (the core's fetch with its web floors).
      const search = Array.isArray(s.webSearch) ? [...new Set(s.webSearch as string[])].sort() : [];
      const fetch = Array.isArray(s.webFetch) ? [...new Set(s.webFetch as string[])].sort() : [];
      // F5: the Browser tool's class, any plugin's that holds `browser`.
      const browserList = Array.isArray(s.browserTools) ? [...new Set(s.browserTools as string[])].sort() : [];
      if (search.length > 0 || fetch.length > 0 || browserList.length > 0) {
        webTools.push({ server: name, search, fetch, ...(browserList.length > 0 ? { browser: browserList } : {}) });
        const lists = [s.readOnly, s.contained, s.webSearch, s.webFetch, s.browserTools].map((l) => (Array.isArray(l) ? new Set(l as string[]) : new Set<string>()));
        const twice = [...new Set([...search, ...fetch, ...browserList])].filter((t) => lists.filter((l) => l.has(t)).length > 1);
        if (twice.length > 0) f.error("plugin", "tool_in_both_lists", ["contributes", "mcpServers", name], `${twice.join(", ")} can't be on two of readOnly, contained, webSearch, webFetch and browserTools: list each tool in one of them`);
        if (browserList.length > 0 && !capabilities.includes("browser")) f.error("plugin", "browser_tool_no_capability", ["contributes", "mcpServers", name, "browserTools"], `a Browser tool drives the Clover Browser: the plugin needs the browser capability`);
        if (search.length > 0 && !capabilities.some((c) => c.startsWith("network:"))) f.error("plugin", "web_tool_no_network", ["contributes", "mcpServers", name, "webSearch"], `a web search tool needs a network: capability to reach its search service`);
        if (fetch.length > 0 && !capabilities.includes("network:public")) f.error("plugin", "web_tool_no_network", ["contributes", "mcpServers", name, "webFetch"], `a page-fetch tool needs network:public, the core's fetch with its web safeguards`);
      }
      // A tool offered only while the plugin holds a capability: one it declares.
      if (isObject(s.needs)) {
        for (const [tool, cap] of Object.entries(s.needs)) {
          if (typeof cap !== "string" || !capabilities.includes(cap)) f.error("plugin", "tool_needs_undeclared", ["contributes", "mcpServers", name, "needs", tool], `${tool} needs "${String(cap)}", which this plugin doesn't declare in its capabilities`);
        }
      }
    }
  }
  // A list the OK card can't show can't be OK'd: the lines naming both lists' tools fit in READ_ONLY_OK_MAX_LINES card
  // lines together.
  const readOnlyLines = readOnlyTools.reduce((n, r) => n + readOnlyOkLines(r, false).length, 0)
    + containedTools.reduce((n, r) => n + containedOkLines(r, true).length, 0);
  if (readOnlyLines > READ_ONLY_OK_MAX_LINES) {
    f.error("plugin", "read_only_too_long", ["contributes", "mcpServers"], `the read-only and display-only tools would fill ${readOnlyLines} lines of the OK card, and at most ${READ_ONLY_OK_MAX_LINES} lines of ${OK_LINE_MAX.toLocaleString("en-US")} characters fit: list fewer or shorter names`);
  }

  const envSecrets: string[] = [];
  if (isObject(contributes.mcpServers)) {
    for (const [name, s] of Object.entries(contributes.mcpServers)) {
      if (s.type === "stdio" && isObject(s.env) && Object.values(s.env).some((v) => typeof v === "string" && v.includes("${secret:"))) envSecrets.push(name);
    }
  }

  const ownPrograms = isObject(top.helper)
    || (isObject(contributes.mcpServers) && Object.values(contributes.mcpServers).some((s) => s.type === "stdio"));
  const hostPrograms = !isChild && isObject(top.host) && top.host.programs === true && top.host.process === "own";
  const outside = {
    programs: [...new Set(outsideField !== undefined && Array.isArray(outsideField.programs) ? (outsideField.programs as unknown[]).filter((p): p is string => typeof p === "string") : [])],
    read: [...new Set(outsideField !== undefined && Array.isArray(outsideField.read) ? (outsideField.read as unknown[]).filter((p): p is string => typeof p === "string") : [])],
  };
  const ok = !f.refusesPlugin();
  return {
    ok,
    id,
    namespace,
    manifest: ok ? manifestOut : undefined,
    class: klass,
    contributions: Object.entries(kept).map(([point, v]) => ({ point, entries: Array.isArray(v) ? v.length : isObject(v) && point === "mcpServers" ? Object.keys(v).length : 1 })),
    declares: declared,
    networkHosts: [...hosts].sort(),
    dynamicHosts,
    helperPermissions: isObject(top.helper) && Array.isArray(top.helper.permissions) ? (top.helper.permissions as string[]) : [],
    capabilities,
    toolNames,
    settings: isObject(top.settings) ? Object.keys(top.settings) : [],
    fetchesCode,
    readOnlyTools,
    containedTools,
    webTools,
    envSecrets,
    ownPrograms,
    hostPrograms,
    outside,
    addons: top.addons !== undefined,
    adult: top.adult === true,
    bot: kept.bot !== undefined,
    restylesCards: capabilities.includes("approvals"),
    issues: f.list,
  };
}

/** The longest key an MCP server is served under (the registry's `SERVER_KEY_MAX`). */
export const MCP_SERVER_KEY_MAX = 64;

/** The key the registry serves a plugin's MCP server under: a bundled plugin's server keeps its own name; any other's
 *  is `<plugin id with its "/" as "-">-<name>`. The registry refuses a server whose name isn't a namespace
 *  (`NAMESPACE_RE`, so never `__`) or whose key is over `MCP_SERVER_KEY_MAX` characters. */
export function mcpServerKey(pluginId: string, name: string, bundled: boolean): string {
  return bundled ? name : `${pluginId.replace("/", "-")}-${name}`;
}

/** At author time, what the registry would refuse at install: a server name that isn't a namespace, or a key over 64
 *  characters. Unknown until the plugin's id is (a child validated without its folder's name). */
function checkServerKey(f: Findings, name: string, at: Seg[], ctx: CoreCtx): boolean {
  if (!NAMESPACE_RE.test(name)) {
    f.error("entry", "server_name", at, `"${name}" can't name a served server: use lower-case letters and digits joined by single hyphens`);
    return false;
  }
  if (ctx.id === undefined) return true;
  const key = mcpServerKey(ctx.id, name, ctx.bundled);
  if (key.length > MCP_SERVER_KEY_MAX) {
    f.error("entry", "server_key_long", at, `the server is served as "${key}", ${key.length} characters; a server key is at most ${MCP_SERVER_KEY_MAX}, so shorten the server's name`);
    return false;
  }
  return true;
}

interface CoreCtx {
  hasHost: boolean;
  hasClient: boolean;
  /** It holds a bot (`contributes.bot`): what it adds is inside the bot unless it says `"app": true` (§5.5). */
  isBot: boolean;
  /** The bot's name, for the refusals' words. */
  botName?: string | undefined;
  topId: string | undefined;
  /** This manifest's own capabilities (`window` fields and `app.tray` ask for some). */
  capabilities: readonly string[];
  id: string | undefined;
  /** The plugin's namespace (its top-level plugin's, for a child). */
  namespace: string | undefined;
  /** One of the app's own plugins (`ValidateOptions.bundled`): its MCP servers keep their names as their keys. */
  bundled: boolean;
  seenDecl: Map<string, string>;
  declared: DeclaredPoint[];
  refusedPathUnder(at: Seg[]): boolean;
}

const LIST_KEYS = new Set<CoreContributionKey>([
  "models", "skills", "agents", "agentBackends", "hooks", "commands", "triggers", "computerProviders",
  "relays", "notifiers", "companions", "themes", "locales", "ui",
  "turns",
]);

/** The field each list point's entries are unique by within one plugin (§5.1 "Entry ids"). */
const UNIQUE_BY: Partial<Record<CoreContributionKey, string>> = {
  models: "provider", agentBackends: "id", hooks: "id", commands: "name", triggers: "type",
  computerProviders: "id", relays: "id", notifiers: "id", companions: "id", themes: "id", locales: "lang",
  turns: "name",
};

function entrySchemaOf(key: CoreContributionKey): z.ZodType {
  const s = CORE_CONTRIBUTION_SCHEMAS[key] as unknown as { element?: z.ZodType; valueType?: z.ZodType };
  if (LIST_KEYS.has(key)) return (CORE_CONTRIBUTION_SCHEMAS[key] as unknown as z.ZodArray<z.ZodType>).element;
  if (key === "mcpServers") return (s as unknown as z.ZodRecord<z.ZodString, z.ZodType>).valueType;
  return CORE_CONTRIBUTION_SCHEMAS[key] as z.ZodType;
}

function checkCoreContribution(f: Findings, key: CoreContributionKey, value: unknown, at: Seg[], ctx: CoreCtx): unknown {
  if (LIST_KEYS.has(key)) {
    if (!Array.isArray(value)) {
      f.error("contribution", "schema", at, `\`${key}\` is a list`);
      return undefined;
    }
    const entrySchema = entrySchemaOf(key);
    const out: unknown[] = [];
    const unique = UNIQUE_BY[key];
    const seen = new Map<string, number>();
    const uiIds = new Map<string, number>();
    let backgrounds = 0;
    value.forEach((entry, i) => {
      const eat = [...at, i];
      const parsed = entrySchema.safeParse(entry);
      if (!parsed.success) {
        schemaFindings(f, "entry", parsed.error, eat);
        return;
      }
      if (ctx.refusedPathUnder(eat)) return;
      const e = parsed.data as Record<string, unknown>;
      if (unique && typeof e[unique] === "string") {
        const k = e[unique] as string;
        if (seen.has(k)) {
          f.error("entry", "entry_duplicate", [...eat, unique], `"${k}" is also ${key}[${seen.get(k)}]'s ${unique}`);
          return;
        }
        seen.set(k, i);
      }
      if (key === "agents" && isObject(e) && typeof e.id === "string") {
        if (seen.has(e.id)) {
          f.error("entry", "entry_duplicate", [...eat, "id"], `"${e.id}" is also agents[${seen.get(e.id)}]'s id`);
          return;
        }
        seen.set(e.id, i);
      }
      if (!checkEntry(f, key, e, eat, ctx)) return;
      if (key === "ui") {
        const spot = e.spot as string;
        const uid = `${spot}\u0000${(e.id as string | undefined) ?? spot}`;
        if (uiIds.has(uid)) {
          f.error("entry", "ui_id_required", [...eat, "id"], `this plugin fills "${spot}" twice; give each entry its own \`id\``);
          return;
        }
        uiIds.set(uid, i);
        if (spot === "app.background" && e.hide !== true && ++backgrounds > BACKGROUND_PARTS_MAX) {
          f.error("entry", "ui_background_cap", eat, `a plugin may keep at most ${BACKGROUND_PARTS_MAX} parts running in the background (\`app.background\`)`);
          return;
        }
      }
      if (isObject(e)) checkDeclares(f, ctx.topId, e.declares, eat, key === "ui" ? { ui: e } : {}, "entry", ctx.seenDecl, ctx.declared);
      out.push(parsed.data);
    });
    return out;
  }
  if (key === "mcpServers") {
    if (!isObject(value)) {
      f.error("contribution", "schema", at, "`mcpServers` is an object of servers by name");
      return undefined;
    }
    const entrySchema = entrySchemaOf(key);
    const out: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(value)) {
      const eat = [...at, name];
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        f.error("entry", "server_name", eat, `"${name}" is not a server name (letters, digits, _ and -)`);
        continue;
      }
      const parsed = entrySchema.safeParse(server);
      if (!parsed.success) {
        schemaFindings(f, "entry", parsed.error, eat);
        continue;
      }
      if (ctx.refusedPathUnder(eat)) continue;
      const s = parsed.data as Record<string, unknown>;
      if (!checkServerKey(f, name, eat, ctx)) continue;
      if (!checkEntry(f, key, s, eat, ctx)) continue;
      checkDeclares(f, ctx.topId, s.declares, eat, {}, "entry", ctx.seenDecl, ctx.declared);
      out[name] = s;
    }
    return out;
  }
  // `bot` and `computer`: one per plugin.
  const parsed = (CORE_CONTRIBUTION_SCHEMAS[key] as z.ZodType).safeParse(value);
  if (!parsed.success) {
    schemaFindings(f, "contribution", parsed.error, at);
    return undefined;
  }
  if (ctx.refusedPathUnder(at)) return undefined;
  const e = parsed.data as Record<string, unknown>;
  checkDeclares(f, ctx.topId, e.declares, at, {}, "contribution", ctx.seenDecl, ctx.declared);
  return parsed.data;
}

/** The checks an entry's schema can't make: fields that go together, handlers that need host code, interpolation,
 *  and a bot plugin's limits. False refuses the entry. */
function checkEntry(f: Findings, key: CoreContributionKey, e: Record<string, unknown>, at: Seg[], ctx: CoreCtx): boolean {
  const needHost = (field: string): boolean => {
    if (typeof e[field] === "string" && !ctx.hasHost) {
      f.error("entry", "handler_needs_host", [...at, field], `\`${field}\` names an export of \`host.entry\`, and the plugin has no \`host\``);
      return false;
    }
    return true;
  };
  switch (key) {
    case "models": {
      const hasEndpoint = e.endpoint !== undefined;
      const hasAdapter = e.adapter !== undefined;
      if (hasEndpoint === hasAdapter) {
        f.error("entry", "model_endpoint_or_adapter", at, "a model has either a compatible `endpoint` (data) or an `adapter` (code), not both or neither");
        return false;
      }
      if (!needHost("adapter")) return false;
      return checkAuthHandlers(f, e.auth, [...at, "auth"], ctx);
    }
    case "mcpServers": {
      const type = e.type as string;
      const forbidden: Record<string, string[]> = {
        stdio: ["url", "headers", "perComputer"],
        http: ["command", "args", "env", "perComputer"],
        host: ["command", "args", "env", "url", "headers"],
      };
      for (const field of forbidden[type] ?? []) {
        if (e[field] !== undefined) {
          f.error("entry", "server_fields", [...at, field], `a \`${type}\` server has no \`${field}\``);
          return false;
        }
      }
      if (type === "stdio" && e.command === undefined) {
        f.error("entry", "server_fields", at, "a `stdio` server needs a `command`");
        return false;
      }
      if (type === "http" && e.url === undefined) {
        f.error("entry", "server_fields", at, "an `http` server needs a `url`");
        return false;
      }
      if (type === "host" && !ctx.hasHost) {
        f.error("entry", "handler_needs_host", at, "a `host` server is served by the plugin's own code, and the plugin has no `host`");
        return false;
      }
      if (isObject(e.env)) {
        const reserved = Object.keys(e.env).filter((k) => RESERVED_ENV.test(k)).sort();
        if (reserved.length > 0) {
          f.error("entry", "reserved_env", [...at, "env", reserved[0]!], `a server's \`env\` never sets ${reserved.join(", ")}: Clover sets its own \`CLOVER_*\` names, and what changes how Bun, Node or the loader loads code (\`BUN_*\`, \`NODE_*\` but \`NODE_ENV\` and \`NODE_NO_WARNINGS\`, \`LD_*\`, \`DYLD_*\`) isn't a plugin's`);
          return false;
        }
      }
      if (isObject(e.tools)) {
        for (const tool of Object.keys(e.tools)) {
          if (!isToolKey(tool)) {
            f.error("entry", "tool_name", [...at, "tools", tool], `"${tool}" is not a tool name (letters, digits, _, - and ., never __)`);
            return false;
          }
        }
      }
      let ok = checkInterpolated(f, [...at, "command"], e.command, false) && checkInterpolated(f, [...at, "url"], e.url, false);
      const stdio = e.type === "stdio";
      if (Array.isArray(e.args)) e.args.forEach((a, i) => { ok = checkInterpolated(f, [...at, "args", i], a, false, stdio) && ok; });
      if (isObject(e.env)) for (const [k, v] of Object.entries(e.env)) ok = checkInterpolated(f, [...at, "env", k], v, true, stdio) && ok;
      if (isObject(e.headers)) for (const [k, v] of Object.entries(e.headers)) ok = checkInterpolated(f, [...at, "headers", k], v, true) && ok;
      return ok;
    }
    case "agentBackends": {
      if (e.protocol === "acp" && e.command === undefined) {
        f.error("entry", "agent_backend_command", at, "an ACP backend names the agent's `command`");
        return false;
      }
      if (e.protocol === "cloud" && e.handler === undefined) {
        f.error("entry", "agent_backend_command", at, "a cloud backend names a `handler` that speaks the vendor's API");
        return false;
      }
      if (!needHost("handler")) return false;
      let ok = checkInterpolated(f, [...at, "command"], e.command, false);
      if (Array.isArray(e.args)) e.args.forEach((a, i) => { ok = checkInterpolated(f, [...at, "args", i], a, false) && ok; });
      return ok;
    }
    case "hooks": {
      if ((e.handler === undefined) === (e.command === undefined)) {
        f.error("entry", "hook_handler_or_command", at, "a hook has either a `handler` or a `command`");
        return false;
      }
      if (!needHost("handler")) return false;
      const on = (e.on as HookEvent[]) ?? [];
      if (e.tools !== undefined && !on.some((ev) => TOOL_HOOK_EVENTS.includes(ev))) {
        f.warn("hook_tools_event", [...at, "tools"], "`tools` filters only `tool.before` and `tool.after`");
      }
      let ok = checkInterpolated(f, [...at, "command"], e.command, false);
      if (Array.isArray(e.args)) e.args.forEach((a, i) => { ok = checkInterpolated(f, [...at, "args", i], a, false) && ok; });
      // Its stdin is its input, which a web page or pasted text can fill: never a script (`hook-command.ts`).
      if (typeof e.command === "string") {
        const why = hookReadsStdinAsScript(e.command, Array.isArray(e.args) ? (e.args as string[]) : undefined);
        if (why !== undefined) {
          f.error("entry", "hook_reads_stdin", [...at, "command"], `${why}: a hook's stdin is its input (tool results, prompts, pasted text), never a script; give it a script file or \`-c\``);
          ok = false;
        }
      }
      return ok;
    }
    case "commands": {
      // A held key binding (`hold`) is a key's: it needs `key`, never a text-editing one, and it runs only from its key, so no args.
      if (e.hold === true && e.key === undefined) {
        f.error("entry", "hold_without_key", [...at, "hold"], "`hold` asks for a key's release as well as its press: give the command a `key`");
        return false;
      }
      if (e.hold === true && e.args !== undefined) {
        f.error("entry", "hold_args", [...at, "args"], "a held key's command declares no `args`: it runs only from its key, and its handler gets `{ key: \"down\" }` on the press, `{ key: \"up\" }` on the release and `{ key: \"cancel\" }` when it ended with none");
        return false;
      }
      if (e.hold === true && typeof e.key === "string" && TEXT_EDITING_KEYS.has(e.key.split("+").pop() ?? "")) {
        f.error("entry", "hold_editing_key", [...at, "key"], `\`hold\` can't take ${e.key}: its key edits text where you type (the arrows, Home, End, Backspace, Delete, Enter and Tab), so holding it in the message box would count as the binding's presses; pick another key`);
        return false;
      }
      // A command's args schema in the subset `command.run` enforces (F-M3's review N4), or it takes no call.
      if (e.args !== undefined) {
        const schema = checkArgsSchema(e.args);
        if (!schema.ok) {
          f.error("entry", "args_schema", [...at, "args", ...schema.path.split("/").slice(1).map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))], `the args schema uses \`${schema.keyword}\`, which commands don't take or isn't well formed`);
          return false;
        }
      }
      return needHost("handler");
    }
    case "triggers":
      // `schedule` and `webhook` are the core's own types, and `webhook` working at all is read from the bundled
      // trigger's entry: a plugin outside the bundled tree can't contribute either (as Clover's reserved UI entries).
      if ((e.type === "schedule" || e.type === "webhook") && ctx.topId !== BUNDLED_ROOT_PLUGIN) {
        f.error("entry", "trigger_reserved", [...at, "type"], `the "${e.type}" trigger is Clover's own`);
        return false;
      }
      return needHost("handler");
    case "relays":
    case "notifiers":
    case "companions":
      return needHost("handler");
    case "computerProviders":
      return needHost("handler") && checkAuthHandlers(f, e.auth, [...at, "auth"], ctx);
    case "ui":
      return checkUi(f, e, at, ctx);
    default:
      return true;
  }
}

function checkAuthHandlers(f: Findings, auth: unknown, at: Seg[], ctx: CoreCtx): boolean {
  if (!Array.isArray(auth)) return true;
  for (let i = 0; i < auth.length; i++) {
    const a = auth[i];
    if (isObject(a) && a.method === "custom" && !ctx.hasHost) {
      f.error("entry", "handler_needs_host", [...at, i, "handler"], "a `custom` sign-in names an export of `host.entry`, and the plugin has no `host`");
      return false;
    }
    if (isObject(a) && a.method === "core" && ctx.topId !== BUNDLED_ROOT_PLUGIN) {
      f.error("entry", "auth_core_bundled_only", [...at, i, "method"], "a sign-in the core runs is only for the plugins Clover ships");
      return false;
    }
  }
  return true;
}

function checkUi(f: Findings, e: Record<string, unknown>, at: Seg[], ctx: CoreCtx): boolean {
  const kinds = ["component", "web", "style", "hide", "layout"].filter((k) => (k === "hide" ? e.hide === true : e[k] !== undefined));
  // A message action is data: the conversation draws the button, and a press runs a handler of the plugin's host half.
  const actionOnly = e.spot === "conversation.message.action" && kinds.length === 0;
  if (actionOnly && !ctx.hasHost) {
    f.error("entry", "message_action_needs_host", [...at, "call"], "a message action runs a handler in the plugin's `ui` table, and the plugin has no `host`");
    return false;
  }
  if (e.spot === "conversation.message.action" && kinds.length !== 0) {
    f.error("entry", "message_action_data", at, "a message action is data the conversation draws: `title`, `icon`, `call` and `on`, with no `component`, `web`, `style`, `layout` or `hide`");
    return false;
  }
  // A pill target is data too: the Dispatch pill draws its row from `title`, and the user's words go to `handler`.
  const targetOnly = e.spot === "pill.target" && typeof e.handler === "string" && kinds.length === 0;
  // A tray line is data as well: its `title` is the line, `toggles` or `command` what it does.
  const trayOnly = e.spot === "app.tray" && kinds.length === 0;
  if (kinds.length !== 1 && !actionOnly && !targetOnly && !trayOnly) {
    f.error("entry", "ui_one_of", at, "a `ui` entry has exactly one of `component`, `web`, `style`, `layout` or `hide: true`");
    return false;
  }
  // A layout patch for bots' tabs: on `bot.tab`, its bots by `when.bot` (none: every bot the plugin dresses).
  if (e.layout !== undefined && e.spot !== "bot.tab") {
    f.error("entry", "ui_layout_spot", [...at, "spot"], "a `layout` entry rearranges bots' tabs: its spot is `bot.tab`, its bots `when.bot`");
    return false;
  }
  if (e.layout !== undefined && e.key !== undefined) {
    f.error("entry", "ui_layout_spot", [...at, "key"], "a `layout` entry names its bots with `when.bot`, not `key`");
    return false;
  }
  if (e.component !== undefined && !ctx.hasClient) {
    f.error("entry", "component_needs_client", [...at, "component"], "`component` names an export of `client.entry`, and the plugin has no `client`");
    return false;
  }
  if (isObject(e.web) && (e.web.url === undefined) === (e.web.entry === undefined)) {
    f.error("entry", "ui_web", [...at, "web"], "a web view shows either a `url` or a page in the folder (`entry`)");
    return false;
  }
  const spotName = e.spot as string;
  const spot = spotInfo(spotName);
  if (e.target !== undefined && e.hide !== true) {
    f.error("entry", "ui_target", [...at, "target"], "`target` names the entry a `hide` takes out of a list spot; this entry hides nothing");
    return false;
  }
  if (e.hide === true && spot?.shape === "list" && e.target === undefined) f.warn("ui_hide_list", [...at, "hide"], `"${spotName}" is a list: a \`hide\` there names the entry it takes out (\`target\`), and without one it hides nothing`);
  if (e.hide === true && spot !== undefined && spot.shape !== "list" && e.target !== undefined) f.warn("ui_target", [...at, "target"], `"${spotName}" shows one entry${spot.shape === "keyed" ? " per key" : ""}; a \`hide\` there hides it, and \`target\` is ignored`);
  if (spotName === "app.background" && e.hide !== true && e.component === undefined) {
    f.error("entry", "ui_background_component", [...at, "component"], "a background part is a `component` of the plugin's client: it has no page of its own to show");
    return false;
  }
  if (e.window !== undefined && spotName !== "app.surface") {
    f.error("entry", "ui_window_not_surface", [...at, "window"], "`window` is for `app.surface` entries");
    return false;
  }
  const bundledTree = ctx.topId === BUNDLED_ROOT_PLUGIN;
  if (isObject(e.window)) {
    // What a surface may do is what its plugin's OK card says (F4, the owner's ruling of 2026-11-15): no door checks a plugin's id.
    const needs = (field: string, cap: string, why: string): boolean => {
      if (ctx.capabilities.includes(cap)) return true;
      f.error("entry", "ui_window_capability", [...at, "window", field], `${why} needs the \`${cap}\` capability`);
      return false;
    };
    if (e.window.alwaysOnTop === true && !needs("alwaysOnTop", "overlay", "an always-on-top surface")) return false;
    if (e.window.cards === true && !needs("cards", "approvals.all", "a surface that draws the pending cards")) return false;
    if (e.window.cards === true && !ctx.capabilities.includes("approvals")) {
      f.error("entry", "ui_window_capability", [...at, "window", "cards"], "a surface that draws the pending cards needs the `approvals` capability");
      return false;
    }
  }
  if ((e.toggles !== undefined || e.command !== undefined) && spotName !== "app.tray") {
    f.error("entry", "ui_tray_field", [...at, e.toggles !== undefined ? "toggles" : "command"], "`toggles` and `command` are for `app.tray` entries");
    return false;
  }
  if (spotName === "app.tray" && e.hide !== true) {
    if (!ctx.capabilities.includes("tray")) {
      f.error("entry", "ui_window_capability", [...at], "an `app.tray` entry needs the `tray` capability");
      return false;
    }
    if ((e.toggles === undefined) === (e.command === undefined)) {
      f.error("entry", "ui_tray_field", [...at], "an `app.tray` entry has either `toggles` (the id of one of the plugin's own surfaces) or `command` (one of its own commands)");
      return false;
    }
  }
  if (spot?.reserved && !bundledTree) {
    const id = typeof e.id === "string" ? e.id : spotName;
    if (spot.reserved.ids.some((r) => foldTitle(r) === foldTitle(id))) {
      f.error("entry", "ui_reserved", [...at, "id"], `"${id}" is reserved for Clover's own ${spotName} entry`);
      return false;
    }
    if (typeof e.title === "string" && spot.reserved.titles.some((t) => foldTitle(t) === foldTitle(e.title as string))) {
      f.error("entry", "ui_reserved", [...at, "title"], `"${e.title}" is reserved for Clover's own ${spotName} entry`);
      return false;
    }
  }
  // A hide shows nothing, so it carries none of the spot's fields (a title, an icon).
  if (spot && e.hide !== true) {
    const fields = spot.fields.safeParse(e);
    if (!fields.success) {
      schemaFindings(f, "entry", fields.error, at);
      return false;
    }
    if (e.key !== undefined && spot.shape !== "keyed") f.warn("ui_key", [...at, "key"], `"${spotName}" is not keyed; \`key\` is ignored`);
  }
  // A `panel` entry whose key isn't a stock panel's adds a panel of its own (§5.5): it needs a title for its button, and a key that is
  // a plain word (it is part of the panel's id in the window).
  if (spotName === "panel" && e.hide !== true && isOwnPanelKey(typeof e.key === "string" ? e.key : undefined)) {
    const key = e.key as string;
    if (!OWN_PANEL_KEY_RE.test(key)) {
      f.error("entry", "panel_key", [...at, "key"], `A panel's key is lower-case words and digits joined with hyphens (up to 32 characters); "${key}" isn't. A key that is not one of the stock panels' (session, terminal, diff, browser, files, agent) adds a panel.`);
      return false;
    }
    if ((e.component !== undefined || e.web !== undefined) && e.title === undefined) {
      f.error("entry", "panel_title", [...at, "title"], `The panel "${key}" adds a panel of its own: it needs a \`title\`, which names its button.`);
      return false;
    }
  }
  // Whoever owns a plug sets the rules for what plugs into it (§5.5, the owner's rule of November 14).
  const when = isObject(e.when) ? e.when.bot : undefined;
  const bots = when === undefined ? [] : Array.isArray(when) ? when : [when];
  // The sidebar, Settings and the bots' Edit page look the same on every tab: nothing tied to a bot's tab dresses them,
  // whichever plugin's it is.
  if (SAME_ON_EVERY_TAB.has(spotName) && bots.length > 0) {
    f.error("entry", "bot_tied_not_offered", [...at, "when", "bot"], `"${spotName}" looks the same on every tab: nothing tied to a bot's tab dresses it.`);
    return false;
  }
  // A part kept in the background has no place in a tab: nothing ties it to a bot's.
  if (spotName === "app.background" && bots.length > 0) {
    f.error("entry", "bot_tied_not_offered", [...at, "when", "bot"], `"${spotName}" has no place in a bot's tab: nothing tied to a bot's tab runs there.`);
    return false;
  }
  if (ctx.isBot && e.app !== true) {
    const bot = ctx.botName ?? ctx.id ?? "its bot";
    // Inside the bot: only what Bots offers, on its own tab.
    if (spotName === "bot.editor.section") {
      f.error("entry", "bot_editor_stock", [...at, "spot"], `${bot}'s Edit page keeps its stock look; its settings show there as a section of their own, from the plugin's settings.`);
      return false;
    }
    if (spotName === "panel" && !botsOffer(spotName, typeof e.key === "string" ? e.key : undefined)) {
      const which = typeof e.key === "string" ? `"${e.key}" isn't one of them` : "an entry with no key would fill every panel";
      f.error("entry", "bot_panel_not_offered", [...at, typeof e.key === "string" ? "key" : "spot"], `Bots offers the Browser and agent panels on ${bot}'s tab, and a panel of its own (any other key, with a title); ${which}.`);
      return false;
    }
    // A spot outside the catalog is one a plugin declares (a bot's own component's, inside its tab): judged where it is.
    if (spot !== undefined && !botsOffer(spotName, typeof e.key === "string" ? e.key : undefined)) {
      f.error("entry", "bot_spot_not_offered", [...at, "spot"], `Bots doesn't offer "${spotName}" to ${bot}: a bot's plugin dresses only its own tab (inside it, its top bar, its Browser and agent panels). To show it everywhere, add "app": true; it then gets a switch of its own.`);
      return false;
    }
    if (bots.some((b) => b !== ctx.id)) {
      f.error("entry", "bot_when_other_bot", [...at, "when", "bot"], `"${spotName}" inside ${bot}'s tab is ${bot}'s; dressing other bots' tabs is an app part: add "app": true.`);
      return false;
    }
  }
  return true;
}

/** A dotted `contributes` key: a point another plugin declares (§5.4). A well-known data point's entries are checked
 *  now; any other waits until its point appears, and is checked then. */
function checkPluginPointValue(f: Findings, key: string, value: unknown, at: Seg[], ctx: { hasHost: boolean }): unknown {
  if (CORE_POINT_NAMES.has(key) || SPOT_NAMES.has(key)) {
    f.error("contribution", "fill_spot_through_ui", at, `"${key}" is a UI spot; fill it with a \`ui\` entry`);
    return undefined;
  }
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.every(isObject)) {
    f.error("contribution", "schema", at, "a point's value is an entry object or a list of them");
    return undefined;
  }
  const dp = dataPointInfo(key);
  if (!dp) return value;
  const out: unknown[] = [];
  entries.forEach((entry, i) => {
    const eat = Array.isArray(value) ? [...at, i] : at;
    const parsed = dp.entry.safeParse(entry);
    if (!parsed.success) {
      schemaFindings(f, "entry", parsed.error, eat);
      return;
    }
    const e = parsed.data as Record<string, unknown>;
    if (typeof e.handler === "string" && !ctx.hasHost) {
      f.error("entry", "handler_needs_host", [...eat, "handler"], "`handler` names an export of `host.entry`, and the plugin has no `host`");
      return;
    }
    out.push(parsed.data);
  });
  return Array.isArray(value) ? out : out[0];
}

/** Data, web or code, worked out from the manifest, never declared (§5.3). */
export function classify(m: Manifest): PluginClassName {
  if (m.host || m.client || m.helper) return "code";
  const c = m.contributes ?? {};
  if (Object.values(c.mcpServers ?? {}).some((s) => s.type === "stdio")) return "code";
  if ((c.hooks ?? []).some((h) => h.command !== undefined)) return "code";
  if ((c.agentBackends ?? []).some((b) => b.command !== undefined)) return "code";
  if ((c.ui ?? []).some((u) => u.web !== undefined)) return "web";
  return "data";
}

/** The `url` fields whose hosts count as the plugin's network hosts (§5.3). */
function urlFields(m: Manifest): string[] {
  const out: string[] = [];
  const auth = (list: readonly unknown[] | undefined) => {
    for (const a of list ?? []) if (isObject(a) && a.method === "oauth-pkce") out.push(String(a.authorizeUrl), String(a.tokenUrl));
  };
  auth(m.auth);
  const c = m.contributes ?? {};
  for (const s of Object.values(c.mcpServers ?? {})) if (s.type === "http" && s.url) out.push(s.url);
  for (const model of c.models ?? []) {
    if (model.endpoint) out.push(model.endpoint.baseUrl);
    auth(model.auth);
  }
  for (const p of c.computerProviders ?? []) auth(p.auth);
  for (const u of c.ui ?? []) if (u.web?.url) out.push(u.web.url);
  return out;
}

/** The `network:` grants that name this computer or the local network (`localhost`, `*.local`, a loopback, private or
 *  link-local address), which the OK warns about (#371's review). */
export function localNetworkHosts(capabilities: readonly string[]): string[] {
  const out: string[] = [];
  for (const cap of capabilities) {
    const c = parseCapability(cap);
    if (c?.kind !== "network") continue;
    const h = c.host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
    const a = v4 ? Number(v4[1]) : -1;
    const b = v4 ? Number(v4[2]) : -1;
    const local =
      h === "localhost" || h.endsWith(".localhost") || h === "local" || h.endsWith(".local") ||
      a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ||
      h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith("::ffff:");
    if (local) out.push(c.port !== undefined ? `${c.host}:${c.port}` : c.host);
  }
  return out;
}

/** What a plugin tree's hooks see and can do, for its OK (§5.3, §5.6): a hook is handed the conversation as it
 *  happens, so the OK says which part. One line for the whole tree (the plugin and its children), or none. */
export function hookOkLines(reports: readonly ManifestReport[]): string[] {
  const events = new Set<string>();
  for (const r of reports) {
    const hooks = (r.manifest as { contributes?: { hooks?: unknown } } | undefined)?.contributes?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) for (const e of (h as { on?: unknown }).on instanceof Array ? (h as { on: unknown[] }).on : []) if (typeof e === "string") events.add(e);
  }
  if (events.size === 0) return [];
  // Hooks that all say `own-bot` see only their own bot's sessions (the host holds them to it). A hook without a scope
  // takes its plugin's, else its tree's top plugin's, as the host reads it (`scopeOf`).
  const scopeOf = (r: ManifestReport | undefined) => (r?.manifest as { scope?: unknown } | undefined)?.scope;
  const top = reports.find((r) => r.id !== undefined && !r.id.includes("/"));
  const own = reports.every((r) => {
    const hooks = (r.manifest as { contributes?: { hooks?: unknown } } | undefined)?.contributes?.hooks;
    return !Array.isArray(hooks) || hooks.every((h) => ((h as { scope?: unknown }).scope ?? scopeOf(r) ?? scopeOf(top)) === "own-bot");
  });
  // The events a hook that may change something is on (an `observe` hook only hears them).
  const changes = new Set<string>();
  for (const r of reports) {
    const hooks = (r.manifest as { contributes?: { hooks?: unknown } } | undefined)?.contributes?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) if ((h as { observe?: unknown }).observe !== true) for (const e of (h as { on?: unknown }).on instanceof Array ? (h as { on: unknown[] }).on : []) if (typeof e === "string") changes.add(e);
  }
  const sees: string[] = [];
  if (events.has("message.in")) sees.push("your messages");
  if (events.has("message.out")) sees.push("the bots' replies");
  if (events.has("tool.before")) sees.push("each tool call before it runs");
  if (events.has("tool.after")) sees.push("what each tool returns");
  const can: string[] = [];
  if (changes.has("message.in") || changes.has("message.out")) can.push("change messages");
  if (changes.has("tool.before")) can.push("change or refuse a tool call (never approve one)");
  if (changes.has("tool.after")) can.push("change what a tool returns");
  // An external coding agent's own session is its own: the hooks see only what it asks Clover about (Clover's rule).
  const agents = `Its hooks don't see what a coding agent such as Claude Code or Codex does inside its own session${events.has("tool.before") ? "; they can refuse starting one" : ""}.`;
  if (sees.length === 0) return [own ? "Its hooks run when its own bot's turns start, end or are compacted, and see no other bot." : "Its hooks run when a conversation's turns start, end or are compacted.", agents];
  if (own) return [`Its hooks see only what its own bot does: ${sees.join(", ").replace("your messages", "your messages to it").replace("the bots' replies", "its replies")}${can.length > 0 ? `; they can ${can.join(", ")}` : ""}.`, agents];
  return [`Its hooks see your conversations: ${sees.join(", ")}${can.length > 0 ? `; they can ${can.join(", ")}` : ""}.`, agents];
}

/** The OK card's line for host code that runs without being asked (§5.2): a `host.start`, or `triggers` (which start
 *  at once on each computer), by where it runs. */
/** The OK card's line for a plugin that contributes a notifier: what the core tells it (§10). */
export const NOTIFIER_OK_LINE = "It is told when your bots need you or have answered, so it can notify you; it does not get the words.";

/** The OK card's line for a plugin that can be picked as the Dispatch pill's target (`pill.target`): what the user
 *  sends from the pill to it, it receives. */
export const PILL_TARGET_OK_LINE = "It can be picked as a target in the Dispatch pill: what you then type there goes to it, as your own words, and not to a bot.";

export const HOST_START_OK_LINES = {
  each: "It runs in the background from the moment Clover starts, on every computer it's installed on.",
  main: "It runs in the background from the moment Clover starts, on your main computer.",
  chosen: "It runs in the background from the moment Clover starts, on the computer you add it on.",
} as const;

/** What a plugin tree runs without being asked, for its OK (§5.2, §7): the routine triggers it adds (a routine that
 *  uses one runs when the plugin says so), and where its host code runs in the background. The plugin and its children
 *  together; none for a tree with neither. */
export function backgroundOkLines(reports: readonly ManifestReport[]): string[] {
  const types: string[] = [];
  const where = new Set<keyof typeof HOST_START_OK_LINES>();
  let notifies = false;
  let pillTarget = false;
  for (const r of reports) {
    const m = r.manifest as { host?: { start?: unknown }; contributes?: { triggers?: unknown; notifiers?: unknown } } | undefined;
    if (Array.isArray(m?.contributes?.notifiers) && m.contributes.notifiers.length > 0) notifies = true;
    const ui = (r.manifest as { contributes?: { ui?: unknown } } | undefined)?.contributes?.ui;
    if (Array.isArray(ui) && ui.some((e) => (e as { spot?: unknown } | null)?.spot === "pill.target")) pillTarget = true;
    const triggers = Array.isArray(m?.contributes?.triggers) ? m.contributes.triggers : [];
    for (const t of triggers) if (typeof (t as { type?: unknown }).type === "string") types.push((t as { type: string }).type);
    if (triggers.length > 0) where.add("each");
    const start = m?.host?.start;
    if (start === "each" || start === "main" || start === "chosen") where.add(start);
  }
  const lines: string[] = [];
  if (types.length > 0) lines.push(`It adds routine triggers (${[...new Set(types)].sort().join(", ")}): a routine that uses one runs whenever the plugin says so.`);
  if (notifies) lines.push(NOTIFIER_OK_LINE);
  if (pillTarget) lines.push(PILL_TARGET_OK_LINE);
  for (const w of ["each", "main", "chosen"] as const) if (where.has(w)) lines.push(HOST_START_OK_LINES[w]);
  return lines;
}


/** A point's `fills` line as its declarer wrote it, with who declared it and its title (§5.4): the core's points'
 *  from `CORE_POINTS` (declared by Clover), a plugin's from its declaration. `tree`: the declarer's top-level id (its
 *  own tree's entries get no line). */
export interface FillsDecl { by: string; title: string; ok: string; warns?: boolean; tree?: string; /** The declarer's plugin id (a plugin's point; none for the core's). */ id?: string }
/** The `fills` of a point a plugin declares, as the registry knows it now (undefined: none, or not declared here). */
export type FillsOf = (point: string) => FillsDecl | undefined;

/** The most a `fills` line's parts may run to once made plain. */
export const FILLS_OK_MAX = 300;
const FILLS_NAME_MAX = 80;

/** Text as one plain line: control, line-break, zero-width, direction-mark and direction-override characters to one
 *  space, runs of space to one, trimmed and cut to `max`. A declarer's words are shown as text, never as markup. */
export function plainLine(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** One filler's line for a point with `fills`, attributed to its declarer so it can't pass as Clover's words: a
 *  plugin's point names the declarer by its name and its id (the id alone when the name is empty once made plain). */
export function fillsLine(f: FillsDecl): string {
  const ok = plainLine(f.ok, FILLS_OK_MAX).replace(/[.!?]$/, "");
  const name = plainLine(f.by, FILLS_NAME_MAX);
  const id = f.id === undefined ? "" : plainLine(f.id, FILLS_NAME_MAX);
  const label = id === "" ? `${name}'s` : name === "" || name === id ? `${id}'s` : `${name}'s (${id})`;
  const line = `Fills ${label} "${plainLine(f.title, FILLS_NAME_MAX)}": ${ok}.`;
  return f.warns === true ? `Careful: ${line}` : line;
}

/** The core point's `fills`, from the catalog. */
function coreFills(point: string): FillsDecl | undefined {
  const p = CORE_POINTS.find((x) => x.name === point);
  return p?.fills === undefined ? undefined : { by: "Clover", title: p.title ?? p.name, ok: p.fills.ok, ...(p.fills.warns === true ? { warns: true } : {}) };
}

/** The `fills` lines of a tree's OK card (§5.4, §5.6): one per point with a `fills` line that the tree's plugins fill
 *  (a core point's from the catalog; another plugin's through `declared`), the cautions first. A point the tree
 *  declares itself, and a point with no `fills`, show nothing. */
export function fillsOkLines(reports: readonly ManifestReport[], declared?: FillsOf): string[] {
  const top = reports.find((r) => r.id !== undefined && !r.id.includes("/"))?.id;
  const points = new Set<string>();
  for (const r of reports) for (const c of r.contributions) if (c.entries > 0) points.add(c.point);
  const decls: FillsDecl[] = [];
  for (const point of points) {
    const f = coreFills(point) ?? (point.includes(".") ? declared?.(point) : undefined);
    if (f === undefined || (f.tree !== undefined && top !== undefined && f.tree === top)) continue;
    decls.push(f);
  }
  return [...decls.filter((d) => d.warns === true), ...decls.filter((d) => d.warns !== true)].map(fillsLine);
}

/** A plugin that fills the island's `island.line` point (the owner's ruling, 2026-11-14): the card says it puts words on the
 *  island, so the user has seen that before it can. */
export const ISLAND_LINE_OK_LINE = "It puts a line of text on the island, with its name beside it, in the island's own style, when Clover isn't in front.";
export const BACKGROUND_OK_LINE = "It keeps a part running in the background while Clover is open.";
/** The most `app.background` parts one plugin may have. */
export const BACKGROUND_PARTS_MAX = 2;

/** The OK's text for a plugin, in English (§5.1, §5.6); the app shows it from the built-in tables in the user's
 *  language. One card covers a plugin and its children. */
/** How the OK card names a part beside a bot (`pluginParts`): a `ui` entry by its spot, the rest by their point. */
const BESIDE_LABELS: Readonly<Record<string, string>> = {
  "island.tab": "an island tab", "sidebar.app": "a sidebar button", "settings.section": "a Settings section", main: "an app page",
  status: "the status bar", "app.surface": "a window of its own", "app.background": "a part running in the background", "pill.target": "a Dispatch pill target", sidebar: "the sidebar",
  "sidebar.bot": "the bots' sidebar rows", "bot.editor.section": "a section on bots' Edit pages", panel: "a panel", "panel.view": "a panel",
  "bot.tab": "other bots' tabs", locales: "translations", mcpServers: "tools", skills: "skills", hooks: "hooks",
  agents: "agent definitions", commands: "commands", "island.line": "a line on the island",
};
/** The right panels Bots offers a bot to replace on its tab, as the OK card names them. */
const PANEL_LABELS: Readonly<Record<string, string>> = { browser: "Browser", agent: "agent" };

/** A bot's name as the OK card says it: its `en` text. */
export function botNameOf(manifest: Manifest | undefined): string | undefined {
  const name = (manifest?.contributes?.bot as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? name : isObject(name) && typeof name.en === "string" ? name.en : undefined;
}

/** The OK card's lines for a plugin with a bot (§5.5, the owner's rule of November 14): what of it shows or serves beyond
 *  the bot's tab, with a switch of its own (said once the plugin marks a part `"app": true`), and each right panel it
 *  replaces on its tab. Only the fields that say so add a line, so a plugin in the shape of before keeps the lines its
 *  OK showed. */
export function botPartLines(manifest: Manifest | undefined): string[] {
  if (!holdsBot(manifest)) return [];
  const lines: string[] = [];
  if (marksAppParts(manifest)) {
    const kinds = [...new Set(pluginParts(manifest).beside.map((p) => {
      const label = BESIDE_LABELS[p.kind];
      if (label !== undefined) return label;
      // A spot of bots' tabs, dressed in every bot's tab (or the ones `when.bot` names).
      return SPOT_NAMES.has(p.kind) ? `${p.kind} in bots' tabs` : p.kind;
    }))];
    lines.push(`Everywhere, with a switch of its own: ${kinds.join(", ")}.`);
  }
  const bot = botNameOf(manifest) ?? "its bot";
  const replaced = new Set<string>();
  for (const e of manifest?.contributes?.ui ?? []) {
    const u = e as { spot?: string; key?: string; app?: boolean; component?: unknown; web?: unknown };
    if (u.app === true || u.spot !== "panel" || u.key === undefined || PANEL_LABELS[u.key] === undefined) continue;
    if (u.component === undefined && u.web === undefined) continue;
    replaced.add(u.key);
  }
  for (const key of replaced) lines.push(`It replaces the ${PANEL_LABELS[key]} panel on ${bot}'s tab.`);
  return lines;
}

/** The tab kinds an added panel's `when.session` names, as the OK card says them. */
const PANEL_KIND_WORDS: Readonly<Record<string, string>> = { bot: "bots' tabs", agent: "agents' tabs", "side-thread": "side threads' tabs", coding: "coding sessions" };

/** The OK card's line for each panel a plugin adds (a `panel` entry whose key isn't a stock panel's, §5.5): its title, and where it
 *  shows: on its bot's tab alone when it is inside a bot's plugin, else on the right of every tab of the kinds it names. */
export function ownPanelLines(manifest: Manifest | undefined): string[] {
  const bot = holdsBot(manifest) ? (botNameOf(manifest) ?? "its bot") : undefined;
  const lines: string[] = [];
  for (const e of manifest?.contributes?.ui ?? []) {
    const u = e as { spot?: string; key?: string; app?: boolean; title?: unknown; component?: unknown; web?: unknown; when?: { session?: unknown } };
    if (u.spot !== "panel" || !isOwnPanelKey(u.key) || (u.component === undefined && u.web === undefined)) continue;
    const title = typeof u.title === "string" ? u.title : isObject(u.title) && typeof u.title.en === "string" ? u.title.en : (u.key as string);
    if (bot !== undefined && u.app !== true) {
      lines.push(`It adds a panel, "${title}", to ${bot}'s tab, with a button of its own beside the right panels' buttons.`);
      continue;
    }
    const raw = u.when?.session;
    const kinds = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((k): k is string => typeof k === "string");
    const where = kinds.length === 0 ? "every tab" : kinds.map((k) => PANEL_KIND_WORDS[k] ?? k).join(", ");
    lines.push(`It adds a panel, "${title}", on the right of ${where}, with a button of its own beside the right panels' buttons.`);
  }
  return lines;
}

export function describeOk(
  report: ManifestReport,
  opts: {
    os?: "macos" | "windows" | "linux";
    /** The tree's flag (`TreeReport.restylesCards`). */
    restylesCards?: boolean;
    /** The tree's flag (`TreeReport.restylesWindow`): a theme's `shell` block. */
    restylesWindow?: boolean;
    /** The plugin's host code runs fenced to its network proxy on this computer (macOS with its sandbox on, B-M2's
     *  2g): only then does the OK say host code is held to the list. */
    hostNetworkHeld?: boolean;
    /** Whether this computer runs plugin processes in Clover's sandbox (the plugin fence). `false`: the OK says the
     *  plugin's programs run without it here (#406's review); absent: nothing is said either way. */
    sandboxed?: boolean;
    /** The core's grant to a wrapper the user brought (its install record's `wrapped.network`, the owner's ruling of
     *  2026-11-10): its programs reach any host. Said second, before what it adds, in place of the "reaches no host"
     *  line; the core passes it only while the tree declares no `network:` host. */
    networkOpen?: boolean;
    /** Every capability the plugin's tree declares (its children's too): a `network:` grant anywhere in it means its
     *  servers' read-only tools still ask. Absent: the report's own. */
    treeCapabilities?: readonly string[];
    /** Its install record carries a wrapper's network grant (`wrapped.network`), whatever the tree declares. */
    wrappedNetwork?: boolean;
  } = {},
): string[] {
  const lines: string[] = [];
  const what = report.class === "code" ? "runs code on your computers" : report.class === "web" ? "shows web pages" : "is data only: files, no code";
  lines.push(`${report.id ?? "This plugin"} ${what}.`);
  if (opts.networkOpen === true) lines.push("It can reach any host on the network, including services on this computer and your local network: it's a server you added, which names no hosts, so Clover doesn't hold its programs to a list. They are still fenced from your files.");
  if (report.class === "code" && opts.os && opts.os !== "macos") lines.push("Its code could read Clover's logins and approve its own cards.");
  if (report.contributions.length > 0) lines.push(`It adds: ${report.contributions.map((c) => c.point).join(", ")}.`);
  lines.push(...botPartLines(report.manifest));
  lines.push(...ownPanelLines(report.manifest));
  if (report.contributions.some((c) => c.point === "island.line")) lines.push(ISLAND_LINE_OK_LINE);
  if ((report.manifest?.contributes?.ui ?? []).some((e) => (e as { spot?: string; hide?: boolean }).spot === "app.background" && (e as { hide?: boolean }).hide !== true)) lines.push(BACKGROUND_OK_LINE);
  for (const cap of report.capabilities) {
    if (parseCapability(cap)?.kind === "network") continue;
    const text = capabilityOkText(cap);
    if (text) lines.push(`It ${text}.`);
  }
  if (opts.restylesCards && !report.capabilities.includes("approvals")) lines.push(`It ${capabilityOkText("approvals")}.`);
  // Host code is held to the list only where the fence holds it to its proxy (#371's review: the sandbox there and on,
  // not merely macOS).
  const hostHeld = opts.hostNetworkHeld === true;
  if (opts.restylesWindow) lines.push("It styles the window while its tab shows.");
  if (report.networkHosts.length > 0) {
    const host = report.class !== "code" ? "" : hostHeld ? "; so does its host code" : "; its host code can reach any host";
    lines.push(`Its components reach only ${report.networkHosts.join(", ")}${host}.`);
  } else if (report.class === "code" && opts.networkOpen !== true) lines.push(hostHeld ? "Its code reaches no host." : "Its components reach no host; its host code can reach any host.");
  // Its `network:` grants that are local, and its remote MCP servers whose url is on this computer or the local network
  // (`http://localhost:11434/mcp`): the core's client reaches those for it (the card is the only gate, so it says so).
  const httpLocal = Object.values(report.manifest?.contributes?.mcpServers ?? {}).flatMap((sv) => {
    if (sv.type !== "http" || typeof sv.url !== "string") return [];
    const host = /^https?:\/\/([^/?#]*)/i.exec(sv.url)?.[1]?.replace(/^[^@]*@/, "");
    return host === undefined || host === "" || host.includes("${") ? [] : [`network:${host}`];
  });
  const local = [...new Set(localNetworkHosts([...report.capabilities, ...httpLocal]))];
  if (local.length > 0) lines.push(`It can reach services on this computer or your local network: ${local.join(", ")}.`);
  if (report.dynamicHosts) lines.push("Some of the hosts it reaches come from its settings.");
  // An agent backend is a process the plugin starts for the user (the controller's ruling): named on the card, with its
  // program; adding or changing one asks again on an update.
  // An agent definition is words that steer an agent working with the bot's reach (the controller's fixed point): named
  // on the card, so the user has seen that the plugin brings one; adding or changing one asks again (changes.ts).
  for (const d of agentDefinitionsOf(report.manifest)) lines.push(`It adds an agent definition ${d.name}: instructions an agent follows when your bot hands it work.`);
  for (const b of agentBackendsOf(report.manifest)) lines.push(`It starts the agent backend ${b.name}${b.program !== undefined ? `, running ${b.program}` : b.handler !== undefined ? ", in its host code" : ""}.`);
  for (const cmd of report.fetchesCode) lines.push(`It fetches code when it runs: ${cmd}.`);
  // Lane C's ask: what this card shows is what may run without an approval card at the default level, nothing else.
  // A server that can reach the network gets no skip (`readOnlyReachesNetwork`), and the card says its tools still ask.
  // A plugin that names programs of the user's it runs outside its sandbox (P5) gets no tool that runs without a card:
  // a tool is its own code, which could run them with what a bot hands it. Its card says its tools still ask.
  const runsOutside = (report.outside?.programs.length ?? 0) > 0;
  const treeNet = { capabilities: opts.treeCapabilities ?? report.capabilities, wrappedNetwork: opts.wrappedNetwork === true || opts.networkOpen === true, fenced: opts.sandboxed !== false, runsOutside };
  if (runsOutside) lines.push(...outsideToolsOkLines(report));
  else {
    for (const r of report.readOnlyTools ?? []) lines.push(...readOnlyOkLines(r, readOnlyReachesNetwork(r, treeNet)));
    for (const r of report.containedTools ?? []) lines.push(...containedOkLines(r, containedToolsHold(r, treeNet)));
    for (const w of report.webTools ?? []) lines.push(...webToolOkLines(w));
  }
  if (report.envSecrets.length > 0) {
    lines.push(`Its server${report.envSecrets.length > 1 ? "s" : ""} ${report.envSecrets.join(", ")} get${report.envSecrets.length > 1 ? "" : "s"} your keys in ${report.envSecrets.length > 1 ? "their" : "its"} environment, which other plugins on this ${opts.os === "macos" ? "Mac" : "computer"} could read.`);
  }
  if (report.ownPrograms) lines.push("It runs its own programs, which Clover doesn't confine.");
  // Its host code's programs (`host.programs`): held to its own folder and the user's picks where the fence holds them;
  // elsewhere the line below says they run without the sandbox.
  if (report.hostPrograms === true) lines.push(opts.sandboxed === false ? HOST_PROGRAMS_OK_LINE_UNFENCED : HOST_PROGRAMS_OK_LINE);
  if (opts.sandboxed === false && report.class === "code") lines.push("Its programs run without Clover's sandbox on this computer.");
  lines.push(...outsideOkLines(report.outside ?? { programs: [], read: [] }));
  if (report.addons) lines.push("It loads add-ons of its own, which Clover doesn't check.");
  if (report.adult) lines.push("It may contain adult content.");
  return lines;
}

/** A program a manifest may name outside the sandbox: a bare name found on the PATH, or an absolute path with no `..`. */
export function outsideProgramOk(p: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  if (p.startsWith("/")) return p.length > 1 && !p.split("/").includes("..") && !p.endsWith("/");
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(p);
}

/** A folder a manifest may name to read outside the sandbox: `~/` and a folder, or an absolute path below `/`, with no
 *  `..`; never the whole home or the whole disk. */
export function outsideFolderOk(p: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  const rest = p.startsWith("~/") ? p.slice(2) : p.startsWith("/") ? p.slice(1) : undefined;
  if (rest === undefined) return false;
  const parts = rest.split("/").filter((s) => s !== "");
  if (parts.length === 0 || parts.includes("..") || parts.includes(".")) return false;
  // An absolute path names a folder below the disk's top folders, never one of them (`/Users`, `/home`, `/Volumes`,
  // `/private` hold every home), and nothing of the system's own (`/System` reaches the homes another way). The core
  // also refuses any folder that holds the user's home or Clover's.
  // Case-folded: the disk is case-insensitive by default, so `/system` is `/System`.
  if (p.startsWith("/")) return parts.length >= 2 && parts[0]!.toLowerCase() !== "system";
  return true;
}

/** The OK card's lines for what a plugin names outside its sandbox (P5), each a warning: every program it runs with the
 *  user's own access, and every folder of the user's it reads. */
export function outsideOkLines(o: { programs: readonly string[]; read: readonly string[] }): string[] {
  const lines: string[] = [];
  // One line a program: what it is (any arguments the plugin chooses, the user's own access) is the whole of the risk.
  for (const program of o.programs) lines.push(`${OUTSIDE_PROGRAM_LINE}: ${program}.`);
  if (o.read.length > 0) lines.push(`It reads ${o.read.length === 1 ? "this folder" : "these folders"} of yours outside its sandbox: ${o.read.join(", ")}.`);
  return lines;
}

/** The start of the OK card's line for each program a plugin runs outside its sandbox (P5); the program follows. */
export const OUTSIDE_PROGRAM_LINE = "It runs this program of yours outside Clover's sandbox, with whatever arguments it chooses and your own access (your sign-ins, your Keychain, your files and your network)";

/** The OK card's lines for the tools of a plugin that runs programs outside its sandbox (P5): each server that says its
 *  tools only read, only change its display or search or read the web, one line saying they still ask (its tools are
 *  its own code, which can run those programs with what a bot hands them). */
export function outsideToolsOkLines(report: Pick<ManifestReport, "readOnlyTools" | "containedTools" | "webTools">): string[] {
  const servers = new Map<string, number>();
  for (const r of [...(report.readOnlyTools ?? []), ...(report.containedTools ?? [])]) servers.set(r.server, (servers.get(r.server) ?? 0) + r.tools.length);
  for (const w of report.webTools ?? []) servers.set(w.server, (servers.get(w.server) ?? 0) + w.search.length + w.fetch.length + (w.browser?.length ?? 0));
  return [...servers].map(([server, n]) => `Its server ${server} says ${n === 1 ? "one tool needs" : `${n} tools need`} no asking, but this plugin runs programs of yours outside its sandbox, so ${n === 1 ? "it still asks" : "they still ask"} before running.`);
}

/** The OK card's line for a host half that runs programs (`host.programs`), where the plugin fence holds them. */
export const HOST_PROGRAMS_OK_LINE = "It runs programs on this computer, limited to its own folder and the files you pick.";
/** The same where this computer has no plugin fence (the no-sandbox line follows it). */
export const HOST_PROGRAMS_OK_LINE_UNFENCED = "It runs programs on this computer.";

// ---- read-only MCP tools (lane C's ask) ----

/** The longest line of the OK card (a sealed list item). */
export const OK_LINE_MAX = 4000;
/** The most OK card lines a plugin's read-only tools may fill; a longer list is refused at validation. */
export const READ_ONLY_OK_MAX_LINES = 4;

/** A server that reaches the network itself: an http server (its address is reached by the runtime). */
function serverReachesNetwork(s: { type?: unknown; url?: unknown }): boolean {
  return s.type === "http" || s.url !== undefined;
}

/** Whether a server's read-only tools still ask: they skip the card only where a call can't carry its arguments off
 *  the computer. So never for an http server, a tree with any `network:` grant (`network:public` and local ones
 *  included), a wrapper whose install record carries a network grant, or where Clover's fence doesn't hold plugin
 *  processes (`fenced` false). A cardless "read-only" call on a networked server is a cardless send of whatever the
 *  bot puts in its arguments. The call-time check (`pluginToolReadOnly`) and the OK card read this same rule. */
export function readOnlyReachesNetwork(
  server: { type?: unknown; url?: unknown; network?: boolean } | undefined,
  tree: { capabilities: readonly string[]; wrappedNetwork: boolean; fenced: boolean; runsOutside?: boolean },
): boolean {
  // A tree that names programs it runs outside its sandbox (P5, `host.outside.programs`): its code reaches what they
  // reach, the network included, with what a bot hands a tool.
  return server === undefined || server.network === true || serverReachesNetwork(server) || !tree.fenced || tree.wrappedNetwork || tree.runsOutside === true
    || tree.capabilities.some((c) => typeof c === "string" && c.startsWith("network:"));
}

/** The capabilities a tree may hold for its display-only tools (`contained`) to skip the card: reads of Clover's own
 *  state, which change nothing and, with no network anywhere in the tree and the plugin fence holding its processes,
 *  stay on this computer. A contained tool's plugin may keep what a call hands it in its own data (that is what a
 *  display is for), so what it may read and where it may send it bound the skip. Every other capability, and any one
 *  added later, keeps the card:
 *  (`shell.read` / `shell.control` are inside: they move only the window's own parts, by the user's press.)
 *  - `conversation.post`, `computers.control`, `files`, `project.write`, `browser`, `terminal`, `plugins.install`:
 *    effects beyond the plugin's display (messages, the screen and input, files, the browser, a terminal, installs);
 *  - `approvals`: it places the frames of approval cards;
 *  - `notify`, `audio`: they reach the user's attention (a notification, the speaker or the microphone);
 *  - `call:<plugin>`: another plugin's commands, and their effects;
 *  - `logs.read`: every plugin's logs, other plugins' data;
 *  - `network:*`: the network, already a condition of its own (`readOnlyReachesNetwork`).
 *  The two `avatar.*` capabilities stay allowed: the plugin's own bot's figure is its display (`avatar.report`, which
 *  tells the core what the stage drew for every bot, is not here). */
export const CONTAINED_TOOL_CAPABILITIES: readonly string[] = [
  "conversation.read", "memory.read", "bots.read", "routines.read", "computers.read", "devices.read", "usage.read",
  // The window's own parts (`shell.*`): display only, acts count only by the user's own press in a plugin's frame.
  "shell.read", "shell.control",
  // The figure's own display: `avatar.control` cues only the plugin's own bot's avatar (an expression, a motion, an
  // outfit part, the pace, a look-at point: nothing it can read, send or keep), at most 20 a second; `avatar.read` reads
  // that figure's names and box.
  "avatar.read", "avatar.control",
];

/** Whether a server's display-only tools may skip the card: everything that holds a read-only tool to its card
 *  (`readOnlyReachesNetwork`: no http server, no `network:` grant in the tree, no wrapper's grant, the plugin fence
 *  here), and no capability in the tree beyond `CONTAINED_TOOL_CAPABILITIES`. The call-time check
 *  (`pluginToolContained`) and the OK card read this same rule. */
export function containedToolsHold(
  server: { type?: unknown; url?: unknown; network?: boolean } | undefined,
  tree: { capabilities: readonly string[]; wrappedNetwork: boolean; fenced: boolean; runsOutside?: boolean },
): boolean {
  return !readOnlyReachesNetwork(server, tree) && tree.capabilities.every((c) => typeof c === "string" && CONTAINED_TOOL_CAPABILITIES.includes(c));
}

/** The OK card's lines for a server's display-only tools, in a sentence of their own: every name, split over lines of
 *  at most `OK_LINE_MAX`; or, where they don't hold (`containedToolsHold`), one line saying they still ask. */
export function containedOkLines(r: { server: string; tools: readonly string[] }, hold: boolean): string[] {
  const n = r.tools.length;
  if (!hold) return [`Its server ${r.server} says ${n === 1 ? "one tool only changes" : `${n} tools only change`} its own display, but it can reach the network or do more than read Clover's state, so ${n === 1 ? "it still asks" : "they still ask"} before running.`];
  const lines: string[] = [];
  let line = `Its server ${r.server} says ${n === 1 ? "this tool only changes its own display, so at the default level it runs" : "these tools only change its own display, so at the default level they run"} without asking: `;
  let first = true;
  for (const t of r.tools) {
    const piece = first ? t : `, ${t}`;
    if (line.length + piece.length + 1 > OK_LINE_MAX) {
      lines.push(`${line}${first ? "" : ","}`);
      line = `${r.server}'s display-only tools, continued: ${t}`;
    } else line += piece;
    first = false;
  }
  lines.push(`${line}.`);
  return lines;
}

/** The OK card's lines for a server's web tools (`webSearch`, `webFetch`), each a warning: what runs without asking at
 *  the default level, and that what a bot searches or fetches goes through this plugin. */
export function webToolOkLines(w: { server: string; search: readonly string[]; fetch: readonly string[]; browser?: readonly string[] }): string[] {
  const lines: string[] = [];
  const names = (t: readonly string[]) => t.join(", ").slice(0, 300);
  if (w.search.length > 0) lines.push(`Its server ${w.server} says ${names(w.search)} search${w.search.length === 1 ? "es" : ""} the web: at the default approval level a search runs without asking, and what a bot searches goes to this plugin.`);
  if (w.fetch.length > 0) lines.push(`Its server ${w.server} says ${names(w.fetch)} read${w.fetch.length === 1 ? "s" : ""} web pages: at the default approval level a page whose link a bot already has is read without asking (a few a turn), any other page asks, site by site, and what is read goes through this plugin.`);
  if ((w.browser ?? []).length > 0) lines.push(`Its server ${w.server} says ${names(w.browser!)} drive${w.browser!.length === 1 ? "s" : ""} the calling bot's own tab of the Clover Browser. Looking and acting are told apart by the plugin's own word (its verbs): at the default approval level what it calls looking runs without asking, what it calls clicking and typing asks for the site, and what the tab shows goes through this plugin.`);
  return lines;
}

/** The OK card's lines for a server's read-only tools: every name, split over lines of at most `OK_LINE_MAX`, the
 *  first with the count; or, for a server that can reach the network, one line saying they still ask. */
export function readOnlyOkLines(r: { server: string; tools: readonly string[] }, reachesNetwork: boolean): string[] {
  const n = r.tools.length;
  const tools = `${n} tool${n === 1 ? "" : "s"}`;
  if (reachesNetwork) return [`Its server ${r.server} says ${n === 1 ? "one tool only reads" : `${tools} only read`}, but it can reach the network, so ${n === 1 ? "it still asks" : "they still ask"} before running.`];
  const lines: string[] = [];
  let line = `Its server ${r.server} says ${n === 1 ? "this tool only reads, so at the default approval level it runs" : `these ${tools} only read, so at the default approval level they run`} without asking: `;
  let first = true;
  for (const t of r.tools) {
    const piece = first ? t : `, ${t}`;
    if (line.length + piece.length + 1 > OK_LINE_MAX) {
      lines.push(`${line}${first ? "" : ","}`);
      line = `${r.server}'s read-only tools, continued: ${t}`;
    } else line += piece;
    first = false;
  }
  lines.push(`${line}.`);
  return lines;
}

/** A manifest's agent backends as the OK card names them: name (cut to 80), the program it runs (cut to 200) or its
 *  host-code handler. */
/** A manifest's agent definitions (`agents`), each by its id, its display name (plain, at most 80 characters) and the
 *  file its instructions are in. */
export function agentDefinitionsOf(m: Manifest | undefined): { id: string; name: string; file?: string }[] {
  const list = (m?.contributes as { agents?: (string | { id: string; name?: unknown; instructions?: string })[] } | undefined)?.agents ?? [];
  const plain = (t: string) => t.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return list.map((e) => {
    if (typeof e === "string") {
      const id = e.split("/").pop()!.replace(/\.md$/i, "");
      return { id, name: plain(id) || "an agent", file: e };
    }
    const name = typeof e.name === "string" ? e.name : ((e.name as { en?: string } | undefined)?.en ?? e.id);
    return { id: e.id, name: plain(name) || e.id, ...(e.instructions === undefined ? {} : { file: e.instructions }) };
  });
}

export function agentBackendsOf(m: Manifest | undefined): { id: string; name: string; program?: string; handler?: string }[] {
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const list = (m?.contributes as { agentBackends?: { id: string; name: unknown; command?: string; handler?: string }[] } | undefined)?.agentBackends ?? [];
  return list.map((b) => {
    const name = typeof b.name === "string" ? b.name : ((b.name as { en?: string } | undefined)?.en ?? b.id);
    return { id: b.id, name: cut(name, 80), ...(b.command !== undefined ? { program: cut(b.command, 200) } : {}), ...(b.handler !== undefined ? { handler: b.handler } : {}) };
  });
}

/** One way a setting feeds what a plugin runs or reaches (`settingFeeds`). */
export interface SettingFeed {
  key: string;
  /** Where in the manifest (a JSON pointer), or the hooks' environment. */
  where: string;
  /** For a host: its template (`${setting:region}.example.com`), from a `network:` grant or a URL field. */
  host?: string;
}

/** Every way a plugin's settings feed what it runs or reaches, as the core expands them (the one scanner: the user's
 *  sealed card for a host that moves, `settingHostTemplates`, and the refusal of a plugin's own change to such a
 *  setting, `settingTemplated`, both read it):
 *  1. a placeholder the expander fills from a setting (`SETTING_FED_PARTS`: `${setting:k}`, `${secret:k}`,
 *     `${secretFile:k}`) in ANY string of the manifest but its own `settings` block: the fields the core fills (a stdio
 *     server's program, arguments and environment, an http server's URL and headers, a hook's or agent backend's
 *     command and arguments, a model's `baseUrl`, a `network:` grant's host) and, over-matching on purpose, any other
 *     string that quotes one (which only asks on a card more often). A string the expander can't parse is still read
 *     token by token;
 *  2. a host template among those: a `network:` grant's host or a URL field's host that names a setting;
 *  3. every plain setting of a plugin with a `command` hook, which gets it in its environment (`hookOptionEnvName`). */
export function settingFeeds(m: Manifest | undefined): SettingFeed[] {
  if (m === undefined) return [];
  const out: SettingFeed[] = [];
  const fedKinds = Object.entries(SETTING_FED_PARTS).filter(([, fed]) => fed).map(([k]) => k);
  const token = new RegExp(`\\$\\{(${fedKinds.join("|")}):([^}]+)\\}`, "g");
  const scan = (v: unknown, where: string): void => {
    if (typeof v === "string") {
      if (!v.includes("${")) return;
      const parsed = parseInterpolation(v);
      if (parsed.ok) {
        for (const part of parsed.parts) if (SETTING_FED_PARTS[part.kind] && "key" in part) out.push({ key: part.key, where });
      } else {
        for (const t of v.matchAll(token)) out.push({ key: t[2]!, where });
      }
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${where}/${i}`));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) scan(x, `${where}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  };
  const { settings: _settings, ...rest } = m as Manifest & { settings?: unknown };
  scan(rest, "");
  // Host templates: a `network:` grant's host, and a URL field's host.
  const keysOf = (t: string) => [...t.matchAll(/\$\{setting:([A-Za-z0-9_.-]+)\}/g)].map((x) => x[1]!);
  (m.capabilities ?? []).forEach((c, i) => {
    if (typeof c !== "string" || !c.startsWith("network:") || !c.includes("${setting:")) return;
    const host = c.slice("network:".length);
    for (const key of keysOf(host)) out.push({ key, where: `/capabilities/${i}`, host });
  });
  for (const url of urlFields(m)) {
    const host = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1]?.replace(/^[^@]*@/, "");
    if (host === undefined || !host.includes("${setting:")) continue;
    for (const key of keysOf(host)) out.push({ key, where: "a URL field", host });
  }
  // A `command` hook gets every plain setting in its environment.
  const hooks = (m.contributes as { hooks?: unknown } | undefined)?.hooks;
  if (Array.isArray(hooks) && hooks.some((h) => isObject(h) && h.command !== undefined)) {
    for (const [key, f] of Object.entries((m as { settings?: Record<string, { type?: unknown }> }).settings ?? {})) {
      if (f?.type !== "secret") out.push({ key, where: `the command hooks' environment (${hookOptionEnvName(key)})` });
    }
  }
  return out;
}

/** The hosts a plugin's settings feed (the controller's ruling: "hosts from its settings"): each `network:` grant and
 *  each URL field (an http server's `url`, a model's `baseUrl`, a sign-in's URLs, a web UI's URL) whose host names a
 *  `${setting:<key>}`, as its host template (`${setting:region}.example.com`); from `settingFeeds`. A change to one of
 *  those keys changes where the plugin's keys and requests go. */
export function settingHostTemplates(m: Manifest | undefined): { template: string; keys: string[] }[] {
  const out = new Map<string, string[]>();
  for (const f of settingFeeds(m)) {
    if (f.host === undefined) continue;
    const keys = out.get(f.host) ?? [];
    if (!keys.includes(f.key)) keys.push(f.key);
    out.set(f.host, keys);
  }
  return [...out].map(([template, keys]) => ({ template, keys }));
}

/** A host template with the settings' values put in (`${setting:k}` → the value, or `?` when it has none). */
export function settingHost(template: string, values: Readonly<Record<string, unknown>>): string {
  return template.replace(/\$\{setting:([A-Za-z0-9_.-]+)\}/g, (_m, k: string) => {
    const v = values[k];
    return typeof v === "string" || typeof v === "number" ? String(v) : "?";
  });
}

/** Whether a setting feeds anything the plugin runs or reaches (the controller's ruling), by `settingFeeds`: a
 *  placeholder the core fills from it anywhere in the manifest but its own `settings` block (over-matching a string
 *  that merely quotes one, which only asks on a card more often), a host template, or a `command` hook's environment.
 *  A change to one moves where its keys go or what it runs: only the user changes it, on a sealed card. */
export function settingTemplated(m: Manifest | undefined, key: string): boolean {
  return settingFeeds(m).some((f) => f.key === key);
}
