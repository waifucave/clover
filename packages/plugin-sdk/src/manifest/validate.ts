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
import { CAPABILITIES, capabilityOkText, isCapability, parseCapability, parseSettingHost } from "../catalogs/capabilities";
import { TOOL_HOOK_EVENTS, type HookEvent } from "../catalogs/hooks";
import { CORE_POINT_NAMES, WELL_KNOWN_POINT_NAMES, dataPointInfo } from "../catalogs/points";
import { SPOT_NAMES, foldTitle, isReservedPluginName, spotInfo } from "../catalogs/spots";
import { treePathProblem } from "../formats/tree-hash";
import { parseJsonc } from "../jsonc";
import { isRange, satisfies } from "../semver";
import { FORMATS, MANIFEST_FILE, PLUGIN_API_VERSION } from "../version";
import { DOTTED_POINT_NAME_RE, POINT_NAME_RE } from "./fields";
import { checkArgsSchema } from "./args";
import { parseInterpolation, usesSecrets } from "./interpolation";
import { fetchesCodeAtRunTime, toolWireName } from "./names";
import { CORE_CONTRIBUTION_KEYS, CORE_CONTRIBUTION_SCHEMAS, ManifestSchema, isToolKey, type CoreContributionKey } from "./schema";
import type { Manifest, PointDecl } from "./types";

/** Environment names a plugin's server never sets (the core refuses them too, `refuseReservedPluginEnv`). */
export const RESERVED_ENV = /^(CLOVER_|BUN_|LD_|DYLD_|NODE_(?!(ENV|NO_WARNINGS)$))/;

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
  /** It declares programs of its own (a `stdio` server, a helper, or a Node host, Clover's own plugins only), which
   *  Clover's load guard doesn't hold to the plugin's folder: the OK says so (#234's check 3). */
  ownPrograms: boolean;
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
  list("skills").forEach((e, i) => add(["contributes", "skills", i], e, "entry", true));
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

/** Checks a value that may hold interpolation (§5.9); `secrets` says whether `${secret:…}` may appear. */
function checkInterpolated(f: Findings, path: Seg[], value: unknown, secrets: boolean): boolean {
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
    const where = jsonPointer(at);
    // A UI spot may be declared on several of a plugin's entries (lane F: its panel and its Files view both declare
    // `file.preview`), each a place the spot shows, all with the same declaration; any other point is declared once.
    const key = spot ? `${name}\u0000${canonicalDecl(d)}` : undefined;
    if (seen.has(name) && !(spot && seen.get(`${name}\u0000spot`) === key)) {
      f.error(refuses, "point_duplicate", at, `"${name}" is declared twice (also at ${seen.get(name)})${spot ? " with another declaration" : ""}`);
      continue;
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
    helperPermissions: [], capabilities: [], toolNames: [], settings: [], fetchesCode: [], ownPrograms: false, addons: false, adult: false, bot: false, restylesCards: false, issues,
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

  const capabilities = Array.isArray(top.capabilities) ? top.capabilities.filter((c): c is string => typeof c === "string") : [];
  capabilities.forEach((c, i) => {
    if (!isCapability(c)) f.error("plugin", "capability_unknown", ["capabilities", i], `"${c}" is not a capability (see the catalog)`);
    else if (capabilities.indexOf(c) !== i) f.warn("capability_duplicate", ["capabilities", i], `"${c}" is listed twice`);
    else if (CAPABILITIES.find((x) => x.name === c)?.bundledOnly && topId !== BUNDLED_ROOT_PLUGIN) {
      f.error("plugin", "capability_bundled_only", ["capabilities", i], `"${c}" is only for the plugins Clover ships`);
    }
  });

  if (isObject(top.settings)) for (const [k, s] of Object.entries(top.settings)) if (isObject(s)) checkSetting(f, k, s);
  if (isObject(top.helper) && isObject(top.helper.bin) && Object.keys(top.helper.bin).length === 0) {
    f.error("plugin", "helper_bin", ["helper", "bin"], "a helper names its program for at least one platform");
  }
  // A host half runs under Bun, where Clover's load guard holds it to its folder (#234's check 3, the controller's
  // ruling); a program of its own is declared as a `stdio` server or a helper, which the OK covers and Clover doesn't
  // confine. Only Clover's own plugins keep a Node host (the cloud model plugins' signing).
  if (isObject(top.host) && top.host.runtime === "node" && topId !== BUNDLED_ROOT_PLUGIN) {
    f.error("plugin", "host_runtime_bundled_only", ["host", "runtime"], "a plugin's host runs under Bun; a program of its own goes in a `stdio` server or a helper");
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
        const result = checkCoreContribution(f, key as CoreContributionKey, value, at, { hasHost, hasClient, isBot, topId, id, namespace, seenDecl, declared, refusedPathUnder });
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

  const ownPrograms = isObject(top.helper) || (isObject(top.host) && top.host.runtime === "node")
    || (isObject(contributes.mcpServers) && Object.values(contributes.mcpServers).some((s) => s.type === "stdio"));
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
    ownPrograms,
    addons: top.addons !== undefined,
    adult: top.adult === true,
    bot: kept.bot !== undefined,
    restylesCards: capabilities.includes("approvals"),
    issues: f.list,
  };
}

interface CoreCtx {
  hasHost: boolean;
  hasClient: boolean;
  isBot: boolean;
  topId: string | undefined;
  id: string | undefined;
  /** The plugin's namespace (its top-level plugin's, for a child). */
  namespace: string | undefined;
  seenDecl: Map<string, string>;
  declared: DeclaredPoint[];
  refusedPathUnder(at: Seg[]): boolean;
}

const LIST_KEYS = new Set<CoreContributionKey>([
  "models", "skills", "agents", "agentBackends", "hooks", "commands", "triggers", "voices", "computerProviders",
  "relays", "notifiers", "companions", "themes", "locales", "ui",
]);

/** The field each list point's entries are unique by within one plugin (§5.1 "Entry ids"). */
const UNIQUE_BY: Partial<Record<CoreContributionKey, string>> = {
  models: "provider", agentBackends: "id", hooks: "id", commands: "name", triggers: "type", voices: "id",
  computerProviders: "id", relays: "id", notifiers: "id", companions: "id", themes: "id", locales: "lang",
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
      if (Array.isArray(e.args)) e.args.forEach((a, i) => { ok = checkInterpolated(f, [...at, "args", i], a, false) && ok; });
      if (isObject(e.env)) for (const [k, v] of Object.entries(e.env)) ok = checkInterpolated(f, [...at, "env", k], v, true) && ok;
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
      return ok;
    }
    case "commands": {
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
    case "relays":
    case "notifiers":
    case "companions":
      return needHost("handler");
    case "voices":
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
  const kinds = ["component", "web", "style", "hide"].filter((k) => (k === "hide" ? e.hide === true : e[k] !== undefined));
  // A message's menu item runs a command, and only one of the plugin's own: another plugin's would run it without
  // `call:<that plugin>` (the controller's ruling on lane F's F-M3). The app draws the item, so it needs no component.
  if (e.spot === "menu.message" && e.command !== undefined) {
    const ns = typeof e.command === "string" ? e.command.slice(0, Math.max(0, e.command.indexOf("."))) : undefined;
    if (ns === undefined || ns === "" || ns !== ctx.namespace) {
      f.error("entry", "menu_command_namespace", [...at, "command"], `a message menu item runs one of the plugin's own commands (\`${ctx.namespace ?? "<namespace>"}.<name>\`)`);
      return false;
    }
  }
  const commandOnly = e.spot === "menu.message" && typeof e.command === "string" && kinds.length === 0;
  if (kinds.length !== 1 && !commandOnly) {
    f.error("entry", "ui_one_of", at, "a `ui` entry has exactly one of `component`, `web`, `style` or `hide: true`");
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
  if (e.window !== undefined && spotName !== "app.surface") {
    f.error("entry", "ui_window_not_surface", [...at, "window"], "`window` is for `app.surface` entries");
    return false;
  }
  const bundledTree = ctx.topId === BUNDLED_ROOT_PLUGIN;
  if (isObject(e.window) && e.window.alwaysOnTop === true && !bundledTree) {
    f.error("entry", "ui_always_on_top", [...at, "window", "alwaysOnTop"], "only the plugins Clover ships open always-on-top surfaces");
    return false;
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
  if (spot) {
    const fields = spot.fields.safeParse(e);
    if (!fields.success) {
      schemaFindings(f, "entry", fields.error, at);
      return false;
    }
    if (e.key !== undefined && spot.shape !== "keyed") f.warn("ui_key", [...at, "key"], `"${spotName}" is not keyed; \`key\` is ignored`);
  }
  if (ctx.isBot) {
    if (spot && !spot.inBotTab) {
      f.error("entry", "bot_spot_outside_tab", [...at, "spot"], `a bot's plugin adds UI only inside its own tab, and "${spotName}" is outside it; put it in a child plugin`);
      return false;
    }
    const when = isObject(e.when) ? e.when.bot : undefined;
    const bots = when === undefined ? [] : Array.isArray(when) ? when : [when];
    if (bots.some((b) => b !== ctx.id)) {
      f.error("entry", "bot_when_other_bot", [...at, "when", "bot"], "in a bot's plugin, `when.bot` is the bot itself; dressing other bots' tabs takes another plugin");
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
  for (const v of c.voices ?? []) auth(v.auth);
  for (const p of c.computerProviders ?? []) auth(p.auth);
  for (const u of c.ui ?? []) if (u.web?.url) out.push(u.web.url);
  return out;
}

/** The OK's text for a plugin, in English (§5.1, §5.6); the app shows it from the built-in tables in the user's
 *  language. One card covers a plugin and its children. */
export function describeOk(
  report: ManifestReport,
  opts: { os?: "macos" | "windows" | "linux"; source?: "index" | "other"; /** The tree's flag (`TreeReport.restylesCards`). */ restylesCards?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const what = report.class === "code" ? "runs code on your computers" : report.class === "web" ? "shows web pages" : "is data only: files, no code";
  lines.push(`${report.id ?? "This plugin"} ${what}.`);
  if (report.class === "code" && opts.os && opts.os !== "macos") lines.push("Its code could read Clover's logins and approve its own cards.");
  if (report.contributions.length > 0) lines.push(`It adds: ${report.contributions.map((c) => c.point).join(", ")}.`);
  for (const cap of report.capabilities) {
    if (parseCapability(cap)?.kind === "network") continue;
    const text = capabilityOkText(cap);
    if (text) lines.push(`It ${text}.`);
  }
  if (opts.restylesCards && !report.capabilities.includes("approvals")) lines.push(`It ${capabilityOkText("approvals")}.`);
  if (report.networkHosts.length > 0) {
    lines.push(`Its components reach only ${report.networkHosts.join(", ")}${report.class === "code" ? "; its host code can reach any host" : ""}.`);
  } else if (report.class === "code") lines.push("Its components reach no host; its host code can reach any host.");
  if (report.dynamicHosts) lines.push("Some of the hosts it reaches come from its settings.");
  if (report.helperPermissions.length > 0) lines.push(`Its helper asks for: ${report.helperPermissions.join(", ")}.`);
  for (const cmd of report.fetchesCode) lines.push(`It fetches code when it runs: ${cmd}.`);
  if (report.ownPrograms) lines.push("It runs its own programs, which Clover doesn't confine.");
  if (report.addons) lines.push("It loads add-ons of its own, which Clover doesn't check.");
  if (report.adult) lines.push("It may contain adult content.");
  if (opts.source === "other") lines.push("Not reviewed: it isn't from the official index.");
  return lines;
}
