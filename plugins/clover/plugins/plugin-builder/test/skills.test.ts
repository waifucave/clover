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
/** The framing variables a bot's layout sets for Clover's own avatar renderers (plugin-ui, "Fitting the space you get"). */
const AVATAR_FRAMING = ["--clover-avatar-crop", "--clover-avatar-headroom"];
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
        if (AVATAR_FRAMING.includes(v)) continue; // a layout's framing for Clover's own renderers, not a token (pinned below)
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
  // plugin-host's "Programs" (lane A's `host.programs`): a host half runs programs only from a process of its own that
  // declares them, in a top-level plugin, fenced like its stdio servers (any program, the picks, its folders); every
  // other host half runs its Bun alone. The OK line is the SDK's. This fails on a build without it.
  test("a host half runs programs only with host.programs; the fence, the rules and the OK line are the build's", () => {
    const daemonHost = readFileSync(join(ROOT, "packages/core/src/plugin-host/daemon-host.ts"), "utf8");
    const validate = readFileSync(join(ROOT, "packages/plugin-sdk/src/manifest/validate.ts"), "utf8");
    expect(daemonHost).toContain("write: [data, tmp, ...programs.write], exec: \"any\", tools: true, network,");
    expect(daemonHost).toContain("write: [data, tmp], exec: \"plugin\", execs: [l.cmd[0]!], fork: false, network,");
    expect(daemonHost).toContain("return host?.process === \"own\" && host.programs === true;");
    for (const key of ["host_programs_own_process", "host_programs_top_only"]) expect({ key, refused: validate.includes(`"${key}"`) }).toEqual({ key, refused: true });
    const line = /export const HOST_PROGRAMS_OK_LINE = "([^"]+)";/.exec(validate)?.[1];
    expect(line).toBe("It runs programs on this computer, limited to its own folder and the files you pick.");
    const flat = text("plugin-host").replace(/\s+/g, " ");
    expect(flat).toContain(`Its OK card says "${line}"`);
    expect(flat).toContain("A host half starts no program unless its plugin says so");
    // A pick added waits for the calls in flight (10 minutes at most); one taken back replaces the process after 5 s.
    expect(daemonHost).toContain("export const PICK_WAIT_MS = 10 * 60_000;");
    expect(readFileSync(join(ROOT, "packages/core/src/contracts/plugin-host.ts"), "utf8")).toContain("export const RELOAD_GRACE_MS = 5_000;");
    // The stdio servers follow picks the same way (the skill says so).
    const stdio = readFileSync(join(ROOT, "packages/core/src/computers/stdio-mcp.ts"), "utf8");
    expect(stdio).toContain("export const STDIO_PICK_WAIT_MS = 10 * 60_000;");
    expect(stdio).toMatch(/export const STDIO_PICK_GRACE_MS = 5_000;/);
    expect(flat).toContain("A pick the user adds while a call is running (an export) waits");
    expect(flat).toContain("A pick the user takes back replaces it after 5 seconds");
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

// The drop (lane A's `lane/a-plugin-drop`): the entry skill's moving line is true only on a build with it; this fails on
// one without, so the line and the drop merge together.
test("the entry skill's move-into-the-plugins-folder line matches a build with the drop", () => {
  const fence = readFileSync(join(ROOT, "packages/core/src/contracts/fence.ts"), "utf8");
  const folders = readFileSync(join(ROOT, "packages/core/src/registry/folders.ts"), "utf8");
  expect(/pluginDrop\?: string;/.test(fence)).toBe(true);
  expect(/dropped\(name: string, bot: string\): boolean/.test(folders)).toBe(true);
  expect(text(ENTRY)).toContain("Moving the folder works as well as the install tool");
});

// plugin-ui's "Fitting the space you get", held to the runtime it describes: a frame is its spot's width and its
// content's reported height (clamped), the few fixed boxes, the narrow window's 900 px, what the stage hands an avatar
// renderer, and the framing variables only Clover's own renderer reads from its own element.
describe("plugin-ui's \"Fitting the space you get\" matches the runtime", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  test("a frame is as wide as its place and as tall as its content says", () => {
    const sdk = read("packages/plugin-sdk/src/ui/index.tsx");
    expect(sdk).toContain('style={{ display: "block", border: 0, width: "100%", height: height === undefined ? undefined : `${height}px`');
    expect(sdk).toContain('if (m.type === "child-size" && m.child === item.mount) setHeight(m.height);');
    expect(sdk).toContain("for (const c of Array.from(host.children)) bottom = Math.max(bottom, c.getBoundingClientRect().bottom);");
    expect(sdk).toContain('style={{ display: "contents" }}');
    expect(read("apps/desktop/src/main/ui/runtime.ts")).toContain("height: Math.max(0, Math.min(100_000, Math.round(height)))");
    expect(read("apps/desktop/src/layer/layer.css")).toContain("html, body, #clover-root { margin: 0; height: 100%;");
  });
  test("the fixed boxes, the narrow window and the stage's props", () => {
    expect(read("plugins/clover/plugins/shell/client/styles.css")).toMatch(/\.cl-window__sidebar-content iframe \{[^}]*height: 100% !important;/);
    expect(read("plugins/clover/plugins/sidebar/client/styles.css")).toMatch(/\.cl-sidebar__app-badge > iframe \{\s*width: 48px;\s*height: 18px;/);
    expect(read("plugins/alpha/tab/layout.css")).toContain(".alpha-figure > *, .alpha-figure iframe { width: 100% !important; height: 100% !important; }");
    expect(read("plugins/clover/plugins/shell/client/Shell.tsx")).toContain('const q = "(max-width: 899px)";');
    const stage = read("packages/plugin-sdk/src/catalogs/spots.ts");
    expect(stage).toContain('props: z.object({ bot: BotRef, file: z.string(), format: z.string(), speaking: z.boolean(), speech: z.looseObject({}).optional() })');
    const vrm = read("plugins/clover/plugins/vrm/src/ui/VrmAvatar.tsx");
    for (const v of AVATAR_FRAMING) expect({ v, read: vrm.includes(`num("${v}")`) }).toEqual({ v, read: true });
    expect(text("plugin-ui")).toContain("## Fitting the space you get");
  });
});
