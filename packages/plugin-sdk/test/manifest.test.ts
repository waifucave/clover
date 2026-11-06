// The manifest's schema and validator (spec §5.1, §5.4, §5.9): what refuses a plugin, a contribution or an entry, and
// what `clover plugin validate` reports.
import { describe, expect, test } from "bun:test";
import { describeOk, parseJsonc, validateManifest, type ManifestReport } from "../src/index";

const codes = (r: ManifestReport) => r.issues.map((i) => `${i.severity}:${i.refuses}:${i.code}:${i.path}`);
const has = (r: ManifestReport, code: string, refuses?: string) =>
  r.issues.some((i) => i.code === code && (refuses === undefined || i.refuses === refuses));

/** Alpha's manifest, as spec §5.9 gives it. */
const ALPHA = `{ "manifest": 1, "id": "alpha", "version": "1.111.1", "name": "Alpha", "icon": "assets/portrait.webp",
  "contributes": {
    "bot": { "name": "Alpha", "instructions": "bot/instructions.md", "greeting": "bot/greeting.md", "memory": "bot/memory",
             "model": { "default": "<qualified catalog id>", "effort": "medium" },
             "avatar": { "file": "assets/alpha.vrm", "format": "vrm", "portrait": "assets/portrait.webp" },
             "voice": { "provider": "fish-audio", "voice": "<fish voice id>", "model": "s2.1-pro-free" },
             "theme": "alpha", "layout": "tab/layout.json" },
    "themes": [{ "id": "alpha", "file": "tab/theme.json" }] } }`;

const min = (extra: Record<string, unknown> = {}) => ({ manifest: 1, id: "luna", name: "Luna", ...extra });

describe("Alpha's manifest from the spec", () => {
  test("validates as a bundled data plugin with a bot and a theme", () => {
    const r = validateManifest(ALPHA, { folderName: "alpha", bundled: true });
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.class).toBe("data");
    expect(r.bot).toBe(true);
    expect(r.contributions).toEqual([{ point: "bot", entries: 1 }, { point: "themes", entries: 1 }]);
    expect(r.manifest?.contributes?.bot?.voice?.provider).toBe("fish-audio");
  });

  test("is refused when it isn't bundled: `alpha` is one of the plugins Clover ships", () => {
    expect(has(validateManifest(ALPHA, { folderName: "alpha" }), "id_reserved", "plugin")).toBe(true);
  });
});

describe("the envelope", () => {
  test("JSON with comments and trailing commas is accepted", () => {
    const r = validateManifest(`{ // a comment
      "manifest": 1, "id": "luna", /* another */ "name": "Luna", }`, { folderName: "luna" });
    expect(r.ok).toBe(true);
  });

  test("a newer format needs a newer Clover; a missing one is invalid", () => {
    expect(has(validateManifest({ ...min(), manifest: 2 }), "needs_newer_clover", "plugin")).toBe(true);
    expect(has(validateManifest({ id: "luna", name: "x" }), "manifest_format", "plugin")).toBe(true);
    expect(has(validateManifest("{ not json"), "jsonc", "plugin")).toBe(true);
  });

  test("the folder name must equal the id, and a top-level plugin needs one", () => {
    expect(has(validateManifest(min(), { folderName: "lunar" }), "id_mismatch", "plugin")).toBe(true);
    expect(has(validateManifest({ manifest: 1, name: "Luna" }), "id_missing", "plugin")).toBe(true);
    expect(has(validateManifest({ ...min(), id: "Luna_1" }), "schema", "plugin")).toBe(true);
  });

  test("unknown top-level keys refuse the plugin; `$schema` is an editor's hint", () => {
    expect(has(validateManifest({ ...min(), kind: "bot" }), "schema", "plugin")).toBe(true);
    expect(validateManifest({ ...min(), $schema: "./node_modules/@waifucave/clover-plugin-sdk/generated/clover.schema.json" }).ok).toBe(true);
  });

  test("a child omits id and namespace, inherits version and takes its id from its folder", () => {
    const parent = { id: "luna", namespace: "luna" };
    const ok = validateManifest({ manifest: 1, name: "Tarot" }, { folderName: "tarot-panel", parent });
    expect(ok.ok).toBe(true);
    expect(ok.id).toBe("luna/tarot-panel");
    expect(ok.namespace).toBe("luna");
    expect(has(validateManifest({ manifest: 1, id: "tarot-panel", name: "T" }, { folderName: "tarot-panel", parent }), "child_id")).toBe(true);
    expect(has(validateManifest({ manifest: 1, name: "T", namespace: "x" }, { folderName: "tarot-panel", parent }), "namespace_child")).toBe(true);
    const v = validateManifest({ manifest: 1, name: "T", version: "1.0.0" }, { folderName: "tarot-panel", parent });
    expect(v.ok).toBe(true);
    expect(has(v, "version_child")).toBe(true);
    expect(has(validateManifest({ manifest: 1, name: "T", adult: true }, { folderName: "tarot-panel", parent }), "adult_child")).toBe(true);
    expect(has(validateManifest({ ...min(), enabledByDefault: false }), "enabled_by_default_top")).toBe(true);
  });

  test("the namespace `clover` is reserved for what Clover ships", () => {
    expect(has(validateManifest({ ...min(), namespace: "clover" }), "namespace_reserved", "plugin")).toBe(true);
    expect(validateManifest({ ...min(), id: "clover", namespace: undefined }, { bundled: true }).ok).toBe(true);
  });

  test("capabilities follow the catalog's grammar", () => {
    const good = ["conversation.read", "network:api.example.com", "network:*.example.com", "network:localhost:8080", "call:luna"];
    expect(validateManifest({ ...min(), capabilities: good }).ok).toBe(true);
    for (const bad of ["conversations.read", "network:*.com", "network:http://x", "call:Luna", "network:a b"]) {
      expect(has(validateManifest({ ...min(), capabilities: [bad] }), "capability_unknown", "plugin")).toBe(true);
    }
  });

  test("settings: enums have options, secrets have no default, defaults fit their type", () => {
    const s = (setting: Record<string, unknown>) => validateManifest({ ...min(), settings: { k: { title: "K", ...setting } } });
    expect(s({ type: "enum", options: ["a", "b"], default: "a" }).ok).toBe(true);
    expect(has(s({ type: "enum" }), "setting_options", "plugin")).toBe(true);
    expect(has(s({ type: "secret", default: "sk-123" }), "setting_secret_default", "plugin")).toBe(true);
    expect(has(s({ type: "number", min: 1, max: 5, default: 9 }), "setting_default", "plugin")).toBe(true);
    expect(has(s({ type: "boolean", default: "yes" }), "setting_default", "plugin")).toBe(true);
  });
});

describe("code, engines and platforms", () => {
  test("data, web or code is worked out from the manifest (§5.3)", () => {
    expect(validateManifest(min()).class).toBe("data");
    const web = validateManifest({ ...min(), contributes: { ui: [{ spot: "panel", key: "luna", web: { url: "https://luna.example.com/", partition: "main" } }] } });
    expect(web.class).toBe("web");
    expect(web.networkHosts).toEqual(["luna.example.com"]);
    const stdio = validateManifest({ ...min(), engines: { clover: "^1.0.0" }, contributes: { mcpServers: { blender: { type: "stdio", command: "uvx", args: ["blender-mcp"] } } } });
    expect(stdio.class).toBe("code");
    expect(stdio.fetchesCode).toEqual(["uvx blender-mcp"]);
  });

  test("a plugin with code needs engines.clover, which must take in this plugin API", () => {
    const code = { ...min(), host: { entry: "host/index.ts" } };
    expect(has(validateManifest(code), "engines_missing", "plugin")).toBe(true);
    expect(validateManifest({ ...code, engines: { clover: "^1.0.0" } }).ok).toBe(true);
    expect(has(validateManifest({ ...code, engines: { clover: "^2.0.0" } }), "engines_excludes_api", "plugin")).toBe(true);
    expect(has(validateManifest({ ...code, engines: { clover: "soon" } }), "engines_range", "plugin")).toBe(true);
    expect(validateManifest({ ...code, engines: { clover: "^1.0.0" } }, { apiVersion: "1.4.0" }).ok).toBe(true);
  });

  test("a homepage or author link is no network host; start, stop and mcp are no handlers; waifucave is reserved in any case", () => {
    const linked = validateManifest({ ...min(), homepage: "https://luna.example.com/", author: { name: "Me", url: "https://me.example/" } });
    expect(linked.ok).toBe(true);
    expect(linked.networkHosts).toEqual([]);
    for (const handler of ["start", "stop", "mcp"]) {
      const r = validateManifest({ ...min(), engines: { clover: "^1.0.0" }, host: { entry: "host/index.ts" }, contributes: { commands: [{ name: "go", description: "Go", handler }] } });
      expect([handler, r.manifest?.contributes?.commands ?? []]).toEqual([handler, []]);
    }
    for (const secret of ["waifucave", "WaifuCave", "WAIFUCAVE"]) {
      const r = validateManifest({ ...min(), auth: [{ method: "api-key", secret }] });
      expect([secret, r.issues.some((i) => i.severity === "error")]).toEqual([secret, true]);
    }
  });

  test("handlers need host code, components need a client module", () => {
    const r = validateManifest({ ...min(), contributes: { commands: [{ name: "draw", description: "Draw a card", handler: "draw" }] } });
    expect(r.ok).toBe(true);
    expect(has(r, "handler_needs_host", "entry")).toBe(true);
    expect(r.manifest?.contributes?.commands).toEqual([]);
    const ui = validateManifest({ ...min(), contributes: { ui: [{ spot: "status", component: "Status" }] } });
    expect(has(ui, "component_needs_client", "entry")).toBe(true);
  });
});

describe("contributes", () => {
  test("an unknown key without a dot refuses that contribution; a dotted one is a plugin point and waits", () => {
    const r = validateManifest({ ...min(), contributes: { tools: [], "luna.cards": [{ id: "fool" }], "island.tab": {} } });
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual([
      "error:contribution:unknown_contribution:/contributes/tools",
      "error:contribution:fill_spot_through_ui:/contributes/island.tab",
    ]);
    expect(r.manifest?.contributes?.["luna.cards"]).toEqual([{ id: "fool" }]);
  });

  test("an entry that fails its schema is refused alone; the rest of the plugin runs", () => {
    const r = validateManifest({
      ...min(),
      contributes: {
        models: [
          { provider: "acme", name: "Acme", catalog: [], auth: [{ method: "api-key", secret: "key" }], endpoint: { protocol: "openai-chat", baseUrl: "https://api.acme.ai/v1" } },
          { provider: "broken", name: "Broken" },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.manifest?.contributes?.models?.map((m) => m.provider)).toEqual(["acme"]);
    expect(r.issues.every((i) => i.refuses === "entry" && i.path.startsWith("/contributes/models/1"))).toBe(true);
    expect(r.networkHosts).toEqual(["api.acme.ai"]);
  });

  test("a model has an endpoint or an adapter, not both or neither", () => {
    const m = (extra: Record<string, unknown>) => validateManifest({ ...min(), contributes: { models: [{ provider: "acme", name: "Acme", catalog: [], auth: [], ...extra }] } });
    expect(has(m({}), "model_endpoint_or_adapter", "entry")).toBe(true);
    expect(has(m({ adapter: "acme", endpoint: { protocol: "openai-chat", baseUrl: "https://x.ai" } }), "model_endpoint_or_adapter")).toBe(true);
  });

  test("entry ids are unique within a plugin", () => {
    const r = validateManifest({ ...min(), engines: { clover: "^1.0.0" }, host: { entry: "h.ts" }, contributes: { voices: [{ id: "v", name: "V", handler: "a" }, { id: "v", name: "W", handler: "b" }] } });
    expect(has(r, "entry_duplicate", "entry")).toBe(true);
    expect(r.manifest?.contributes?.voices?.length).toBe(1);
  });

  test("a ui entry has exactly one of component, web, style or hide; filling a spot twice needs ids", () => {
    const base = { ...min(), engines: { clover: "^1.0.0" }, client: { entry: "client/index.tsx" } };
    expect(has(validateManifest({ ...base, contributes: { ui: [{ spot: "status" }] } }), "ui_one_of")).toBe(true);
    expect(has(validateManifest({ ...base, contributes: { ui: [{ spot: "status", component: "A", hide: true }] } }), "ui_one_of")).toBe(true);
    expect(validateManifest({ ...base, contributes: { ui: [{ spot: "composer", style: "composer.json" }, { spot: "status", hide: true }] } }).issues).toEqual([]);
    const twice = validateManifest({ ...base, contributes: { ui: [{ spot: "status", component: "A" }, { spot: "status", component: "B" }] } });
    expect(has(twice, "ui_id_required", "entry")).toBe(true);
    const ids = validateManifest({ ...base, contributes: { ui: [{ spot: "status", id: "a", component: "A" }, { spot: "status", id: "b", component: "B" }] } });
    expect(ids.issues).toEqual([]);
  });

  test("a spot's own fields are checked: an app button needs a title, an icon and what it opens", () => {
    const base = { ...min(), engines: { clover: "^1.0.0" }, client: { entry: "c.tsx" } };
    expect(has(validateManifest({ ...base, contributes: { ui: [{ spot: "sidebar.app", component: "App" }] } }), "schema", "entry")).toBe(true);
    expect(validateManifest({ ...base, contributes: { ui: [{ spot: "sidebar.app", component: "App", title: "Waifus", icon: "icon.svg", opens: "waifus" }] } }).issues).toEqual([]);
    expect(has(validateManifest({ ...base, contributes: { ui: [{ spot: "status", component: "S", window: { type: "overlay" } }] } }), "ui_window_not_surface")).toBe(true);
  });

  test("a bot's plugin fills only spots in its own tab, and `when.bot` is the bot itself (§5.5)", () => {
    const bot = { name: "Luna", instructions: "bot/instructions.md" };
    const base = { ...min(), engines: { clover: "^1.0.0" }, client: { entry: "c.tsx" } };
    const inTab = validateManifest({ ...base, contributes: { bot, ui: [{ spot: "composer", component: "C" }, { spot: "conversation.message", key: "bot", component: "Bubble" }] } });
    expect(inTab.issues).toEqual([]);
    const outside = validateManifest({ ...base, contributes: { bot, ui: [{ spot: "island.tab", component: "T", title: "Tarot" }] } });
    expect(has(outside, "bot_spot_outside_tab", "entry")).toBe(true);
    const other = validateManifest({ ...base, contributes: { bot, ui: [{ spot: "composer", component: "C", when: { bot: "alpha" } }] } });
    expect(has(other, "bot_when_other_bot", "entry")).toBe(true);
  });

  test("a bot's theme names one of its plugin's themes; a typo only warns", () => {
    const r = validateManifest({ ...min(), contributes: { bot: { name: "Luna", instructions: "i.md", theme: "lunar" }, themes: [{ id: "luna", file: "t.json" }] } });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => `${i.severity}:${i.code}`)).toEqual(["warning:theme_ref"]);
  });
});

describe("servers, tools and interpolation", () => {
  const code = { ...min(), engines: { clover: "^1.0.0" } };

  test("each server type has its own fields", () => {
    const s = (server: Record<string, unknown>) => validateManifest({ ...code, contributes: { mcpServers: { x: server } } });
    expect(has(s({ type: "stdio" }), "server_fields")).toBe(true);
    expect(has(s({ type: "http" }), "server_fields")).toBe(true);
    expect(has(s({ type: "http", url: "https://mcp.example.com", command: "x" }), "server_fields")).toBe(true);
    expect(has(s({ type: "host" }), "handler_needs_host")).toBe(true);
    expect(has(s({ type: "stdio", command: "x", perComputer: true }), "server_fields")).toBe(true);
  });

  test("tool names are mcp__<namespace>__<Tool>, unique, never with __ (§6.7)", () => {
    const r = validateManifest({ ...code, contributes: { mcpServers: {
      a: { type: "stdio", command: "a", tools: { Render: "preload", "*": "on-demand" } },
      b: { type: "http", url: "https://b.example.com/mcp", tools: { "export.png": "on-demand" } },
    } } });
    expect(r.ok).toBe(true);
    expect(r.toolNames).toEqual(["mcp__luna__Render", "mcp__luna__export-png"]);
    const dup = validateManifest({ ...code, contributes: { mcpServers: {
      a: { type: "stdio", command: "a", tools: { Render: "preload" } },
      b: { type: "stdio", command: "b", tools: { Render: "preload" } },
    } } });
    expect(has(dup, "tool_duplicate", "plugin")).toBe(true);
    const dunder = validateManifest({ ...code, contributes: { mcpServers: { a: { type: "stdio", command: "a", tools: { "do__it": "preload" } } } } });
    expect(has(dunder, "tool_name", "entry")).toBe(true);
  });

  test("interpolation: four forms, and secrets only in env and headers (§5.9)", () => {
    const s = (server: Record<string, unknown>) => validateManifest({ ...code, contributes: { mcpServers: { x: server } } });
    expect(s({ type: "stdio", command: "${plugin}/bin/server", args: ["--data", "${data}", "--mode=${setting:mode}"], env: { TOKEN: "${secret:token}" } }).issues).toEqual([]);
    expect(s({ type: "http", url: "https://${setting:host}/mcp", headers: { Authorization: "Bearer ${secret:token}" } }).issues).toEqual([]);
    expect(has(s({ type: "stdio", command: "x", args: ["${secret:token}"] }), "secret_outside_env", "entry")).toBe(true);
    expect(has(s({ type: "http", url: "https://x.example.com/?k=${secret:k}" }), "secret_outside_env", "entry")).toBe(true);
    expect(has(s({ type: "stdio", command: "x", args: ["${HOME}"] }), "interpolation", "entry")).toBe(true);
    expect(s({ type: "http", url: "https://${setting:host}/mcp" }).dynamicHosts).toBe(true);
  });
});

describe("paths stay inside the folder", () => {
  test("absolute paths, .. and backslashes are refused at the level that names them", () => {
    expect(has(validateManifest({ ...min(), icon: "/etc/passwd" }), "path_escape", "plugin")).toBe(true);
    expect(has(validateManifest({ ...min(), contributes: { bot: { name: "L", instructions: "../outside.md" } } }), "path_escape", "contribution")).toBe(true);
    expect(has(validateManifest({ ...min(), contributes: { themes: [{ id: "t", file: "tab\\theme.json" }] } }), "path_escape", "entry")).toBe(true);
    const client = (css: string[]) => validateManifest({ ...min(), engines: { clover: "^1.0.0" }, client: { entry: "client/index.js", css } });
    expect(has(client(["client/../../out.css"]), "path_escape", "plugin")).toBe(true);
    expect(client(["client/index.css"]).issues.filter((i) => i.code === "path_escape")).toEqual([]);
    expect(validateManifest({ ...min(), contributes: { skills: ["skills/*"], themes: [{ id: "t", file: "./tab/theme.json" }] } }).issues).toEqual([]);
  });
});

describe("declared points (§5.4)", () => {
  const base = { ...min(), engines: { clover: "^1.0.0" }, host: { entry: "h.ts", start: "main" }, client: { entry: "c.tsx" } };

  test("a new point's name starts with the plugin's id and a dot", () => {
    const ok = validateManifest({ ...base, host: { ...base.host, declares: { "luna.cards": { shape: "list", fields: { type: "object" } } } } });
    expect(ok.issues).toEqual([]);
    expect(ok.declares).toEqual([{ name: "luna.cards", by: "host", shape: "list", spot: false, wellKnown: false }]);
    const bad = validateManifest({ ...base, host: { ...base.host, declares: { "cards.deck": { shape: "list" } } } });
    expect(has(bad, "point_name", "plugin")).toBe(true);
  });

  test("a UI spot is declared only by a ui entry with a component", () => {
    const spot = { "luna.deck": { shape: "list", props: {} } };
    expect(has(validateManifest({ ...base, host: { ...base.host, declares: spot } }), "spot_declarer", "plugin")).toBe(true);
    const ok = validateManifest({ ...base, contributes: { ui: [{ spot: "panel", key: "luna", component: "Panel", declares: spot }] } });
    expect(ok.issues).toEqual([]);
    expect(ok.declares[0]).toEqual({ name: "luna.deck", by: "ui/0", shape: "list", spot: true, wellKnown: false });
  });

  test("core points can't be declared; well-known names take the catalog's declaration", () => {
    expect(has(validateManifest({ ...base, host: { ...base.host, declares: { models: { shape: "list" } } } }), "point_declares_core")).toBe(true);
    const wrongShape = validateManifest({ ...base, contributes: { ui: [{ spot: "app.surface", component: "Island", declares: { "island.tab": { shape: "single", props: {} } } }] } });
    expect(has(wrongShape, "point_declares_well_known")).toBe(true);
    const right = validateManifest({ ...base, contributes: { ui: [{ spot: "app.surface", component: "Island", declares: { "island.tab": { shape: "list", props: {} } } }] } });
    expect(right.issues).toEqual([]);
  });

  test("a well-known data point's entries are checked against the catalog now", () => {
    const r = validateManifest({ ...min(), contributes: { "avatar.packs": [{ id: "chibi", file: "chibi.vrm", format: "vrm" }, { id: "bad" }] } });
    expect(r.ok).toBe(true);
    expect(has(r, "schema", "entry")).toBe(true);
    expect(r.manifest?.contributes?.["avatar.packs"]).toEqual([{ id: "chibi", file: "chibi.vrm", format: "vrm" }]);
  });
});

describe("the OK's text", () => {
  test("says what the plugin is, what it adds, what it reaches and what it warns about", () => {
    const r = validateManifest({
      ...min(), engines: { clover: "^1.0.0" }, capabilities: ["approvals", "network:api.luna.example"], addons: { description: "Tarot decks" },
      contributes: { mcpServers: { tarot: { type: "stdio", command: "npx", args: ["tarot-mcp"] } } },
    });
    const lines = describeOk(r, { os: "linux", source: "other" });
    expect(lines).toContain("luna runs code on your computers.");
    expect(lines).toContain("Its code could read Clover's logins and approve its own cards.");
    expect(lines).toContain("It restyles approval cards.");
    expect(lines).toContain("Its components reach only api.luna.example; its host code can reach any host.");
    expect(lines).toContain("It fetches code when it runs: npx tarot-mcp.");
    expect(lines).toContain("It loads add-ons of its own, which Clover doesn't check.");
    expect(lines).toContain("Not reviewed: it isn't from the official index.");
    expect(lines.filter((l) => l === "It restyles approval cards.")).toHaveLength(1);
    expect(r.restylesCards).toBe(true);
  });

  test("a tree whose theme sets card.* tokens restyles approval cards too (review S7)", () => {
    const r = validateManifest(min());
    expect(r.restylesCards).toBe(false);
    expect(describeOk(r)).not.toContain("It restyles approval cards.");
    expect(describeOk(r, { restylesCards: true })).toContain("It restyles approval cards.");
  });
});

describe("JSON with comments", () => {
  test("keeps strings intact and reports where it failed", () => {
    expect(parseJsonc('{"a": "// not a comment", "b": "/* nor this */",}')).toEqual({ ok: true, value: { a: "// not a comment", b: "/* nor this */" } });
    expect(parseJsonc('[1, 2, /* c */ ]')).toEqual({ ok: true, value: [1, 2] });
    const bad = parseJsonc('{\n  "a": 1\n  "b": 2\n}');
    expect(bad.ok).toBe(false);
  });
});

describe("lane A's asks: settings in hosts, the core's own sign-ins, a Bun process of its own", () => {
  const issues = (m: Record<string, unknown>, bundled = false) => validateManifest(
    { manifest: 1, ...(bundled ? {} : { id: "bedrock" }), name: "Bedrock", engines: { clover: "^1.0.0" }, host: { entry: "host/index.ts" }, ...m },
    bundled ? { parent: { id: "clover", namespace: "clover" }, folderName: "bedrock", bundled: true } : { folderName: "bedrock" },
  ).issues.map((i) => `${i.code}:${i.path}`);
  const settings = { region: { type: "string", title: "Region" } };

  test("a network: host and a model's endpoint may name the plugin's settings, never its secrets", () => {
    expect(issues({ settings, capabilities: ["network:bedrock-runtime.${setting:region}.amazonaws.com"] })).toEqual([]);
    expect(issues({ capabilities: ["network:bedrock-runtime.${setting:region}.amazonaws.com"] })).toEqual(["interpolation:/capabilities/0"]);
    expect(issues({ settings, capabilities: ["network:a.${secret:region}.amazonaws.com"] })).toEqual(["capability_unknown:/capabilities/0"]);
    expect(issues({ settings, capabilities: ["network:${setting:region}.com"] })).toEqual(["capability_unknown:/capabilities/0"]);
    const model = (baseUrl: string) => ({ contributes: { models: [{ provider: "bedrock", name: "Bedrock", catalog: [], auth: [], endpoint: { protocol: "openai-chat", baseUrl } }] } });
    expect(issues({ settings, ...model("https://${setting:region}.example.com/v1") })).toEqual([]);
    expect(issues({ settings, ...model("https://${secret:region}.example.com/v1") }).some((i) => i.startsWith("interpolation:/contributes/models/0/endpoint/baseUrl"))).toBe(true);
    expect(issues({ ...model("https://${setting:tenant}.example.com/v1") })).toEqual(["interpolation:/contributes/models/0/endpoint/baseUrl"]);
    const report = validateManifest({ manifest: 1, id: "bedrock", name: "Bedrock", settings, capabilities: ["network:bedrock-runtime.${setting:region}.amazonaws.com"] }, { folderName: "bedrock" });
    expect(report.dynamicHosts).toBe(true);
  });

  test("a sign-in the core runs is the clover tree's; a Bun host may ask for a process of its own", () => {
    const auth = { auth: [{ method: "core", flow: "xai-device" }] };
    expect(issues(auth)).toEqual(["auth_core_bundled_only:/auth/0/method"]);
    expect(issues(auth, true)).toEqual([]);
    expect(issues({ auth: [{ method: "core", flow: "somewhere-else" }] }, true).length).toBeGreaterThan(0);
    expect(issues({ host: { entry: "host/index.ts", process: "own" } })).toEqual([]);
    expect(issues({ host: { entry: "host/index.ts", process: "shared" } }).length).toBeGreaterThan(0);
  });
});
