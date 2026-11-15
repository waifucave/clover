// The manifest fields row (checklist rows 1.2, 1.10, 1.14, 1.17, 1.21, 1.23, 1.25, 1.26, 1.33, 1.47): fixture plugins
// the run writes into its own temp folder, each installed over the app's methods (so it runs in the cli role on a
// packaged table too) and read back: a `host.runtime: "node"` and a `helper` plugin refused with their instead-messages;
// settings by scope (account, device, bot) as its host reads them; a `custom` sign-in whose handler the core runs and
// holds to its rules; a `platforms` list that leaves this computer out; a child off by default; `mcpServers` placed per
// computer and by `when.os`; an `agents`-scoped and an `onlyBackends` plugin, read from what Alpha's turn and a coding
// session on Clover's own agent are offered; a Claude Code plugin folder wrapped. Kept apart from run.ts (which starts
// a run when loaded) so the fixtures and the verdicts can be unit-tested.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bridgeShortName } from "../../packages/core/src/agents/plugin-reach";
import { resolveShell } from "../../packages/plugin-sdk/src/formats/shell";

export const MANIFEST_FIELDS_STEP = "manifest fields on the app: a host.runtime node and a helper plugin refused with their instead-messages; settings by scope (account, device, bot) read by its host as set; a custom sign-in's handler run and held to the core's flows; a platforms list without this computer off with why; a child off by default until switched on; servers by perComputer and when.os; an agents-scoped plugin offered to a coding session and not to Alpha, an onlyBackends one the other way round; a Claude Code plugin folder wrapped and its skill in Alpha's Glossary; a plugin with a bot: its OK card's lines and checkbox for its parts beyond the bot's tab, a tool inside the bot offered to that bot and not to Alpha, its app parts switched off with the bot kept, and a bot's entry on the sidebar refused with its words; the rest of Bots' offer list refused, each with its words (a panel key besides Browser and agent, another bot's tab, a spot not offered, each same-on-every-tab spot tied to a bot), and a theme's old sidebar names loaded with a warning and ignored; per-entry own-bot: her skill and agent definition in her Glossary and not Alpha's, her command refused to Alpha's session";

export const ENGINES = { clover: "^1.0.0" } as const;

/** The ids the row installs (each removed at its end, whatever failed). */
export const FIELDS_IDS = {
  node: "acceptance-node",
  helper: "acceptance-helper",
  fields: "acc-fields",
  platforms: "acceptance-elsewhere",
  // Long on purpose: its tool's bridge name (`acceptance-agents-only-tools__AgentsOnly`) passes the bridge's 34
  // characters, so a coding session gets it under its short form (`AGENTS_ONLY_SHORT`) and calls it by that.
  agents: "acceptance-agents-only",
  cc: "acc-cc",
  bot: "acc-juniper",
  botSidebar: "acc-bot-sidebar",
  oldSidebar: "acc-old-sidebar",
} as const;

/** A host half that serves the named host MCP servers, each with its tools, every tool answering `<tool>-pong` unless
 *  `calls` names it (tool → body of an async function of the host's `api`, run while serving the call, so its API calls
 *  act for the session the call serves; what it returns is the answer, and what it throws comes back as `refused: …`);
 *  and the handlers given (name → body of an async function `(args, ctx)`). */
export function hostSource(servers: Record<string, string[]>, handlers: Record<string, string> = {}, calls: Record<string, string> = {}): string {
  const lines = [
    "// The acceptance run's manifest-fields fixture (written by the run): host MCP servers whose tools answer `<tool>-pong`, and its handlers.",
    `const calls = { ${Object.entries(calls).map(([tool, body]) => `${JSON.stringify(tool)}: async (api) => { ${body} }`).join(", ")} };`,
    "const serve = (tools) => async (transport, api) => {",
    "  const reply = (id, body) => void transport.send({ jsonrpc: \"2.0\", id, ...body }).catch(() => {});",
    "  transport.onmessage = (m) => {",
    "    if (m.id === undefined) return;",
    "    const p = m.params ?? {};",
    "    if (m.method === \"initialize\") reply(m.id, { result: { protocolVersion: typeof p.protocolVersion === \"string\" ? p.protocolVersion : \"2025-06-18\", capabilities: { tools: {} }, serverInfo: { name: \"acceptance-fields\", version: \"1\" } } });",
    "    else if (m.method === \"ping\") reply(m.id, { result: {} });",
    "    else if (m.method === \"tools/list\") reply(m.id, { result: { tools: tools.map((name) => ({ name, description: `The acceptance run's ${name}.`, inputSchema: { type: \"object\", properties: {}, additionalProperties: false } })) } });",
    "    else if (m.method === \"tools/call\" && tools.includes(p.name) && calls[p.name] !== undefined) {",
    "      const text = (t) => reply(m.id, { result: { content: [{ type: \"text\", text: t }] } });",
    "      Promise.resolve().then(() => calls[p.name](api)).then((v) => text(String(v)), (err) => text(`refused: ${err?.message ?? String(err)}`));",
    "    }",
    "    else if (m.method === \"tools/call\" && tools.includes(p.name)) reply(m.id, { result: { content: [{ type: \"text\", text: `${p.name}-pong` }] } });",
    "    else reply(m.id, { error: { code: -32601, message: `unknown: ${String(m.method)}` } });",
    "  };",
    "  await transport.start();",
    "};",
    "export async function start() {}",
    "export async function stop() {}",
    `export const mcp = { ${Object.entries(servers).map(([name, tools]) => `${JSON.stringify(name)}: serve(${JSON.stringify(tools)})`).join(", ")} };`,
    ...Object.entries(handlers).map(([name, body]) => `export async function ${name}(args, ctx) { ${body} }`),
    "",
  ];
  return lines.join("\n");
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A plugin folder with one manifest and a host half (`host/index.js`). */
export function writePlugin(dir: string, manifest: Record<string, unknown>, host?: string, extra: Record<string, string> = {}): string {
  writeTree(dir, {
    "clover.json": `${JSON.stringify(manifest, null, 2)}\n`,
    ...(host === undefined ? {} : { "host/index.js": host, "package.json": "{\"type\":\"module\"}\n" }),
    ...extra,
  });
  return dir;
}

/** The two folders validation refuses (rows 1.2 and 1.10). */
export function writeRefused(root: string): { node: string; helper: string } {
  const node = writePlugin(join(root, FIELDS_IDS.node), { manifest: 1, id: FIELDS_IDS.node, name: "Acceptance node", version: "0.0.1", engines: ENGINES, host: { entry: "host/index.js", runtime: "node" } }, "export async function start() {}\n");
  const helper = writePlugin(join(root, FIELDS_IDS.helper), {
    manifest: 1, id: FIELDS_IDS.helper, name: "Acceptance helper", version: "0.0.1", engines: ENGINES,
    helper: { bin: { "darwin-arm64": "helper/acceptance-helper" }, permissions: ["accessibility"] },
  }, undefined, { "helper/acceptance-helper": "#!/bin/sh\nexit 0\n" });
  return { node, helper };
}

/** The instead-messages validation gives (packages/plugin-sdk/src/manifest/validate.ts). */
export const NODE_REFUSAL = "node is not supported: a plugin's host runs under Bun";
export const HELPER_REFUSAL = "a helper isn't supported: run a program from the host half";

/** The main fixture: settings by scope, a `custom` sign-in, a child off by default, servers by placement. */
export function writeFields(root: string): string {
  return writePlugin(join(root, FIELDS_IDS.fields), {
    manifest: 1, id: FIELDS_IDS.fields, name: "Acceptance fields", version: "0.0.1", engines: ENGINES,
    host: { entry: "host/index.js", runtime: "bun" },
    settings: {
      region: { type: "string", title: "Region", default: "eu" },
      tint: { type: "color", title: "Tint", scope: "device" },
      nick: { type: "string", title: "Nickname", scope: "bot" },
    },
    auth: [{ method: "custom", handler: "signInCore" }, { method: "custom", handler: "signInNothing" }],
    contributes: {
      mcpServers: {
        local: { type: "host", perComputer: true, tools: { FieldsLocal: "preload" } },
        mac: { type: "host", when: { os: ["macos"] }, tools: { FieldsMac: "preload" } },
        win: { type: "host", when: { os: ["windows"] }, tools: { FieldsWin: "preload" } },
      },
      commands: [{ name: "report", description: "Says its settings as its host reads them", handler: "report", args: { type: "object", properties: { bot: { type: "string", maxLength: 64 } }, additionalProperties: false } }],
    },
  }, hostSource({ local: ["FieldsLocal"], mac: ["FieldsMac"], win: ["FieldsWin"] }, {
    report: "return { region: await ctx.api.settings.get(\"region\"), tint: (await ctx.api.settings.get(\"tint\")) ?? null, nick: (await ctx.api.settings.get(\"nick\", { bot: args?.bot })) ?? null };",
    // Names the core's xAI device flow, which only xAI's bundled model plugin may run: the core refuses it for a third party.
    signInCore: "return { flow: \"core\", id: \"xai-device\" };",
    signInNothing: "return { flow: \"mine\", url: \"https://example.com/login\" };",
  }), {
    "plugins/extra/clover.json": `${JSON.stringify({ manifest: 1, name: "Acceptance fields extra", engines: ENGINES, enabledByDefault: false, contributes: { commands: [{ name: "extra-ping", description: "A command of the child", handler: "ping", args: { type: "object", additionalProperties: false } }] }, host: { entry: "host/index.js", runtime: "bun" } }, null, 2)}\n`,
    "plugins/extra/host/index.js": "export async function start() {}\nexport async function ping() { return { text: \"extra-pong\" }; }\n",
  });
}

/** A plugin for platforms this computer isn't (row 1.21). */
export function writeElsewhere(root: string, here: string): string {
  const other = here === "linux-x64" ? "windows-x64" : "linux-x64";
  return writePlugin(join(root, FIELDS_IDS.platforms), { manifest: 1, id: FIELDS_IDS.platforms, name: "Acceptance elsewhere", version: "0.0.1", engines: ENGINES, platforms: [other], host: { entry: "host/index.js", runtime: "bun" } }, "export async function start() {}\n");
}

/** The two reach fixtures (rows 1.25, 1.26): an `agents`-scoped server, and one for Claude Code's sessions only. */
export function writeReach(root: string): { agents: string; cc: string } {
  const agents = writePlugin(join(root, FIELDS_IDS.agents), {
    manifest: 1, id: FIELDS_IDS.agents, name: "Acceptance agents only", version: "0.0.1", engines: ENGINES, scope: "agents",
    host: { entry: "host/index.js", runtime: "bun" }, contributes: { mcpServers: { tools: { type: "host", tools: { AgentsOnly: "preload" } } } },
  }, hostSource({ tools: ["AgentsOnly"] }));
  const cc = writePlugin(join(root, FIELDS_IDS.cc), {
    manifest: 1, id: FIELDS_IDS.cc, name: "Acceptance Claude Code only", version: "0.0.1", engines: ENGINES, onlyBackends: ["claude-code"],
    host: { entry: "host/index.js", runtime: "bun" }, contributes: { mcpServers: { tools: { type: "host", tools: { CcOnly: "preload" } } } },
  }, hostSource({ tools: ["CcOnly"] }));
  return { agents, cc };
}

/** The agents-scoped tool's name on a coding session's bridge: shortened, as the bridge gives it. */
export const AGENTS_ONLY_SHORT = bridgeShortName(`${FIELDS_IDS.agents}-tools`, "AgentsOnly");
/** Its real name, as a bot sees it and as its call is judged. */
export const AGENTS_ONLY_REAL = `mcp__${FIELDS_IDS.agents}-tools__AgentsOnly`;

export const CLAUDE_SKILL = "acc-claude-hello";
export const CLAUDE_MARK = "ACCEPTANCE-CLAUDE-SKILL";

/** A small Claude Code plugin folder (row 1.33): its plugin.json and one skill. */
export function writeClaudePlugin(root: string): string {
  const dir = join(root, "acc-claude-plugin");
  writeTree(dir, {
    ".claude-plugin/plugin.json": `${JSON.stringify({ name: "acc-claude-plugin", description: "The acceptance run's Claude Code plugin", version: "1.0.0" }, null, 2)}\n`,
    [`skills/${CLAUDE_SKILL}/SKILL.md`]: `---\nname: ${CLAUDE_SKILL}\ndescription: The acceptance run's skill from a Claude Code plugin\n---\n${CLAUDE_MARK}: answer with the words "claude skill".\n`,
  });
  return dir;
}

/** The bot the plugin-with-a-bot fixture brings (§5.5, the owner's rule of November 14). */
export const BOT_PARTS_BOT = "Juniper";

/** A plugin with a bot: an island tab beside it (`"app": true`), a tool server inside it (`own-bot`, JuniperStage) and
 *  one beside it (JuniperNotes), and its tab's Browser panel replaced. `model` is the model Alpha runs, so its bot's
 *  turns reach the run's fake provider. */
export function writeBotParts(root: string, model: string, o: { client?: string; settings?: Record<string, unknown>; ownPanels?: boolean } = {}): string {
  return writePlugin(join(root, FIELDS_IDS.bot), {
    manifest: 1, id: FIELDS_IDS.bot, name: "Acceptance Juniper", version: "0.0.1", engines: ENGINES,
    host: { entry: "host/index.js", runtime: "bun" }, client: { entry: "client/index.js" },
    ...(o.settings !== undefined ? { settings: o.settings } : {}),
    ...(o.ownPanels === true ? { capabilities: ["shell.control"] } : {}),
    contributes: {
      bot: { name: BOT_PARTS_BOT, instructions: "bot/instructions.md", model: { default: model } },
      mcpServers: {
        stage: { type: "host", scope: "own-bot", tools: { JuniperStage: "preload" } },
        notes: { type: "host", tools: { JuniperNotes: "preload", JuniperRun: "preload" } },
      },
      // Inside her, entry by entry (`scope: "own-bot"`), and one skill beside her for every bot.
      skills: [{ path: "skills/mine/SKILL.md", scope: "own-bot" }, "skills/shared/SKILL.md"],
      agents: [{ id: "helper", name: "Juniper's helper", backend: "clover-code", instructions: "agents/helper.md", scope: "own-bot" }],
      commands: [{ name: "scene", description: "Sets Juniper's scene", handler: "scene", scope: "own-bot", args: { type: "object", additionalProperties: false } }],
      ui: [
        { spot: "island.tab", id: "day", title: "Juniper's day", component: "Day", app: true },
        { spot: "panel", ...(o.ownPanels === true ? { id: "browser" } : {}), key: "browser", component: "Browser" },
        // Panels of her own (§5.5): Scene inside her, on her tab only; Desk beside her (`app`), on every tab.
        ...(o.ownPanels === true ? [{ spot: "panel", id: "scene", key: "scene", title: "Scene", component: "Scene" }, { spot: "panel", id: "desk", key: "desk", title: "Desk", component: "Desk", app: true }] : []),
      ],
    },
  }, hostSource({ stage: ["JuniperStage"], notes: ["JuniperNotes", "JuniperRun"] }, { scene: "return { text: \"scene-ran\" };" }, {
    // Beside her (every bot is offered it): runs her own-bot command for the session whose call it serves.
    JuniperRun: `return JSON.stringify(await api.commands.run(${JSON.stringify(BOT_COMMAND)}, {}));`,
  }), {
    "bot/instructions.md": "You are the acceptance run's bot.\n",
    "client/index.js": o.client ?? "export const Day = () => null;\nexport const Browser = () => null;\n",
    "skills/mine/SKILL.md": `---\nname: mine\ndescription: ${OWN_BOT_MARK} Juniper's own way to set a scene\n---\nSet the scene the way Juniper does.\n`,
    "skills/shared/SKILL.md": `---\nname: shared\ndescription: ${OWN_BOT_MARK} a skill for every bot\n---\nShared by every bot.\n`,
    "agents/helper.md": `${OWN_BOT_MARK}: help Juniper set her scenes.\n`,
  });
}

/** The word Juniper's skills and agent definition carry, which a Glossary search finds them by. */
export const OWN_BOT_MARK = "juniperkit";
/** Her own-bot command's full name, as `command.run` and `commands.run` take it. */
export const BOT_COMMAND = `${FIELDS_IDS.bot}.scene`;
/** Her parts inside her, as Glossary names them, and the one beside her. */
export const OWN_BOT_ITEMS = { skill: `${FIELDS_IDS.bot}:mine`, agent: `${FIELDS_IDS.bot}:helper`, shared: `${FIELDS_IDS.bot}:shared` } as const;
/** What the command says when another bot's session runs it (packages/core/src/registry/commands.ts). */
export const BOT_COMMAND_REFUSAL = `${BOT_COMMAND} is ${FIELDS_IDS.bot}'s own: only you and ${FIELDS_IDS.bot} run it`;

/** What the per-entry own-bot reads got wrong (row 1.99); empty when right. Each `…Glossary` is a Glossary search's
 *  answer for `OWN_BOT_MARK`; each `…Run` the answer of JuniperRun (her command run through `commands.run` for the
 *  session whose call it serves). */
export function ownBotWrong(o: { juniperGlossary: string; alphaGlossary: string; juniperRun: string; alphaRun: string }): string[] {
  const wrong: string[] = [];
  for (const [what, name] of [["skill", OWN_BOT_ITEMS.skill], ["agent definition", OWN_BOT_ITEMS.agent]] as const) {
    if (!o.juniperGlossary.includes(name)) wrong.push(`Juniper's Glossary doesn't list her own-bot ${what} ${name}`);
    if (o.alphaGlossary.includes(name)) wrong.push(`Alpha's Glossary lists Juniper's own-bot ${what} ${name}`);
  }
  if (!o.alphaGlossary.includes(OWN_BOT_ITEMS.shared)) wrong.push(`Alpha's Glossary doesn't list ${OWN_BOT_ITEMS.shared} (beside Juniper), so its search proves nothing`);
  if (!o.juniperRun.includes("scene-ran")) wrong.push(`Juniper's session couldn't run her own command ${BOT_COMMAND}: ${o.juniperRun.slice(0, 200)}`);
  if (!o.alphaRun.includes(BOT_COMMAND_REFUSAL)) wrong.push(`Alpha's session running ${BOT_COMMAND} wasn't refused as hers: ${o.alphaRun.slice(0, 200)}`);
  return wrong;
}

/** What the window run needs of the plugin with a bot: a Browser panel that draws a marker (`drawing`), or one that never
 *  mounts (a module that waits forever: the frame reports no size, so the shell shows the stock panel in its stead). */
export const BOT_PARTS_CLIENT = {
  drawing: "import { createElement } from \"@waifucave/clover-plugin-sdk/ui\";\nexport const Day = () => null;\nexport const Browser = () => createElement(\"div\", { \"data-juniper-browser\": \"\" }, \"Juniper's own browser panel\");\n",
  /** Her tab's panels of her own: Scene draws a marker, Desk has a button whose press asks the window to open Scene (`shell.openPanel`). */
  own: "import { createElement, usePluginApi } from \"@waifucave/clover-plugin-sdk/ui\";\nexport const Day = () => null;\nexport const Browser = () => createElement(\"div\", { \"data-juniper-browser\": \"\" }, \"Juniper's own browser panel\");\nexport const Scene = () => createElement(\"div\", { \"data-juniper-scene\": \"\" }, \"Juniper's scene panel\");\nexport const Desk = () => { const api = usePluginApi(); return createElement(\"div\", { \"data-juniper-desk\": \"\", style: { padding: 16 } }, createElement(\"button\", { type: \"button\", \"data-open-scene\": \"\", style: { padding: \"12px 20px\" }, onClick: () => { void api.shell?.openPanel(\"scene\").catch(() => undefined); } }, \"Open Scene\")); };\n",
  never: "await new Promise(() => {});\nexport const Day = () => null;\nexport const Browser = () => null;\n",
} as const;
/** Settings the plugin carries for the bot's Edit page: one for the bot (the section's switch) and one for the account. */
export const BOT_PARTS_SETTINGS = {
  loud: { type: "boolean", title: "Speaks up", scope: "bot", default: false },
  greeting: { type: "string", title: "Greeting", default: "hello" },
} as const;

/** Its OK card's lines for its parts (packages/plugin-sdk/src/manifest/validate.ts's `botPartLines`), and its checkbox
 *  for the parts beyond its bot's tab (packages/core/src/registry/core.ts). */
export const BOT_PARTS_LINES = [
  "Everywhere, with a switch of its own: an island tab, tools, skills.",
  `It replaces the Browser panel on ${BOT_PARTS_BOT}'s tab.`,
] as const;
export const BOT_PARTS_CHECKBOX = { id: `${FIELDS_IDS.bot}#app`, label: `Its parts beyond ${BOT_PARTS_BOT}'s tab`, checked: true } as const;

/** A plugin whose bot puts an entry on the sidebar, which looks the same on every tab: refused. */
export function writeBotOnSidebar(root: string): string {
  return writePlugin(join(root, FIELDS_IDS.botSidebar), {
    manifest: 1, id: FIELDS_IDS.botSidebar, name: "Acceptance bot sidebar", version: "0.0.1", engines: ENGINES, client: { entry: "client/index.js" },
    contributes: { bot: { name: "Sidebar bot", instructions: "bot/instructions.md" }, ui: [{ spot: "sidebar", component: "Side" }] },
  }, undefined, { "bot/instructions.md": "You are a bot.\n", "client/index.js": "export const Side = () => null;\n" });
}
export const BOT_SIDEBAR_REFUSAL = "Bots doesn't offer \"sidebar\" to Sidebar bot: a bot's plugin dresses only its own tab";

/** The rest of Bots' closed offer list (row 1.97): one fixture per refusal, each with the code validation gives and the
 *  words the app's install answers with (packages/plugin-sdk/src/manifest/validate.ts's `checkUi`; an install's
 *  refusal carries the words, the code is named by them). A bot's own entries (the bot Rowan): a panel key other than
 *  Browser and agent, an entry tied to another bot (Alpha), an unmarked entry on a spot Bots doesn't offer. Then each
 *  spot that looks the same on every tab, tied to a bot (`when.bot`) by a plugin with no bot of its own. */
export interface Refusal { code: string; what: string; folder: string; words: string }
export const REFUSAL_BOT = "Rowan";
export function writeRefusals(root: string): Refusal[] {
  const bot = (id: string, entry: Record<string, unknown>) => writePlugin(join(root, id), {
    manifest: 1, id, name: `Acceptance ${id}`, version: "0.0.1", engines: ENGINES, client: { entry: "client/index.js" },
    contributes: { bot: { name: REFUSAL_BOT, instructions: "bot/instructions.md" }, ui: [entry] },
  }, undefined, { "bot/instructions.md": "You are a bot.\n", "client/index.js": "export const Part = () => null;\n" });
  const tied = (id: string, entry: Record<string, unknown>) => writePlugin(join(root, id), {
    manifest: 1, id, name: `Acceptance ${id}`, version: "0.0.1", engines: ENGINES, client: { entry: "client/index.js" },
    contributes: { ui: [{ component: "Part", when: { bot: "alpha" }, ...entry }] },
  }, undefined, { "client/index.js": "export const Part = () => null;\n", "icon.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n" });
  const out: Refusal[] = [
    { code: "bot_panel_not_offered", what: "a panel key other than Browser and agent", folder: bot("acc-refuse-panel", { spot: "panel", key: "terminal", component: "Part" }),
      words: `Bots offers the Browser and agent panels on ${REFUSAL_BOT}'s tab, and a panel of its own (any other key, with a title); "terminal" isn't one of them.` },
    { code: "bot_when_other_bot", what: "an entry tied to another bot (Alpha)", folder: bot("acc-refuse-other-bot", { spot: "composer", component: "Part", when: { bot: "alpha" } }),
      words: `"composer" inside ${REFUSAL_BOT}'s tab is ${REFUSAL_BOT}'s; dressing other bots' tabs is an app part: add "app": true.` },
    { code: "bot_spot_not_offered", what: "an unmarked entry on a spot Bots doesn't offer (status)", folder: bot("acc-refuse-status", { spot: "status", component: "Part" }),
      words: `Bots doesn't offer "status" to ${REFUSAL_BOT}: a bot's plugin dresses only its own tab` },
  ];
  const never: [string, Record<string, unknown>][] = [
    ["sidebar", {}],
    ["sidebar.bot", { key: "alpha" }],
    ["sidebar.app", { title: "Tied", icon: "icon.svg", opens: "settings" }],
    ["settings.section", { title: "Tied" }],
    ["bot.editor.section", { title: "Tied" }],
  ];
  for (const [spot, fields] of never) {
    out.push({ code: "bot_tied_not_offered", what: `${spot} tied to a bot`, folder: tied(`acc-refuse-tied-${spot.replace(/\./g, "-")}`, { spot, ...fields }),
      words: `"${spot}" looks the same on every tab: nothing tied to a bot's tab dresses it.` });
  }
  return out;
}

/** A plugin whose theme still names the sidebar's old shell names (before §5.5): it loads, each name is a warning
 *  (`shell_not_offered`), and the window ignores them (`resolveShell` never gives them back). */
export const OLD_SIDEBAR_SHELL = { tokens: { bar: "#F6F2FF", "bar.text": "#221A33", "bar.rule": "#C9BDEB", sidebar: "#16132B", "sidebar.mode": "none" } } as const;
export function writeOldSidebarTheme(root: string): string {
  return writePlugin(join(root, FIELDS_IDS.oldSidebar), {
    manifest: 1, id: FIELDS_IDS.oldSidebar, name: "Acceptance old sidebar", version: "0.0.1", engines: ENGINES,
    contributes: { themes: [{ id: "old-sidebar", file: "theme/old.json" }] },
  }, undefined, { "theme/old.json": `${JSON.stringify({ theme: 1, name: "Old sidebar", tokens: { "color.surface": "#FFFDF6" }, shell: OLD_SIDEBAR_SHELL }, null, 2)}\n` });
}
/** The sidebar names the window takes from that theme's shell (none, when it ignores them), light and dark. */
export function oldSidebarTaken(): string[] {
  return (["light", "dark"] as const).flatMap((a) => Object.keys(resolveShell(OLD_SIDEBAR_SHELL as never, a, "#FFFDF6", "both").values).filter((k) => k.startsWith("sidebar")));
}

/** What the plugin-with-a-bot fixture's turns were offered wrong; empty when right. `alpha` and `bot`: Alpha's and
 *  Juniper's turns with its app parts on; `after`: Juniper's turn with them off. */
export function botPartsWrong(o: { alpha: readonly string[]; bot: readonly string[]; after: readonly string[] }): string[] {
  const wrong: string[] = [];
  if (offered(o.alpha, "JuniperStage")) wrong.push("Alpha was offered JuniperStage (inside Juniper: scope own-bot)");
  if (!offered(o.alpha, "JuniperNotes")) wrong.push("Alpha wasn't offered JuniperNotes (beside Juniper)");
  if (!offered(o.bot, "JuniperStage")) wrong.push("Juniper wasn't offered JuniperStage (her own)");
  if (!offered(o.bot, "JuniperNotes")) wrong.push("Juniper wasn't offered JuniperNotes (beside her)");
  if (!offered(o.after, "JuniperStage")) wrong.push("with its app parts off, Juniper wasn't offered JuniperStage (inside her, kept)");
  if (offered(o.after, "JuniperNotes")) wrong.push("with its app parts off, Juniper was still offered JuniperNotes (beside her)");
  return wrong;
}

/** Which offered tool names end in each suffix (a bot's `mcp__<server>__<tool>`, an agent's bridge `…__<server>__<tool>`). */
export function offered(tools: readonly string[], suffix: string): boolean {
  return tools.some((t) => t === suffix || t.endsWith(`__${suffix}`));
}

/** What a turn's offer says wrong, for the reach and placement fixtures; empty when right. */
export function offerWrong(o: { bot: readonly string[]; coding: readonly string[] }): string[] {
  const wrong: string[] = [];
  if (!offered(o.bot, "FieldsLocal")) wrong.push("Alpha wasn't offered FieldsLocal (a perComputer server, on this computer)");
  if (!offered(o.bot, "FieldsMac")) wrong.push("Alpha wasn't offered FieldsMac (when.os macos)");
  if (offered(o.bot, "FieldsWin")) wrong.push("Alpha was offered FieldsWin (when.os windows)");
  if (offered(o.bot, "AgentsOnly")) wrong.push("Alpha was offered AgentsOnly (scope: agents)");
  if (!offered(o.bot, "CcOnly")) wrong.push("Alpha wasn't offered CcOnly (onlyBackends never narrows a bot)");
  if (!offered(o.coding, AGENTS_ONLY_SHORT)) wrong.push(`the coding session wasn't offered AgentsOnly under its short name ${AGENTS_ONLY_SHORT} (scope: agents; its full bridge name is too long)`);
  if (offered(o.coding, "CcOnly")) wrong.push("the coding session on Clover's own agent was offered CcOnly (onlyBackends: claude-code)");
  return wrong;
}

/** The ordinary plugin that adds panels (no bot: §5.5, "an Office plugin"): Sheets on every kind of tab, Slides on coding sessions only.
 *  `titleless` leaves Slides without its `title`, which the check refuses. */
export const OFFICE_ID = "acc-office";
export function writeOfficePanels(root: string, o: { titleless?: boolean } = {}): string {
  return writePlugin(join(root, OFFICE_ID), {
    manifest: 1, id: OFFICE_ID, name: "Acceptance Office", version: "0.0.1", engines: ENGINES, client: { entry: "client/index.js" },
    contributes: {
      ui: [
        { spot: "panel", id: "sheets", key: "sheets", title: "Sheets", component: "Sheets" },
        { spot: "panel", id: "slides", key: "slides", ...(o.titleless === true ? {} : { title: "Slides" }), component: "Slides", when: { session: ["coding"] } },
      ],
    },
  }, undefined, {
    "client/index.js": "import { createElement } from \"@waifucave/clover-plugin-sdk/ui\";\nexport const Sheets = () => createElement(\"div\", { \"data-office-sheets\": \"\" }, \"Sheets panel\");\nexport const Slides = () => createElement(\"div\", { \"data-office-slides\": \"\" }, \"Slides panel\");\n",
  });
}
export const OFFICE_REFUSAL = "The panel \"slides\" adds a panel of its own: it needs a `title`, which names its button.";
