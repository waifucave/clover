// The copy's one table of old names (`names.ts`), row by row, and the plugin content map held against the rename's own
// (`scripts/rename/codemod.ts` with the moss rules): a plugin the copy rewrites reads as the rename made the repo's own.
import { describe, expect, test } from "bun:test";
import { MOSS_RULES, rewriteText } from "../../../../../scripts/rename/codemod";
import {
  MAP_ROWS, mapHomePath, mapPluginId, mapPluginText, mapPointName, mapStoredString, mapToolName, NEW_HOME_INSTRUCTIONS, NEW_SDK_CONFIG, NEW_USAGE_LEDGER,
  OLD_HOME_INSTRUCTIONS, OLD_MCP_PREFIX, OLD_PLUGIN_SDK, OLD_ROOT_PLUGIN, OLD_SDK_CONFIG, OLD_USAGE_LEDGER, PLUGIN_CONTENT_MAP, pluginPathMap,
} from "../../../src/migration/old-home/names";

const R = OLD_ROOT_PLUGIN;

describe("ids and tool names", () => {
  test.each([
    [R, "moss"],
    [`${R}/voice`, "moss/voice"],
    [`${R}/forwarder`, "moss/forwarder"],
    ["alpha", "alpha"],
    ["acceptance-echo", "acceptance-echo"],
    [`${R}x`, `${R}x`],
    [`${R}-plugins`, `${R}-plugins`],
  ])("plugin id %s → %s", (from, to) => expect(mapPluginId(from)).toBe(to));

  test.each([
    [`${OLD_MCP_PREFIX}web__WebSearch`, "mcp__moss__web__WebSearch"],
    [`tool:${OLD_MCP_PREFIX}x__Fetch`, "tool:mcp__moss__x__Fetch"],
    ["mcp__acceptance-echo-echo__echo", "mcp__acceptance-echo-echo__echo"],
    [`say ${OLD_MCP_PREFIX}x in a sentence`, `say ${OLD_MCP_PREFIX}x in a sentence`],
  ])("tool name %s → %s", (from, to) => expect(mapToolName(from)).toBe(to));

  test.each([
    [R, "moss"],
    [`${R}/settings`, "moss/settings"],
    [`${R} is a plant`, `${R} is a plant`],
    ["dark", "dark"],
    [`${OLD_MCP_PREFIX}web__X`, "mcp__moss__web__X"],
  ])("stored string %s → %s", (from, to) => expect(mapStoredString(from)).toBe(to));

  test.each([
    [`${R}/voice.provider`, "moss/voice.provider"],
    [`${R}:x`, "moss:x"],
    ["theme.palette", "theme.palette"],
    [`${R}y.z`, `${R}y.z`],
  ])("point %s → %s", (from, to) => expect(mapPointName(from)).toBe(to));
});

describe("paths in the home", () => {
  test.each([
    [OLD_USAGE_LEDGER, NEW_USAGE_LEDGER],
    [`${OLD_USAGE_LEDGER}-wal`, `${NEW_USAGE_LEDGER}-wal`],
    ["usage/usage.db", "usage/usage.db"],
    [`plugin-data/${R}/state.json`, "plugin-data/moss/state.json"],
    [`plugin-data/${R}`, "plugin-data/moss"],
    ["plugin-data/acceptance-echo/x", "plugin-data/acceptance-echo/x"],
    [`settings/plugins/${R}.json`, "settings/plugins/moss.json"],
    [`settings/plugins/${R}/settings.json`, "settings/plugins/moss/settings.json"],
    [`settings/plugin-stores/${R}/voice.json`, "settings/plugin-stores/moss/voice.json"],
    [`settings/${R}.json`, `settings/${R}.json`],
    [OLD_HOME_INSTRUCTIONS, NEW_HOME_INSTRUCTIONS],
    [`sdk/${OLD_HOME_INSTRUCTIONS}`, `sdk/${NEW_HOME_INSTRUCTIONS}`],
    [`bots/alpha/${OLD_HOME_INSTRUCTIONS}`, `bots/alpha/${OLD_HOME_INSTRUCTIONS}`],
    [`sdk/${OLD_SDK_CONFIG}`, `sdk/${NEW_SDK_CONFIG}`],
    [`sdk/plugins/x/.${R}-plugin/plugin.json`, "sdk/plugins/x/.moss-plugin/plugin.json"],
    ["sessions/bot/s.jsonl", "sessions/bot/s.jsonl"],
  ])("%s → %s", (from, to) => expect(mapHomePath(from)).toBe(to));

  test.each([
    [`plugins/echo/${R}.json`, "plugins/echo/moss.json"],
    [`plugins/echo/child/${R}.json`, "plugins/echo/child/moss.json"],
    ["plugins/echo/index.ts", "plugins/echo/index.ts"],
  ])("plugin path %s → %s", (from, to) => expect(pluginPathMap(from)).toBe(to));
});

describe("a plugin's source text", () => {
  // One sample per row of the content map, and each row is exercised.
  const samples: Record<string, string> = {
    "sdk-import": `import { definePlugin } from "${OLD_PLUGIN_SDK}";\nimport { Card } from "${OLD_PLUGIN_SDK}/ui";\n`,
    "protocol-import": `import type { Card } from "@waifucave/${R}-protocol";\n`,
    "plugin-env": `const dir = process.env.CLOVER_PLUGIN_DIR ?? process.env.CLOVER_PLUGIN_DATA;\n`,
    "css-tokens": `.x { color: var(--${R}-color-text); border: 1px solid var(--${R}-card-muted); }\n`,
    "url-schemes": `const a = "${R}-asset://i.png", b = "${R}-plugin://x/y", c = "${R}://open", d = "${R}-sealed://card";\n`,
    "root-plugin-ids": `{ "requires": ["${R}/settings", "${R}"], "name": "${R} meadow" }\n`,
    "standing-server-tools": `call("${OLD_MCP_PREFIX}web__WebSearch");\n`,
  };
  test("every row has a sample", () => {
    expect(Object.keys(samples).sort()).toEqual(PLUGIN_CONTENT_MAP.map((r) => r.id).sort());
  });
  test.each(PLUGIN_CONTENT_MAP.map((r) => r.id))("row %s changes its sample, and as the rename's own content map does", (id) => {
    const sample = samples[id]!;
    const ours = mapPluginText(sample);
    expect(ours).not.toBe(sample);
    expect(ours).not.toMatch(new RegExp(`${R}(?:-plugin-sdk|-protocol|-asset|-plugin:|://)|CLOVER_PLUGIN|--${R}-|mcp__${R}__`));
    // The rename made the same change to the repo's own plugins (its generic pass also renames prose, which a plugin's
    // own words keep: the sample's `"<old> meadow"` string is the one place the two differ, on purpose).
    const rename = rewriteText(sample, "plugins/example/index.ts", MOSS_RULES).out;
    if (id === "root-plugin-ids") expect(ours).toBe(`{ "requires": ["moss/settings", "moss"], "name": "${R} meadow" }\n`);
    else expect(ours).toBe(rename);
  });
});

describe("the table's rows", () => {
  test("every row names its store, its old and new value and what was done, and says whether it is signed", () => {
    for (const row of MAP_ROWS) {
      expect(row.store.length).toBeGreaterThan(0);
      expect(row.done.length).toBeGreaterThan(4);
      expect(["no", "MAC (registry key)", "hash (kept tag)", "device key"]).toContain(row.signed);
    }
    // The signed stores say what was done with the signature.
    expect(MAP_ROWS.filter((r) => r.signed === "MAC (registry key)").map((r) => r.done).join(" ")).toMatch(/signed again|dropped/);
  });
});
