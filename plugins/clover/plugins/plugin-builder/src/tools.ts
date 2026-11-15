// The plugin builder's tool, pure: `PluginNew` makes a plugin's files from one of the SDK's templates, the same files
// as `clover plugin new <template>` writes, for a bot that has no `clover` command at hand. It touches no disk (this
// plugin's host half is fenced to its own folders): the bot writes the files into its scratch folder. Checking,
// installing and a plugin's state are the core's own tools (PluginValidate, PluginInstall, PluginStatus).
import { PLUGIN_TEMPLATES, templateFiles } from "@waifucave/clover-plugin-sdk/templates";

/** The tool's name, as the skills name it (`skills/building-plugins/SKILL.md` is the one place a skill does). */
export const TOOL_NEW = "PluginNew";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const TOOLS = [
  {
    name: TOOL_NEW,
    description: `Make a new Clover plugin's files from a template: the same files as \`clover plugin new <template>\`. Templates: ${Object.entries(PLUGIN_TEMPLATES).map(([k, t]) => `${k} (${t.description})`).join("; ")}. It returns the files; write each one, at its path, into a new folder named after the id in your scratch folder, then check the folder with PluginValidate. Read the building-plugins skill first.`,
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", enum: Object.keys(PLUGIN_TEMPLATES), description: "Which starting point." },
        id: { type: "string", description: "The plugin's id: a letter, then lowercase letters, digits and single hyphens. Its folder has this name." },
        name: { type: "string", description: "What people see: a short name." },
      },
      required: ["template", "id", "name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** PluginNew: the template's files, to be written by the bot. */
export function pluginNew(args: unknown): ToolResult {
  const a = isObj(args) ? args : {};
  const template = typeof a.template === "string" ? a.template : "";
  const made = templateFiles(template, { id: typeof a.id === "string" ? a.id : "", name: typeof a.name === "string" ? a.name : "" });
  if ("error" in made) return { content: [{ type: "text", text: `Nothing made: ${made.error}.` }], isError: true };
  const id = String(a.id);
  const body = Object.entries(made.files).map(([path, contents]) => `--- ${path} ---\n${contents}`).join("\n");
  return {
    content: [{
      type: "text",
      text: `Made a ${template} plugin, ${id}: ${Object.keys(made.files).length} files. Write each one below, at its path, into a folder named \`${id}\` in your scratch folder (the folder's name must be the id), change what its README says to change, then check the folder with PluginValidate.\n\n${body}`,
    }],
    structuredContent: { id, template, files: made.files },
  };
}

export async function runTool(name: string, args: unknown): Promise<ToolResult> {
  if (name === TOOL_NEW) return pluginNew(args);
  return { content: [{ type: "text", text: `No tool ${name}.` }], isError: true };
}
