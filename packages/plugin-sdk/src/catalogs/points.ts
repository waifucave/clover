// The extension-point catalog (spec §5.3, §5.4). The core owns a fixed set of points, the ones its own parts read or
// call; plugins declare the rest. The well-known names the SDK publishes (the spots in `spots.ts`, and the data points
// below) are exempt from the `<plugin-id>.` prefix rule, and a plugin that declares one must use the catalog's
// declaration, or it is refused (§5.4).
import { z } from "zod";
import { utf16 } from "@waifucave/clover-protocol";
import { EntryId, HandlerName, Path, Text } from "../manifest/fields";
import { AVATAR_CAPABILITIES, AVATAR_FILE_CAPS, AVATAR_FILE_TYPES, AVATAR_FINDERS, AVATAR_MODEL_MAX_FILES, avatarFileProblem } from "./avatars";
import { SPOTS } from "./spots";

export interface CorePointInfo {
  /** Its `contributes` key, or its spot name for the app's spots. */
  readonly name: string;
  /** The daemon reads or calls it, or the app's fixed plugin runtime does. */
  readonly side: "daemon" | "app";
  readonly shape: "single" | "list" | "keyed";
  /** The entry field that must be unique among enabled plugins (§5.1 "Entry ids"); the plugin enabled first keeps it. */
  readonly uniqueBy?: string;
  /** Data, code, or either (a model is data for a compatible endpoint, code with an adapter). */
  readonly kind: "data" | "code" | "either";
  /** Where its entries run (§5.2). */
  readonly runsOn: string;
  readonly doc: string;
  readonly shipsWith: string;
}

export const CORE_POINTS: readonly CorePointInfo[] = [
  { name: "bot", side: "daemon", shape: "single", kind: "data", runsOn: "data, on every device",
    doc: "Builds `<bot-instructions>`, picks the default model, keys memory by the bot's id (§6).", shipsWith: "Alpha only" },
  { name: "models", side: "daemon", shape: "list", uniqueBy: "provider", kind: "either", runsOn: "every computer running a session; started when first needed",
    doc: "Calls the adapter, or the declared endpoint, for every turn; the welcome guide reads the sign-in methods (§3.3).", shipsWith: "every provider today's agent SDK has" },
  { name: "mcpServers", side: "daemon", shape: "keyed", kind: "either", runsOn: "local servers on each computer they are installed on; remote servers on the computer running the session (§9.1)",
    doc: "Dispatches tool calls, builds the MCP block and shows MCP Apps pages.", shipsWith: "the web tools; `mcp__clover__Browser`" },
  { name: "skills", side: "daemon", shape: "list", kind: "data", runsOn: "data, on every device", doc: "Indexes them in `Glossary` (§6.8).", shipsWith: "—" },
  { name: "agents", side: "daemon", shape: "list", kind: "data", runsOn: "data, on every device",
    doc: "Offers these presets to `Agent`: backend, model, effort, instructions, computer, root folder, plugins (§9.3).", shipsWith: "—" },
  { name: "agentBackends", side: "daemon", shape: "list", uniqueBy: "id", kind: "code", runsOn: "the computer the agent is placed on",
    doc: "Starts agents for `Agent`: an ACP agent or a vendor cloud agent (§9.3).", shipsWith: "Claude Code, Codex, Grok, Gemini CLI, DeepSeek, Winter's coding agent" },
  { name: "hooks", side: "daemon", shape: "list", kind: "code", runsOn: "every computer running a session; started when first needed",
    doc: "Calls them in the turn loop; a hook can block or adjust, never replace the runtime or skip approvals.", shipsWith: "—" },
  { name: "commands", side: "daemon", shape: "list", uniqueBy: "name", kind: "code", runsOn: "the main, unless `runsOn` says otherwise",
    doc: "Runs a plugin's public functions for any client at once, with no model turn (§5.4).", shipsWith: "—" },
  { name: "triggers", side: "daemon", shape: "keyed", uniqueBy: "type", kind: "code", runsOn: "each computer, started at once",
    doc: "Arms them for routine files (§7).", shipsWith: "schedule, webhook" },
  { name: "voices", side: "daemon", shape: "list", uniqueBy: "id", kind: "code", runsOn: "the computer the user is talking on",
    doc: "Speech-to-text and text-to-speech for the bot's voice choice (§6.6), which the active voice mode takes.", shipsWith: "Fish Audio" },
  { name: "voiceModes", side: "daemon", shape: "list", uniqueBy: "id", kind: "code", runsOn: "the computer the user is talking on",
    doc: "The voice slot (§6.6): one voice mode is active (Settings › Voice); it speaks the bots' replies, plays sound as their voices through its one queue, and hears push-to-talk. The others neither speak nor hear.", shipsWith: "Clover Voice" },
  { name: "computerProviders", side: "daemon", shape: "keyed", uniqueBy: "id", kind: "code", runsOn: "the main, unless `runsOn` says otherwise",
    doc: "Creates, resizes and deletes the VMs that cloud computer folders describe (§9.2).", shipsWith: "Google Cloud, Hetzner" },
  { name: "computer", side: "daemon", shape: "single", kind: "data", runsOn: "data",
    doc: "A cloud computer, created after the user's OK (§9.2).", shipsWith: "—" },
  { name: "relays", side: "daemon", shape: "list", kind: "code", runsOn: "every device that uses them",
    doc: "Carries encrypted traffic when two devices can't connect directly, or holds encrypted sync mail (§8.3).", shipsWith: "n0's public relays; the cloud computer relay" },
  { name: "notifiers", side: "daemon", shape: "list", kind: "code", runsOn: "the main, unless `runsOn` says otherwise",
    doc: "Told when a bot needs the user or has answered (which bot and session, and whether a message, a card or a question waits; never the words), so it can notify the user or wake a companion (§10). The OK card says so.", shipsWith: "waifucave push; desktop notifications" },
  { name: "companions", side: "daemon", shape: "list", kind: "code", runsOn: "the main, unless `runsOn` says otherwise",
    doc: "Serves a remote client within the fixed list of remote calls (§10).", shipsWith: "the iOS app; clover.waifucave.com" },
  { name: "themes", side: "app", shape: "list", kind: "data", runsOn: "every app instance",
    doc: "Applies the base theme, the user's global theme and each bot's theme in its tab (§5.5).", shipsWith: "the base theme" },
  { name: "app.root", side: "app", shape: "single", kind: "code", runsOn: "every app instance",
    doc: "Mounts the main window's root: the shell (§5.5).", shipsWith: "the default shell" },
  { name: "app.surface", side: "app", shape: "list", kind: "code", runsOn: "every app instance",
    doc: "Opens top-level floating windows.", shipsWith: "island, Dispatch pill" },
  { name: "bot.tab", side: "app", shape: "keyed", kind: "code", runsOn: "every app instance",
    doc: "Holds each bot's tab, which the shell shows.", shipsWith: "the default bot tab" },
  { name: "locales", side: "app", shape: "keyed", kind: "data", runsOn: "every app instance",
    doc: "Supplies strings for the core's own text and each plugin's keys, in the user's language (§5.5).", shipsWith: "English, built in" },
];

export const CORE_POINT_NAMES: ReadonlySet<string> = new Set(CORE_POINTS.map((p) => p.name));

/** A well-known point a bundled plugin declares that is not a UI spot: filled with a top-level `contributes` key. */
export interface DataPointInfo {
  readonly name: string;
  readonly shape: "single" | "list" | "keyed";
  readonly declaredBy: string;
  readonly entry: z.ZodType;
  readonly kind: "data" | "code";
  readonly doc: string;
}

/** One `avatar.formats` entry: what a renderer plugin declares about the model format it draws. */
export const AvatarFormatEntry = z.strictObject({
  id: EntryId,
  /** The format id: the key of the `avatar` entry that draws it, and a bot's `avatar.format`. */
  format: utf16(32, 1).regex(/^[a-z0-9-]+$/),
  name: Text,
  /** What `avatar.file` names: its extensions, lower case with the dot (`.vrm`, `.model3.json`). */
  entry: z.strictObject({ extensions: z.array(utf16(32, 2).regex(/^\.[a-z0-9]+(\.[a-z0-9]+)*$/)).min(1).max(8) }),
  files: z.strictObject({
    /** The kinds of file a model is made of, each with its extensions and a cap. */
    kinds: z.array(z.strictObject({
      ext: z.array(utf16(32, 2).regex(/^\.[a-z0-9]+(\.[a-z0-9]+)*$/)).min(1).max(16),
      type: z.enum(AVATAR_FILE_TYPES),
      maxBytes: z.number().int().min(1).max(Math.max(...Object.values(AVATAR_FILE_CAPS))).optional(),
    }).superRefine((k, ctx) => {
      if (k.maxBytes !== undefined && k.maxBytes > AVATAR_FILE_CAPS[k.type]) ctx.addIssue({ code: "custom", path: ["maxBytes"], message: `a ${k.type} file may be at most ${AVATAR_FILE_CAPS[k.type]} bytes` });
    })).min(1).max(16),
    find: z.enum(AVATAR_FINDERS).default("folder"),
    maxFiles: z.number().int().min(1).max(AVATAR_MODEL_MAX_FILES).optional(),
  }),
  /** What the avatar picker may offer for this format. */
  import: z.strictObject({ accepts: z.array(z.enum(["folder", "zip", "file"])).min(1).max(3) }).optional(),
  capabilities: z.array(z.enum(AVATAR_CAPABILITIES)).max(8).optional(),
  /** A picture to show when the model cannot be drawn: a file in the renderer's folder. */
  portrait: Path.optional(),
});
export type AvatarFormatEntry = z.infer<typeof AvatarFormatEntry>;

export const DATA_POINTS: readonly DataPointInfo[] = [
  { name: "webhook.ingress", shape: "list", declaredBy: "clover/trigger-webhook", kind: "code",
    entry: z.strictObject({ id: EntryId, name: Text.optional(), handler: HandlerName }),
    doc: "Ways for webhooks to reach a device: the waifucave forwarder, the user's cloud computer, a tunnel (§7)." },
  { name: "island.line", shape: "list", declaredBy: "clover/island", kind: "code",
    entry: z.strictObject({ id: EntryId, handler: HandlerName }),
    doc: "A line a plugin puts on the island: one line of plain text, an optional icon from the island's small named set and an optional progress bar, drawn in the island's own style with the plugin's name beside it. The island calls `handler` (an `IslandLineHandler`) only when Clover isn't in front (the first line on its closed strip, the lines on its open Needs you tab) and draws what it returns; the island decides how many lines fit, in what order, and how long they last. Nothing is drawn when the handler returns nothing, and a plugin that is off or removed has no line." },
  { name: "avatar.formats", shape: "list", declaredBy: "clover/character", kind: "data",
    entry: AvatarFormatEntry,
    doc: "A model format a renderer plugin draws: the files its models are made of (closed kinds, capped), how they are found from the entry file, what the picker may import, and what the renderer can do. Nothing in the app is hardcoded per format (§5.5)." },
  { name: "avatar.packs", shape: "list", declaredBy: "clover/character", kind: "data",
    entry: z.strictObject({ id: EntryId, name: Text.optional(), file: Path, format: utf16(32, 1).regex(/^[a-z0-9-]+$/), portrait: Path.optional(), license: utf16(200).optional() })
      .superRefine((a, ctx) => {
        const problem = avatarFileProblem(a.format, a.file);
        if (problem) ctx.addIssue({ code: "custom", path: ["file"], message: problem });
      }),
    doc: "Avatar files with their format and portrait, so an avatar pack is a data plugin (§5.5)." },
];

/** Every well-known name: exempt from the prefix rule, and declared only with the catalog's declaration. */
export const WELL_KNOWN_POINT_NAMES: ReadonlySet<string> = new Set([
  ...SPOTS.map((s) => s.name).filter((n) => !CORE_POINT_NAMES.has(n)),
  ...DATA_POINTS.map((p) => p.name),
]);

export function dataPointInfo(name: string): DataPointInfo | undefined {
  return DATA_POINTS.find((p) => p.name === name);
}
