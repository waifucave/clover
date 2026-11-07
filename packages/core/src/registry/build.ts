// The registry's builder: one plugin entry into one ES module of JavaScript (spec §5.5; the registry contract's
// client entries). It is the only builder plugin code goes through, at load and at release alike:
//
// * a client entry (`client.entry`, `side: "client"`) for the app's layers: everything bundled in but
//   `CLIENT_BARE_IMPORTS` (React 19 and the UI API), which each layer provides through its import map; CSS it imports
//   comes out as stylesheets beside it, for the manifest's `client.css`; built for production React;
// * a host entry (`host.entry`) or a program a `stdio` server or agent backend runs (`side: "bun"` or `"node"`):
//   everything bundled in but Node's and Bun's own modules and the packages `keepExternal` keeps out (native addons,
//   which `ship.ts` ships beside the module with their prebuilt binaries).
//
// The output is checked, not trusted: a bare import left in it other than those is a build failure, with the import
// named. The registry's load-time build of a TypeScript client entry (`UiPluginView.clientEntry`) and the release's
// `buildPluginForShipping` both call `buildPluginModule`, so what a development folder runs and what ships come from the
// same build.
//
// What the output may not hold (#271's review):
// * no path of the computer that built it: `__dirname` and `__filename` in a bundled CommonJS dependency would be
//   inlined as the dependency's absolute path, so they are defined as the module's own at run time
//   (`import.meta.dirname`/`filename`; in a client, `/`); the bundler's per-input path comments are removed; and every
//   file the build writes (modules, stylesheets, assets) is scanned for the strings `forbid` names (the builder's home,
//   user name and checkout), failing the build if one is there;
// * no load the scan can't check (`runtimeLoadProblems`; #271's review M1, then R1's sturdier rule, since a pattern
//   for each call misses aliases):
//   - host code imports a built-in that loads or runs other code (`module`, `worker_threads`, `vm`, `child_process`)
//     only when its plugin names it in the manifest's `builtins`; the bundler's own Node shim (`createRequire`) is the
//     one exception;
//   - outside the bundler's own shim lines, a module loader (`require`, `__require`, `import.meta.require`,
//     `import.meta.resolve`) may only be called with a literal the module may import, and any other reference to one,
//     or to `dlopen`, `getBuiltinModule` or `Module._load`, fails the build;
//   - `import()` takes a string literal only;
//   - host code names no `Worker`, no `Bun.spawn`/`build`/`plugin`/`resolve`, and doesn't pass `Bun` itself on.
//   A client's Worker is the layer's to allow: its CSP gives `worker-src` only `'self' blob:` (lane E).
import { CLIENT_BARE_IMPORTS } from "@waifucave/clover-plugin-sdk";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, extname } from "node:path";

/** Who runs the module: the app's layers (a browser), the plugin Bun, or Node (a `runtime: "node"` host). */
export type BuildSide = "client" | "bun" | "node";

/** A build that failed, or whose output imports what it may not. Each problem names the file. */
export class PluginBuildError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "PluginBuildError";
  }
}

export interface BuildModuleOptions {
  /** The code-loading built-ins the plugin named in its manifest's `builtins` (host and program side). */
  builtins?: readonly string[];
  /** The entry's source file (absolute). */
  entry: string;
  /** The module to write (absolute); its folder is created. Stylesheets and assets go beside it. */
  outFile: string;
  side: BuildSide;
  /** Host and program side: a bare import (its specifier and the importing file) to leave as an import, for a package
   *  the caller ships beside the module. Asked once per import the bundler meets. */
  keepExternal?: (spec: string, importer: string) => boolean;
  /** Strings no output file may hold (the builder's home, user name, checkout): a match fails the build. */
  forbid?: readonly Forbidden[];
}

/** A string an output may not hold, and how a problem names it (never the string itself). */
export interface Forbidden {
  text: string | RegExp;
  label: string;
}

export interface BuiltPluginModule {
  /** The module written (`outFile`). */
  file: string;
  /** Its text. */
  source: string;
  /** Client side: the stylesheets its CSS imports became, absolute, beside it. */
  css: string[];
  /** Other files the build wrote beside it (assets the entry imports), absolute. */
  assets: string[];
  /** The bare imports left in it (the layers' for a client module; Node's, Bun's and `keepExternal`'s otherwise). */
  imports: string[];
}

/** The package a bare specifier names (`@scope/name/sub` → `@scope/name`). */
export function packageOfSpecifier(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Node's and Bun's own modules, with or without the `node:` prefix. */
export function isRuntimeBuiltin(spec: string): boolean {
  return spec === "bun" || spec.startsWith("bun:") || spec.startsWith("node:") || isBuiltin(spec);
}

const isBare = (spec: string) => !spec.startsWith(".") && !spec.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(spec) && !/^[a-z][a-z0-9+.-]*:/i.test(spec);

/** Builds one entry (see the file's header). Throws `PluginBuildError` with the bundler's messages, or with the
 *  imports its output may not have. */
export async function buildPluginModule(o: BuildModuleOptions): Promise<BuiltPluginModule> {
  const outdir = dirname(o.outFile);
  mkdirSync(outdir, { recursive: true });
  const kept = new Set<string>();
  const client = o.side === "client";
  const keepExternal = o.keepExternal;
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [o.entry],
      root: dirname(o.entry),
      metafile: true,
      outdir,
      target: client ? "browser" : o.side === "node" ? "node" : "bun",
      format: "esm",
      splitting: false,
      minify: false,
      sourcemap: "none",
      throw: false,
      naming: { entry: "[name].[ext]", asset: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
      define: { __dirname: DIRNAME, __filename: FILENAME, ...(client ? { "process.env.NODE_ENV": JSON.stringify("production") } : {}) },
      banner: client ? `const ${DIRNAME} = "/", ${FILENAME} = "/index.js";` : `const ${DIRNAME} = import.meta.dirname, ${FILENAME} = import.meta.filename;`,
      ...(client ? { external: [...CLIENT_BARE_IMPORTS] } : {}),
      plugins: client || keepExternal === undefined ? [] : [{
        name: "clover-keep-external",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (!isBare(args.path) || isRuntimeBuiltin(args.path)) return undefined;
            if (!keepExternal(args.path, args.importer)) return undefined;
            kept.add(packageOfSpecifier(args.path));
            return { path: args.path, external: true };
          });
        },
      }],
    });
  } catch (e) {
    throw new PluginBuildError([`${o.entry}: ${e instanceof Error ? e.message : String(e)}`]);
  }
  if (!result.success) {
    throw new PluginBuildError(result.logs.filter((l) => l.level === "error").map((l) => `${o.entry}: ${String(l.message ?? l)}`).concat(result.logs.length === 0 ? [`${o.entry}: the build failed`] : []));
  }
  const entries = result.outputs.filter((x) => x.kind === "entry-point");
  if (entries.length !== 1) throw new PluginBuildError([`${o.entry}: the build wrote ${entries.length} modules, not one`]);
  const written = entries[0]!.path;
  if (written !== o.outFile) renameSync(written, o.outFile);
  const css: string[] = [];
  const assets: string[] = [];
  for (const x of result.outputs) {
    if (x.kind === "entry-point") continue;
    if (x.kind === "chunk") throw new PluginBuildError([`${o.entry}: the build split it into chunks; a plugin entry is one module`]);
    if (extname(x.path) === ".css") css.push(x.path);
    else assets.push(x.path);
  }
  // The bundler marks where each input starts with a comment naming its path from this process's folder, which can
  // run through the folders above the checkout (a home folder's name): those lines go, and nothing else changes.
  const meta = typeof result.metafile === "string" ? JSON.parse(result.metafile) : result.metafile;
  const markers = new Set(Object.keys((meta as { inputs?: Record<string, unknown> } | undefined)?.inputs ?? {}).map((k) => `// ${k}`));
  const source = (await Bun.file(o.outFile).text()).split("\n").filter((line) => !markers.has(line)).join("\n");
  await Bun.write(o.outFile, source);
  const imports = [...new Set(new Bun.Transpiler({ loader: "js" }).scanImports(source).map((i) => i.path))].sort();
  const problems: string[] = [];
  const name = basename(o.outFile);
  for (const spec of imports) {
    if (!client && isRuntimeBuiltin(spec)) continue;
    if (!isBare(spec)) problems.push(`${name}: imports ${spec}; a built module imports no file and no URL`);
    else if (client) {
      if (!(CLIENT_BARE_IMPORTS as readonly string[]).includes(spec)) problems.push(`${name}: a client module imports ${spec}; only ${CLIENT_BARE_IMPORTS.join(", ")} come from the layer, everything else is bundled`);
    } else if (!kept.has(packageOfSpecifier(spec))) {
      problems.push(`${name}: imports ${spec}, which the build neither bundled nor ships`);
    }
  }
  problems.push(...runtimeLoadProblems(source, name, { client, allowed: (spec) => isRuntimeBuiltin(spec) || kept.has(packageOfSpecifier(spec)), builtins: o.builtins ?? [] }));
  // A stylesheet carries the same markers as `/* <path> */`.
  const cssMarkers = new Set(Object.keys((meta as { inputs?: Record<string, unknown> } | undefined)?.inputs ?? {}).map((k) => `/* ${k} */`));
  for (const f of css) await Bun.write(f, readFileSync(f, "utf8").split("\n").filter((line) => !cssMarkers.has(line)).join("\n"));
  for (const f of [o.outFile, ...css, ...assets]) problems.push(...forbiddenIn(f === o.outFile ? source : readFileSync(f, "latin1"), basename(f), o.forbid ?? []));
  if (problems.length > 0) throw new PluginBuildError(problems);
  return { file: o.outFile, source, css, assets, imports };
}

/** What a bundle's CommonJS `__dirname` and `__filename` become: the module's own, at run time. */
const DIRNAME = "__clover_dirname";
const FILENAME = "__clover_filename";

/** Each forbidden string in `text`, by its label. */
export function forbiddenIn(text: string, file: string, forbid: readonly Forbidden[]): string[] {
  const out: string[] = [];
  for (const f of forbid) {
    const hit = typeof f.text === "string" ? f.text !== "" && text.includes(f.text) : f.text.test(text);
    if (hit) out.push(`${file}: holds ${f.label}, a path of the computer that built it`);
  }
  return out;
}

/** The strings a build on this computer must not leave in what it ships: the home folder, the user's name as a path
 *  segment, and the given folders (the checkout, the plugin), each as written and with the other slash. */
export function buildMachineStrings(folders: readonly { path: string; label: string }[], home: string, user: string): Forbidden[] {
  const out: Forbidden[] = [];
  const both = (p: string) => [...new Set([p, p.replaceAll("\\", "/"), p.replaceAll("/", "\\")])];
  for (const { path, label } of [...folders, { path: home, label: "the home folder" }]) {
    if (path.length < 2) continue;
    for (const v of both(path)) out.push({ text: v, label });
  }
  // A short user name would match ordinary words in a path ("me", "ci"): only one of 3 or more characters is looked for.
  if (user.length >= 3) out.push({ text: new RegExp(`[/\\\\]${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]`), label: "the user's name in a path" });
  return out;
}

const literal = String.raw`\s*(["'])([^"'\\\n]*)\1\s*\)`;

/** Node's built-ins that load or run other code. Host code imports one only when its plugin names it in the manifest's
 *  `builtins` (#271's review, R1), and the OK says so; the rest of the scan can't follow what they load. */
export const CODE_LOADING_BUILTINS = ["module", "worker_threads", "vm", "child_process"] as const;
export type CodeLoadingBuiltin = (typeof CODE_LOADING_BUILTINS)[number];

/** The code-loading built-in a specifier names, if any (`node:vm`, `vm`, `node:child_process/…`). */
export function codeLoadingBuiltinOf(spec: string): CodeLoadingBuiltin | undefined {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  return (CODE_LOADING_BUILTINS as readonly string[]).find((b) => bare === b || bare.startsWith(`${b}/`)) as CodeLoadingBuiltin | undefined;
}

/** The bundler's own shims, which are the only places its loaders may be named: `var __require = import.meta.require;`
 *  (a Bun target) and `import { createRequire } from "node:module"; … var __require = createRequire(import.meta.url);`
 *  (a Node target). */
const SHIM_LINES = [/^var __require = import\.meta\.require;$/m, /^var __require = (?:\/\* @__PURE__ \*\/ )?createRequire\(import\.meta\.url\);$/m];
const NODE_SHIM_IMPORT = /^import \{ createRequire \} from "node:module";$/m;

/** `source` with the insides of its strings, template text, comments and regular expressions blanked (same length),
 *  so the scan reads only code: a library's prose that says "require" is no reference. A template's `${…}` stays
 *  code. Regular expressions are told from division by the token before them, the usual heuristic. */
export function codeOnly(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const templates: number[] = []; // brace depth at each open template's `${`
  let depth = 0;
  let i = 0;
  let last = ""; // the last significant character of code
  const n = source.length;
  const template = (from: number): number => {
    // In template text from `from`; returns where code resumes (after `${`) or the template ends (after the backtick).
    let k = from;
    while (k < n) {
      const c = source[k]!;
      if (c === "\\") k += 2;
      else if (c === "`") {
        blank(from, k);
        return k + 1;
      } else if (c === "$" && source[k + 1] === "{") {
        blank(from, k);
        templates.push(depth);
        depth++;
        return k + 2;
      } else k++;
    }
    blank(from, n);
    return n;
  };
  while (i < n) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end < 0 ? n : end + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && source[k] !== c && source[k] !== "\n") k += source[k] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(k, n));
      i = k + 1;
      last = c;
    } else if (c === "`") {
      i = template(i + 1);
      last = "`";
    } else if (c === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(source.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let k = i + 1;
      let cls = false;
      while (k < n && source[k] !== "\n") {
        const d = source[k]!;
        if (d === "\\") k += 2;
        else if (d === "[") (cls = true), k++;
        else if (d === "]") (cls = false), k++;
        else if (d === "/" && !cls) break;
        else k++;
      }
      blank(i + 1, Math.min(k, n));
      i = k + 1;
      last = "/";
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        if (templates.length > 0 && templates[templates.length - 1] === depth - 1) {
          templates.pop();
          depth--;
          i = template(i + 1);
          last = "`";
          continue;
        }
        depth--;
      }
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out.join("");
}

/** The loads in a module the scan can't check (see the file's header); `allowed` says which literal specifiers
 *  `require` may name (a client may name none), and `builtins` the code-loading built-ins the plugin named. */
export function runtimeLoadProblems(source: string, file: string, o: { client: boolean; allowed: (spec: string) => boolean; builtins?: readonly string[] }): string[] {
  const problems: string[] = [];
  const say = (n: number, what: string) => {
    if (n > 0) problems.push(`${file}: ${n} ${what}, which can't be checked`);
  };
  // The bundler's shim lines go first (they are the only places its loaders may be named); then only code is read.
  let text = source;
  const nodeShim = NODE_SHIM_IMPORT.test(text) && SHIM_LINES[1]!.test(text);
  for (const line of SHIM_LINES) text = text.replace(line, "");
  if (nodeShim) text = text.replace(NODE_SHIM_IMPORT, "");
  const code = codeOnly(text);
  const literalAt = (at: number) => new RegExp(String.raw`^\s*\(${literal}`).exec(text.slice(at));
  // import(): a string literal only (its specifier is checked with the static imports).
  let computedImports = 0;
  for (const m of code.matchAll(/(?<![\w$.])import\s*(?=\()/g)) if (literalAt(m.index! + m[0].length) === null) computedImports++;
  say(computedImports, "import() of a computed specifier");
  // A loader may only be called with a literal the module may import; any other reference to one is a load the scan
  // can't follow (aliased, passed on, read as a property; R1).
  let loaderRefs = 0;
  for (const m of code.matchAll(/(?<![\w$.])(?:require|__require)(?![\w$])|import\s*\.\s*meta\s*\.\s*(?:require|resolve)(?![\w$])/g)) {
    const call = m[0].endsWith("resolve") ? null : literalAt(m.index! + m[0].length);
    if (call === null) {
      loaderRefs++;
      continue;
    }
    const spec = call[2]!;
    const builtin = codeLoadingBuiltinOf(spec);
    if (o.client || !o.allowed(spec)) problems.push(`${file}: requires ${spec} at run time, which ${o.client ? "a client module never does" : "the build neither bundled nor ships"}`);
    else if (builtin !== undefined && !(o.builtins ?? []).includes(builtin)) problems.push(`${file}: requires ${spec}, which loads or runs other code; the plugin names it in its manifest's \`builtins\` to use it`);
  }
  say(loaderRefs, "reference(s) to a module loader outside a literal require");
  say([...code.matchAll(/\bdlopen\b|\bgetBuiltinModule\b|\b_load\b|\b_resolveFilename\b/g)].length, "reference(s) to process.dlopen, getBuiltinModule or Module's loader");
  // The same names reached by a computed member (`globalThis["process"]["dlopen"]`), and import.meta passed on.
  say([...text.matchAll(/\[\s*(["'`])(?:dlopen|getBuiltinModule|_load|_resolveFilename|require|__require|Worker|spawn|spawnSync|build|plugin|resolve|resolveSync|createRequire)\1\s*\]/g)].length, "computed reference(s) to a loader or a way to run code");
  say([...code.matchAll(/import\s*\.\s*meta(?!\s*\.\s*(?:url|dir|dirname|file|filename|path|main|env|require|resolve)\b)/g)].length, "use(s) of import.meta passed on");
  if (!o.client) {
    say([...code.matchAll(/(?<![\w$.])Worker(?![\w$])/g)].length, "reference(s) to Worker");
    say([...code.matchAll(/\bBun\s*\.\s*(?:spawn|spawnSync|build|plugin|resolve|resolveSync)\b|\bBun\s*\[|(?<![\w$.])Bun\s*(?=[;,)}\]])|=\s*Bun\s*(?![\s.\w$])|\}\s*=\s*Bun\b(?!\s*\.)/g)].length, "reference(s) to Bun's spawn, build, plugin or resolve, or Bun itself passed on");
    // A code-loading built-in, imported (statically, or with a literal import()), only when the plugin named it.
    for (const i of new Bun.Transpiler({ loader: "js" }).scanImports(source)) {
      const b = codeLoadingBuiltinOf(i.path);
      if (b === undefined || (o.builtins ?? []).includes(b)) continue;
      if (b === "module" && nodeShim && i.path === "node:module" && [...source.matchAll(/\bcreateRequire\b/g)].length === 2) continue; // the Node shim's own
      problems.push(`${file}: imports ${i.path}, which loads or runs other code; the plugin names it in its manifest's \`builtins\` to use it`);
    }
  }
  return problems;
}

/** Where a built module goes for a source entry, as a manifest path (with `/`): the same path with `.js`. */
export function builtModulePath(entry: string): string {
  return entry.replace(/\.(?:[cm]?[jt]sx?)$/, "") + ".js";
}
