// The extension-point catalog (spec §5.3, §5.4). The core owns a fixed set of points, the ones its own parts read or
// call; plugins declare the rest. The well-known names the SDK publishes (the spots in `spots.ts`, and the data points
// below) are exempt from the `<plugin-id>.` prefix rule, and a plugin that declares one must use the catalog's
// declaration, or it is refused (§5.4).
import { z } from "zod";
import { EntryId, HandlerName, Text } from "../manifest/fields";
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
  /** One filler at a time (§5.4 "One at a time"): the platform keeps which entry is active; Settings' picker is titled
   *  by `title`. */
  readonly oneAtATime?: boolean;
  readonly title?: string;
  /** The line its fillers' OK cards show (`fillsOkLines`), attributed to MOSS. */
  readonly fills?: { readonly ok: string; readonly warns?: boolean };
}

export const CORE_POINTS: readonly CorePointInfo[] = [
  { name: "bot", side: "daemon", shape: "single", kind: "data", runsOn: "data, on every device",
    doc: "Builds `<bot-instructions>`, picks the default model, keys memory by the bot's id (§6).", shipsWith: "Alpha only" },
  { name: "models", side: "daemon", shape: "list", uniqueBy: "provider", kind: "either", runsOn: "every computer running a session; started when first needed",
    doc: "Calls the adapter, or the declared endpoint, for every turn; the welcome guide reads the sign-in methods (§3.3).", shipsWith: "every provider today's agent SDK has" },
  { name: "mcpServers", side: "daemon", shape: "keyed", kind: "either", runsOn: "local servers on each computer they are installed on; remote servers on the computer running the session (§9.1)",
    doc: "Dispatches tool calls, builds the MCP block and shows MCP Apps pages.", shipsWith: "the web tools; `mcp__moss__Browser`" },
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
  { name: "turns", side: "daemon", shape: "list", kind: "data", runsOn: "data",
    doc: "Names of the plugin's own one-at-a-time turns that another plugin may take (`<plugin id>/<name>`, §5.4 \"Turns\"); its own need no entry.", shipsWith: "—" },
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
  { name: "app.background", side: "app", shape: "list", kind: "code", runsOn: "every app instance",
    doc: "Runs parts that have no place in the window, in a hidden window of their own." , shipsWith: "nothing yet; any plugin" },
  { name: "locales", side: "app", shape: "keyed", kind: "data", runsOn: "every app instance",
    doc: "Supplies strings for the core's own text and each plugin's keys, in the user's language (§5.5).", shipsWith: "English, built in" },
];

export const CORE_POINT_NAMES: ReadonlySet<string> = new Set(CORE_POINTS.map((p) => p.name));

/** A well-known point a bundled plugin declares that is not a UI spot: filled with a top-level `contributes` key. */
export interface DataPointInfo {
  readonly name: string;
  readonly shape: "single" | "list" | "keyed";
  /** A plugin's id, or `"core"`: a point the core and the app read themselves is the
   *  platform's. No plugin declares it; its entries are in force as soon as their plugin runs. */
  readonly declaredBy: string;
  /** For a platform point (`declaredBy: "core"`): the capabilities whose holders read its entries (`points.entries`,
   *  `points.watch`), since no plugin declares it and the declarer's right to read is nobody's. Any one is enough. */
  readonly readBy?: readonly string[];
  readonly entry: z.ZodType;
  readonly kind: "data" | "code";
  readonly doc: string;
  /** One filler at a time (§5.4 "One at a time"), with the title Settings' picker shows. */
  readonly oneAtATime?: boolean;
  readonly title?: string;
}

export const DATA_POINTS: readonly DataPointInfo[] = [
  { name: "webhook.ingress", shape: "list", declaredBy: "moss/trigger-webhook", kind: "code",
    entry: z.strictObject({ id: EntryId, name: Text.optional(), handler: HandlerName }),
    doc: "Ways for webhooks to reach a device: the waifucave forwarder, the user's cloud computer, a tunnel (§7)." },
  { name: "usage.sources", shape: "list", declaredBy: "moss/usage", kind: "code",
    entry: z.strictObject({
      /** The source's id: what its records and its plan reading are filed under, and what an alarm names. */
      id: EntryId,
      /** What the Usage surfaces call it; the id when left out. */
      name: Text.optional(),
      handler: HandlerName,
      /** What it gives: a plan reading (`plan`), the numbers its tool's own files hold (`usage`), or both. */
      provides: z.array(z.enum(["plan", "usage"])).min(1).max(2),
      /** The least time between two plan readings (default 5 minutes, at least 10 seconds): the core asks no oftener. */
      planEveryMs: z.number().int().min(10_000).max(86_400_000).optional(),
    }),
    doc: "A tool of the user's installed on this computer whose usage MOSS reads: its plan windows (`plan`) and the token counts its own session files hold (`ingest`), through its own program and its own folders (`host.outside`), never its sign-in. The core calls the handler on this computer only, asks no oftener than `planEveryMs`, prices the records and keeps the store; the source owns how its tool is read (§12)." },
  { name: "island.line", shape: "list", declaredBy: "island", kind: "code",
    entry: z.strictObject({ id: EntryId, handler: HandlerName }),
    doc: "A line a plugin puts on the island: one line of plain text, an optional icon from the island's small named set and an optional progress bar, drawn in the island's own style with the plugin's name beside it. The island calls `handler` (an `IslandLineHandler`) only when MOSS isn't in front (the first line on its closed strip, the lines on its open Needs you tab) and draws what it returns; the island decides how many lines fit, in what order, and how long they last. Nothing is drawn when the handler returns nothing, and a plugin that is off or removed has no line." },
];

/** Every well-known name: exempt from the prefix rule, and declared only with the catalog's declaration. */
export const WELL_KNOWN_POINT_NAMES: ReadonlySet<string> = new Set([
  ...SPOTS.map((s) => s.name).filter((n) => !CORE_POINT_NAMES.has(n)),
  ...DATA_POINTS.map((p) => p.name),
]);

export function dataPointInfo(name: string): DataPointInfo | undefined {
  return DATA_POINTS.find((p) => p.name === name);
}

/** Whether a point takes one filler at a time (§5.4 "One at a time"), with the title Settings' picker shows: a core
 *  point's from `CORE_POINTS`, any other's from its declaration (a well-known name's declaration is the catalog's). */
export function oneAtATimeOf(name: string, decl: { oneAtATime?: boolean; title?: unknown } | undefined): { title: string | { en: string; [lang: string]: string } } | undefined {
  const core = CORE_POINTS.find((p) => p.name === name);
  if (core !== undefined) return core.oneAtATime === true ? { title: core.title ?? name } : undefined;
  if (decl?.oneAtATime !== true) return undefined;
  const t = decl.title;
  if (typeof t === "string" && t !== "") return { title: t };
  if (typeof t === "object" && t !== null && typeof (t as { en?: unknown }).en === "string") return { title: t as { en: string; [lang: string]: string } };
  return { title: name };
}

/** Whether a data point is the platform's own (no plugin declares it; fillers need no declarer to run). */
export function isPlatformDataPoint(name: string): boolean {
  return dataPointInfo(name)?.declaredBy === "core";
}
