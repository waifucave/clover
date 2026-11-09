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
// * no load the scan can't check (`runtimeLoadProblems`; #271's review M1, R1's sturdier rule, then #337's: a parse of
//   each module with acorn, never a pattern over its text, which a regular expression or a division could fool):
//   - host code imports a built-in that loads or runs other code (`module`, `worker_threads`, `vm`, `child_process`)
//     only when its top-level plugin names it in the manifest's `builtins` (which the OK card lists; a child can't);
//     the bundler's own Node shim (`createRequire`) is the one exception;
//   - outside the bundler's own shim, a module loader (`require`, `__require`, `import.meta.require`) may only be
//     called with one literal the module may import; any other reference to one, a `.require` member
//     (`module.require`, `process.mainModule.require`), `import.meta.resolve`, `dlopen`, `binding`, `mainModule`,
//     `getBuiltinModule`, `createRequire` or Module's loader, `eval`, `Function` (and a `.constructor(…)` call), as a
//     name, a member or a destructured key, fails the build;
//   - `import()` takes a string literal only, and `import.meta` isn't passed on;
//   - host code names no `Worker`, no `Bun.spawn`/`spawnSync`/`$`/`build`/`plugin`/`resolve`/`FFI` (however `Bun`
//     is reached: `globalThis["Bun"]`, destructured), and doesn't pass `Bun` itself on;
//   - a module that doesn't parse fails the build.
//   A client's Worker is the layer's to allow: its CSP gives `worker-src` only `'self' blob:` (lane E).
//
//   This is a best-effort lint, not containment: it keeps the common ways to load or run code out of what Clover
//   builds and ships, and a determined plugin can still get past it (a computed member it can't name, code it
//   assembles). What holds a plugin's host code is its process's fence (`plugin-fence.ts`, 2f), and the OK card says
//   so.
import { CLIENT_BARE_IMPORTS } from "@waifucave/clover-plugin-sdk";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, extname, resolve } from "node:path";

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
  /**
   * Every file the bundler read into it (its metafile's inputs), absolute, sorted. The bundler inlines whatever an
   * entry imports, wherever it is, so a release build checks each of these against what it may ship.
   */
  inputs: string[];
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
      // NO MACROS. A plugin file importing `with { type: "macro" }` would run that function in THIS process at build
      // time and inline what it returns (a file it read, the builder's environment): plugin code running in the
      // builder, which can be the daemon. Off, such an import fails the build ("Macros are disabled"). bun-types has
      // no field for it, hence the spread; Bun refuses macros from node_modules on its own.
      // LAST, so nothing after it turns them back on.
      ...{ macros: false },
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
  const inputKeys = Object.keys((meta as { inputs?: Record<string, unknown> } | undefined)?.inputs ?? {});
  // The metafile names each input from this process's folder.
  const inputs = [...new Set(inputKeys.map((k) => resolve(process.cwd(), k)))].sort();
  const markers = new Set(inputKeys.map((k) => `// ${k}`));
  const source = (await Bun.file(o.outFile).text()).split("\n").filter((line) => !markers.has(line)).join("\n");
  await Bun.write(o.outFile, source);
  const imports = [...new Set(new Bun.Transpiler({ loader: "js", ...({ macro: false } as object) }).scanImports(source).map((i) => i.path))].sort();
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
  return { file: o.outFile, source, css, assets, imports, inputs };
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
  // As a whole path segment only (`/ci/`, never "ci" in a word), so a short name is looked for too (#337's review).
  if (user !== "") out.push({ text: new RegExp(`[/\\\\]${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]`), label: "the user's name in a path" });
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

/** Names that load, run or reach code the scan can't follow, flagged wherever they're referenced (as a bare name, a
 *  property, a computed `["…"]` member or a destructured key). */
const LOADER_NAMES = new Set(["dlopen", "getBuiltinModule", "_load", "_resolveFilename", "createRequire"]);
/** `process`'s members that reach a loader or native code, flagged on `process` however it's reached (a library's own
 *  `binding` or `mainModule` is no loader). */
const PROCESS_LOADERS = new Set(["binding", "_linkedBinding", "mainModule"]);
/** Bun's members that run, build or load code: flagged on `Bun` however it's reached (`Bun.x`, `globalThis.Bun.x`,
 *  `globalThis["Bun"]["x"]`). */
const BUN_RUNNERS = new Set(["spawn", "spawnSync", "build", "plugin", "resolve", "resolveSync", "$", "Transpiler", "FFI", "dlopen", "connect", "listen"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window"]);

/** The name a member's property gives, when it's a plain name or a string literal; undefined when computed. */
function memberName(m: acorn.MemberExpression): string | undefined {
  if (!m.computed && m.property.type === "Identifier") return m.property.name;
  if (m.computed && m.property.type === "Literal" && typeof m.property.value === "string") return m.property.value;
  if (m.computed && m.property.type === "TemplateLiteral" && m.property.expressions.length === 0) return m.property.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/** Whether an expression is a global (`Bun`, `process`): the name, or a global object's member of that name. */
function isGlobal(e: acorn.AnyNode | null | undefined, name: string): boolean {
  if (e == null) return false;
  if (e.type === "Identifier") return e.name === name;
  if (e.type === "MemberExpression") return memberName(e) === name && e.object.type === "Identifier" && GLOBAL_OBJECTS.has(e.object.name);
  return false;
}
const isBun = (e: acorn.AnyNode) => isGlobal(e, "Bun");

/** The loads in a module the scan can't check (see the file's header): a parse of the module (acorn), never a pattern
 *  over its text (#337's review: a regular expression after `}` and `.require` slipped past the old reading).
 *  `allowed` says which literal specifiers `require` may name (a client may name none), and `builtins` the
 *  code-loading built-ins the plugin named. A module that doesn't parse is refused. This is a lint that keeps the
 *  common ways out of a plugin's build, not a boundary: the plugin-process fence is (2f). */
export function runtimeLoadProblems(source: string, file: string, o: { client: boolean; allowed: (spec: string) => boolean; builtins?: readonly string[] }): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  const flag = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);
  let ast: acorn.Program;
  try {
    ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (err) {
    return [`${file}: doesn't parse as a JavaScript module (${(err as Error).message}), so its loads can't be checked`];
  }
  const nodeShim = NODE_SHIM_IMPORT.test(source) && SHIM_LINES[1]!.test(source);
  const checkSpec = (spec: string) => {
    const builtin = codeLoadingBuiltinOf(spec);
    if (o.client || !o.allowed(spec)) problems.push(`${file}: requires ${spec} at run time, which ${o.client ? "a client module never does" : "the build neither bundled nor ships"}`);
    else if (builtin !== undefined && !(o.builtins ?? []).includes(builtin)) problems.push(`${file}: requires ${spec}, which loads or runs other code; the plugin names it in its manifest's \`builtins\` to use it`);
  };
  // First pass: the nodes the checks account for (the bundler's shim, a loader called with a literal), so the second
  // pass, which visits children before their parents, doesn't flag their parts.
  const handled = new Set<acorn.AnyNode>();
  const handle = (e: acorn.AnyNode) => {
    handled.add(e);
    if (e.type === "MemberExpression") handled.add(e.object);
  };
  walk.full(ast, (node) => {
    const n = node as acorn.AnyNode;
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.id.name === "__require" && n.init) {
      // The bundler's shims: `var __require = import.meta.require;` and `var __require = createRequire(import.meta.url);`.
      const init = n.init;
      if (init.type === "MemberExpression" && init.object.type === "MetaProperty" && memberName(init) === "require") handle(init);
      if (nodeShim && init.type === "CallExpression" && init.callee.type === "Identifier" && init.callee.name === "createRequire" && init.arguments.length === 1) {
        const arg = init.arguments[0]!;
        if (arg.type === "MemberExpression" && arg.object.type === "MetaProperty" && memberName(arg) === "url") {
          handle(init.callee);
          handle(arg);
        }
      }
    } else if (n.type === "CallExpression") {
      // A loader called with one literal: the literal is checked, the loader is accounted for.
      const c = n.callee;
      const loader = (c.type === "Identifier" && (c.name === "require" || c.name === "__require"))
        || (c.type === "MemberExpression" && c.object.type === "MetaProperty" && memberName(c) === "require");
      const arg = n.arguments[0];
      if (loader && n.arguments.length === 1 && arg?.type === "Literal" && typeof arg.value === "string") {
        handle(c);
        checkSpec(arg.value);
      }
    }
  });
  const loaderRef = "reference(s) to a module loader outside a literal require";
  const loaderName = "reference(s) to a loader (process.dlopen, binding or mainModule, getBuiltinModule, Module's loader, createRequire)";
  const bunRunner = "reference(s) to Bun's spawn, build, plugin, resolve, $ or FFI";
  const bunItself = "reference(s) to Bun itself passed on";
  // A name read: as a reference (`eval`), a member (`process.binding`, `x["dlopen"]`) or a destructured key.
  const named = (name: string, onBun: boolean, onProcess = false) => {
    if (name === "require" || name === "__require") flag(loaderRef);
    else if (LOADER_NAMES.has(name) || (onProcess && PROCESS_LOADERS.has(name))) flag(loaderName);
    else if (name === "eval") flag("use(s) of eval");
    else if (name === "Function") flag("use(s) of Function (new Function runs a string as code)");
    else if (!o.client && name === "Worker") flag("reference(s) to Worker");
    else if (!o.client && onBun && BUN_RUNNERS.has(name)) flag(bunRunner);
    else if (!o.client && name === "Bun") flag(bunItself);
  };
  walk.fullAncestor(ast, (node, _state, ancestors, type) => {
    const n = node as acorn.AnyNode;
    if (handled.has(n)) return;
    const parent = ancestors[ancestors.length - 2] as acorn.AnyNode | undefined;
    const isObjectOf = parent?.type === "MemberExpression" && parent.object === n;
    switch (n.type) {
      case "ImportExpression":
        if (n.source.type !== "Literal" || typeof n.source.value !== "string") flag("import() of a computed specifier");
        return;
      case "CallExpression":
        // `(…).constructor("code")`: Function by another name.
        if (n.callee.type === "MemberExpression" && memberName(n.callee) === "constructor") flag("call(s) of a constructor property (Function by another name)");
        return;
      case "Identifier":
        // A reference, not a name being declared or bound (a declared name does nothing by itself; reading it is
        // what's judged, and a destructured key is judged at its pattern). A non-computed key is never visited. Bun as
        // a member's object is judged at the member.
        if (type === "VariablePattern" || type === "Pattern") return;
        if (n.name === "Bun" && isObjectOf) return;
        named(n.name, false);
        return;
      case "MemberExpression": {
        if (n.object.type === "MetaProperty") {
          const name = memberName(n);
          // import.meta's plain facts are fine; require only in a literal call (the first pass), resolve never.
          if (name === "require" || name === "resolve") flag(loaderRef);
          else if (name === undefined || !["url", "dir", "dirname", "file", "filename", "path", "main", "env"].includes(name)) flag("use(s) of import.meta passed on");
          return;
        }
        const name = memberName(n);
        if (name === undefined) return; // a computed key the scan can't name: the fence's
        const viaGlobal = n.object.type === "Identifier" && GLOBAL_OBJECTS.has(n.object.name);
        if (name === "Bun" && viaGlobal && isObjectOf) return; // judged at the member it's the object of
        named(name, isBun(n.object), isGlobal(n.object, "process"));
        return;
      }
      case "ObjectPattern": {
        // `const { spawn } = Bun`, `const { mainModule } = process`, `const { Bun: B } = globalThis`: a key is read
        // from what the pattern destructures, when the scan can see it.
        const from = parent?.type === "VariableDeclarator" && parent.id === n ? parent.init : parent?.type === "AssignmentExpression" && parent.left === n ? parent.right : undefined;
        for (const p of n.properties) {
          if (p.type !== "Property") continue;
          const key = !p.computed && p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" && typeof p.key.value === "string" ? p.key.value : undefined;
          if (key === undefined) continue;
          const onGlobalObject = from?.type === "Identifier" && GLOBAL_OBJECTS.has(from.name);
          if (key === "Bun") {
            if (onGlobalObject) named(key, false);
          } else if (key === "process") {
            if (onGlobalObject) flag(loaderName);
          } else named(key, isGlobal(from, "Bun"), isGlobal(from, "process"));
        }
        return;
      }
      case "MetaProperty":
        if (!isObjectOf) flag("use(s) of import.meta passed on");
        return;
    }
  });
  for (const [what, n] of counts) problems.push(`${file}: ${n} ${what}, which can't be checked`);
  if (!o.client) {
    // A code-loading built-in, imported (statically, or with a literal import()), only when the plugin named it.
    for (const i of new Bun.Transpiler({ loader: "js", ...({ macro: false } as object) }).scanImports(source)) {
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
