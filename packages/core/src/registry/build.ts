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
// * no load the scan can't check (`runtimeLoadProblems`): `import()` of anything but a string literal, `require` (or
//   `__require`, `import.meta.require`) of anything but a literal the module may import, `createRequire` outside the
//   bundler's own `__require` shim, `process.getBuiltinModule` of `module` or of a computed name, a `Worker`,
//   `Bun.resolve`/`Bun.resolveSync`, `import.meta.resolve` and `process.dlopen`.
import { CLIENT_BARE_IMPORTS } from "@waifucave/clover-plugin-sdk";
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
  problems.push(...runtimeLoadProblems(source, name, { client, allowed: (spec) => isRuntimeBuiltin(spec) || kept.has(packageOfSpecifier(spec)) }));
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
  if (user.length > 0) out.push({ text: new RegExp(`[/\\\\]${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]`), label: "the user's name in a path" });
  return out;
}

const literal = String.raw`\s*(["'])([^"'\\\n]*)\1\s*\)`;

/** The loads in a module the scan can't check (see the file's header); `allowed` says which literal specifiers
 *  `require` may name (a client may name none). */
export function runtimeLoadProblems(source: string, file: string, o: { client: boolean; allowed: (spec: string) => boolean }): string[] {
  const problems: string[] = [];
  const count = (re: RegExp) => [...source.matchAll(re)].length;
  const say = (n: number, what: string) => {
    if (n > 0) problems.push(`${file}: ${n} ${what}, which can't be checked`);
  };
  // import(): a string literal only (its specifier is checked with the static imports).
  say(count(/(?<![\w$.])import\s*\(/g) - count(new RegExp(String.raw`(?<![\w$.])import\s*\(${literal}`, "g")), "import() of a computed specifier");
  // require: a literal the module may import; the bundler's own shims are assignments, not calls.
  const requireCall = String.raw`(?<![\w$.])(?:require|__require|import\.meta\.require)\s*\(`;
  const literals = [...source.matchAll(new RegExp(requireCall + literal, "g"))];
  say(count(new RegExp(requireCall, "g")) - literals.length, "require() of a computed specifier");
  for (const m of literals) {
    const spec = m[2]!;
    if (o.client || !o.allowed(spec)) problems.push(`${file}: requires ${spec} at run time, which ${o.client ? "a client module never does" : "the build neither bundled nor ships"}`);
  }
  // createRequire: only the bundler's `var __require = createRequire(import.meta.url);` (a Node target's shim).
  say(count(/(?<![\w$])createRequire\s*\(/g) - count(/var __require = (?:\/\* @__PURE__ \*\/ )?createRequire\(import\.meta\.url\);/g), "createRequire() call(s)");
  const builtins = [...source.matchAll(new RegExp(String.raw`process\s*\.\s*getBuiltinModule\s*\(${literal}`, "g"))];
  say(count(/process\s*\.\s*getBuiltinModule\s*\(/g) - builtins.length, "process.getBuiltinModule() of a computed name");
  for (const m of builtins) if (m[2] === "module" || m[2] === "node:module") problems.push(`${file}: takes node:module through process.getBuiltinModule, a way to load anything`);
  // A host's Worker loads a file the scan never saw. A client's runs only what the layer's CSP lets a plugin origin
  // start (its own files, or a blob of code already in the bundle, as Mochi2D's decoder is), so it is the layer's rule.
  if (!o.client) say(count(/(?<![\w$.])new\s+(?:[\w$]+\s*\.\s*)?Worker\s*\(/g), "Worker(s) started from a path or URL");
  say(count(/(?<![\w$])Bun\s*\.\s*resolve(?:Sync)?\s*\(/g) + count(/import\.meta\.resolve\s*\(/g), "module resolution call(s)");
  say(count(/(?<![\w$])process\s*\.\s*dlopen\s*\(/g), "process.dlopen() call(s)");
  return problems;
}

/** Where a built module goes for a source entry, as a manifest path (with `/`): the same path with `.js`. */
export function builtModulePath(entry: string): string {
  return entry.replace(/\.(?:[cm]?[jt]sx?)$/, "") + ".js";
}
