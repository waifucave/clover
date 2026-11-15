// The one scanner for "this setting feeds what the plugin runs or reaches" (`settingFeeds`), which both the user's
// sealed card for a host that moves (`settingHostTemplates`) and the refusal of a plugin's own change
// (`settingTemplated`) read: every form the core expands from a setting counts, and a form added to the expander
// without the scanner knowing it fails here.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hookOptionEnvName, parseInterpolation, SETTING_FED_PARTS, settingFeeds, settingHostTemplates, settingTemplated, type Manifest } from "../src/index";

const m = (o: Record<string, unknown>): Manifest => ({ manifest: 1, id: "ocean", name: "Ocean", version: "1.0.0", settings: {}, ...o }) as unknown as Manifest;

describe("settingFeeds", () => {
  test("each placeholder kind the expander fills from a setting, wherever it sits; a page's plain setting feeds nothing", () => {
    const man = m({
      settings: { region: { type: "string", title: "R" }, order: { type: "enum", title: "O", options: ["a", "b"] }, KEY: { type: "secret", title: "K" }, mode: { type: "string", title: "M" }, quoted: { type: "string", title: "Q", description: "${setting:quoted} in a description, which is fine" } },
      capabilities: ["network:${setting:region}.example.com"],
      contributes: {
        mcpServers: {
          s: { type: "stdio", command: "bun", args: ["${plugin}/s.mjs", "--mode=${setting:mode}"], env: { K: "${secretFile:KEY}" } },
          h: { type: "http", url: "https://api.example.com/${setting:region}", headers: { a: "${secret:KEY}" } },
        },
        agentBackends: [{ id: "b", name: "B", protocol: "acp", command: "run", args: ["${setting:mode}"] }],
        commands: [{ name: "c", description: "Mentions ${setting:mentioned} in prose", handler: "c" }],
      },
    });
    const keys = new Set(settingFeeds(man).map((f) => f.key));
    expect([...keys].sort()).toEqual(["KEY", "mentioned", "mode", "region"]);
    for (const k of ["region", "mode", "KEY", "mentioned"]) expect([k, settingTemplated(man, k)]).toEqual([k, true]);
    // A plain setting nothing names, and one quoted only inside its own settings block, feed nothing.
    expect(settingTemplated(man, "order")).toBe(false);
    expect(settingTemplated(man, "quoted")).toBe(false);
    expect(settingHostTemplates(man)).toEqual([{ template: "${setting:region}.example.com", keys: ["region"] }]);
    expect(settingTemplated(undefined, "x")).toBe(false);
  });

  test("a string the expander can't parse is still read token by token (over-matching asks on a card more often, never less)", () => {
    const man = m({ settings: { region: { type: "string", title: "R" } }, contributes: { hooks: [{ id: "h", on: ["turn.start"], handler: "h", args: ["${nope} ${setting:region}"] }] } });
    expect(settingTemplated(man, "region")).toBe(true);
  });

  test("a command hook gets every plain setting in its environment (never a secret): each one feeds it", () => {
    const man = m({
      settings: { order: { type: "enum", title: "O", options: ["a"] }, KEY: { type: "secret", title: "K" } },
      contributes: { hooks: [{ id: "h", on: ["turn.end"], command: "sh hooks/h.sh" }] },
    });
    expect(settingTemplated(man, "order")).toBe(true);
    expect(settingFeeds(man).find((f) => f.key === "order")?.where).toContain(hookOptionEnvName("order"));
    expect(settingFeeds(man).some((f) => f.key === "KEY")).toBe(false);
    // A handler hook runs in the plugin's own process and gets no environment: nothing fed.
    const handler = m({ settings: { order: { type: "enum", title: "O", options: ["a"] } }, contributes: { hooks: [{ id: "h", on: ["turn.end"], handler: "h" }] } });
    expect(settingTemplated(handler, "order")).toBe(false);
  });
});

describe("the scanner knows every form the core expands", () => {
  const src = (rel: string) => readFileSync(join(import.meta.dir, "..", "src", rel), "utf8");

  test("every placeholder the expander parses is classed in SETTING_FED_PARTS, and each fed one is found by the scanner", () => {
    const text = src("manifest/interpolation.ts");
    const parse = text.slice(text.indexOf("export function parseInterpolation"), text.indexOf("export function usesSecrets"));
    const named = [...parse.matchAll(/body\.startsWith\("([A-Za-z]+):"\)/g)].map((x) => x[1]!);
    const bare = [...parse.matchAll(/body === "([A-Za-z]+)"/g)].map((x) => x[1]!);
    expect(named.length + bare.length).toBeGreaterThan(0);
    for (const kind of [...named, ...bare]) expect([kind, Object.hasOwn(SETTING_FED_PARTS, kind)]).toEqual([kind, true]);
    // Each form that takes a key is fed (a placeholder that names a setting or a secret), and the scanner finds it.
    for (const kind of named) {
      expect([kind, SETTING_FED_PARTS[kind as keyof typeof SETTING_FED_PARTS]]).toEqual([kind, true]);
      const value = `\${${kind}:k1}`;
      const parsed = parseInterpolation(value);
      expect(parsed.ok).toBe(true);
      expect([kind, settingTemplated(m({ contributes: { mcpServers: { s: { type: "stdio", command: "bun", env: { X: value } } } } }), "k1")]).toEqual([kind, true]);
    }
  });

  test("the hooks' environment name lives in one place: the core writes it only through hookOptionEnvName", () => {
    const core = join(import.meta.dir, "..", "..", "core", "src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "tests" && name !== "node_modules") walk(p); continue; }
        if (!p.endsWith(".ts")) continue;
        const t = readFileSync(p, "utf8");
        // Writing the variable by hand (a template literal or a string concatenation building it).
        if (/`CLAUDE_PLUGIN_OPTION_\$\{|"CLAUDE_PLUGIN_OPTION_"\s*\+/.test(t)) hits.push(p);
      }
    };
    walk(core);
    expect(hits).toEqual([]);
    expect(readFileSync(join(core, "runtime-sdk", "turn-loop", "plugin-hook-spawn.ts"), "utf8")).toContain("hookOptionEnvName(key)");
  });
});
