// clover.json (spec §5.9, format 1): a child of `clover` with no id of its own, the `browser` capability, and one
// `host` MCP server whose one tool is the tool the server lists.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { TOOL_NAME } from "../src/schema";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "clover.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The keys lane B's `McpServerSchema` allows (a strict object, `plugin-sdk/src/manifest/schema.ts` on lane/b-m0). */
const MCP_SERVER_KEYS = new Set(["type", "command", "args", "env", "url", "headers", "tools", "instructions", "perComputer", "scope", "when", "declares"]);

const inside = (path: string): boolean => {
  const rel = relative(root, resolve(root, path));
  return rel !== "" && !rel.startsWith("..") && !path.startsWith("/") && !path.includes("\\");
};

describe("clover.json", () => {
  test("a child of `clover`: format 1, no id of its own, a name and the plugin-API range", () => {
    expect(manifest.manifest).toBe(1);
    expect(manifest.id).toBeUndefined();
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(typeof manifest.engines?.clover).toBe("string");
    // The installed tree's shape: a child sits in its parent's `plugins/` folder.
    const parent = JSON.parse(readFileSync(join(root, "..", "..", "clover.json"), "utf8"));
    expect(parent.id).toBe("clover");
  });

  test("asks only for the browser capability", () => {
    expect(manifest.capabilities).toEqual(["browser"]);
  });

  test("its host entry exists, runs on bun, and exports start, stop and the browser MCP server", async () => {
    expect(manifest.host).toEqual({ entry: "host/index.ts", runtime: "bun" });
    expect(existsSync(join(root, manifest.host.entry))).toBe(true);
    const entry = await import(join(root, manifest.host.entry));
    expect(typeof entry.start).toBe("function");
    expect(typeof entry.stop).toBe("function");
    for (const name of Object.keys(manifest.contributes.mcpServers)) expect([name, typeof entry.mcp?.[name]]).toEqual([name, "function"]);
  });

  test("one host MCP server, `browser`, per computer, whose one tool is the server's", () => {
    const servers = manifest.contributes.mcpServers;
    expect(Object.keys(servers)).toEqual(["browser"]);
    const browser = servers.browser;
    expect(browser.type).toBe("host");
    expect(browser.perComputer).toBe(true);
    expect(browser.tools).toEqual({ [TOOL_NAME]: "preload" });
    for (const key of Object.keys(browser)) expect([key, MCP_SERVER_KEYS.has(key)]).toEqual([key, true]);
    // The core names it mcp__<plugin namespace>__<tool>: the `clover` tree's namespace is `clover`.
    expect(`mcp__clover__${TOOL_NAME}`).toBe("mcp__clover__Browser");
  });

  test("its instructions are a file inside the plugin, under about 4 KB", () => {
    const path = manifest.contributes.mcpServers.browser.instructions;
    expect(typeof path).toBe("string");
    expect(inside(path)).toBe(true);
    expect(existsSync(join(root, path))).toBe(true);
    expect(statSync(join(root, path)).size).toBeLessThanOrEqual(4096);
    const text = readFileSync(join(root, path), "utf8");
    for (const verb of ["open", "navigate", "read", "screenshot", "click", "type", "key", "select", "scroll", "wait"]) expect(text).toContain(`\`${verb}\``);
  });
});

describe("package.json", () => {
  test("named for the child, private, with no runtime dependencies", () => {
    expect(pkg.name).toBe("@waifucave/clover-plugin-browser");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.exports["."]).toBe("./host/index.ts");
  });
});
