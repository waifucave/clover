// The catalogs (spec §5.3–§5.5): capabilities, hooks, points, spots, tokens, the plugin API's gating, and the names
// derived from plugins (§5.1 wrappers, §6.7 tool names).
import { describe, expect, test } from "bun:test";
import {
  API_CALLS, CAPABILITIES, CARD_TOKENS, CLAUDE_HOOK_EVENTS, CORE_CONTRIBUTION_KEYS, CORE_POINTS, DATA_POINTS, HOOK_EVENTS,
  HOOK_RETURNS, MESSAGE_KINDS, PointDeclSchema, SPOTS, TOKENS, TOKEN_GROUPS, WELL_KNOWN_POINT_NAMES, apiCallAllowed, capabilityOkText, catalogJson,
  AVATAR_FORMATS, avatarFileProblem, catalogPointDecl, cssProperty, cssVar, isAnyTokenValue, isValueForToken,
  fetchesCodeAtRunTime, hookMatchesTool, hookOrder, interpolate, isPluginTokenName, isSafeTokenValue, isTokenName, isTokenValue, keyMatches,
  networkAllows, pluginTokenName,
  parseCapability,
  parseInterpolation, splitToolWireName, toolWireName, validateManifest, wrapperId, mayHoldCapability, foldTitle, CLIENT_BARE_IMPORTS,
} from "../src/index";

describe("capabilities", () => {
  test("the catalog holds §5.4's sixteen, devices.read for the Devices tab (review S16) and terminal for the terminal panel", () => {
    expect(CAPABILITIES.map((c) => c.name)).toEqual([
      "conversation.read", "conversation.post", "memory.read", "bots.read", "routines.read", "computers.read",
      "computers.control", "devices.read", "approvals", "files", "browser", "terminal", "usage.read", "logs.read", "notify", "audio",
      "call:<plugin-id>", "network:<host>",
    ]);
    expect(CAPABILITIES.filter((c) => c.warns).map((c) => c.ok)).toEqual([
      "controls the screen and input of your computers", "restyles approval cards", "runs commands on your computers", "can hear your microphone",
    ]);
  });

  test("terminal is for the bundled clover tree only, decided from the install record (review T1)", () => {
    expect(mayHoldCapability("terminal", { id: "clover/panel-terminal", source: "bundled" })).toBe(true);
    expect(mayHoldCapability("terminal", { id: "clover/panel-terminal", source: "store" })).toBe(false);
    expect(mayHoldCapability("terminal", { id: "luna", source: "bundled" })).toBe(false);
    expect(mayHoldCapability("files", { id: "luna", source: "store" })).toBe(true);
    const term = (id: string, parent?: { id: string; namespace: string }) => validateManifest(
      { manifest: 1, ...(parent ? {} : { id }), name: "T", engines: { clover: "^1.0.0" }, client: { entry: "ui/index.js" }, capabilities: ["terminal"] },
      parent ? { parent, folderName: id, bundled: true } : { folderName: id },
    );
    expect(term("shellish").issues.map((i) => i.code)).toEqual(["capability_bundled_only"]);
    expect(term("panel-terminal", { id: "clover", namespace: "clover" }).issues.map((i) => i.code)).toEqual([]);
  });

  test("network:<host> is a name, an IP, with :port if needed, or *. and a domain (§5.4)", () => {
    expect(parseCapability("network:api.example.com")).toEqual({ kind: "network", host: "api.example.com", wildcard: false });
    expect(parseCapability("network:*.example.com")).toEqual({ kind: "network", host: "example.com", wildcard: true });
    expect(parseCapability("network:localhost:11434")).toEqual({ kind: "network", host: "localhost", port: 11434, wildcard: false });
    expect(parseCapability("network:192.168.1.10:8080")).toEqual({ kind: "network", host: "192.168.1.10", port: 8080, wildcard: false });
    expect(parseCapability("network:[::1]:8080")).toEqual({ kind: "network", host: "[::1]", port: 8080, wildcard: false });
    expect(parseCapability("network:*.com")).toBeNull();
    // A wildcard never covers an address or a registry suffix (review minors).
    for (const wide of ["network:*.0.0.1", "network:*.168.1.10", "network:*.1", "network:*.co.uk", "network:*.com.au", "network:*.ne.jp", "network:*.org.uk:8443"]) {
      expect([wide, parseCapability(wide)]).toEqual([wide, null]);
    }
    expect(parseCapability("network:*.example.co.uk")).toEqual({ kind: "network", host: "example.co.uk", wildcard: true });
    expect(parseCapability("network:*.github.io")).toEqual({ kind: "network", host: "github.io", wildcard: true });
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
    expect(apiCallAllowed("conversation.history", "shared", ["conversation.read"])).toBe(true);
    expect(apiCallAllowed("conversation.history", "shared", ["conversation.post"])).toBe(false);
    expect(apiCallAllowed("conversation.note", "ui", ["conversation.post"])).toBe(true);
    expect(apiCallAllowed("secrets.get", "ui", [])).toBe(false);
    // Only a process of the plugin's own reads a secret, never a worker of a shared process (review minor).
    expect(apiCallAllowed("secrets.get", "shared", [])).toBe(false);
    expect(apiCallAllowed("secrets.get", "clover", [])).toBe(false);
    expect(apiCallAllowed("secrets.get", "own", [])).toBe(true);
    // Key pairs only from the clover process (the owner's answer to S4).
    for (const call of ["keys.open", "keys.publicKey", "keys.delete"]) {
      expect([call, apiCallAllowed(call, "clover", []), apiCallAllowed(call, "shared", []), apiCallAllowed(call, "own", []), apiCallAllowed(call, "ui", [])]).toEqual([call, true, false, false, false]);
    }
    // Calls for any host half reach every process.
    for (const from of ["clover", "shared", "own"] as const) expect(apiCallAllowed("ui.send", from, [])).toBe(true);
    expect(apiCallAllowed("host.call", "shared", [])).toBe(false);
    expect(apiCallAllowed("commands.run", "shared", ["call:luna"], { plugin: "luna/tarot" })).toBe(true);
    expect(apiCallAllowed("commands.run", "shared", ["call:luna"], { plugin: "nova" })).toBe(false);
    expect(apiCallAllowed("net.fetch", "shared", ["network:api.acme.ai"], { host: "api.acme.ai" }, networkAllows)).toBe(true);
    expect(apiCallAllowed("net.fetch", "shared", ["network:api.acme.ai"], { host: "evil.example" }, networkAllows)).toBe(false);
    expect(apiCallAllowed("no.such.call", "shared", ["files"])).toBe(false);
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

  test("a well-known name's declaration is the catalog's, keep and needs included, whoever declares it (review S2)", () => {
    for (const name of WELL_KNOWN_POINT_NAMES) {
      const decl = catalogPointDecl(name);
      expect(PointDeclSchema.safeParse(decl).success).toBe(true);
      expect(decl!.props !== undefined).toBe(SPOTS.some((s) => s.name === name));
    }
    expect(catalogPointDecl("conversation.message")).toMatchObject({ shape: "keyed", keep: ["approval"], needs: ["conversation.read"], context: ["bot"] });
    expect(catalogPointDecl("webhook.ingress")).toMatchObject({ shape: "list", fields: { type: "object" } });
    expect(catalogPointDecl("webhook.ingress")!.props).toBeUndefined();
    for (const name of ["app.root", "bot.tab", "models", "luna.cards"]) expect(catalogPointDecl(name)).toBeUndefined();
  });

  test("avatars are VRM or Live2D Cubism models, the avatar spot keyed by format (the owner's decision)", () => {
    expect(AVATAR_FORMATS.map((a) => a.format)).toEqual(["vrm", "live2d"]);
    expect(SPOTS.find((s) => s.name === "avatar")!.keys).toEqual(["vrm", "live2d"]);
    expect(avatarFileProblem("live2d", "assets/alpha/alpha.model3.json")).toBeUndefined();
    expect(avatarFileProblem("live2d", "assets/alpha.zip")).toBeUndefined();
    expect(avatarFileProblem("live2d", "assets/alpha.vrm")).toBeDefined();
    expect(avatarFileProblem("vrm", "assets/alpha.model3.json")).toBeDefined();
    expect(avatarFileProblem("sprite-sheet", "anything.png")).toBeUndefined();
    const pack = DATA_POINTS.find((p) => p.name === "avatar.packs")!.entry;
    expect(pack.safeParse({ id: "alpha", file: "alpha/alpha.model3.json", format: "live2d" }).success).toBe(true);
    expect(pack.safeParse({ id: "alpha", file: "alpha.png", format: "live2d" }).success).toBe(false);
  });

  test("lane F's asks: settings declares its sections, an unfilled panel key shows a placeholder, a panel may be for some sessions only", () => {
    const spot = (name: string) => SPOTS.find((s) => s.name === name)!;
    expect(spot("settings.section").declaredBy).toBe("settings");
    expect(spot("panel").placeholder).toBe(true);
    expect(spot("panel").context).toContain("session");
    const panel = (when: unknown) => validateManifest({
      manifest: 1, id: "term", name: "Term", engines: { clover: "^1.0.0" }, client: { entry: "ui/index.js" },
      contributes: { ui: [{ spot: "panel", key: "terminal", component: "Terminal", title: "Terminal", when }] },
    });
    expect(panel({ session: "coding" }).issues).toEqual([]);
    expect(panel({ session: ["coding", "agent"] }).issues).toEqual([]);
    expect(panel({ session: "code" }).issues.map((i) => [i.refuses, i.path])).toEqual([["entry", "/contributes/ui/0/when/session"]]);
  });

  test("lane G's asks: reserved island tabs, always-on-top surfaces and pill targets' handlers are the clover tree's rules", () => {
    const entry = (ui: Record<string, unknown>, parent?: { id: string; namespace: string }) => validateManifest(
      { manifest: 1, ...(parent ? {} : { id: "home" }), name: "Home", engines: { clover: "^1.0.0" }, client: { entry: "ui/index.js" }, host: { entry: "host/index.ts" }, contributes: { ui: [ui] } },
      parent ? { parent, folderName: "home", bundled: true } : { folderName: "home" },
    ).issues.map((i) => `${i.code}:${i.path}`);
    const CLOVER = { id: "clover", namespace: "clover" };
    // A third-party island tab can't pose as Needs you, by id or by title in any case or width.
    expect(entry({ spot: "island.tab", id: "needs-you", component: "Tab", title: "Lights" })).toEqual(["ui_reserved:/contributes/ui/0/id"]);
    expect(entry({ spot: "island.tab", id: "lights", component: "Tab", title: "ＮＥＥＤＳ  you" })).toEqual(["ui_reserved:/contributes/ui/0/title"]);
    expect(entry({ spot: "island.tab", id: "lights", component: "Tab", title: "Lights" })).toEqual([]);
    expect(entry({ spot: "island.tab", id: "needs-you", component: "Tab", title: "Needs you" }, CLOVER)).toEqual([]);
    // Invisible characters, lookalike letters, accents and punctuation don't make it another title (#179's review).
    for (const title of ["Needs\u200B you", "Needs y\u043Eu", "N\u0435eds you", "Ne\u0301eds you!", "needs_you", "NEEDS\u2060 YOU"]) {
      expect([title, entry({ spot: "island.tab", id: "lights", component: "Tab", title })]).toEqual([title, ["ui_reserved:/contributes/ui/0/title"]]);
    }
    expect(entry({ spot: "island.tab", id: "needs_you", component: "Tab", title: "Lights" })).toEqual(["ui_reserved:/contributes/ui/0/id"]);
    // Nor may a plugin be named so: the island labels a tab with its plugin's name.
    const named = (name: string, bundled = false) => validateManifest({ manifest: 1, ...(bundled ? {} : { id: "home" }), name }, bundled ? { parent: CLOVER, folderName: "home", bundled: true } : { folderName: "home" })
      .issues.map((i) => `${i.code}:${i.path}`);
    expect(named("Needs\u200B y\u043Eu")).toEqual(["name_reserved:/name"]);
    expect(named("Needs you", true)).toEqual([]);
    expect(named("Lights")).toEqual([]);
    // Always-on-top surfaces are the clover tree's in 1.111.1 (R12).
    expect(entry({ spot: "app.surface", component: "Float", window: { type: "overlay", alwaysOnTop: true } })).toEqual(["ui_always_on_top:/contributes/ui/0/window/alwaysOnTop"]);
    expect(entry({ spot: "app.surface", component: "Float", window: { type: "overlay", alwaysOnTop: true } }, CLOVER)).toEqual([]);
    // A pill target names the handler that gets the user's words.
    expect(entry({ spot: "pill.target", component: "Target", title: "Lights" }).some((i) => i.endsWith("/handler"))).toBe(true);
    expect(entry({ spot: "pill.target", component: "Target", title: "Lights", handler: "lights" })).toEqual([]);
    expect(foldTitle(" Needs\u3000YOU ")).toBe("needs you");
    // The panel says whose tabs a bot's panel shows; the client entry's bare imports are React 19's and the UI API's.
    expect(Object.keys((SPOTS.find((s) => s.name === "panel")!.props as unknown as { shape: Record<string, unknown> }).shape)).toEqual(["app", "session", "bot"]);
    expect(CLIENT_BARE_IMPORTS).toContain("@waifucave/clover-plugin-sdk/ui");
    expect(API_CALLS["files.watch"]).toEqual({ capability: "files", where: "both" });
  });

  test("a keyed spot's entry with no key fills every key; a key ending in * fills what it matches", () => {
    expect(keyMatches(undefined, "alpha")).toBe(true);
    expect(keyMatches("image/*", "image/png")).toBe(true);
    expect(keyMatches("image/*", "text/plain")).toBe(false);
    expect(keyMatches("bot", "bot")).toBe(true);
  });
});

describe("tokens", () => {
  test("every default fits its type, every name fits the grammar, and sealed frames take only card.*", () => {
    for (const t of TOKENS) {
      expect([t.name, isTokenName(t.name), isTokenValue(t.type, t.default)]).toEqual([t.name, true, true]);
      if (t.dark !== undefined) expect([t.name, isTokenValue(t.type, t.dark)]).toEqual([t.name, true]);
    }
    expect(CARD_TOKENS.map((t) => t.name)).toEqual(expect.arrayContaining([
      "card.background", "card.text", "card.muted", "card.rim", "card.radius", "card.padding", "card.approve.background",
      "card.approve.text", "card.deny.background", "card.deny.text", "card.button.radius", "card.font.family", "card.font.size",
    ]));
    expect(CARD_TOKENS.every((t) => t.name.startsWith("card."))).toBe(true);
    expect(new Set(TOKENS.map((t) => t.name)).size).toBe(TOKENS.length);
    // Two names never map to one custom property.
    expect(new Set(TOKENS.map((t) => cssProperty(t.name))).size).toBe(TOKENS.length);
  });

  test("lane F's twelve plugin.clover tokens are catalog tokens now, at F's measured values", () => {
    const value = (name: string) => { const t = TOKENS.find((x) => x.name === name)!; return [t.type, t.default, t.dark]; };
    expect(value("sidebar.tint")).toEqual(["color", "#F5F5F5B3", "#202020B3"]);
    expect(value("sidebar.solid")).toEqual(["color", "#F5F5F5", "#202020"]);
    expect(value("titlebar.tint")).toEqual(["color", "#FFFFFFC7", "#191919C7"]);
    expect(value("titlebar.blur")).toEqual(["dimension", "16px", undefined]);
    expect(value("titlebar.height")).toEqual(["dimension", "45px", undefined]);
    expect(value("color.scrim")).toEqual(["color", "#00000033", "#00000080"]);
    expect(value("font.line.code")).toEqual(["number", 1.4, undefined]);
    expect(value("color.diff.added.soft")).toEqual(["color", "#1A7F371A", "#8CC28324"]);
    expect(value("color.diff.removed.soft")).toEqual(["color", "#C2364F17", "#DA6F8024"]);
    expect(value("color.branch")).toEqual(["color", "#6F52C4", "#B19EDE"]);
    expect(value("color.unread")).toEqual(["color", "#8A8A8A", "#848484"]);
    expect(value("color.brand")).toEqual(["color", "#C2387A", "#FF7AB6"]);
    // The accent no longer defaults to pink; it follows the OS, with F's blues where nothing is read.
    expect(value("color.accent")).toEqual(["color", "#2F6FDF", "#4180E3"]);
    expect(value("card.approve.background")).toEqual(["color", "#2F6FDF", "#3570D8"]);
    expect(value("color.accent.ink")).toEqual(["color", "#111111", undefined]);
    expect(TOKENS.some((t) => t.name === "card.approve.ink")).toBe(false);
  });

  test("names: lowercase segments, a letter first; the property is --clover- and the name with hyphens", () => {
    expect(isTokenName("color.text.muted")).toBe(true);
    for (const bad of ["Color.text", "color..text", "color.text-muted", "1color", "color.", ".color", "color_text"]) {
      expect([bad, isTokenName(bad)]).toEqual([bad, false]);
    }
    expect(cssProperty("color.text.muted")).toBe("--clover-color-text-muted");
    expect(cssVar("color.text.muted")).toBe("var(--clover-color-text-muted)");
    expect(cssProperty("plugin.mcp-blender.glow")).toBe("--clover-plugin-mcp_blender-glow");
    expect(cssProperty("plugin.mcp.blender.glow")).not.toBe(cssProperty("plugin.mcp-blender.glow"));
    for (const bad of ["x; y", "mcp-blender.glow", "color.text-muted", "plugin.-x.glow"]) expect(() => cssProperty(bad)).toThrow();
  });

  test("a plugin's own tokens are plugin.<top-level id>.<name>, so no id can name a catalog token", () => {
    expect(pluginTokenName("luna", "glow.soft")).toBe("plugin.luna.glow.soft");
    expect(isPluginTokenName("plugin.luna.glow.soft", "luna")).toBe(true);
    expect(isPluginTokenName("plugin.tarot-deck.card.back", "tarot-deck")).toBe(true);
    expect(isPluginTokenName("plugin.luna.Glow", "luna")).toBe(false);
    expect(isPluginTokenName("plugin.lunar.glow", "luna")).toBe(false);
    expect(isPluginTokenName("plugin.luna", "luna")).toBe(false);
    expect(isPluginTokenName("luna.glow", "luna")).toBe(false);
    // A plugin whose id is a catalog group still can't reach the catalog's names, `card.*` included.
    expect(isPluginTokenName("card.background", "card")).toBe(false);
    expect(isPluginTokenName("plugin.card.background", "card")).toBe(true);
    expect(TOKEN_GROUPS.has("plugin")).toBe(false);
    // Every catalog property and every plugin property differ, whatever the ids.
    const plugin = new Set(["card", "color", "font", "card-background"].flatMap((id) => TOKENS.map((t) => cssProperty(pluginTokenName(id, t.name)))));
    for (const t of TOKENS) expect(plugin.has(cssProperty(t.name))).toBe(false);
  });

  test("every value, the catalog's or a plugin's own, passes the safety check", () => {
    for (const bad of ["red; x", "a\nb", '"open', "red !important", "src(x)", "cross-fade(a, b)", Number.NaN, {}, null]) {
      expect([bad, isSafeTokenValue(bad)]).toEqual([bad, false]);
    }
    for (const ok of ["#fff", 1.5, "0 1px 2px rgb(0 0 0 / 40%)"]) expect([ok, isSafeTokenValue(ok)]).toEqual([ok, true]);
  });

  test("quoted strings fit only a font family, and every one must close, read as CSS reads it (review S6)", () => {
    expect(isSafeTokenValue('"Segoe UI", sans-serif', "fontFamily")).toBe(true);
    expect(isSafeTokenValue('"Segoe UI", sans-serif')).toBe(false);
    expect(isSafeTokenValue('"https://evil.example/x.png"', "paint")).toBe(false);
    expect(isTokenValue("shadow", "0 0 'x'")).toBe(false);
    // Counting quotes would pass these; reading them leaves a string open.
    for (const open of [`'"'"`, `"a'b`, `'a"b' "`]) {
      expect([open, isSafeTokenValue(open, "fontFamily"), isTokenValue("fontFamily", open)]).toEqual([open, false, false]);
    }
    expect(isTokenValue("fontFamily", `"It's Mine", serif`)).toBe(true);
    expect(isAnyTokenValue('"Luna Sans", serif')).toBe(true);
    expect(isAnyTokenValue('"https://evil.example/"')).toBe(false);
    expect(isValueForToken("color.accent", '"Luna"')).toBe(false);
    expect(isValueForToken("font.sans", '"Luna Sans", serif')).toBe(true);
  });

  test("a value can never break out of its custom property", () => {
    for (const bad of ["red; } body { x: y", "url(https://evil.example/x.png)", "red /* hi */", "expression(alert(1))", "@import x", "a\\b"]) {
      for (const type of ["color", "shadow", "paint", "fontFamily", "dimension"] as const) expect(isTokenValue(type, bad)).toBe(false);
    }
    expect(isTokenValue("color", "oklch(70% 0.1 250)")).toBe(true);
    expect(isTokenValue("dimension", "1.5rem")).toBe(true);
    expect(isTokenValue("paint", "#FFFFFF")).toBe(true);
    expect(isTokenValue("paint", "linear-gradient(180deg, rgb(0 0 0 / 50%) 0%, #151519 100%)")).toBe(true);
    expect(isTokenValue("paint", "linear-gradient(180deg, url(x.png))")).toBe(false);
    expect(isTokenValue("shadow", "0 4px 24px rgb(0 0 0 / 45%)")).toBe(true);
  });

  test("numbers fit number and fontWeight tokens only", () => {
    expect(isTokenValue("number", 1.62)).toBe(true);
    expect(isTokenValue("fontWeight", 700)).toBe(true);
    expect(isTokenValue("fontWeight", "700")).toBe(true);
    expect(isTokenValue("fontWeight", 0)).toBe(false);
    expect(isTokenValue("fontWeight", 1001)).toBe(false);
    expect(isTokenValue("dimension", 12)).toBe(false);
    expect(isTokenValue("number", Number.NaN)).toBe(false);
    expect(isTokenValue("number", Number.POSITIVE_INFINITY)).toBe(false);
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
    expect(c.capabilities.length).toBe(18);
    expect(c.spots.length).toBe(SPOTS.length);
    expect(c.spots.every((s) => typeof s.props === "object" && typeof s.fields === "object")).toBe(true);
    expect(Object.keys(c.apiCalls).length).toBe(Object.keys(API_CALLS).length);
  });
});
