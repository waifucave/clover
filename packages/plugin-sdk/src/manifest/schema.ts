// `clover.json`, format 1 (spec §5.9): the one source for the manifest's TypeScript types (`types.ts`), its JSON Schema
// (`generated/clover.schema.json`) and its validation (`validate.ts`). Every shape below follows §5.9's reference; the
// details §5.9 leaves open are noted where they are chosen.
import { z } from "zod";
import { Os, Platform, RunsOn, Scope, SemverVersion, TopPluginId, COMPUTER_NAME_RE } from "@waifucave/clover-protocol";
import { AUTH_SCHEME_RE } from "../api/keyed-fetch";
import { avatarFileProblem } from "../catalogs/avatars";
import {
  ComponentName, EntryId, HandlerName, JsonSchema, KEY_CHORD_RE, COMMAND_NAME_RE, LangTag, NAMESPACE_RE, Path, PathGlob,
  LinkUrl, PointName, Program, SecretName, SettingKey, Text, TOOL_NAME_RE, Url,
} from "./fields";

// -------------------------------------------------------------------------------------------------
// Points a plugin declares (§5.4)
// -------------------------------------------------------------------------------------------------

export const PointDeclSchema = z.strictObject({
  shape: z.enum(["single", "list", "keyed"]),
  /** What an entry carries, as a JSON Schema; its formats are §5.4's. */
  fields: JsonSchema.optional(),
  /** What a UI spot hands each component; `{}` for nothing. A declaration with `props` is a UI spot. */
  props: JsonSchema.optional(),
  /** Capabilities an entry's plugin must have for the data its props carry (§5.5). */
  needs: z.array(z.string().min(1).max(300)).max(32).optional(),
  /** Keys that can't be hidden (§5.5). */
  keep: z.array(z.string().min(1).max(256)).max(64).optional(),
  /** The keys the spot offers to `when`, such as "bot". */
  context: z.array(z.string().min(1).max(64)).max(16).optional(),
  /** Open only to the declaring plugin's own tree. */
  private: z.boolean().optional(),
  deprecated: Text.optional(),
  doc: Text.optional(),
});

export const DeclaresSchema = z.record(PointName, PointDeclSchema);
const declares = { declares: DeclaresSchema.optional() };

// -------------------------------------------------------------------------------------------------
// Sign-ins and settings
// -------------------------------------------------------------------------------------------------

/** Where the keyed fetch puts this entry's key (`api/keyed-fetch.ts`): `authorization` with a scheme (`Bearer` when
 *  none is named), `x-api-key`, `api-key` or `x-goog-api-key`. Left out: `Authorization: Bearer`. */
export const KeyPlacementSchema = z.discriminatedUnion("header", [
  z.strictObject({ header: z.literal("authorization"), scheme: z.string().regex(AUTH_SCHEME_RE).optional() }),
  z.strictObject({ header: z.enum(["x-api-key", "api-key", "x-goog-api-key"]) }),
]);

/** A sign-in for the plugin's own service (§5.1 "Sign-ins"). `secret` names where the core keeps the key or token. */
export const AuthSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("api-key"), secret: SecretName, help: z.string().max(2000).optional(), placement: KeyPlacementSchema.optional() }),
  z.strictObject({
    method: z.literal("oauth-pkce"),
    authorizeUrl: Url, tokenUrl: Url, clientId: z.string().min(1).max(512),
    scopes: z.array(z.string().min(1).max(512)).max(64).optional(),
    secret: SecretName,
    placement: KeyPlacementSchema.optional(),
  }),
  z.strictObject({ method: z.literal("custom"), handler: HandlerName, placement: KeyPlacementSchema.optional() }),
]);

export const SettingSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean", "enum", "color", "secret"]),
  title: Text,
  description: Text.optional(),
  default: z.unknown().optional(),
  options: z.array(z.union([z.string().min(1).max(256), z.strictObject({ value: z.string().min(1).max(256), title: Text })])).max(256).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Default `account`; `device` values don't sync; `bot` is one value per bot. */
  scope: z.enum(["account", "device", "bot"]).optional(),
  /** The plugin waits until the value is set. */
  required: z.boolean().optional(),
});

// -------------------------------------------------------------------------------------------------
// The daemon's core points (§5.3)
// -------------------------------------------------------------------------------------------------

export const BotSchema = z.strictObject({
  name: Text,
  /** Markdown that becomes `<bot-instructions>` (§6.1). */
  instructions: Path,
  /** A qualified catalog id; with no key for it, the user's default model. */
  model: z.strictObject({ default: z.string().min(1).max(200), effort: z.string().min(1).max(32).optional() }).optional(),
  /** `format` is `vrm` or `live2d` (`AVATAR_FORMATS`), or one a renderer plugin brings; a `live2d` file is a Cubism
   *  `.model3.json` or a `.zip` holding one. */
  avatar: z.strictObject({ file: Path, format: z.string().min(1).max(32).regex(/^[a-z0-9-]+$/), portrait: Path.optional() })
    .superRefine((a, ctx) => {
      const problem = avatarFileProblem(a.format, a.file);
      if (problem) ctx.addIssue({ code: "custom", path: ["file"], message: problem });
    })
    .optional(),
  voice: z.strictObject({
    provider: EntryId, voice: z.string().min(1).max(256), model: z.string().min(1).max(128).optional(),
    /** Listening from another voice provider (§6.6). */
    listen: z.strictObject({ provider: EntryId, model: z.string().min(1).max(128).optional() }).optional(),
  }).optional(),
  /** A theme id from this plugin, and a layout file; both apply in its tab. */
  theme: EntryId.optional(),
  layout: Path.optional(),
  greeting: Path.optional(),
  /** Starter memories, copied once into the bot's memory folder. */
  memory: Path.optional(),
  ...declares,
});

export const ModelSchema = z.strictObject({
  provider: EntryId,
  name: Text,
  /** The provider's terms, shown before sign-in (§5.7): a URL or a short text. */
  terms: z.string().min(1).max(4096).optional(),
  /** Rows follow the SDK's catalog row schema (`clover-sdk`, lane A). */
  catalog: z.union([Path, z.array(z.record(z.string(), z.unknown())).max(10_000)]),
  auth: z.array(AuthSchema).max(16),
  /** Data, no code: a compatible endpoint. */
  endpoint: z.strictObject({ protocol: z.enum(["openai-chat", "openai-responses", "anthropic-messages"]), baseUrl: Url }).optional(),
  /** A handler in host code, instead of an endpoint. */
  adapter: HandlerName.optional(),
  ...declares,
});

export const McpServerSchema = z.strictObject({
  /** `host` is the plugin's own code, served as an MCP server. */
  type: z.enum(["host", "stdio", "http"]),
  command: Program.optional(),
  args: z.array(z.string().max(4096)).max(256).optional(),
  env: z.record(z.string().min(1).max(256), z.string().max(8192)).optional(),
  url: Url.optional(),
  headers: z.record(z.string().min(1).max(256), z.string().max(8192)).optional(),
  /** Per tool, `preload` or `on-demand`; `"*"` sets the default for the rest (§6.7). */
  tools: z.record(z.string().min(1).max(64), z.enum(["preload", "on-demand"])).optional(),
  /** Extra text for the MCP block, capped at about 4 KB (§6.1). */
  instructions: Path.optional(),
  /** `host` only: bound to its computer, so a local server (§9.1). */
  perComputer: z.boolean().optional(),
  scope: Scope.optional(),
  when: z.strictObject({ os: z.array(Os).min(1).max(3).optional() }).optional(),
  ...declares,
});

export const AgentDefSchema = z.strictObject({
  id: EntryId,
  name: Text,
  backend: z.string().min(1).max(128),
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(32).optional(),
  instructions: Path.optional(),
  computer: z.string().min(1).max(63).optional(),
  root: z.string().min(1).max(4096).optional(),
  plugins: z.strictObject({ only: z.array(z.string().min(1).max(81)).max(256).optional(), except: z.array(z.string().min(1).max(81)).max(256).optional() }).optional(),
  ...declares,
});

export const AgentBackendSchema = z.strictObject({
  id: EntryId,
  name: Text,
  protocol: z.enum(["acp", "cloud"]),
  command: Program.optional(),
  args: z.array(z.string().max(4096)).max(256).optional(),
  handler: HandlerName.optional(),
  ...declares,
});

export const HOOK_EVENT_NAMES = ["tool.before", "tool.after", "message.in", "message.out", "turn.start", "turn.end", "compact.before", "compact.after"] as const;

export const HookSchema = z.strictObject({
  id: EntryId,
  on: z.array(z.enum(HOOK_EVENT_NAMES)).min(1).max(HOOK_EVENT_NAMES.length),
  /** Exact tool names, or patterns with `*`. */
  tools: z.array(z.string().min(1).max(256)).max(256).optional(),
  handler: HandlerName.optional(),
  /** Speaks Claude Code's hook protocol (§5.3). */
  command: Program.optional(),
  args: z.array(z.string().max(4096)).max(256).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  scope: Scope.optional(),
  ...declares,
});

export const CommandSchema = z.strictObject({
  name: z.string().regex(COMMAND_NAME_RE),
  description: Text,
  args: JsonSchema.optional(),
  handler: HandlerName,
  key: z.string().max(64).regex(KEY_CHORD_RE).optional(),
  runsOn: RunsOn.optional(),
  ...declares,
});

export const TriggerSchema = z.strictObject({
  type: EntryId,
  title: Text,
  fields: JsonSchema.optional(),
  handler: HandlerName,
  ...declares,
});

export const VoiceSchema = z.strictObject({
  id: EntryId,
  name: Text,
  speak: z.boolean().optional(),
  listen: z.boolean().optional(),
  auth: z.array(AuthSchema).max(16).optional(),
  handler: HandlerName,
  ...declares,
});

export const ComputerProviderSchema = z.strictObject({
  id: EntryId,
  name: Text,
  auth: z.array(AuthSchema).max(16),
  handler: HandlerName,
  ...declares,
});

/** A cloud computer (§9.2): the folder names its provider, size and region; deleting a VM always asks. */
export const ComputerSchema = z.strictObject({
  provider: EntryId,
  name: z.string().min(1).max(63).regex(COMPUTER_NAME_RE),
  size: z.string().min(1).max(128),
  region: z.string().min(1).max(128),
  image: z.string().min(1).max(512).optional(),
  makeMain: z.enum(["ask", "no"]).optional(),
  onRemove: z.enum(["ask", "keep"]).optional(),
  ...declares,
});

export const ServiceSchema = z.strictObject({
  id: EntryId,
  name: Text.optional(),
  handler: HandlerName,
  runsOn: RunsOn.optional(),
  ...declares,
});

// -------------------------------------------------------------------------------------------------
// The app's core points (§5.3, §5.5)
// -------------------------------------------------------------------------------------------------

export const ThemeEntrySchema = z.strictObject({ id: EntryId, file: Path, ...declares });
export const LocaleEntrySchema = z.strictObject({ lang: LangTag, file: Path, ...declares });

/** A `ui` entry. It has exactly one of `component`, `web`, `style` or `hide` (§5.9); other fields are the spot's own
 *  (title, icon, opens…), which the spot catalog checks. */
export const UiSchema = z.object({
  spot: PointName,
  /** Defaults to the spot; required if the plugin fills one spot twice. */
  id: EntryId.optional(),
  key: z.string().min(1).max(256).optional(),
  /** Position in a list spot; default 500, then plugin id. */
  order: z.number().int().min(0).max(1_000_000).optional(),
  when: z.object({
    bot: z.union([z.string().min(1).max(81), z.array(z.string().min(1).max(81)).min(1).max(256)]).optional(),
    surface: z.union([z.string().min(1).max(128), z.array(z.string().min(1).max(128)).min(1).max(64)]).optional(),
    os: z.array(Os).min(1).max(3).optional(),
    setting: z.record(SettingKey, z.unknown()).optional(),
  }).catchall(z.unknown()).optional(),
  component: ComponentName.optional(),
  /** The partition is prefixed with the plugin's id. */
  web: z.strictObject({ url: Url.optional(), entry: Path.optional(), partition: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).optional(),
  /** A theme-format file; restyles what fills this spot or key (§5.5). */
  style: Path.optional(),
  hide: z.boolean().optional(),
  window: z.strictObject({
    type: z.enum(["overlay", "window"]),
    alwaysOnTop: z.boolean().optional(),
    transparent: z.boolean().optional(),
    placement: z.partialRecord(Os, z.string().min(1).max(256)).optional(),
  }).optional(),
  ...declares,
}).catchall(z.unknown());

// -------------------------------------------------------------------------------------------------
// contributes
// -------------------------------------------------------------------------------------------------

/** The core points, by their `contributes` key, and each one's shape there. */
export const CORE_CONTRIBUTION_SCHEMAS = {
  bot: BotSchema,
  models: z.array(ModelSchema).max(64),
  mcpServers: z.record(z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/), McpServerSchema),
  skills: z.array(PathGlob).max(1000),
  agents: z.array(z.union([Path, AgentDefSchema])).max(256),
  agentBackends: z.array(AgentBackendSchema).max(32),
  hooks: z.array(HookSchema).max(256),
  commands: z.array(CommandSchema).max(512),
  triggers: z.array(TriggerSchema).max(64),
  voices: z.array(VoiceSchema).max(64),
  computerProviders: z.array(ComputerProviderSchema).max(16),
  computer: ComputerSchema,
  relays: z.array(ServiceSchema).max(16),
  notifiers: z.array(ServiceSchema).max(16),
  companions: z.array(ServiceSchema).max(16),
  themes: z.array(ThemeEntrySchema).max(256),
  locales: z.array(LocaleEntrySchema).max(512),
  ui: z.array(UiSchema).max(1000),
} as const;
export type CoreContributionKey = keyof typeof CORE_CONTRIBUTION_SCHEMAS;
export const CORE_CONTRIBUTION_KEYS = Object.keys(CORE_CONTRIBUTION_SCHEMAS) as CoreContributionKey[];

/** A value for a point another plugin declares (`"webhook.ingress": …`): one entry or a list of entries, each an
 *  object; it is checked against the point's schema when the point appears (§5.4). */
export const PluginPointValueSchema = z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown())).max(1000)]);

export const ContributionsSchema = z.object({
  bot: CORE_CONTRIBUTION_SCHEMAS.bot.optional(),
  models: CORE_CONTRIBUTION_SCHEMAS.models.optional(),
  mcpServers: CORE_CONTRIBUTION_SCHEMAS.mcpServers.optional(),
  skills: CORE_CONTRIBUTION_SCHEMAS.skills.optional(),
  agents: CORE_CONTRIBUTION_SCHEMAS.agents.optional(),
  agentBackends: CORE_CONTRIBUTION_SCHEMAS.agentBackends.optional(),
  hooks: CORE_CONTRIBUTION_SCHEMAS.hooks.optional(),
  commands: CORE_CONTRIBUTION_SCHEMAS.commands.optional(),
  triggers: CORE_CONTRIBUTION_SCHEMAS.triggers.optional(),
  voices: CORE_CONTRIBUTION_SCHEMAS.voices.optional(),
  computerProviders: CORE_CONTRIBUTION_SCHEMAS.computerProviders.optional(),
  computer: CORE_CONTRIBUTION_SCHEMAS.computer.optional(),
  relays: CORE_CONTRIBUTION_SCHEMAS.relays.optional(),
  notifiers: CORE_CONTRIBUTION_SCHEMAS.notifiers.optional(),
  companions: CORE_CONTRIBUTION_SCHEMAS.companions.optional(),
  themes: CORE_CONTRIBUTION_SCHEMAS.themes.optional(),
  locales: CORE_CONTRIBUTION_SCHEMAS.locales.optional(),
  ui: CORE_CONTRIBUTION_SCHEMAS.ui.optional(),
}).catchall(PluginPointValueSchema);

// -------------------------------------------------------------------------------------------------
// The manifest
// -------------------------------------------------------------------------------------------------

export const HELPER_PERMISSIONS = ["accessibility", "screen-recording", "input-monitoring", "microphone", "camera"] as const;

export const ManifestSchema = z.strictObject({
  /** An editor's hint (the JSON Schema's URL); ignored. */
  $schema: z.string().max(2048).optional(),
  manifest: z.literal(1),
  /** Required at top level; must equal the folder name. Children omit it. */
  id: TopPluginId.optional(),
  name: Text,
  /** Semver; default "0.0.0"; required to publish to an index; children inherit. */
  version: SemverVersion.optional(),
  description: Text.optional(),
  /** svg, png or webp, at most 256 KiB. */
  icon: Path.optional(),
  author: z.strictObject({ name: z.string().min(1).max(200), url: LinkUrl.optional() }).optional(),
  license: z.string().min(1).max(100).optional(),
  homepage: LinkUrl.optional(),
  /** Tool prefix (top level only); default = id; children share it; "clover" reserved. */
  namespace: z.string().min(1).max(40).regex(NAMESPACE_RE).optional(),
  /** Plugin-API semver range; required when the plugin has code. */
  engines: z.strictObject({ clover: z.string().min(1).max(256) }).optional(),
  /** Code runs only on these; default all. */
  platforms: z.array(Platform).min(1).max(4).optional(),
  /** Whole tree; off until the user confirms they are 18+. */
  adult: z.boolean().optional(),
  /** Children only; default true. */
  enabledByDefault: z.boolean().optional(),
  /** Default "both"; covers mcpServers, skills, agents, hooks. */
  scope: Scope.optional(),
  /** Only these Agent backends receive it, e.g. ["claude-code"]. */
  onlyBackends: z.array(EntryId).min(1).max(64).optional(),
  host: z.strictObject({
    entry: Path,
    /** bun = a worker in the plugin host; node = its own process. */
    runtime: z.enum(["bun", "node"]).optional(),
    /** Starts at once there (§5.2); otherwise only when needed. */
    start: RunsOn.optional(),
    /** Points the host serves (§5.4). */
    declares: DeclaresSchema.optional(),
  }).optional(),
  /** React module loaded into the app. */
  /** Components (§5.5). In an installed plugin `entry` is one bundled ES module of JavaScript: its only bare imports
   *  are `react`, `react/jsx-runtime`, `react-dom` and `@waifucave/clover-plugin-sdk/ui`, which the layer's runtime
   *  provides (one React per layer, lane E), and it imports no CSS. `css` lists the stylesheets its components wear,
   *  cleaned like a theme's CSS and loaded in each layer that mounts one of them, before them. A development folder
   *  may name TypeScript or TSX with CSS imports: the core bundles it the same way (§5.6). */
  client: z.strictObject({ entry: Path, css: z.array(Path).max(32).optional() }).optional(),
  /** A native program the plugin host starts and supervises; a signed .app on macOS, started through Launch Services. */
  helper: z.strictObject({
    bin: z.partialRecord(Platform, Path),
    permissions: z.array(z.enum(HELPER_PERMISSIONS)).max(HELPER_PERMISSIONS.length).optional(),
    ipc: z.enum(["socket", "stdio"]).optional(),
  }).optional(),
  /** They gate the plugin API; they are not containment (§5.4). */
  capabilities: z.array(z.string().min(1).max(300)).max(256).optional(),
  settings: z.record(SettingKey, SettingSchema).optional(),
  /** Sign-ins for the plugin's own service (§5.1). */
  auth: z.array(AuthSchema).max(32).optional(),
  /** Runs add-ons of its own, in a format it chooses (§5.4). */
  addons: z.strictObject({ description: Text }).optional(),
  contributes: ContributionsSchema.optional(),
  /** A hint; the OK shows the core's own record (§5.6). */
  generated: z.strictObject({
    from: z.enum(["mcp-config", "mcp-url", "skill-folder", "agent-file", "claude-plugin", "winter"]),
    by: z.enum(["user", "bot", "migration"]),
    at: z.string().min(1).max(64),
  }).optional(),
});

/** The tool names a server's `tools` record may hold. */
export function isToolKey(name: string): boolean {
  return name === "*" || (TOOL_NAME_RE.test(name) && !name.includes("__"));
}
