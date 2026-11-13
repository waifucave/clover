// Every bundled plugin's host half reaches only members of the plugin API the catalog (`API_CALLS`) lists for host code,
// and none it marks not served yet. A member outside the catalog (`api.env`, `api.log`, `api.computer`) fails where it is
// read in the host process (the proxy throws, by name), so a bundled half that reaches one is broken: this scan finds it
// in the source first. The host halves take the SDK's own `HostPluginApi` (or a `Pick` of it) as their type, so the type
// checker holds what this scan can't see (a member read through a variable).
//
// A host half's files are its `host.entry` and every file it imports, transitively, inside its plugin's folder. Comments
// and strings are blanked first (`api.fish.audio` in a comment, `https://api.hetzner.cloud` in a string).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { API_CALLS, type ApiCallInfo } from "@waifucave/clover-plugin-sdk";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const PLUGINS = join(ROOT, "plugins");

/** Bundled host halves the scan skips, by plugin id, with why. Each must still fail the scan: one that passes comes off. */
const SKIPPED: Record<string, string> = {
  "clover/forwarder": "parked: PARKED.md",
  "clover/push": "parked: PARKED.md",
  "clover/companion-web": "parked: PARKED.md",
  "clover/relay-cloudflare": "parked: PARKED.md",
};

/** What `api.plugin` is: data, the plugin's own `PluginSelf`. */
const PLUGIN_SELF = new Set(["id", "namespace", "version", "computer", "device"]);
/** A call's own function methods. */
const FUNCTION_KEYS = new Set(["bind", "call", "apply"]);

const CALLS = API_CALLS as Readonly<Record<string, ApiCallInfo>>;
const PREFIXES = new Set(Object.keys(CALLS).flatMap((call) => call.split(".").map((_, i, parts) => parts.slice(0, i + 1).join("."))));

/** Why `api.<path>` is wrong in a host half, or undefined when it's a member a host half may reach. */
function memberProblem(path: readonly string[]): string | undefined {
  if (path[0] === "plugin") return path.length === 1 || PLUGIN_SELF.has(path[1]!) ? undefined : `api.${path.join(".")} isn't a field of api.plugin`;
  for (let i = 1; i <= path.length; i++) {
    const dotted = path.slice(0, i).join(".");
    const info = CALLS[dotted];
    if (info !== undefined) {
      if (info.where === "ui") return `api.${dotted} is a component's alone`;
      if (info.notYet !== undefined) return `api.${dotted} isn't served yet (${info.notYet})`;
      const rest = path.slice(i);
      if (rest.length === 0 || (rest.length === 1 && FUNCTION_KEYS.has(rest[0]!))) return undefined;
      return `api.${path.join(".")} reaches past the call ${dotted}`;
    }
    if (!PREFIXES.has(dotted)) return `api.${dotted} doesn't exist in the plugin API`;
  }
  // An area (`api.browser`, its calls reached through a variable) where a host half has nothing it may call.
  const area = path.join(".");
  const under = Object.entries(CALLS).filter(([call]) => call.startsWith(`${area}.`));
  if (under.length > 0 && under.every(([, info]) => info.where === "ui" || info.notYet !== undefined)) return `api.${area} has no call served to a host half yet`;
  return undefined;
}

/** The source with comments and string contents blanked (a template's `${…}` goes with it: no host half builds an API
 *  path in one). */
function code(source: string): string {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, (m) =>
    m.startsWith("/") ? m.replace(/[^\n]/g, " ") : `${m[0]}${m[0]}`,
  );
}

/** Each `api.a.b.c` (any `?.`), as its path. */
function apiPaths(source: string): string[][] {
  const out: string[][] = [];
  for (const m of code(source).matchAll(/(?<![\w$])api((?:\s*\??\.\s*[A-Za-z_$][\w$]*)+)/g)) {
    out.push(m[1]!.split(/\??\./).map((s) => s.trim()).filter((s) => s !== ""));
  }
  return out;
}

/** A file's relative imports, resolved, kept inside `folder`. */
function importsOf(file: string, folder: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = resolve(dirname(file), m[1]!);
    const found = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((p) => existsSync(p) && statSync(p).isFile());
    if (found !== undefined && /\.tsx?$/.test(found) && (found + sep).startsWith(folder + sep)) out.push(found);
  }
  return out;
}

/** The host half's files: its entry and what it imports inside its folder. */
function hostFiles(folder: string, entry: string): string[] {
  const seen = new Set<string>();
  const todo = [join(folder, entry)];
  while (todo.length > 0) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    todo.push(...importsOf(f, folder));
  }
  return [...seen].sort();
}

interface Half {
  id: string;
  folder: string;
  files: string[];
}

function bundledHalves(): Half[] {
  const halves: Half[] = [];
  const visit = (folder: string, parent: string | undefined) => {
    const manifestFile = join(folder, "clover.json");
    if (!existsSync(manifestFile)) return;
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { id?: string; host?: { entry?: string } };
    // A child plugin has no id of its own: it is its parent's and its folder's name.
    const id = parent === undefined ? manifest.id! : `${parent}/${basename(folder)}`;
    if (manifest.host?.entry !== undefined) halves.push({ id, folder, files: hostFiles(folder, manifest.host.entry) });
    const children = join(folder, "plugins");
    if (existsSync(children)) for (const d of readdirSync(children).sort()) visit(join(children, d), id);
  };
  for (const d of readdirSync(PLUGINS).sort()) visit(join(PLUGINS, d), undefined);
  return halves;
}

/** What the member scan can't read: a computed member (`api[name]`, `api?.[name]`, at any depth) and an `api` typed
 *  `any` (a helper's parameter, a cast), which the type checker can't hold to the catalog either. */
function opaque(source: string): string[] {
  const out: string[] = [];
  const c = code(source);
  for (const m of c.matchAll(/(?<![\w$])api((?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\?\.)?\s*\[/g)) out.push(`api${m[1]!.replace(/\s+/g, "")}[…] is a computed member`);
  for (const m of c.matchAll(/(?<![\w$])api\s*\??\s*:\s*any\b|(?<![\w$])api\s+as\s+any\b/g)) out.push(`${m[0].replace(/\s+/g, " ")}: the plugin API typed any`);
  return out;
}

function problems(half: Half): string[] {
  const out: string[] = [];
  for (const f of half.files) {
    for (const why of opaque(readFileSync(f, "utf8"))) out.push(`${relative(ROOT, f)}: ${why}`);
    for (const path of apiPaths(readFileSync(f, "utf8"))) {
      const why = memberProblem(path);
      if (why !== undefined) out.push(`${relative(ROOT, f)}: ${why}`);
    }
  }
  return out;
}

describe("bundled host halves reach only the plugin API's host members", () => {
  const halves = bundledHalves();

  test("the scan sees every bundled host half (the clover tree's and Alpha's)", () => {
    const ids = halves.map((h) => h.id);
    for (const id of ["alpha", "clover/browser", "clover/notifications", "clover/web", "clover/fish-audio", "clover/provider-gcp", ...Object.keys(SKIPPED)]) expect(ids).toContain(id);
    for (const h of halves) expect(h.files.length).toBeGreaterThan(0);
  });

  test("the checker: a member outside the catalog, a component's call, a not-yet call, and past a call each fail; host members pass", () => {
    expect(apiPaths("const o = api.env?.CLOVER_HOOKS_ORIGIN; api.log('x'); ctx.api.net.fetch(u)")).toEqual([["env", "CLOVER_HOOKS_ORIGIN"], ["log"], ["net", "fetch"]]);
    expect(memberProblem(["env", "CLOVER_HOOKS_ORIGIN"])).toBe("api.env doesn't exist in the plugin API");
    expect(memberProblem(["computer"])).toBe("api.computer doesn't exist in the plugin API");
    expect(memberProblem(["t"])).toBe("api.t is a component's alone");
    // No call a host half can reach is marked not-yet any more (the last, browser.onCdpEvent, is a component's alone).
    expect(memberProblem(["settings", "get", "x"])).toBe("api.settings.get.x reaches past the call settings.get");
    expect(memberProblem(["device", "id"])).toBeDefined();
    for (const ok of [["net", "fetch"], ["settings"], ["settings", "get", "bind"], ["storage", "synced", "get"], ["plugin", "computer"], ["memory"], ["keys", "publicKey"]]) expect(memberProblem(ok)).toBeUndefined();
    expect(opaque("const v = api[\"env\"]; ctx.api.settings?.[k]; function f(api: any) {} const g = (api?: any) => api as any;")).toEqual([
      "api[…] is a computed member", "api.settings[…] is a computed member", "api: any: the plugin API typed any", "api?: any: the plugin API typed any", "api as any: the plugin API typed any",
    ]);
    expect(opaque("const list = [api.net]; apis[0]; const x = api.settings.get(k)[0];")).toEqual([]);
    // Comments and strings don't count.
    expect(apiPaths("// reaches only `api.fish.audio`\nconst u = \"https://api.hetzner.cloud/v1\";")).toEqual([]);
  });

  for (const half of halves) {
    const skipped = SKIPPED[half.id];
    if (skipped !== undefined) {
      test(`${half.id} is skipped (${skipped}), and still fails the scan (when it passes, it comes off the list)`, () => {
        expect(problems(half).length).toBeGreaterThan(0);
      });
      continue;
    }
    test(`${half.id}'s host half reaches only host members of the plugin API`, () => {
      expect(problems(half)).toEqual([]);
    });
  }
});
