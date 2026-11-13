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

export const MANIFEST_FIELDS_STEP = "manifest fields on the app: a host.runtime node and a helper plugin refused with their instead-messages; settings by scope (account, device, bot) read by its host as set; a custom sign-in's handler run and held to the core's flows; a platforms list without this computer off with why; a child off by default until switched on; servers by perComputer and when.os; an agents-scoped plugin offered to a coding session and not to Alpha, an onlyBackends one the other way round; a Claude Code plugin folder wrapped and its skill in Alpha's Glossary";

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
} as const;

/** A host half that serves the named host MCP servers, each with its tools, every tool answering `<tool>-pong`; and
 *  the handlers given (name → body of an async function `(args, ctx)`). */
export function hostSource(servers: Record<string, string[]>, handlers: Record<string, string> = {}): string {
  const lines = [
    "// The acceptance run's manifest-fields fixture (written by the run): host MCP servers whose tools answer `<tool>-pong`, and its handlers.",
    "const serve = (tools) => async (transport) => {",
    "  const reply = (id, body) => void transport.send({ jsonrpc: \"2.0\", id, ...body }).catch(() => {});",
    "  transport.onmessage = (m) => {",
    "    if (m.id === undefined) return;",
    "    const p = m.params ?? {};",
    "    if (m.method === \"initialize\") reply(m.id, { result: { protocolVersion: typeof p.protocolVersion === \"string\" ? p.protocolVersion : \"2025-06-18\", capabilities: { tools: {} }, serverInfo: { name: \"acceptance-fields\", version: \"1\" } } });",
    "    else if (m.method === \"ping\") reply(m.id, { result: {} });",
    "    else if (m.method === \"tools/list\") reply(m.id, { result: { tools: tools.map((name) => ({ name, description: `The acceptance run's ${name}.`, inputSchema: { type: \"object\", properties: {}, additionalProperties: false } })) } });",
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
