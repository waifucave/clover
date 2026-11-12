// The skills, held to the SDK they describe: each one's frontmatter, the entry skill routing to every other, the
// generated catalog block current, every manifest field and core point named, the tool names in one place only, the UI
// exports and plugin-API calls they name real, the design tokens they use real, and the parts marked "not in this
// build yet" or "not served yet" still true (a test fails once another lane's work lands and the text is stale).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CALLS, CORE_CONTRIBUTION_KEYS, ManifestSchema, TOKENS, cssProperty, type ApiCallInfo } from "@waifucave/clover-plugin-sdk";
import * as uiSdk from "@waifucave/clover-plugin-sdk/ui";
import { withReference } from "./catalog";

const SKILLS = join(import.meta.dir, "..", "skills");
const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const names = readdirSync(SKILLS).sort();
const text = (name: string) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
const calls = API_CALLS as Record<string, ApiCallInfo>;

const TOOL_NAMES = ["PluginNew", "PluginValidate", "PluginInstall", "PluginStatus"];
const ENTRY = "building-plugins";

describe("every skill", () => {
  test("is the set the plugin ships, and the entry skill routes to every other", () => {
    expect(names).toEqual(["building-plugins", "plugin-cards", "plugin-catalog", "plugin-examples", "plugin-host", "plugin-loop", "plugin-manifest", "plugin-ui"]);
    const entry = text(ENTRY);
    for (const n of names) if (n !== ENTRY) expect(entry).toContain(`**${n}**`);
  });

  for (const n of names) {
    test(`${n}: frontmatter with its own name and a description that says when to use it`, () => {
      const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text(n));
      expect(m).not.toBeNull();
      expect(m![1]).toBe(n);
      expect(m![2]!.length).toBeGreaterThan(80);
      expect(m![2]!.length).toBeLessThan(1024);
    });
  }

  test("the tools are named in the entry skill alone (the others say 'the scaffold tool' and so on)", () => {
    for (const t of TOOL_NAMES) expect(text(ENTRY)).toContain(t);
    expect(text(ENTRY)).toContain("`mcp__builder__PluginNew`");
    for (const n of names) {
      if (n === ENTRY) continue;
      for (const t of TOOL_NAMES) expect({ skill: n, names: text(n).includes(t) ? t : null }).toEqual({ skill: n, names: null });
    }
  });

  test("every --clover- variable a skill uses is a design token", () => {
    const real = new Set(TOKENS.map((t) => cssProperty(t.name)));
    for (const n of names) {
      for (const v of text(n).match(/--clover-[a-z0-9-]+[a-z0-9]/g) ?? []) {
        if (v === "--clover-a-b-c") continue; // the worked example of the naming rule
        expect({ skill: n, v, real: real.has(v) }).toEqual({ skill: n, v, real: true });
      }
    }
  });
});

test("plugin-catalog's generated block is current (bun run gen rewrites it)", () => {
  const t = text("plugin-catalog");
  expect(withReference(t)).toBe(t);
});

describe("plugin-manifest", () => {
  const t = text("plugin-manifest");
  test("names every top-level manifest field", () => {
    for (const k of Object.keys(ManifestSchema.shape)) expect({ k, named: t.includes(`\`${k}\``) }).toEqual({ k, named: true });
  });
  test("names every core point under contributes", () => {
    for (const k of CORE_CONTRIBUTION_KEYS) expect({ k, named: t.includes(`\`${k}\``) }).toEqual({ k, named: true });
  });
});

describe("plugin-ui and plugin-host name what is real", () => {
  test("each UI SDK export plugin-ui's table names is exported", () => {
    const t = text("plugin-ui");
    const table = t.slice(t.indexOf("| export |"), t.indexOf("## A whole app"));
    const named = [...table.matchAll(/^\| ([^|]+) \|/gm)].flatMap((m) => [...m[1]!.matchAll(/`([A-Za-z]+)(?:\([^`]*\))?`/g)].map((x) => x[1]!)).filter((x) => x !== "export");
    expect(named.length).toBeGreaterThan(10);
    for (const e of named) expect({ e, exported: e in uiSdk }).toEqual({ e, exported: true });
  });

  test("each api.<call>( a skill names is a plugin-API call", () => {
    for (const n of ["plugin-ui", "plugin-host", "plugin-cards", "plugin-loop"]) {
      for (const m of text(n).matchAll(/api\.([a-z]+(?:\.[a-zA-Z]+)*)\(/g)) {
        const path = m[1]!;
        expect({ skill: n, path, real: path in calls }).toEqual({ skill: n, path, real: true });
        expect({ skill: n, path, notYet: calls[path]!.notYet ?? null }).toEqual({ skill: n, path, notYet: null });
      }
    }
  });
});

describe("what the skills say isn't there yet is still not there", () => {
  test("the not-served list in the entry skill: each family still has a call the core doesn't serve", () => {
    const line = /These API calls are listed but answer "isn't available yet": ([^(]+)\(/.exec(text(ENTRY).replace(/\n\s*/g, " "));
    expect(line).not.toBeNull();
    const families = [...line![1]!.matchAll(/`([a-z]+)(?:\.\*|\.[a-zA-Z]+)?`/g)].map((m) => m[0].slice(1, -1));
    expect(families.length).toBeGreaterThan(5);
    for (const f of families) {
      const hits = Object.entries(calls).filter(([p]) => (f.endsWith(".*") ? p.startsWith(f.slice(0, -1)) : p === f));
      expect({ f, listed: hits.length > 0 }).toEqual({ f, listed: true });
      expect({ f, notYet: hits.some(([, i]) => i.notYet !== undefined) }).toEqual({ f, notYet: true });
    }
  });

  // Lane G's file and folder pickers, media URLs and WASM: once a picker call is in the catalog, plugin-ui's "Files and
  // media" section must be rewritten for it (and its pending marker dropped).
  test("plugin-ui's files-and-media section matches the catalog", () => {
    const pickers = Object.keys(calls).filter((p) => /pick/i.test(p));
    const pending = text("plugin-ui").includes("NOT IN THIS BUILD YET");
    expect({ pickers: pickers.length > 0, pending }).toEqual({ pickers: pickers.length > 0, pending: pickers.length === 0 });
  });

  // Lane B's core tools: the entry skill names them before they land; once the core defines them, each must be the
  // name the entry skill gives.
  test("the core's plugin tools, once they land, carry the names the entry skill gives", () => {
    const src = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map((d) => {
      const p = join(dir, d.name);
      return d.isDirectory() ? src(p) : d.name.endsWith(".ts") ? readFileSync(p, "utf8") : "";
    }).join("\n");
    const core = src(join(ROOT, "packages", "core", "src"));
    if (!core.includes("\"PluginInstall\"")) return; // not landed in this build
    for (const t of ["PluginValidate", "PluginInstall", "PluginStatus"]) expect({ t, defined: core.includes(`"${t}"`) }).toEqual({ t, defined: true });
  });
});
