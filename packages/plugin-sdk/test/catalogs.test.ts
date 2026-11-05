// The catalogs (spec §5.3–§5.5): capabilities, hooks, points, spots, tokens, the plugin API's gating, and the names
// derived from plugins (§5.1 wrappers, §6.7 tool names).
import { describe, expect, test } from "bun:test";
import {
  API_CALLS, CAPABILITIES, CARD_TOKENS, CLAUDE_HOOK_EVENTS, CORE_CONTRIBUTION_KEYS, CORE_POINTS, DATA_POINTS, HOOK_EVENTS,
  HOOK_RETURNS, MESSAGE_KINDS, SPOTS, TOKENS, WELL_KNOWN_POINT_NAMES, apiCallAllowed, capabilityOkText, catalogJson, cssVar,
  fetchesCodeAtRunTime, hookMatchesTool, hookOrder, interpolate, isTokenValue, keyMatches, networkAllows, parseCapability,
  parseInterpolation, splitToolWireName, toolWireName, wrapperId,
} from "../src/index";

describe("capabilities", () => {
  test("the catalog holds §5.4's sixteen", () => {
    expect(CAPABILITIES.map((c) => c.name)).toEqual([
      "conversation.read", "conversation.post", "memory.read", "bots.read", "routines.read", "computers.read",
      "computers.control", "approvals", "files", "browser", "usage.read", "logs.read", "notify", "audio",
      "call:<plugin-id>", "network:<host>",
    ]);
    expect(CAPABILITIES.filter((c) => c.warns).map((c) => c.ok)).toEqual([
      "controls the screen and input of your computers", "restyles approval cards", "can hear your microphone",
    ]);
  });

  test("network:<host> is a name, an IP, with :port if needed, or *. and a domain (§5.4)", () => {
    expect(parseCapability("network:api.example.com")).toEqual({ kind: "network", host: "api.example.com", wildcard: false });
    expect(parseCapability("network:*.example.com")).toEqual({ kind: "network", host: "example.com", wildcard: true });
    expect(parseCapability("network:localhost:11434")).toEqual({ kind: "network", host: "localhost", port: 11434, wildcard: false });
    expect(parseCapability("network:192.168.1.10:8080")).toEqual({ kind: "network", host: "192.168.1.10", port: 8080, wildcard: false });
    expect(parseCapability("network:[::1]:8080")).toEqual({ kind: "network", host: "[::1]", port: 8080, wildcard: false });
    expect(parseCapability("network:*.com")).toBeNull();
    expect(parseCapability("network:API.example.com")).toBeNull();
    expect(parseCapability("network:x:70000")).toBeNull();
    expect(parseCapability("call:luna")).toEqual({ kind: "call", plugin: "luna" });
    expect(parseCapability("call:luna/tarot")).toBeNull();
  });

  test("a wildcard covers subdomains, not the domain; a port must match", () => {
    const caps = ["network:*.example.com", "network:api.acme.ai", "network:localhost:11434"];
    expect(networkAllows(caps, "a.example.com")).toBe(true);
    expect(networkAllows(caps, "example.com")).toBe(false);
    expect(networkAllows(caps, "API.acme.ai")).toBe(true);
    expect(networkAllows(caps, "api.acme.ai", 8443)).toBe(false);
    expect(networkAllows(caps, "localhost", 11434)).toBe(true);
    expect(networkAllows(caps, "localhost")).toBe(false);
    expect(capabilityOkText("network:*.example.com")).toBe("connects to *.example.com");
    expect(capabilityOkText("call:luna")).toBe("runs commands of luna");
  });
});

describe("the plugin API's gating", () => {
  test("every gated call names a capability from the catalog", () => {
    const names = new Set(CAPABILITIES.map((c) => c.name));
    for (const [call, info] of Object.entries(API_CALLS)) {
      const cap = (info as { capability?: string }).capability;
      if (cap === undefined) continue;
      expect([call, cap === "call:*" || cap === "network:*" || names.has(cap)]).toEqual([call, true]);
    }
  });

  test("every capability but call: and network: gates at least one call", () => {
    const used = new Set(Object.values(API_CALLS).map((i) => (i as { capability?: string }).capability));
    for (const c of CAPABILITIES) if (!c.name.includes("<")) expect([c.name, used.has(c.name)]).toEqual([c.name, true]);
  });

  test("without the capability the call doesn't exist; secrets only in a host's own process", () => {
    expect(apiCallAllowed("conversation.history", "host", ["conversation.read"])).toBe(true);
    expect(apiCallAllowed("conversation.history", "host", ["conversation.post"])).toBe(false);
    expect(apiCallAllowed("conversation.note", "ui", ["conversation.post"])).toBe(true);
    expect(apiCallAllowed("secrets.get", "ui", [])).toBe(false);
    expect(apiCallAllowed("host.call", "host", [])).toBe(false);
    expect(apiCallAllowed("commands.run", "host", ["call:luna"], { plugin: "luna/tarot" })).toBe(true);
    expect(apiCallAllowed("commands.run", "host", ["call:luna"], { plugin: "nova" })).toBe(false);
    expect(apiCallAllowed("net.fetch", "host", ["network:api.acme.ai"], { host: "api.acme.ai" }, networkAllows)).toBe(true);
    expect(apiCallAllowed("net.fetch", "host", ["network:api.acme.ai"], { host: "evil.example" }, networkAllows)).toBe(false);
    expect(apiCallAllowed("no.such.call", "host", ["files"])).toBe(false);
  });
});

describe("hooks", () => {
  test("eight events, what each may return, and Claude Code's names (§5.3)", () => {
    expect(HOOK_EVENTS).toEqual(["tool.before", "tool.after", "message.in", "message.out", "turn.start", "turn.end", "compact.before", "compact.after"]);
    expect(HOOK_RETURNS["tool.before"]).toEqual(["deny", "ask", "input"]);
    expect(HOOK_RETURNS["tool.before"]).not.toContain("allow" as never);
    expect(HOOK_RETURNS["turn.end"]).toEqual([]);
    expect(CLAUDE_HOOK_EVENTS).toEqual({ PreToolUse: "tool.before", PostToolUse: "tool.after", UserPromptSubmit: "message.in", Stop: "turn.end", PreCompact: "compact.before", PostCompact: "compact.after" });
  });

  test("hooks on one event run in the order of their plugins' ids; tools filter by name or *", () => {
    expect(hookOrder([{ pluginId: "zeta" }, { pluginId: "alpha" }, { pluginId: "mcp-x" }]).map((h) => h.pluginId)).toEqual(["alpha", "mcp-x", "zeta"]);
    expect(hookMatchesTool(["Bash"], "Bash")).toBe(true);
    expect(hookMatchesTool(["mcp__blender__*"], "mcp__blender__Render")).toBe(true);
    expect(hookMatchesTool(["mcp__blender__*"], "mcp__figma__Export")).toBe(false);
    expect(hookMatchesTool(undefined, "Anything")).toBe(true);
  });
});

describe("points and spots", () => {
  test("the core's points are §5.3's, and every daemon point is a manifest key", () => {
    expect(CORE_POINTS.map((p) => p.name)).toEqual([
      "bot", "models", "mcpServers", "skills", "agents", "agentBackends", "hooks", "commands", "triggers", "voices",
      "computerProviders", "computer", "relays", "notifiers", "companions", "themes", "app.root", "app.surface", "bot.tab", "locales",
    ]);
    for (const p of CORE_POINTS) if (p.side === "daemon" || p.name === "themes" || p.name === "locales") expect(CORE_CONTRIBUTION_KEYS).toContain(p.name as never);
    expect(CORE_POINTS.filter((p) => p.uniqueBy).map((p) => `${p.name}.${p.uniqueBy}`)).toEqual([
      "models.provider", "agentBackends.id", "commands.name", "triggers.type", "voices.id", "computerProviders.id",
    ]);
  });

  test("the spot catalog holds §5.5's spots, with conversation.message's keys and its kept approval cell", () => {
    const names = SPOTS.map((s) => s.name);
    for (const n of ["app.root", "app.surface", "bot.tab", "sidebar", "sidebar.bot", "sidebar.app", "main", "panel", "panel.view", "settings.section",
      "bot.header", "bot.stage", "bot.side", "conversation", "composer", "avatar", "composer.action", "conversation.message", "tool.result",
      "conversation.message.extra", "bot.header.action", "status", "menu.message", "file.preview", "island.tab", "pill.target"]) expect(names).toContain(n);
    const msg = SPOTS.find((s) => s.name === "conversation.message")!;
    expect(msg.keys).toEqual(MESSAGE_KINDS);
    expect(msg.keep).toEqual(["approval"]);
    expect(msg.needs).toEqual(["conversation.read"]);
    expect(new Set(names).size).toBe(names.length);
  });

  test("spots inside a bot's tab are the tab's parts; the shell and surfaces are outside", () => {
    const inTab = SPOTS.filter((s) => s.inBotTab).map((s) => s.name).sort();
    expect(inTab).toEqual(["avatar", "bot.header", "bot.header.action", "bot.side", "bot.stage", "bot.tab", "composer", "composer.action",
      "conversation", "conversation.message", "conversation.message.extra", "file.preview", "menu.message", "tool.result"]);
  });

  test("well-known names are the spots and data points, never a core point", () => {
    for (const p of DATA_POINTS) expect(WELL_KNOWN_POINT_NAMES.has(p.name)).toBe(true);
    for (const p of CORE_POINTS) expect(WELL_KNOWN_POINT_NAMES.has(p.name)).toBe(false);
    expect(WELL_KNOWN_POINT_NAMES.has("island.tab")).toBe(true);
    expect(WELL_KNOWN_POINT_NAMES.has("composer")).toBe(true);
  });

  test("a keyed spot's entry with no key fills every key; a key ending in * fills what it matches", () => {
    expect(keyMatches(undefined, "alpha")).toBe(true);
    expect(keyMatches("image/*", "image/png")).toBe(true);
    expect(keyMatches("image/*", "text/plain")).toBe(false);
    expect(keyMatches("bot", "bot")).toBe(true);
  });
});

describe("tokens", () => {
  test("every default fits its type, and sealed frames take only card.*", () => {
    for (const t of TOKENS) {
      expect([t.name, isTokenValue(t.type, t.default)]).toEqual([t.name, true]);
      if (t.dark) expect([t.name, isTokenValue(t.type, t.dark)]).toEqual([t.name, true]);
    }
    expect(CARD_TOKENS.length).toBeGreaterThan(5);
    expect(CARD_TOKENS.every((t) => t.name.startsWith("card."))).toBe(true);
    expect(new Set(TOKENS.map((t) => t.name)).size).toBe(TOKENS.length);
  });

  test("a value can never break out of its custom property", () => {
    for (const bad of ["red; } body { x: y", "url(https://evil.example/x.png)", "red /* hi */", "expression(alert(1))", "@import x", "a\\b"]) {
      expect(isTokenValue("color", bad)).toBe(false);
      expect(isTokenValue("shadow", bad)).toBe(false);
    }
    expect(isTokenValue("color", "oklch(70% 0.1 250)")).toBe(true);
    expect(isTokenValue("length", "1.5rem")).toBe(true);
    expect(cssVar("color.bg.raised")).toBe("--clover-color-bg-raised");
  });
});

describe("names", () => {
  test("tool names are mcp__<namespace>__<Tool>, with a digest form past 64 characters (§6.7)", () => {
    expect(toolWireName("blender", "Render")).toBe("mcp__blender__Render");
    expect(toolWireName("figma", "export.png")).toBe("mcp__figma__export-png");
    const long = toolWireName("a-very-long-namespace-of-forty-chars-xx", "AnExtremelyLongToolNameThatGoesOnAndOn");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^mcp__a-very-long-namespace-of-forty-chars-xx__[A-Za-z0-9-]+-[0-9a-f]{8}$/);
    expect(toolWireName("a-very-long-namespace-of-forty-chars-xx", "AnExtremelyLongToolNameThatGoesOnAndOn2")).not.toBe(long);
    expect(splitToolWireName("mcp__blender__Render")).toEqual({ namespace: "blender", tool: "Render" });
    expect(splitToolWireName("mcp__blender__Ren__der")).toBeNull();
    expect(splitToolWireName("Bash")).toBeNull();
  });

  test("wrappers are mcp-<server>, skill-<name>, agent-<name>, claude-<name>, cleaned up, numbered on a clash or for clover (§5.1)", () => {
    expect(wrapperId("mcp", "Blender", new Set())).toEqual({ id: "mcp-blender", namespace: "blender" });
    expect(wrapperId("mcp", "My Cool_Server!!", new Set())).toEqual({ id: "mcp-my-cool-server", namespace: "my-cool-server" });
    expect(wrapperId("mcp", "blender", new Set(["mcp-blender"]))).toEqual({ id: "mcp-blender-2", namespace: "blender-2" });
    expect(wrapperId("mcp", "clover", new Set())).toEqual({ id: "mcp-clover-2", namespace: "clover-2" });
    expect(wrapperId("mcp", "!!!", new Set())).toEqual({ id: "mcp-server", namespace: "server" });
    expect(wrapperId("skill", "PDF Tools", new Set())).toEqual({ id: "skill-pdf-tools", namespace: "pdf-tools" });
    const long = wrapperId("claude", "x".repeat(80), new Set());
    expect(long.id.length).toBeLessThanOrEqual(40);
    expect(long.id).toMatch(/^claude-x+$/);
  });

  test("commands that fetch code when they run are flagged (§5.6)", () => {
    expect(fetchesCodeAtRunTime("npx", ["-y", "@modelcontextprotocol/server-github"])).toBe(true);
    expect(fetchesCodeAtRunTime("/opt/homebrew/bin/uvx", ["blender-mcp"])).toBe(true);
    expect(fetchesCodeAtRunTime("pnpm", ["dlx", "x"])).toBe(true);
    expect(fetchesCodeAtRunTime("node", ["server.js"])).toBe(false);
    expect(fetchesCodeAtRunTime("${plugin}/bin/server")).toBe(false);
  });

  test("interpolation fills ${plugin}, ${data}, ${setting:k} and ${secret:k}, and fails on a missing value", () => {
    const values = { plugin: "/p", data: "/d", setting: (k: string) => (k === "mode" ? "fast" : undefined), secret: (k: string) => (k === "t" ? "s3cr3t" : undefined) };
    expect(interpolate("${plugin}/bin --data ${data} --mode=${setting:mode} ${secret:t}", values)).toBe("/p/bin --data /d --mode=fast s3cr3t");
    expect(() => interpolate("${setting:other}", values)).toThrow("setting other is not set");
    expect(parseInterpolation("${env:HOME}").ok).toBe(false);
    expect(parseInterpolation("${plugin").ok).toBe(false);
  });
});

describe("the catalog document", () => {
  test("carries every catalog, with JSON Schemas for spot fields and props", () => {
    const c = catalogJson();
    expect(c.capabilities.length).toBe(16);
    expect(c.spots.length).toBe(SPOTS.length);
    expect(c.spots.every((s) => typeof s.props === "object" && typeof s.fields === "object")).toBe(true);
    expect(Object.keys(c.apiCalls).length).toBe(Object.keys(API_CALLS).length);
  });
});
