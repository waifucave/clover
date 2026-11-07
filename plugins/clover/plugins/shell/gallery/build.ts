// Builds the gallery into a static page: `bun gallery/build.ts [outdir]` (default gallery/dist).
// The parts are separate workspace packages, each with its dependencies beside it, so React is pinned
// to this package's copy here: one React for every part in the bundle.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";

const here = import.meta.dir;
const shell = join(here, "..");

const oneReact: BunPlugin = {
  name: "one-react",
  setup(build) {
    // scheduler is react-dom's own dependency, not the shell's: it resolves from react-dom's folder (the root
    // workspace install keeps each package's dependencies beside it).
    const reactDom = dirname(Bun.resolveSync("react-dom/package.json", shell));
    build.onResolve({ filter: /^(react|react-dom|scheduler)(\/.*)?$/ }, (args) => ({ path: Bun.resolveSync(args.path, /^scheduler(\/|$)/.test(args.path) ? reactDom : shell) }));
  },
};

const HTML = `<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Clover parts gallery</title>
    <link rel="stylesheet" href="main.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="main.js" defer></script>
  </body>
</html>
`;

export interface GalleryBuild {
  outdir: string;
  files: string[];
}

/** A classic script (not a module), so the page also opens straight from disk. */
export async function buildGallery(outdir = join(here, "dist"), options: { production?: boolean } = {}): Promise<GalleryBuild> {
  const production = options.production ?? true;
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(here, "main.tsx")],
    outdir,
    target: "browser",
    format: "iife",
    minify: production,
    naming: "[name].[ext]",
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
    plugins: [oneReact],
    // Macros off: a plugin file's `with { type: "macro" }` import would run in this process (bun-types has no field for it).
    // LAST, so nothing after it turns them back on.
    ...{ macros: false },
  });
  if (!result.success) throw new AggregateError(result.logs, "the gallery did not build");
  writeFileSync(join(outdir, "index.html"), HTML);
  return { outdir, files: [...result.outputs.map((o) => o.path), join(outdir, "index.html")] };
}

if (import.meta.main) {
  const outdir = resolve(process.argv[2] ?? join(here, "dist"));
  console.log(`building the gallery into ${outdir}`);
  const build = await buildGallery(outdir);
  for (const file of build.files) console.log(`  ${file}`);
}
