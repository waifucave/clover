// F2b: a bundled part is built as a third party's folder is. No file of any of MOSS's bundled plugins (its client and
// host code, its tests and its gallery) imports anything outside its own folder but public packages: the UI SDK
// (`@waifucave/moss-plugin-sdk` and its subpaths), React, and the npm packages its own package.json names. Never
// another plugin's folder, the protocol package, the app's or the core's source; and the app's build swaps nothing in
// (no build alias, no `./sdk` substitution), so the client entry it bundles is the one a folder copy builds.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const BUNDLED = join(REPO, "plugins", "moss", "plugins");

/** The npm packages a bundled plugin may import besides its own files. */
const PUBLIC = /^(react|react-dom|@waifucave\/moss-plugin-sdk)(\/|$)/;
const NODE = /^(node:|bun:|bun$)/;

const SPEC = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "out" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|mts|js|mjs|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** A relative path with `/` between its parts, whatever the OS: the pending rulings below name files that way. */
const slashed = (p: string): string => p.split(sep).join("/");

/** What one bundled plugin's files import from outside it: `<file>: <specifier>` lines. */
export function outsideImports(pluginDir: string): string[] {
  // What a file may import: what the package.json files between it and the plugin's folder name (its own, a gallery's).
  const named = (dir: string): string[] => {
    const pkgPath = join(dir, "package.json");
    const pkg = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string> | undefined>) : {};
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
  };
  const ownFor = (file: string): Set<string> => {
    const out = new Set<string>();
    for (let dir = dirname(file); dir === pluginDir || dir.startsWith(pluginDir + sep); dir = dirname(dir)) for (const n of named(dir)) out.add(n);
    return out;
  };
  const bad: string[] = [];
  for (const file of files(pluginDir)) {
    const own = ownFor(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(SPEC)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec === undefined) continue;
      const at = `${slashed(relative(BUNDLED, file))}: ${spec}`;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (target !== pluginDir && !target.startsWith(pluginDir + sep)) bad.push(at);
        continue;
      }
      if (spec.startsWith("/")) { bad.push(at); continue; }
      if (NODE.test(spec) || PUBLIC.test(spec)) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      // Another of MOSS's own packages (a plugin's, the protocol): never; a package of the org's that is published on
      // its own (a runtime a plugin depends on) is any npm package.
      if (name.startsWith("@waifucave/moss-") || name.startsWith("@moss-child")) { bad.push(at); continue; }
      if (!own.has(name)) bad.push(`${at} (not in its package.json)`);
    }
  }
  return bad;
}

/** The bundled plugins with parts (a client entry): the ones the app's `moss` layer bundles. */
const withParts = readdirSync(BUNDLED).filter((n) => {
  const m = join(BUNDLED, n, "moss.json");
  return existsSync(m) && (JSON.parse(readFileSync(m, "utf8")) as { client?: { entry?: string } }).client?.entry !== undefined;
});
/** Those, and the base theme (a look the parts are drawn in, with a gallery of its own): every file of each is scanned,
 *  its tests and its galleries too. The host-only plugins (model providers, the browser's host half) are not UI parts. */
const plugins = [...withParts, ...(withParts.includes("base-theme") ? [] : ["base-theme"])];

/** Every package.json in a plugin's folder (its own, a gallery's): the MOSS packages each depends on but the SDK. */
export function mossDependencies(pluginDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "out" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "package.json") {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as Record<string, Record<string, string> | undefined>;
        for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies })) {
          if ((dep.startsWith("@waifucave/moss-") && dep !== "@waifucave/moss-plugin-sdk") || dep.startsWith("@moss-child")) out.push(`${slashed(relative(BUNDLED, p))}: ${dep}`);
        }
      }
    }
  };
  walk(pluginDir);
  return out;
}

/** The named exceptions, by plugin: each a pattern of `<file>: <specifier>` lines. Only the two whole-app galleries are
 *  left: dev-only pages that draw many parts together (never shipped, never loaded by the app), which move out of
 *  `plugins/` to one `apps/gallery` workspace after try 15 (backlog). The test fails on any other import, and on a
 *  pattern that no longer matches (the list only shrinks). */
const PENDING_RULING: Record<string, readonly RegExp[]> = {
  // A whole-app gallery, dev-only: the whole window, every bundled part together (moves to apps/gallery after try 15).
  shell: [/^shell\/(gallery\/[^:]+|test\/gallery\.test\.ts):/],
  // A whole-app gallery, dev-only: the look, the island with other plugins' tabs, the pill, the avatars, usage and
  // notifications together (lane G's package; moves to apps/gallery after try 15).
  "base-theme": [/^base-theme\/gallery\/src\/(main|alpha|island-tabs)\.tsx: \.\.\/\.\.\/\.\.\//],
};

/** The same, for package.json dependencies (pending the same rulings). */
const PENDING_DEPENDENCY: Record<string, readonly RegExp[]> = {};

describe("each bundled plugin is a folder of its own (F2b)", () => {
  for (const name of plugins) {
    test(`${name} imports nothing outside its folder but public packages`, () => {
      const pending = PENDING_RULING[name] ?? [];
      const found = outsideImports(join(BUNDLED, name));
      expect(found.filter((line) => !pending.some((p) => p.test(line)))).toEqual([]);
      // Each pending pattern still matches something: once fixed, it leaves the list.
      for (const p of pending) expect([String(p), found.some((line) => p.test(line))]).toEqual([String(p), true]);
    });

    test(`${name}'s package.json files depend on no other MOSS package but the SDK`, () => {
      const pending = PENDING_DEPENDENCY[name] ?? [];
      const found = mossDependencies(join(BUNDLED, name));
      expect(found.filter((line) => !pending.some((p) => p.test(line)))).toEqual([]);
      for (const p of pending) expect([String(p), found.some((line) => p.test(line))]).toEqual([String(p), true]);
    });
  }

  test("the app's build substitutes nothing for a part: no build alias, no ./sdk swap", () => {
    const build = readFileSync(join(import.meta.dir, "..", "scripts", "build.ts"), "utf8");
    expect(build).not.toMatch(/@moss-child|onResolve|childAlias/);
    expect(existsSync(join(import.meta.dir, "..", "src", "layer", "moss", "sdk.ts"))).toBe(false);
    for (const n of withParts) expect([n, existsSync(join(BUNDLED, n, "client", "sdk.ts")) || existsSync(join(BUNDLED, n, "client", "sdk.tsx"))]).toEqual([n, false]);
  });
});
