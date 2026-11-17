// The catalogs (spec §5.3–§5.5): capabilities, hooks, points, spots, tokens, the plugin API's gating, and the names
// derived from plugins (§5.1 wrappers, §6.7 tool names).
import { describe, expect, test } from "bun:test";
import {
  API_CALLS, CAPABILITIES, CARD_TOKENS, CLAUDE_HOOK_EVENTS, CORE_CONTRIBUTION_KEYS, CORE_POINTS, DATA_POINTS, HOOK_EVENTS,
  HOOK_RETURNS, MESSAGE_KINDS, PointDeclSchema, SPOTS, TOKENS, TOKEN_GROUPS, WELL_KNOWN_POINT_NAMES, apiCallAllowed, capabilityOkText, catalogJson,
  RETIRED_CAPABILITIES, RETIRED_POINTS, catalogPointDecl, cssProperty, cssVar, isAnyTokenValue, isValueForToken,
  fetchesCodeAtRunTime, hookMatchesTool, hookOrder, interpolate, isPluginTokenName, isSafeTokenValue, isTokenName, isTokenValue, keyMatches,
  networkAllows, pluginTokenName, withImplied,
  parseCapability,
  parseInterpolation, splitToolWireName, toolWireName, validateManifest, wrapperId, foldTitle, isReservedPluginName, CLIENT_BARE_IMPORTS,
  reachesPublicNetwork, BOTS_OFFER, BOT_TAB_INSIDE, SAME_ON_EVERY_TAB, botsOffer, describeOk,
} from "../src/index";

describe("capabilities", () => {
  test("the catalog holds §5.4's sixteen, devices.read for the Devices tab (review S16), terminal for the terminal panel, plugins.install and plugins.watch for the index browser and project.write for the fence", () => {
    // The lists come from the catalog itself (the controller's ruling: no hand-kept copy to fall out of step); what is checked
    // here is their shape: each name once, the families last, every warning a plain OK line.
    const names = CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["conversation.read", "conversation.post", "memory.read", "bots.read", "routines.read", "computers.read", "computers.control", "devices.read", "approvals", "files", "project.write", "browser", "terminal", "shell.read", "shell.control", "plugins.install", "plugins.watch", "usage.read", "logs.read", "notify", "audio", "microphone", "app.settings", "bots.edit", "plugins.read", "plugins.manage", "tools.permissions", "account.read", "commands.run"]));
    expect(names.slice(-3)).toEqual(["call:<plugin-id>", "network:public", "network:<host>"]);
    for (const c of CAPABILITIES) expect([c.name, typeof c.ok === "string" && c.ok.length > 0 && !/[.]$/.test(c.ok)]).toEqual([c.name, true]);
    const warned = CAPABILITIES.filter((c) => c.warns).map((c) => c.name);
    expect(warned).toEqual(expect.arrayContaining(["computers.control", "approvals", "browser", "terminal", "audio", "microphone", "network:public", "app.settings", "bots.edit", "plugins.read", "plugins.manage", "tools.permissions", "account.read", "commands.run"]));
    expect(names).not.toContain("voices.use");
    expect(CAPABILITIES.find((c) => c.name === "audio")?.ok).toBe("can play sound at any time, even while no window of it shows");
    expect(CAPABILITIES.find((c) => c.name === "bots.edit")?.ok).toBe("changes your bots' settings when you press its controls: their names, instructions, models, voices and keys, and whether a bot's browser may reach your home network");
  });

  test("F2: the app's door for parts gates by seven capabilities any plugin may ask for, each with its line on the OK card; plugins.manage carries plugins.read", () => {
    const eight = ["app.settings", "bots.edit", "plugins.read", "plugins.manage", "tools.permissions", "account.read", "commands.run"];
    const asks = validateManifest({ manifest: 1, id: "my-settings", name: "My Settings", engines: { moss: "^1.0.0" }, client: { entry: "ui/index.js" }, capabilities: eight }, { folderName: "my-settings" });
    expect(asks.issues.filter((i) => i.severity === "error")).toEqual([]);
    const ok = describeOk(asks);
    for (const name of eight) expect(ok).toContain(`It ${CAPABILITIES.find((c) => c.name === name)!.ok}.`);
    expect(CAPABILITIES.filter((c) => eight.includes(c.name) && !c.warns).map((c) => c.name)).toEqual([]);
    expect(withImplied(["plugins.manage"])).toEqual(["plugins.manage", "plugins.read"]);
    expect(withImplied(["plugins.read"])).toEqual(["plugins.read"]);
  });

  test("no capability is MOSS's own: any plugin may ask for the five that were (the owner, 2026-11-15), each a warning on its card", () => {
    const six = ["browser", "terminal", "plugins.install", "plugins.watch", "network:public"];
    for (const name of six) expect({ name, warns: CAPABILITIES.find((c) => c.name === name)?.warns }).toEqual({ name, warns: true });
    expect(CAPABILITIES.some((c) => "bundledOnly" in c)).toBe(false);
    const asks = validateManifest({ manifest: 1, id: "asks-all", name: "Asks", engines: { moss: "^1.0.0" }, client: { entry: "ui/index.js" }, capabilities: six }, { folderName: "asks-all" });
    expect(asks.issues.filter((i) => i.severity === "error")).toEqual([]);
    const ok = describeOk(asks);
    for (const name of six) expect(ok).toContain(`It ${CAPABILITIES.find((c) => c.name === name)!.ok}.`);
  });

  test("a web plugin's tools are its manifest's (webSearch, webFetch, needs), any plugin's, each a warning on its card", () => {
    const web = (server: Record<string, unknown>, capabilities: string[] = ["network:search.example.com", "network:public"]) => validateManifest(
      { manifest: 1, id: "acme-web", name: "Acme web", engines: { moss: "^1.0.0" }, host: { entry: "host/index.ts" }, capabilities, contributes: { mcpServers: { web: { type: "host", tools: { Search: "preload", Fetch: "preload" }, ...server } } } },
      { folderName: "acme-web" },
    );
    const good = web({ webSearch: ["Search"], webFetch: ["Fetch"], needs: { Fetch: "network:public" } });
    expect(good.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(good.webTools).toEqual([{ server: "web", search: ["Search"], fetch: ["Fetch"] }]);
    const ok = describeOk(good);
    expect(ok).toContain("Its server web says Search searches the web: at the default approval level a search runs without asking, and what a bot searches goes to this plugin.");
    expect(ok.some((l) => l.startsWith("Its server web says Fetch reads web pages: at the default approval level a page whose link a bot already has is read without asking"))).toBe(true);
    // A page fetch needs network:public; a search a network: capability; a need a declared capability; one tool, one list.
    expect(web({ webFetch: ["Fetch"] }, ["network:search.example.com"]).issues.map((i) => i.code)).toEqual(["web_tool_no_network"]);
    expect(web({ webSearch: ["Search"] }, []).issues.map((i) => i.code)).toEqual(["web_tool_no_network"]);
    expect(web({ needs: { Fetch: "browser" } }).issues.map((i) => i.code)).toEqual(["tool_needs_undeclared"]);
    expect(web({ readOnly: ["Search"], webSearch: ["Search"] }).issues.map((i) => i.code)).toEqual(["tool_in_both_lists"]);
  });

  test("network:public: any public host through the core's fetch, no host for its components", () => {
    expect(parseCapability("network:public")).toEqual({ kind: "fixed", name: "network:public" });
    expect(reachesPublicNetwork(["network:public"])).toBe(true);
    expect(reachesPublicNetwork(["network:api.example.com"])).toBe(false);
    const web = (id: string, parent?: { id: string; namespace: string }) => validateManifest(
      { manifest: 1, ...(parent ? {} : { id }), name: "Web", engines: { moss: "^1.0.0" }, host: { entry: "host/index.ts" }, capabilities: ["network:public"] },
      parent ? { parent, folderName: id, bundled: true } : { folderName: id },
    );
    expect(web("webby").issues).toEqual([]);
    expect(web("webby").networkHosts).toEqual([]);
    const bundled = web("web", { id: "moss", namespace: "moss" });
    expect(bundled.issues).toEqual([]);
    expect(bundled.networkHosts).toEqual([]);
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
      // A family by kind (spec revision 19, §3.6) names one capability per kind of data.
      const family = cap.endsWith(".*") && cap !== "call:*" && cap !== "network:*" ? ["sessions", "bots"].every((k) => names.has(`${cap.slice(0, -1)}${k}`)) : false;
      expect([call, cap === "call:*" || cap === "network:*" || family || names.has(cap)]).toEqual([call, true]);
    }
  });

  test("every capability but call: and network: gates at least one call", () => {
    const used = new Set(Object.values(API_CALLS).flatMap((i) => {
      const cap = (i as { capability?: string }).capability;
      // A family by kind gates each kind's capability.
      return cap !== undefined && cap.endsWith(".*") && cap !== "call:*" && cap !== "network:*" ? [`${cap.slice(0, -1)}sessions`, `${cap.slice(0, -1)}bots`] : [cap];
    }));
    // network:public gates the core's fetch, as network:<host> does, not an API call; project.write gates the
    // plugin-process fence (its hooks' and MCP servers' writes to project folders); plugins.watch gates events only
    // (the controller's ruling: nothing callable).
    // logs.read widens what `logs.*` reads (MOSS's log and every plugin's, beyond the plugin's own), which the core
    // checks per source: the calls themselves need no capability.
    // `microphone` is a permission of the plugin's own frames (`getUserMedia`), checked in the window's session, not an API call;
    // `audio` is the frames' autoplay and the device's speech turn (the turns catalog), not an API call either.
    // approvals.all, user.send, overlay and tray gate a window's fields, a hook and a spot (the app checks them), not a call.
    // F2's eight gate the app's door for its parts (tree-calls.ts and the composer spot's), not a plugin-API call.
    const doorCaps = ["app.settings", "bots.edit", "plugins.read", "plugins.manage", "tools.permissions", "account.read", "commands.run"];
    const notCalls = ["approvals.all", "user.send", "overlay", "tray", "project.write", "plugins.watch", "logs.read", "memory.read", "routines.read", "microphone", "audio", ...doorCaps];
    for (const c of CAPABILITIES) if (!c.name.includes("<") && !c.name.startsWith("network:") && !notCalls.includes(c.name)) expect([c.name, used.has(c.name)]).toEqual([c.name, true]);
    expect(used.has("plugins.watch")).toBe(false);
  });

  test("without the capability the call doesn't exist; secrets only in a host's own process", () => {
    expect(apiCallAllowed("conversation.history", "shared", ["conversation.read"])).toBe(true);
    expect(apiCallAllowed("conversation.history", "shared", ["conversation.post"])).toBe(false);
    expect(apiCallAllowed("conversation.note", "ui", ["conversation.post"])).toBe(true);
    expect(apiCallAllowed("secrets.get", "ui", [])).toBe(false);
    // Only a process of the plugin's own reads a secret, never a worker of a shared process (review minor).
    expect(apiCallAllowed("secrets.get", "shared", [])).toBe(false);
    expect(apiCallAllowed("secrets.get", "moss", [])).toBe(false);
    expect(apiCallAllowed("secrets.get", "own", [])).toBe(true);
    // Key pairs only from the moss process (the owner's answer to S4).
    for (const call of ["keys.open", "keys.publicKey", "keys.delete"]) {
      expect([call, apiCallAllowed(call, "moss", []), apiCallAllowed(call, "shared", []), apiCallAllowed(call, "own", []), apiCallAllowed(call, "ui", [])]).toEqual([call, true, false, false, false]);
    }
    // Calls for any host half reach every process.
    for (const from of ["moss", "shared", "own"] as const) expect(apiCallAllowed("ui.send", from, [])).toBe(true);
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
      "bot", "models", "mcpServers", "skills", "agents", "agentBackends", "hooks", "commands", "triggers",
      "turns", "computerProviders", "computer", "relays", "notifiers", "companions", "themes", "app.root", "app.surface", "app.background", "bot.tab", "locales",
    ]);
    for (const p of CORE_POINTS) if (p.side === "daemon" || p.name === "themes" || p.name === "locales") expect(CORE_CONTRIBUTION_KEYS).toContain(p.name as never);
    expect(CORE_POINTS.filter((p) => p.uniqueBy).map((p) => `${p.name}.${p.uniqueBy}`)).toEqual([
      "models.provider", "agentBackends.id", "commands.name", "triggers.type", "computerProviders.id",
    ]);
  });

  test("the spot catalog holds §5.5's spots, with conversation.message's keys and its kept approval cell", () => {
    const names = SPOTS.map((s) => s.name);
    for (const n of ["app.root", "app.surface", "bot.tab", "sidebar", "sidebar.bot", "sidebar.app", "main", "panel", "panel.view", "settings.section", "bot.editor.section",
      "bot.header", "bot.side", "conversation", "composer", "composer.action", "conversation.message", "tool.result",
      "conversation.message.extra", "bot.header.action", "status", "file.preview", "island.tab", "pill.target"]) expect(names).toContain(n);
    const msg = SPOTS.find((s) => s.name === "conversation.message")!;
    expect(msg.keys).toEqual(MESSAGE_KINDS);
    expect(msg.keep).toEqual(["approval"]);
    expect(msg.needs).toEqual(["conversation.read"]);
    expect(new Set(names).size).toBe(names.length);
    expect(SPOTS.find((s) => s.name === "panel.view")!.doc).toBe("A spot inside each panel view, keyed by the view's id.");
  });

  test("what Bots offers a bot's plugin is a closed list: inside its tab, its top bar, the Browser and agent panels; never the sidebar, Settings or the Edit page", () => {
    expect([...BOTS_OFFER.keys()].sort()).toEqual(["bar", "bot.controls", "bot.header", "bot.header.action", "bot.side", "bot.tab", "chrome.action", "chrome.actions", "chrome.drag", "chrome.panels", "chrome.sidebar", "chrome.title", "composer", "composer.action",
      "conversation", "conversation.message", "conversation.message.action", "conversation.message.extra", "file.preview", "panel", "tool.result"]);
    expect(BOTS_OFFER.get("panel")).toEqual(["browser", "agent"]);
    expect([botsOffer("panel", "browser"), botsOffer("panel", "agent"), botsOffer("panel", "terminal"), botsOffer("panel"), botsOffer("bar"), botsOffer("status")]).toEqual([true, true, false, false, true, false]);
    for (const s of SAME_ON_EVERY_TAB) expect(botsOffer(s)).toBe(false);
    // A bot's layout places the spots inside its tab: not the window's bar or panels.
    expect(BOT_TAB_INSIDE.has("bar") || BOT_TAB_INSIDE.has("panel")).toBe(false);
    expect(BOT_TAB_INSIDE.has("conversation")).toBe(true);
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
      // A platform point's declaration also says `platform: true` (no plugin declares it); that mark is the catalog's, not a manifest field.
      const { platform: _platform, ...declared } = decl as typeof decl & { platform?: boolean };
      expect(PointDeclSchema.safeParse(declared).success).toBe(true);
      expect(decl!.props !== undefined).toBe(SPOTS.some((s) => s.name === name));
    }
    expect(catalogPointDecl("conversation.message")).toMatchObject({ shape: "keyed", keep: ["approval"], needs: ["conversation.read"], context: ["bot"] });
    expect(catalogPointDecl("webhook.ingress")).toMatchObject({ shape: "list", fields: { type: "object" } });
    expect(catalogPointDecl("webhook.ingress")!.props).toBeUndefined();
    expect(catalogPointDecl("webhook.ingress")).not.toHaveProperty("platform");
    for (const name of ["app.root", "bot.tab", "models", "luna.cards"]) expect(catalogPointDecl(name)).toBeUndefined();
  });

  test("the avatar left the platform (G7): its capabilities, points and spots are retired, each naming what replaced it, and none is in a catalog", () => {
    for (const r of RETIRED_CAPABILITIES) expect([r.name, CAPABILITIES.some((c) => c.name === r.name), r.replacedBy.length > 20]).toEqual([r.name, false, true]);
    for (const r of RETIRED_POINTS) expect([r.name, SPOTS.some((x) => x.name === r.name), DATA_POINTS.some((x) => x.name === r.name)]).toEqual([r.name, false, false]);
    const asks = validateManifest({ manifest: 1, id: "old-stage", name: "Old stage", engines: { moss: "^1.0.0" }, client: { entry: "ui/index.js" }, capabilities: ["avatar.report", "bots.avatar"], contributes: { "avatar.packs": [{ id: "x", file: "x.vrm", format: "vrm" }], ui: [{ spot: "avatar", key: "vrm", id: "v", component: "V" }] } }, { folderName: "old-stage" });
    const errors = asks.issues.filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/^capability_retired: `avatar.report` is retired: use the avatar plugin's own UI spot `moss.character.renderer`/),
      expect.stringMatching(/^capability_retired: `bots.avatar` is retired/),
      expect.stringMatching(/^point_retired: `avatar.packs` is retired: use the avatar plugin's own point `moss.character.packs`/),
      expect.stringMatching(/^spot_retired: `avatar` is retired/),
    ]));
  });

  test("lane F's asks: settings declares its sections, an unfilled panel key shows a placeholder, a panel may be for some sessions only", () => {
    const spot = (name: string) => SPOTS.find((s) => s.name === name)!;
    expect(spot("settings.section").declaredBy).toBe("settings");
    expect(spot("bot.editor.section")).toMatchObject({ shape: "list", declaredBy: "bot-editor", context: ["bot"] });
    expect(spot("panel").placeholder).toBe(true);
    expect(spot("panel").context).toContain("session");
    const panel = (when: unknown) => validateManifest({
      manifest: 1, id: "term", name: "Term", engines: { moss: "^1.0.0" }, client: { entry: "ui/index.js" },
      contributes: { ui: [{ spot: "panel", key: "terminal", component: "Terminal", title: "Terminal", when }] },
    });
    expect(panel({ session: "coding" }).issues).toEqual([]);
    expect(panel({ session: ["coding", "agent"] }).issues).toEqual([]);
    expect(panel({ session: "code" }).issues.map((i) => [i.refuses, i.path])).toEqual([["entry", "/contributes/ui/0/when/session"]]);
  });

  test("the schedule and webhook trigger types are the bundled tree's: a third-party triggers entry can't take either", () => {
    const trigger = (type: string, parent?: { id: string; namespace: string }) => validateManifest(
      { manifest: 1, ...(parent ? {} : { id: "hooks" }), name: "Hooks", engines: { moss: "^1.0.0" }, host: { entry: "host/index.ts" }, contributes: { triggers: [{ type, title: "T", handler: "t" }] } },
      parent ? { parent, folderName: "hooks", bundled: true } : { folderName: "hooks" },
    ).issues.filter((i) => i.severity === "error").map((i) => `${i.code}:${i.path}`);
    expect(trigger("webhook")).toEqual(["trigger_reserved:/contributes/triggers/0/type"]);
    expect(trigger("schedule")).toEqual(["trigger_reserved:/contributes/triggers/0/type"]);
    expect(trigger("slack")).toEqual([]);
    expect(trigger("webhook", { id: "moss", namespace: "moss" })).toEqual([]);
  });

  test("lane G's asks: reserved island tabs, always-on-top surfaces and pill targets' handlers are the moss tree's rules", () => {
    const entry = (ui: Record<string, unknown>, parent?: { id: string; namespace: string }, capabilities: string[] = []) => validateManifest(
      { manifest: 1, ...(parent ? {} : { id: "home" }), name: "Home", capabilities, engines: { moss: "^1.0.0" }, client: { entry: "ui/index.js" }, host: { entry: "host/index.ts" }, contributes: { ui: [ui] } },
      parent ? { parent, folderName: "home", bundled: true } : { folderName: "home" },
    ).issues.map((i) => `${i.code}:${i.path}`);
    const MOSS = { id: "moss", namespace: "moss" };
    // A third-party island tab can't pose as Needs you, by id or by title in any case or width.
    expect(entry({ spot: "island.tab", id: "needs-you", component: "Tab", title: "Lights" })).toEqual(["ui_reserved:/contributes/ui/0/id"]);
    expect(entry({ spot: "island.tab", id: "lights", component: "Tab", title: "ＮＥＥＤＳ  you" })).toEqual(["ui_reserved:/contributes/ui/0/title"]);
    expect(entry({ spot: "island.tab", id: "lights", component: "Tab", title: "Lights" })).toEqual([]);
    expect(entry({ spot: "island.tab", id: "needs-you", component: "Tab", title: "Needs you" }, MOSS)).toEqual([]);
    // Invisible characters, lookalike letters, accents and punctuation don't make it another title (#179's review).
    for (const title of ["Needs\u200B you", "Needs y\u043Eu", "N\u0435eds you", "Ne\u0301eds you!", "needs_you", "NEEDS\u2060 YOU"]) {
      expect([title, entry({ spot: "island.tab", id: "lights", component: "Tab", title })]).toEqual([title, ["ui_reserved:/contributes/ui/0/title"]]);
    }
    expect(entry({ spot: "island.tab", id: "needs_you", component: "Tab", title: "Lights" })).toEqual(["ui_reserved:/contributes/ui/0/id"]);
    // Nor may a plugin be named so: the island labels a tab with its plugin's name.
    const named = (name: string, bundled = false) => validateManifest({ manifest: 1, ...(bundled ? {} : { id: "home" }), name }, bundled ? { parent: MOSS, folderName: "home", bundled: true } : { folderName: "home" })
      .issues.map((i) => `${i.code}:${i.path}`);
    expect(named("Needs\u200B y\u043Eu")).toEqual(["name_reserved:/name"]);
    expect(named("Needs you", true)).toEqual([]);
    expect(named("Lights")).toEqual([]);
    for (const name of ["MOSS", "M\u041ESS", "moss!"]) expect([name, named(name)]).toEqual([name, ["name_reserved:/name"]]);
    expect(named("MOSS", true)).toEqual([]);
    // Always-on-top surfaces are for a plugin with the `overlay` capability, whoever it is (F4), and cards and the tray likewise.
    const float = { spot: "app.surface", component: "Float", window: { type: "overlay", alwaysOnTop: true } };
    expect(entry(float)).toEqual(["ui_window_capability:/contributes/ui/0/window/alwaysOnTop"]);
    expect(entry(float, MOSS)).toEqual(["ui_window_capability:/contributes/ui/0/window/alwaysOnTop"]);
    expect(entry(float, undefined, ["overlay"])).toEqual([]);
    expect(entry(float, MOSS, ["overlay"])).toEqual([]);
    // approvals.all alone is refused: it is a widening of `approvals`.
    expect(validateManifest({ manifest: 1, id: "home", name: "Home", capabilities: ["approvals.all"] }, { folderName: "home" }).issues.map((i) => `${i.code}:${i.path}`)).toEqual(["capability_needs:/capabilities/0"]);
    const cards = { spot: "app.surface", component: "Float", window: { type: "overlay", cards: true } };
    expect(entry(cards, undefined, ["approvals"])).toEqual(["ui_window_capability:/contributes/ui/0/window/cards"]);
    expect(entry(cards, undefined, ["approvals.all"])).toEqual(["capability_needs:/capabilities/0", "ui_window_capability:/contributes/ui/0/window/cards"]);
    expect(entry(cards, undefined, ["approvals", "approvals.all"])).toEqual([]);
    expect(entry({ spot: "app.surface", component: "Float", window: { type: "overlay", front: "steps-aside", summon: ["tap"] } })).toEqual([]);
    expect(entry({ spot: "app.tray", id: "put-away", title: "Hide Home", toggles: "float" })).toEqual(["ui_window_capability:/contributes/ui/0"]);
    expect(entry({ spot: "app.tray", id: "put-away", title: "Hide Home", toggles: "float" }, undefined, ["tray"])).toEqual([]);
    expect(entry({ spot: "app.tray", id: "put-away", title: "Hide Home" }, undefined, ["tray"])).toEqual(["ui_tray_field:/contributes/ui/0"]);
    expect(entry({ spot: "app.tray", id: "x", title: "X", toggles: "a", command: "b" }, undefined, ["tray"])).toEqual(["ui_tray_field:/contributes/ui/0"]);
    expect(entry({ spot: "app.surface", component: "Float", toggles: "a" })).toEqual(["ui_tray_field:/contributes/ui/0/toggles"]);
    // A pill target names the handler that gets the user's words.
    expect(entry({ spot: "pill.target", component: "Target", title: "Lights" }).some((i) => i.endsWith("/handler"))).toBe(true);
    expect(entry({ spot: "pill.target", component: "Target", title: "Lights", handler: "lights" })).toEqual([]);
    expect(foldTitle(" Needs\u3000YOU ")).toBe("needsyou");
    // As lane G's island compares: small capitals, Cherokee letters, I/1/l as one, "rn" as "m", and missing or
    // invisible spaces fold too, so the manifest check and the island agree.
    for (const t of ["Needsyou", "Needs\u200Byou", "\u0274\u1D07\u1D07\u1D05\uA731 \u028F\u1D0F\u1D1C"]) expect([t, foldTitle(t)]).toEqual([t, foldTitle("Needs you")]);
    for (const t of ["M0SS", "M\u041ESS", "\u041C\u041E\u0405\u0405", "\u039COSS", "M\u03BFSS"]) expect([t, foldTitle(t)]).toEqual([t, foldTitle("MOSS")]);
    expect(foldTitle("Rnoon")).toBe(foldTitle("moon"));
    // Lane G's cases: I and i are one letter, with 1, l, | and the Greek and Cyrillic lookalikes, so a bot named
    // "Iris" refuses a pill target "iris"; "vv" reads as "w" and "cl" as "d", as the island folds them.
    for (const [a, b] of [["Iris", "iris"], ["Ivy", "ivy"], ["ILSE", "ilse"], ["Iris", "lris"], ["Iris", "1ris"], ["Iris", "|ris"],
      ["Iris", "\u0399ris"], ["Iris", "\u0406ris"], ["iris", "\u0456ris"], ["iris", "\u03B9ris"], ["iris", "\u0131ris"], ["Iris", "\u0130ris"],
      ["Wanda", "Vvanda"], ["wanda", "\u03BD\u03BDanda"], ["Dot", "Clot"], ["dot", "cIot"], ["mimi", "rnirni"]] as const) {
      expect([a, b, foldTitle(a) === foldTitle(b)]).toEqual([a, b, true]);
    }
    expect(foldTitle("Iris")).toBe("lrls");
    // #187's review: stroke letters, Lisu, the lunate sigma, and marks NFKC would spell out.
    for (const t of ["Neeđs you", "Neeɗs you", "Needs yøu", "Ꮑeeds you", "ꓠeeds you", "Needs ყou"]) expect([t, foldTitle(t)]).toEqual([t, foldTitle("Needs you")]);
    for (const t of ["MØSS", "M\u0585SS", "M\u0555SS", "\uA4DFOSS", "Ꮇ0SS", "MOSS™", "MOSS®", "M○SS", "M\u00F2SS", "MO\u0405S", "MOS\u0405"]) expect([t, foldTitle(t)]).toEqual([t, foldTitle("MOSS")]);
    expect(foldTitle("ħŧđ")).toBe("htd");
    expect(foldTitle("Iris")).not.toBe(foldTitle("Irma"));
    // #264's review: lookalikes the island's own fold refused, which needed the order (NFKD and marks first, the map
    // before and after case) and the island's tables: Cherokee, Armenian capitals, Greek sigmas, Cyrillic yi.
    for (const t of ["Needs y\u0585u", "Needs y\u03C3u", "N\u0451eds you", "NEEDS Y\u13EBU", "NEEDS Y\u0555U", "NEEDS YO\u054D", "NEED\u054F YOU"]) expect([t, foldTitle(t)]).toEqual([t, foldTitle("Needs you")]);
    for (const t of ["M\u13EBSS", "M\u0555SS", "MO\u054FS", "MO\u0405S", "\u13B7OSS"]) expect([t, isReservedPluginName(t)]).toEqual([t, true]);
    // Too loose to keep: Greek eta reads as "n" only in some faces.
    expect(foldTitle("\u03B7eeds you")).not.toBe(foldTitle("Needs you"));
    // The panel says whose tabs a bot's panel shows; the client entry's bare imports are React 19's and the UI API's.
    expect(Object.keys((SPOTS.find((s) => s.name === "panel")!.props as unknown as { shape: Record<string, unknown> }).shape)).toEqual(["app", "session", "bot"]);
    expect(CLIENT_BARE_IMPORTS).toContain("@waifucave/moss-plugin-sdk/ui");
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

  test("lane F's twelve plugin.moss tokens are catalog tokens now, at F's measured values", () => {
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

  test("names: lowercase segments, a letter first; the property is --moss- and the name with hyphens", () => {
    expect(isTokenName("color.text.muted")).toBe(true);
    for (const bad of ["Color.text", "color..text", "color.text-muted", "1color", "color.", ".color", "color_text"]) {
      expect([bad, isTokenName(bad)]).toEqual([bad, false]);
    }
    expect(cssProperty("color.text.muted")).toBe("--moss-color-text-muted");
    expect(cssVar("color.text.muted")).toBe("var(--moss-color-text-muted)");
    expect(cssProperty("plugin.mcp-blender.glow")).toBe("--moss-plugin-mcp_blender-glow");
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

  test("wrappers are mcp-<server>, skill-<name>, agent-<name>, claude-<name>, cleaned up, numbered on a clash or for moss (§5.1)", () => {
    expect(wrapperId("mcp", "Blender", new Set())).toEqual({ id: "mcp-blender", namespace: "blender" });
    expect(wrapperId("mcp", "My Cool_Server!!", new Set())).toEqual({ id: "mcp-my-cool-server", namespace: "my-cool-server" });
    expect(wrapperId("mcp", "blender", new Set(["mcp-blender"]))).toEqual({ id: "mcp-blender-2", namespace: "blender-2" });
    expect(wrapperId("mcp", "moss", new Set())).toEqual({ id: "mcp-moss-2", namespace: "moss-2" });
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
    expect(c.capabilities.map((x: { name: string }) => x.name)).toEqual(CAPABILITIES.map((x) => x.name));
    expect(c.spots.length).toBe(SPOTS.length);
    expect(c.spots.every((s) => typeof s.props === "object" && typeof s.fields === "object")).toBe(true);
    expect(Object.keys(c.apiCalls).length).toBe(Object.keys(API_CALLS).length);
  });
});

describe("format upgrades (§5.1 \"Formats\")", () => {
  test("a document's format comes from its version key; newer is refused, current left", async () => {
    const { formatOf, upgradeDocument } = await import("../src/formats/upgrade");
    expect(formatOf({ manifest: 1, name: "x" })).toEqual({ format: "manifest", version: 1 });
    expect(formatOf({ theme: 1 })).toEqual({ format: "theme", version: 1 });
    expect(formatOf({ name: "plain json" })).toBeUndefined();
    expect(upgradeDocument({ layout: 1 })).toEqual({ status: "current", format: "layout", version: 1 });
    expect(upgradeDocument({ locale: 7 })).toEqual({ status: "newer", format: "locale", version: 7, reads: 1 });
  });
});

describe("hosts from settings (#187's review)", () => {
  test("never under a shared-hosting suffix", async () => {
    const { parseNetworkHost, underSharedHosting } = await import("../src/catalogs/capabilities");
    for (const h of ["${setting:r}.github.io", "${setting:r}.workers.dev", "${setting:r}.pages.dev", "${setting:r}.vercel.app", "${setting:r}.netlify.app",
      "${setting:r}.herokuapp.com", "${setting:r}.appspot.com", "${setting:r}.cloudfront.net", "${setting:r}.azurewebsites.net", "${setting:r}.blogspot.com",
      "x.${setting:r}.s3.amazonaws.com"]) expect([h, parseNetworkHost(h)]).toEqual([h, null]);
    expect(parseNetworkHost("bedrock-runtime.${setting:r}.amazonaws.com")).not.toBeNull();
    expect(underSharedHosting("me.github.io")).toBe(true);
    expect(underSharedHosting("example.com")).toBe(false);
  });
});

describe("browser.toolCaller", () => {
  test("is the tool's host half's call only, so no component is offered it", () => {
    expect(API_CALLS["browser.toolCaller"]).toEqual({ capability: "browser", where: "host" });
    expect(API_CALLS["browser.tabs"]?.where).toBe("both");
  });
});
