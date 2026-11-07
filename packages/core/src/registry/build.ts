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
import { CLIENT_BARE_IMPORTS } from "@waifucave/clover-plugin-sdk";
import { mkdirSync, renameSync } from "node:fs";
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
  /** The entry's source file (absolute). */
  entry: string;
  /** The module to write (absolute); its folder is created. Stylesheets and assets go beside it. */
  outFile: string;
  side: BuildSide;
  /** Host and program side: a bare import (its specifier and the importing file) to leave as an import, for a package
   *  the caller ships beside the module. Asked once per import the bundler meets. */
  keepExternal?: (spec: string, importer: string) => boolean;
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
      ...(client ? { external: [...CLIENT_BARE_IMPORTS], define: { "process.env.NODE_ENV": JSON.stringify("production") } } : {}),
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
  if (problems.length > 0) throw new PluginBuildError(problems);
  return { file: o.outFile, source, css, assets, imports };
}

/** Where a built module goes for a source entry, as a manifest path (with `/`): the same path with `.js`. */
export function builtModulePath(entry: string): string {
  return entry.replace(/\.(?:[cm]?[jt]sx?)$/, "") + ".js";
}
