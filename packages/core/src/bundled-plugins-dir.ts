// Where an installed build's bundled plugins are (the registry's `bundledDirs`): `<dirname(clover-core)>/../plugins`,
// but ONLY when the core sits in a daemon folder the installer made, never derived from wherever a binary happens to
// be. A server's old layout put the core at `<cloverHome>/bin/clover-core`, and `../plugins` from there is
// `<cloverHome>/plugins`, the user's own plugins folder, which must never be read as bundled (bundled plugins are
// approved without a card). The two shapes that qualify:
//   - an app: `…/resources/daemon/clover-core` → `…/resources/plugins` (scripts/release/bundled-plugins.ts);
//   - a server (#244): `<cloverHome>/bin/daemon/clover-core` → `<cloverHome>/bin/plugins`.
// Anything else (a dev checkout, `bun` itself, an old server layout) has none.
import { basename, dirname, join, resolve } from "node:path";

/** The bundled plugins folder for the core at `execPath`, or undefined when its place isn't an installed layout. */
export function bundledPluginsDir(execPath: string, cloverHome?: string): string | undefined {
  const daemonDir = dirname(resolve(execPath));
  if (basename(daemonDir) !== "daemon") return undefined;
  const parent = dirname(daemonDir);
  const inApp = basename(parent).toLowerCase() === "resources";
  const inServer = cloverHome !== undefined && parent === resolve(cloverHome, "bin");
  if (!inApp && !inServer) return undefined;
  const dir = join(parent, "plugins");
  // Belt and braces: never the user's own plugins folder.
  if (cloverHome !== undefined && dir === resolve(cloverHome, "plugins")) return undefined;
  return dir;
}
