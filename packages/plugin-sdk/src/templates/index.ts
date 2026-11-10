// `clover plugin new <template>` (spec §5.6): the starting points a plugin begins from. Each writes an ordinary plugin
// folder, nothing more: a manifest, the files it names, and a README saying what to change. Every template is checked
// by `clover plugin validate` in the SDK's tests. None asks for a capability or a project's files, and none carries a
// secret: those are the author's to add when the plugin needs them. Only the model template reaches the network: its
// example endpoint (`api.example.com`) shows as a network host on the OK card, as the real endpoint will.
//
// Templates: a bot, a theme, a tool (an MCP server in the plugin's own host code), a UI part, a model (a compatible
// endpoint, no code), a trigger for routine files, and a point other plugins fill.

import { BUNDLED_BOT_PLUGIN, BUNDLED_ROOT_PLUGIN, PLUGIN_ID_MAX, PLUGIN_ID_MIN, PLUGIN_ID_RE, isPluginId } from "@waifucave/clover-protocol";
import { isReservedPluginName } from "../catalogs/spots";

/** What a template is filled in with. */
export interface TemplateInput {
  /** The plugin's id: lowercase letters, digits and hyphens, as its folder is named. */
  id: string;
  /** What people see. */
  name: string;
}

export interface PluginTemplate {
  /** One line: what the plugin it starts does. */
  description: string;
  /** The folder's files, by path inside it (forward slashes), as text. */
  files(input: TemplateInput): Record<string, string>;
}

/** A plugin id's form (the protocol's: a letter first, then lowercase letters, digits and single hyphens). */
export const TEMPLATE_ID_RE = PLUGIN_ID_RE;

/** The longest name a template writes, in UTF-16 code units: a tab label and a card title, not a paragraph. */
export const TEMPLATE_NAME_MAX = 80;

/** Why `id` can't start a plugin, or undefined when it can: the protocol's id rule, and never an id Clover ships
 *  (`validate` refuses those as `id_reserved`, so `new` never writes one). */
export function templateIdProblem(id: string): string | undefined {
  if (!isPluginId(id)) return `"${id}" isn't a plugin id: a letter first, then lowercase letters, digits and single hyphens, ${PLUGIN_ID_MIN} to ${PLUGIN_ID_MAX} characters`;
  if (id === BUNDLED_ROOT_PLUGIN || id === BUNDLED_BOT_PLUGIN) return `"${id}" is one of the plugins Clover ships: pick another folder name`;
  return undefined;
}

/** A name as a template writes it: control, format and line-separator characters removed (a name lands in a `//`
 *  comment in the template's code, where a line break would end the comment), runs of spaces folded, trimmed. */
export function cleanTemplateName(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/\s+/g, " ").trim();
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const readme = (name: string, body: string): string => `# ${name}\n\n${body}\n\nCheck it with \`clover plugin validate\`, and try it on this computer with \`clover plugin dev .\`.\n`;

/** A camel-case word from an id, for names in code: `my-tool` becomes `myTool`. */
const camel = (id: string): string => id.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
/** And a type-case one: `my-tool` becomes `MyTool`. */
const pascal = (id: string): string => camel(id).replace(/^[a-z]/, (c) => c.toUpperCase());

export const PLUGIN_TEMPLATES: Readonly<Record<string, PluginTemplate>> = {
  bot: {
    description: "A bot: its name and instructions, which you edit in bot/instructions.md.",
    files: ({ id, name }) => ({
      "clover.json": json({
        manifest: 1, id, name, description: `${name}, a bot.`, engines: { clover: "^1.0.0" },
        contributes: { bot: { name, instructions: "bot/instructions.md" } },
      }),
      "bot/instructions.md": `You are ${name}. Say who you are and how you help, in a few short paragraphs.\n`,
      "README.md": readme(name, "A bot. Its instructions are in `bot/instructions.md`; its manifest, `clover.json`, can also give it a model, a voice, an avatar and a theme."),
    }),
  },

  theme: {
    description: "A theme: token values for the app's colours, in light and dark.",
    files: ({ id, name }) => ({
      "clover.json": json({
        manifest: 1, id, name, description: `${name}, a theme.`, engines: { clover: "^1.0.0" },
        contributes: { themes: [{ id, file: "theme.json" }] },
      }),
      "theme.json": json({
        theme: 1, name, appearance: "both",
        tokens: { "color.canvas": "#F4F6F2", "color.surface": "#FFFFFF", "color.text": "#1E2420" },
        dark: { tokens: { "color.canvas": "#151916", "color.surface": "#1C211D", "color.text": "#E8ECE7" } },
      }),
      "README.md": readme(name, "A theme. Its tokens are in `theme.json`: any of the catalog's tokens, each with a light value and, under `dark`, a dark one where it differs."),
    }),
  },

  tool: {
    description: "A tool: an MCP server in the plugin's own host code, with one tool, `hello`.",
    files: ({ id, name }) => ({
      "clover.json": json({
        manifest: 1, id, name, description: `${name}, a tool.`, engines: { clover: "^1.0.0" },
        host: { entry: "host/index.ts", runtime: "bun" },
        contributes: { mcpServers: { tools: { type: "host", tools: { hello: "preload" } } } },
      }),
      "host/index.ts": `// ${name}'s host half: one MCP server, \`tools\`, served on the in-process transport Clover hands it. It speaks
// MCP's JSON-RPC directly, so the plugin ships no dependency. Its key here is the one under \`contributes.mcpServers\`.
import type { HostModule, McpServerTransport } from "@waifucave/clover-plugin-sdk";

const TOOLS = [
  {
    name: "hello",
    description: "Says hello to someone by name.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Who to greet" } }, required: ["name"] },
  },
];

function answer(method: string, params: Record<string, unknown> | undefined): unknown {
  if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(id)}, version: "0.1.0" } };
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call" && params?.name === "hello") {
    const who = String((params.arguments as { name?: unknown } | undefined)?.name ?? "there").slice(0, 100);
    return { content: [{ type: "text", text: \`Hello, \${who}!\` }] };
  }
  throw new Error(\`unknown method \${method}\`);
}

export const mcp: HostModule["mcp"] = {
  tools: async (transport: McpServerTransport) => {
    transport.onmessage = (m) => {
      if (typeof m.id !== "number" && typeof m.id !== "string") return; // a notification: nothing to answer
      try {
        void transport.send({ jsonrpc: "2.0", id: m.id, result: answer(String(m.method), m.params as Record<string, unknown> | undefined) });
      } catch (err) {
        void transport.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: err instanceof Error ? err.message : String(err) } });
      }
    };
    await transport.start();
  },
};
`,
      "README.md": readme(name, "A tool. Its MCP server, `tools`, is in `host/index.ts`, with one tool, `hello`; list each tool you add under `contributes.mcpServers.tools` in `clover.json`. It asks for no network and no files: add `network` or a capability to the manifest only when a tool needs one, and the OK card will say so."),
    }),
  },

  ui: {
    description: "A UI part: a section of Settings, drawn by a component in the plugin's client code.",
    files: ({ id, name }) => {
      const component = `${pascal(id)}Section`;
      return {
        "clover.json": json({
          manifest: 1, id, name, description: `${name}, a part of the app.`, engines: { clover: "^1.0.0" },
          client: { entry: "client/index.ts" },
          contributes: { ui: [{ spot: "settings.section", id: "section", component, title: name }] },
        }),
        "client/index.ts": `// ${name}'s client half: the components its manifest's \`ui\` entries name. React comes from the layer, through
// the plugin SDK, so the plugin ships none of its own.
import { createElement as h, useT } from "@waifucave/clover-plugin-sdk/ui";

export function ${component}() {
  const t = useT();
  return h("p", null, t(${JSON.stringify(`Hello from ${name}.`)}));
}
`,
        "README.md": readme(name, "A UI part: a section of Settings, drawn by the component in `client/index.ts`. Its `ui` entry in `clover.json` says which spot it fills; the catalog lists the spots."),
      };
    },
  },

  model: {
    description: "A model: a provider's compatible endpoint, with no code, signed in with an API key.",
    files: ({ id, name }) => ({
      "clover.json": json({
        manifest: 1, id, name, description: `${name}'s models, on its compatible endpoint.`, engines: { clover: "^1.0.0" },
        contributes: {
          models: [{
            provider: id, name, catalog: "catalog.json",
            auth: [{ method: "api-key", secret: "api-key", help: `Your ${name} API key. Clover keeps it in your credential store.` }],
            endpoint: { protocol: "openai-chat", baseUrl: "https://api.example.com/v1" },
          }],
        },
      }),
      "catalog.json": json({ catalog: 1, provider: { protocols: ["openai-chat-completions"], authKinds: ["api-key"] }, models: [{ id: "example-model", name: "Example model" }] }),
      "README.md": readme(name, "A model provider. Put the provider's endpoint in `clover.json` (`endpoint.baseUrl`, and the protocol it speaks), and its models in `catalog.json`. Clover asks for the API key when someone signs in. The endpoint's host is the plugin's network: the example's `api.example.com` shows as a network host on the OK card, so put the provider's own there."),
    }),
  },

  trigger: {
    description: "A trigger for routine files: `every: <minutes>` fires a routine on a fixed interval.",
    files: ({ id, name }) => ({
      "clover.json": json({
        manifest: 1, id, name, description: `${name}: a trigger for routine files.`, engines: { clover: "^1.0.0" },
        host: { entry: "host/index.ts", runtime: "bun" },
        contributes: {
          triggers: [{
            type: id, title: name,
            fields: { type: "object", required: ["every"], properties: { every: { type: "integer", minimum: 1, maximum: 10080, description: "Minutes between runs." } } },
            handler: camel(id),
          }],
        },
      }),
      "host/index.ts": `// ${name}'s host half: the handler its \`triggers\` entry names. The routine engine asks it whether a routine's
// fields read (\`check\`), when it fires next (\`next\`), and which fires a computer that was off missed (\`missed\`).

function minutes(fields: unknown): number {
  const every = (fields as { every?: unknown } | null | undefined)?.every;
  if (typeof every !== "number" || !Number.isInteger(every) || every < 1 || every > 10080) throw new TypeError("\`every\` is a whole number of minutes, from 1 to 10080");
  return every;
}

export const ${camel(id)} = {
  check(args: { fields: unknown }): { ok: true; summary: string } | { ok: false; reason: string } {
    try {
      return { ok: true, summary: \`every \${minutes(args.fields)} minutes\` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
  next(args: { fields: unknown; after: number }): { at: number } {
    return { at: args.after + minutes(args.fields) * 60_000 };
  },
  // An interval has no fixed times: the engine runs a missed one once when the computer wakes.
  missed(_args: { fields: unknown; after: number; until: number }): { at: number[] } {
    return { at: [] };
  },
};
`,
      "README.md": readme(name, `A trigger. A routine file uses it as \`- ${id}: { every: 30 }\`; its handler is in \`host/index.ts\`.`),
    }),
  },

  point: {
    description: "A point: a list other plugins add entries to, which this plugin's Settings section shows.",
    files: ({ id, name }) => {
      const component = `${pascal(id)}Section`;
      return {
        "clover.json": json({
          manifest: 1, id, name, description: `${name}: a point other plugins fill.`, engines: { clover: "^1.0.0" },
          client: { entry: "client/index.ts" },
          contributes: {
            ui: [{
              spot: "settings.section", id: "section", component, title: name,
              declares: {
                [`${id}.items`]: {
                  shape: "list",
                  fields: { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" } } },
                  doc: `Items ${name} lists: an id and a title each.`,
                },
              },
            }],
          },
        }),
        "client/index.ts": `// ${name}'s client half: a Settings section listing what other plugins add to its point, \`${id}.items\`. React
// comes from the layer, through the plugin SDK, so the plugin ships none of its own.
import { createElement as h, useEffect, usePluginApi, useState } from "@waifucave/clover-plugin-sdk/ui";

interface Item {
  id: string;
  title: string;
}

export function ${component}() {
  const api = usePluginApi();
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let live = true;
    void api.points.entries<Item>(${JSON.stringify(`${id}.items`)}).then((e) => { if (live) setItems(e.map((x) => x.value)); });
    const off = api.points.watch<Item>(${JSON.stringify(`${id}.items`)}, (e) => setItems(e.map((x) => x.value)));
    return () => { live = false; off(); };
  }, [api]);
  return h("ul", null, ...items.map((i) => h("li", { key: i.id }, i.title)));
}
`,
        "README.md": readme(name, `A point, \`${id}.items\`: other plugins add entries to it under \`contributes\` in their own manifests (\`"${id}.items": [{ "id": "…", "title": "…" }]\`), and this plugin's Settings section lists them.`),
      };
    },
  },
};

/** The template's files for `input`, or why it can't be made. */
export function templateFiles(template: string, input: TemplateInput): { files: Record<string, string> } | { error: string } {
  const t = PLUGIN_TEMPLATES[template];
  if (!t) return { error: `no template "${template}": ${Object.keys(PLUGIN_TEMPLATES).join(", ")}` };
  const idProblem = templateIdProblem(input.id);
  if (idProblem) return { error: idProblem };
  const name = cleanTemplateName(input.name);
  if (name === "") return { error: "a plugin's name needs a letter or a digit, not only spaces or control characters" };
  if (name.length > TEMPLATE_NAME_MAX) return { error: `a plugin's name is at most ${TEMPLATE_NAME_MAX} characters` };
  if (isReservedPluginName(name)) return { error: `"${name}" is a name only Clover's own plugins have` };
  return { files: t.files({ id: input.id, name }) };
}
