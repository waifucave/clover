// What a plugin's loader configs reach (#234's review, F2, the controller's ruling): a `tsconfig*.json` or
// `jsconfig*.json` can pull in another file through `extends` (a chain of them) and send imports elsewhere through
// `compilerOptions.paths` and `baseUrl`, and a `package.json` maps imports through `imports` and `exports`. Every file
// they reach inside the plugin counts as code, so a changed `base.json` waits for a new OK; a target outside the
// plugin's tree makes the plugin invalid, since a plugin never pulls in code or config from elsewhere.
import { readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { parseJsonc } from "@waifucave/clover-plugin-sdk";
import type { ValidationIssue } from "@waifucave/clover-protocol";

/** The biggest loader config read when following `extends` and `paths`. */
const LOADER_CONFIG_MAX_BYTES = 1024 * 1024;

/** `loaderReach` over a folder on disk, given its files (tree paths). */
export function folderLoaderReach(folder: string, files: readonly string[]): LoaderReach {
  return loaderReach(files, (path) => {
    try {
      const abs = join(folder, path);
      return statSync(abs).size <= LOADER_CONFIG_MAX_BYTES ? readFileSync(abs, "utf8") : undefined;
    } catch {
      return undefined;
    }
  });
}

/** Reaching outside the tree, as the errors that make a plugin invalid (`loader_outside`). */
export function loaderOutsideIssues(reach: LoaderReach): ValidationIssue[] {
  return reach.outside.map((o) => ({
    severity: "error", refuses: "plugin", code: "loader_outside", file: o.file, path: "",
    message: `${o.file}'s ${o.field} reaches "${o.target}", outside the plugin; a plugin can't pull in code or config from elsewhere`,
  }));
}

export interface LoaderReach {
  /** Tree paths (relative to the plugin folder, with `/`) reached inside the plugin, to count as code. */
  inside: string[];
  /** Why the plugin reaches outside its tree: the config file, the field and the target as written. */
  outside: { file: string; field: string; target: string }[];
}

const TS_CONFIG = /(^|\/)(tsconfig|jsconfig)(\.[^/]*)?\.json$/i;
const PACKAGE = /(^|\/)package\.json$/i;
/** The most config files followed through `extends` for one plugin. */
const MAX_CONFIGS = 256;

/** The folder a tree path sits in, with a trailing `/` ("" at the root). */
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/** A wildcard target with `..` after its `*` climbs from wherever the `*` lands: it can reach anywhere. */
const climbsAfterStar = (target: string) => {
  const star = target.indexOf("*");
  return star >= 0 && target.slice(star + 1).replace(/\\/g, "/").split("/").includes("..");
};

/** `rel` resolved against folder `dir` (both tree paths); undefined when it climbs out of the plugin. */
function resolve(dir: string, rel: string): string | undefined {
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\\\")) return undefined;
  const out: string[] = [];
  for (const seg of `${dir}${rel}`.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** A Node or Bun built-in module (`fs`, `node:fs`, `bun:sqlite`). */
const builtin = (spec: string) => spec.startsWith("node:") || spec.startsWith("bun:") || builtinModules.includes(spec.split("/")[0]!) || builtinModules.includes(spec);

/** Follows every loader config among `files` (tree paths). `readText` gives a file's text, or undefined. */
export function loaderReach(files: readonly string[], readText: (path: string) => string | undefined): LoaderReach {
  const have = new Set(files);
  const inside = new Set<string>();
  const outside: LoaderReach["outside"] = [];
  const seen = new Set<string>();
  const queue = files.filter((f) => TS_CONFIG.test(f));
  const parse = (path: string): Record<string, unknown> | undefined => {
    const text = readText(path);
    if (text === undefined) return undefined;
    const r = parseJsonc(text);
    return r.ok && r.value !== null && typeof r.value === "object" && !Array.isArray(r.value) ? (r.value as Record<string, unknown>) : undefined;
  };
  // A target as a file: as written, else with `.json` (TypeScript's rule for `extends`).
  const asFile = (path: string) => (have.has(path) ? path : have.has(`${path}.json`) ? `${path}.json` : path);
  // A bare `extends` (a package's config) is looked for in node_modules folders from the config's folder up.
  const fromPackages = (dir: string, spec: string): string | undefined => {
    for (let d = dir; ; d = dirOf(d.slice(0, -1))) {
      const p = resolve(d, `node_modules/${spec}`);
      if (p !== undefined && (have.has(p) || have.has(`${p}.json`) || have.has(`${p}/tsconfig.json`))) return have.has(`${p}/tsconfig.json`) ? `${p}/tsconfig.json` : asFile(p);
      if (d === "") return undefined;
    }
  };
  const reach = (file: string, field: string, target: string, base: string, isConfig: boolean) => {
    const bare = !target.startsWith(".") && !target.startsWith("/") && !/^[A-Za-z]:/.test(target) && !target.startsWith("\\");
    const path = bare && isConfig ? fromPackages(base, target) : resolve(base, target);
    if (path === undefined) {
      outside.push({ file, field, target });
      return;
    }
    const f = asFile(path);
    inside.add(f);
    if (isConfig && !seen.has(f)) queue.push(f);
  };
  while (queue.length > 0 && seen.size < MAX_CONFIGS) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const cfg = parse(file);
    if (cfg === undefined) continue;
    const dir = dirOf(file);
    const ext = cfg.extends;
    for (const t of typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext : []) if (typeof t === "string") reach(file, "extends", t, dir, true);
    const opts = cfg.compilerOptions !== null && typeof cfg.compilerOptions === "object" ? (cfg.compilerOptions as Record<string, unknown>) : {};
    let base = dir;
    if (typeof opts.baseUrl === "string") {
      const b = resolve(dir, opts.baseUrl);
      if (b === undefined) {
        outside.push({ file, field: "compilerOptions.baseUrl", target: opts.baseUrl });
        continue;
      }
      base = b === "" ? "" : `${b}/`;
    }
    const paths = opts.paths !== null && typeof opts.paths === "object" ? (opts.paths as Record<string, unknown>) : {};
    for (const [key, targets] of Object.entries(paths)) {
      for (const t of Array.isArray(targets) ? targets : []) {
        if (typeof t !== "string") continue;
        // A wildcard target names everything under its prefix.
        const star = t.indexOf("*");
        const prefix = star < 0 ? t : t.slice(0, star);
        const resolved = climbsAfterStar(t) ? undefined : resolve(base, prefix === "" ? "." : prefix);
        if (resolved === undefined) {
          outside.push({ file, field: `compilerOptions.paths.${key}`, target: t });
          continue;
        }
        if (star < 0) inside.add(asFile(resolved));
        else for (const f of files) if (f.startsWith(resolved)) inside.add(f);
      }
    }
    // A path-like `jsxImportSource` is where the JSX runtime loads from (a bare one is a dependency's name).
    const jsx = opts.jsxImportSource;
    if (typeof jsx === "string" && (jsx.startsWith(".") || jsx.startsWith("/") || /^[A-Za-z]:/.test(jsx) || jsx.startsWith("\\"))) {
      const resolved = resolve(dir, jsx);
      if (resolved === undefined) outside.push({ file, field: "compilerOptions.jsxImportSource", target: jsx });
      else for (const f of files) if (f === resolved || f.startsWith(`${resolved}/`)) inside.add(f);
    }
  }
  // The folder of the dependency a bare specifier names (`dep/x`, `@scope/dep/x`), found in a node_modules folder from
  // `dir` up inside the plugin; undefined when the plugin has none.
  const dependencyFolder = (dir: string, spec: string): string | undefined => {
    const parts = spec.split("/");
    const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    if (name === "" || name === "." || name === ".." || name.includes("..") || (spec.startsWith("@") && parts.length < 2)) return undefined;
    for (let d = dir; ; d = dirOf(d.slice(0, -1))) {
      const folder = `${d}node_modules/${name}/`;
      if (files.some((f) => f.startsWith(folder))) return folder;
      if (d === "") return undefined;
    }
  };
  // package.json `imports` and `exports`: a relative target stays inside the plugin, and counts as code.
  for (const file of files.filter((f) => PACKAGE.test(f))) {
    const pkg = parse(file);
    if (pkg === undefined) continue;
    // `relative`: a bare target is a file of the package's (main, module, a string browser), not a dependency's name.
    const targets: { field: string; target: string; relative: boolean }[] = [];
    const walk = (field: string, v: unknown, relative = false) => {
      if (typeof v === "string") targets.push({ field, target: v, relative });
      else if (Array.isArray(v)) v.forEach((x) => walk(field, x));
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${field}.${k}`, x);
    };
    walk("imports", pkg.imports);
    walk("exports", pkg.exports);
    walk("main", pkg.main, true);
    walk("module", pkg.module, true);
    walk("browser", pkg.browser, true);
    for (const { field, target, relative } of targets) {
      if (!relative && !target.startsWith(".") && !target.startsWith("/") && !/^[A-Za-z]:/.test(target) && !target.startsWith("\\")) {
        // A dependency's name. In `imports` it must be a built-in module or one in the plugin's own node_modules, so a
        // program that isn't Bun (which Clover's load guard doesn't hold) can't be sent elsewhere by it (#234's check 3).
        if (field.startsWith("imports") && !builtin(target) && dependencyFolder(dirOf(file), target) === undefined) outside.push({ file, field, target });
        continue;
      }
      const star = target.indexOf("*");
      const prefix = star < 0 ? target : target.slice(0, star);
      const resolved = climbsAfterStar(target) ? undefined : resolve(dirOf(file), prefix === "" ? "." : prefix);
      if (resolved === undefined) outside.push({ file, field, target });
      else if (star < 0) inside.add(resolved);
      else for (const f of files) if (f.startsWith(resolved)) inside.add(f);
    }
  }
  return { inside: [...inside].sort(), outside };
}
