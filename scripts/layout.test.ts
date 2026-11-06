// The repo layout's conventions (docs/clover-layout.md, plan §7), as far as a test can check them: the workspace
// globs, package names and fields, plugin manifests, services' wrangler configs, the native areas' READMEs, and one
// lockfile. A new package or plugin that breaks one fails here, with the convention it broke.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { workspacePackages, type WorkspacePackage } from "./workspaces";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const isDir = (rel: string): boolean => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isDirectory();
const dirsIn = (rel: string): string[] => (isDir(rel) ? readdirSync(join(ROOT, rel)).filter((d) => !d.startsWith(".") && d !== "node_modules" && isDir(`${rel}/${d}`)).sort() : []);

/** The globs the layout needs, in the root package.json and pnpm-workspace.yaml alike. */
const REQUIRED_GLOBS = ["packages/*", "apps/*", "plugins/*", "plugins/*/*", "plugins/*/plugins/*", "services/*", "native/*"];

/** The name a package in `dir` must have, or undefined where the layout leaves the name alone (spikes, examples). */
export function expectedPackageName(dir: string): string | undefined {
  const parts = dir.split("/");
  const [area, a, b] = parts;
  if (area === "packages" && parts.length === 2) return `@waifucave/clover-${a}`;
  if (area === "apps" && parts.length === 2) return `@waifucave/clover-${a}`;
  if (area === "services" && parts.length === 2) return `@waifucave/clover-service-${a}`;
  if (area === "native" && parts.length === 2) return `@waifucave/clover-native-${a}`;
  if (area === "plugins" && parts.length === 2) return `@waifucave/clover-plugin-${a}`;
  // A child lives in its parent's plugins/ folder, as installed (spec §5.1): plugins/<plugin>/plugins/<child>. A package
  // in one of a plugin's own folders (Alpha's tab look) is named for the plugin and the folder.
  if (area === "plugins" && parts.length === 4 && b === "plugins") return a === "clover" ? `@waifucave/clover-plugin-${parts[3]}` : `@waifucave/clover-plugin-${a}-${parts[3]}`;
  if (area === "plugins" && parts.length === 3 && b !== "plugins") return a === "clover" ? `@waifucave/clover-plugin-${b}` : `@waifucave/clover-plugin-${a}-${b}`;
  return undefined;
}

function rootWorkspaces(): string[] {
  const pkg = JSON.parse(read("package.json")) as { workspaces: string[] };
  return pkg.workspaces;
}

function pnpmWorkspaces(): string[] {
  return [...read("pnpm-workspace.yaml").matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]!);
}

const governed = (p: WorkspacePackage): boolean => expectedPackageName(p.dir) !== undefined;

/** Top-level plugin folders whose clover.json an open pull request adds. Until it lands such a folder may have none;
 *  once it does, the manifest is checked like any other, and the entry can go. */
export const MANIFEST_AWAITS: Readonly<Record<string, string>> = {};

/** The one folder under services/ that is not a Worker: the source the Workers share, a package others import by name
 *  (each Worker's tsconfig includes it). */
const SERVICES_SHARED = "shared";

describe("the repo layout (docs/clover-layout.md)", () => {
  test("one workspace list: the root package.json and pnpm-workspace.yaml agree, and hold the layout's globs", () => {
    const bun = rootWorkspaces();
    const pnpm = pnpmWorkspaces();
    for (const glob of REQUIRED_GLOBS) expect(bun, `package.json workspaces needs ${glob}`).toContain(glob);
    // pnpm alone also lists the browser extension, which is a pnpm package and not a bun workspace.
    expect(pnpm.filter((g) => g !== "extensions/*")).toEqual(bun);
  });

  test("each package in a governed folder is named for it, private, an ES module, and has its own test script", () => {
    const problems: string[] = [];
    for (const p of workspacePackages(ROOT).filter(governed)) {
      const pkg = JSON.parse(read(`${p.dir}/package.json`)) as { name: string; private?: boolean; type?: string; scripts?: Record<string, string> };
      const want = expectedPackageName(p.dir)!;
      if (pkg.name !== want) problems.push(`${p.dir}: named ${pkg.name}, the layout names it ${want}`);
      if (pkg.private !== true) problems.push(`${p.dir}: not "private": true`);
      if (pkg.type !== "module") problems.push(`${p.dir}: not "type": "module"`);
      if (pkg.scripts?.test === undefined) problems.push(`${p.dir}: no test script`);
      if (existsSync(join(ROOT, p.dir, "tsconfig.json")) && pkg.scripts?.typecheck === undefined) problems.push(`${p.dir}: a tsconfig.json but no typecheck script`);
    }
    expect(problems).toEqual([]);
  });

  test("a governed package's tsconfig extends the one shared base", () => {
    const problems: string[] = [];
    for (const p of workspacePackages(ROOT).filter(governed)) {
      const file = `${p.dir}/tsconfig.json`;
      if (!existsSync(join(ROOT, file))) continue;
      const config = Bun.JSONC.parse(read(file)) as { extends?: string };
      const base = `${"../".repeat(p.dir.split("/").length)}tsconfig.base.json`;
      if (config.extends !== base) problems.push(`${file}: extends ${String(config.extends)}, not ${base}`);
    }
    expect(problems).toEqual([]);
  });

  test("one lockfile, at the root: no package keeps one of its own", () => {
    const own = workspacePackages(ROOT).flatMap((p) =>
      ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].filter((f) => existsSync(join(ROOT, p.dir, f))).map((f) => `${p.dir}/${f}`));
    expect(own).toEqual([]);
  });

  test("plugins: a top-level plugin's clover.json names it by its folder; a child's has no id", () => {
    const problems: string[] = [];
    for (const top of dirsIn("plugins")) {
      const file = `plugins/${top}/clover.json`;
      if (existsSync(join(ROOT, file))) {
        const m = Bun.JSONC.parse(read(file)) as { manifest?: unknown; id?: unknown; name?: unknown };
        if (m.manifest !== 1) problems.push(`${file}: manifest is not 1`);
        if (m.id !== top) problems.push(`${file}: id ${JSON.stringify(m.id)}, but a top-level plugin's id is its folder's name, ${JSON.stringify(top)}`);
        if (m.name === undefined) problems.push(`${file}: no name`);
      } else if (MANIFEST_AWAITS[top] === undefined) {
        problems.push(`plugins/${top}: no clover.json`);
        continue;
      }
      for (const own of dirsIn(`plugins/${top}`)) {
        // A child sits in plugins/<top>/plugins/, never beside the plugin's own folders (assets, code, Alpha's tab).
        if (own !== "plugins" && existsSync(join(ROOT, "plugins", top, own, "clover.json"))) problems.push(`plugins/${top}/${own}: a child plugin goes in plugins/${top}/plugins/${own}`);
      }
      for (const child of dirsIn(`plugins/${top}/plugins`)) {
        const childFile = `plugins/${top}/plugins/${child}/clover.json`;
        if (!existsSync(join(ROOT, childFile))) { problems.push(`plugins/${top}/plugins/${child}: no clover.json (only children go in plugins/)`); continue; }
        const c = Bun.JSONC.parse(read(childFile)) as { manifest?: unknown; id?: unknown; name?: unknown };
        if (c.manifest !== 1) problems.push(`${childFile}: manifest is not 1`);
        if (c.id !== undefined) problems.push(`${childFile}: a child has no id (it takes its parent's)`);
        if (c.name === undefined) problems.push(`${childFile}: no name`);
      }
    }
    expect(problems).toEqual([]);
    // Clover's own plugin is here from the start; Alpha's folder comes with lane D's bot (D-M1).
    expect(dirsIn("plugins")).toContain("clover");
  });

  test("services: each one is a Worker with its wrangler config; services/shared is their shared source, a package and not a Worker", () => {
    const wrangler = (s: string): boolean => ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].some((f) => existsSync(join(ROOT, "services", s, f)));
    const workers = dirsIn("services").filter((s) => s !== SERVICES_SHARED);
    expect(workers.filter((s) => !wrangler(s))).toEqual([]);
    expect(workers).toContain("hello");
    expect(wrangler(SERVICES_SHARED)).toBe(false);
    // Imported by name: every file it exports exists, and nothing outside services/ reaches into it by relative path.
    const shared = JSON.parse(read(`services/${SERVICES_SHARED}/package.json`)) as { name: string; exports?: Record<string, string> };
    expect(shared.name).toBe(expectedPackageName(`services/${SERVICES_SHARED}`)!);
    const exported = Object.values(shared.exports ?? {});
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.filter((f) => !existsSync(join(ROOT, "services", SERVICES_SHARED, f)))).toEqual([]);
    const reaching = Bun.spawnSync(["git", "grep", "-lE", "from \"(\\.\\./)+(services/shared|test-harness/src)/", "--", "packages", "apps", "plugins", "scripts"], { cwd: ROOT }).stdout.toString().trim();
    expect(reaching).toBe("");
  });

  test("native: each area has its README, and native/README.md lists it", () => {
    const index = read("native/README.md");
    const problems: string[] = [];
    for (const area of dirsIn("native")) {
      if (!existsSync(join(ROOT, "native", area, "README.md"))) problems.push(`native/${area}: no README.md`);
      if (!index.includes(`\`${area}/\``)) problems.push(`native/README.md does not list ${area}/`);
    }
    expect(problems).toEqual([]);
  });

  test("CI is one set of workflows: no lane keeps its own (their checks run in ci.yml, galleries included)", () => {
    const lane = readdirSync(join(ROOT, ".github", "workflows")).filter((f) => /^lane-.*\.ya?ml$/.test(f));
    expect(lane).toEqual([]);
    expect(read(".github/workflows/ci.yml")).toContain("bun scripts/workspaces.ts run gallery");
  });

  test("the conventions' names follow the folders", () => {
    expect(expectedPackageName("packages/core")).toBe("@waifucave/clover-core");
    expect(expectedPackageName("apps/desktop")).toBe("@waifucave/clover-desktop");
    expect(expectedPackageName("plugins/clover/plugins/shell")).toBe("@waifucave/clover-plugin-shell");
    expect(expectedPackageName("plugins/alpha/tab")).toBe("@waifucave/clover-plugin-alpha-tab");
    expect(expectedPackageName("plugins/alpha/plugins/x")).toBe("@waifucave/clover-plugin-alpha-x");
    expect(expectedPackageName("plugins/clover/plugins")).toBeUndefined();
    expect(expectedPackageName("plugins/alpha")).toBe("@waifucave/clover-plugin-alpha");
    expect(expectedPackageName("services/forwarder")).toBe("@waifucave/clover-service-forwarder");
    expect(expectedPackageName("native/mounts")).toBe("@waifucave/clover-native-mounts");
    expect(expectedPackageName("spikes/bun-compile")).toBeUndefined();
    expect(expectedPackageName("examples/sample-echo")).toBeUndefined();
  });
});
