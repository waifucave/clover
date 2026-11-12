// The skills, held to the SDK they describe: each one's frontmatter, the entry skill routing to every other, the
// generated catalog block current, every manifest field and core point named, the tool names in one place only, the UI
// exports and plugin-API calls they name real, the design tokens they use real, and the parts marked "not in this
// build yet" or "not served yet" still true (a test fails once another lane's work lands and the text is stale).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_CALLS, BotSchema, CommandSchema, CORE_CONTRIBUTION_KEYS, HookSchema, ManifestSchema, McpServerSchema, ModelSchema, PointDeclSchema,
  SettingSchema, TOKENS, TriggerSchema, UiSchema, VoiceSchema, cssProperty, validateManifest, type ApiCallInfo,
} from "@waifucave/clover-plugin-sdk";
import { BUNDLED_READ_TOOLS } from "../../../../../packages/core/src/approvals/bot-check";
import { mcpToolName } from "../../../../../packages/core/src/computers/mcp";
import { pluginMcpServerKey } from "../../../../../packages/core/src/runtime-sdk/turn-loop/plugin-mcp";
import { TOOLS } from "../src/tools";
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
  // The entries a plugin built for a user writes, field by field. (The service points, computers, agent backends and
  // agent definitions are named as points; their fields are left to the SDK's schema, as the skill says.)
  const ENTRY_SCHEMAS = {
    bot: BotSchema, models: ModelSchema, mcpServers: McpServerSchema, hooks: HookSchema, commands: CommandSchema, triggers: TriggerSchema,
    voices: VoiceSchema, settings: SettingSchema, ui: UiSchema, declares: PointDeclSchema,
  } as const;
  for (const [entry, schema] of Object.entries(ENTRY_SCHEMAS)) {
    test(`names every field of a ${entry} entry`, () => {
      for (const k of Object.keys(schema.shape)) expect({ entry, k, named: new RegExp(`[\`{,] ?"?${k}"?[\`:,} ]`).test(t) }).toEqual({ entry, k, named: true });
    });
  }
});

// What the skills say of a plugin page's files and isolation, held to the SDK: the drop call is in the catalog (and the
// generated reference), and `client.isolated` is a manifest field that validates, with no capability.
describe("plugin pages: drops and cross-origin isolation", () => {
  test("files.onDrop is a component's call under `files`, and the skills name it", () => {
    expect(calls["files.onDrop"]).toEqual({ capability: "files", where: "ui" });
    expect(text("plugin-catalog")).toContain("`files.onDrop` (ui)");
    expect(text("plugin-ui")).toContain("api.files.onDrop(");
  });

  test("client.isolated validates (and needs no capability); a non-boolean is refused", () => {
    const m = (isolated: unknown) => validateManifest({ manifest: 1, id: "iso", name: "Iso", engines: { clover: "^1.0.0" }, client: { entry: "client/index.ts", isolated } });
    expect(m(true).issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(m(true).capabilities).toEqual([]);
    expect(m("yes").issues.some((i) => i.severity === "error")).toBe(true);
    for (const n of ["plugin-ui", "plugin-manifest"]) expect({ n, named: text(n).includes('"isolated": true') }).toEqual({ n, named: true });
  });
});

test("the scaffold tool's name, as a bot's session sees it, and it runs without a card", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "clover.json"), "utf8")) as { contributes: { mcpServers: Record<string, { tools: Record<string, string> }> } };
  const [server] = Object.keys(manifest.contributes.mcpServers);
  const key = pluginMcpServerKey("clover/plugin-builder", server!, true);
  expect(key).toBe("builder");
  for (const tool of TOOLS) expect(text(ENTRY)).toContain(`\`${mcpToolName(key!, tool.name)}\``);
  expect([...BUNDLED_READ_TOOLS["clover/plugin-builder"]!]).toEqual(TOOLS.map((x) => x.name));
  expect(Object.keys(manifest.contributes.mcpServers[server!]!.tools)).toEqual(TOOLS.map((x) => x.name));
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
  const src = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? src(p) : d.name.endsWith(".ts") ? readFileSync(p, "utf8") : "";
  }).join("\n");
  const core = src(join(ROOT, "packages", "core", "src"));

  test("the core's plugin tools, once they land, carry the names the entry skill gives", () => {
    if (!core.includes("\"PluginInstall\"")) return; // not landed in this build
    for (const t of ["PluginValidate", "PluginInstall", "PluginStatus"]) expect({ t, defined: core.includes(`"${t}"`) }).toEqual({ t, defined: true });
  });

  // Editing in place needs both lane B's install text saying so and lane A's fence exception (a bot writes its own
  // plugin's folder: `FenceContext.workshop`, the ids it built, and `insideWorkshop` in contracts/fence.ts). With both
  // in the core, plugin-loop's "Editing in place" section must lose its pending marker; with either missing, it keeps it.
  test("plugin-loop's editing-in-place section matches the core", () => {
    const fence = readFileSync(join(ROOT, "packages", "core", "src", "contracts", "fence.ts"), "utf8");
    const inPlace = core.includes("edit it in place") && /\bworkshop\?: readonly string\[\]/.test(fence) && /export (?:async )?(?:function|const) insideWorkshop\b/.test(fence);
    expect({ inPlace, pending: text("plugin-loop").includes("NOT IN THIS BUILD YET") }).toEqual({ inPlace, pending: !inPlace });
  });
});

describe("what the skills say about programs, skill names and the bundle", () => {
  // plugin-host's "Programs": a host half (a worker, or a process of its own) is fenced to its Bun and starts no
  // process; a `stdio` server and a hook command may run programs. When a build lets a host run programs, this fails
  // and the skill's text changes with it.
  test("a host half starts no program; a stdio server or hook command may", () => {
    const supervisor = readFileSync(join(ROOT, "packages/core/src/plugins/supervisor.ts"), "utf8");
    const daemonHost = readFileSync(join(ROOT, "packages/core/src/plugin-host/daemon-host.ts"), "utf8");
    const fence = readFileSync(join(ROOT, "packages/core/src/registry/plugin-fence.ts"), "utf8");
    expect(/exec: "plugin", execs: \[bunCmd\[0\]!\], tools: false, fork: false/.test(supervisor)).toBe(true);
    expect(/exec: "plugin", execs: \[l\.cmd\[0\]!\], fork: false/.test(daemonHost)).toBe(true);
    expect(/exec: "any", tools: true/.test(fence)).toBe(true);
    expect(text("plugin-host")).toContain("A host half starts no program, in a worker or in a process of its own");
    for (const n of ["plugin-host", "plugin-ui", "plugin-examples"]) expect({ n, says: /host half (may )?starts? (a|an) (program|encoder)/.test(text(n)) }).toEqual({ n, says: false });
  });

  test("the entry skill names a skill the way Glossary loads it, and sends bots to the skills, not the app's bundle", () => {
    // A child plugin's id is its parent's and its folder's (`plugins/clover/plugins/plugin-builder`); Glossary names a
    // skill `<plugin id>:<skill name>` (runtime-sdk/turn-loop/glossary.ts).
    const id = "clover/plugin-builder";
    expect(import.meta.dir.endsWith(join("plugins", "clover", "plugins", "plugin-builder", "test"))).toBe(true);
    expect(readFileSync(join(ROOT, "packages/core/src/runtime-sdk/turn-loop/glossary.ts"), "utf8")).toContain("const name = `${c.pluginId}:${fm.name ?? dirName}`;");
    const t = text(ENTRY);
    expect(t).toContain(`load: "${id}:plugin-ui"`);
    expect(text("plugin-ui")).toMatch(/^name: plugin-ui$/m);
    expect(t).toContain("Don't read Clover's app bundle, its compiled daemon or other binaries for answers");
  });
});
