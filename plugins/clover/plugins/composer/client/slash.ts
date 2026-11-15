// The slash menu's rules, apart from the DOM: when a line is a command line, which commands it matches, the name each
// shows under, and how the rest of the line becomes the command's args.
//
// A command line starts with `/` and a name made only of letters, digits, `.`, `_` and `-` (so a path such as
// `/Users/me` is never one). The menu shows a command as `/<name>`, or as `/<namespace>.<name>` when its short name is
// another listed command's too or one of the names Clover keeps for its own (`BUILT_IN_NAMES`): a plugin can't take a
// built-in's name or shadow another plugin's. The full name is always beside it, with the plugin's own name.

/** A command the menu lists (the composer host's `commands`). */
export interface SlashCommand {
  /** `<namespace>.<name>`. */
  name: string;
  pluginId: string;
  pluginName: string;
  description: string;
  /** The JSON Schema of its args. */
  args?: Record<string, unknown>;
  scope?: "bots" | "agents" | "both";
  /** The bot's own plugin's. */
  own: boolean;
}

/** Names Clover keeps for its own slash commands (the CLI's, `packages/cli/src/tui/commands.ts`, and the ones the app
 *  will want): a plugin's command with one of these short names shows only by its full name. */
export const BUILT_IN_NAMES: ReadonlySet<string> = new Set([
  "help", "compact", "model", "output-style", "status", "quota", "sessions", "add-dir", "cd", "dirs", "skills", "mcp", "bg",
  "routines", "memory", "workflows", "background", "archive", "clear", "new", "stop", "settings", "plugins", "bots",
  "agents", "level", "effort", "voice", "attach", "send", "quit", "exit", "resume", "login", "logout", "doctor", "run",
]);

/** A line typed as a command: the name so far, and what follows it. */
export interface SlashLine {
  /** The name typed after `/`, up to the first space (empty while only `/` is typed). */
  token: string;
  /** What follows the name and its first space, the command's argument text (trimmed). */
  rest: string;
}

const NAME = /^[A-Za-z0-9._-]*$/;

/** The line as a command line, or undefined when it isn't one. A `/` followed at once by a space or a line break is
 *  text (a paste that starts with one never runs a command). */
export function slashLine(text: string): SlashLine | undefined {
  if (!text.startsWith("/")) return undefined;
  const body = text.slice(1);
  const space = body.search(/\s/);
  const token = space < 0 ? body : body.slice(0, space);
  if (!NAME.test(token) || (token === "" && body !== "")) return undefined;
  return { token, rest: space < 0 ? "" : body.slice(space).trim() };
}

/** `<namespace>.<name>` → `<name>`. */
export const shortName = (full: string): string => full.slice(full.indexOf(".") + 1);

/** The name each command shows under: its short name, unless another listed command has the same one or it is a
 *  built-in's, then its full name. */
export function displayNames(commands: readonly SlashCommand[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const c of commands) count.set(shortName(c.name).toLowerCase(), (count.get(shortName(c.name).toLowerCase()) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const c of commands) {
    const s = shortName(c.name);
    out.set(c.name, count.get(s.toLowerCase())! > 1 || BUILT_IN_NAMES.has(s.toLowerCase()) ? c.name : s);
  }
  return out;
}

/** A menu row: the command, and the name it shows under. */
export interface SlashItem {
  command: SlashCommand;
  display: string;
}

/** Which sessions a plugin's commands are offered in: one scoped to bots isn't in an agent's tab, and the reverse. */
export function inScope(c: SlashCommand, kind: string | undefined): boolean {
  if (c.scope === undefined || c.scope === "both" || kind === undefined) return true;
  return c.scope === "bots" ? kind === "bot" || kind === "side-thread" : kind === "agent" || kind === "coding";
}

/** The names a row answers to: the one it shows and its full name. A short name that collides with another
 *  command's or a built-in's is shown in full and answers only as part of the full name. */
const keysOf = (i: SlashItem): string[] => [...new Set([i.display, i.command.name])].map((k) => k.toLowerCase());

/** The rows for what is typed: every command while only `/` is; else an exact name first, then those whose shown or
 *  full name starts with it, then those whose short name or any name holds it. The bot's own plugin's stay ahead
 *  within each. */
export function matchCommands(commands: readonly SlashCommand[], token: string): SlashItem[] {
  const names = displayNames(commands);
  const items = commands.map((command) => ({ command, display: names.get(command.name)! }));
  const t = token.toLowerCase();
  if (t === "") return items;
  const exact = items.filter((i) => keysOf(i).includes(t));
  const prefix = items.filter((i) => !exact.includes(i) && keysOf(i).some((k) => k.startsWith(t)));
  const inside = items.filter((i) => !exact.includes(i) && !prefix.includes(i) && [...keysOf(i), shortName(i.command.name).toLowerCase()].some((k) => k.includes(t)));
  return [...exact, ...prefix, ...inside];
}

/** Whether Enter may run `item` for what is typed, with no pick by the arrows: the name it answers to is typed in full,
 *  or it is the one row whose shown name starts with it. Otherwise the person picks (an arrow, a click, or the full
 *  name), so a line never goes to a plugin they didn't mean: a short name two plugins share, or a built-in's, runs
 *  neither. */
export function armedFor(items: readonly SlashItem[], item: SlashItem | undefined, token: string): boolean {
  if (item === undefined || token === "") return false;
  const t = token.toLowerCase();
  if (keysOf(item).includes(t)) return true;
  const starts = items.filter((i) => i.display.toLowerCase().startsWith(t));
  return starts.length === 1 && starts[0] === item;
}

export type ArgsResult = { ok: true; args?: unknown } | { ok: false; why: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The property the rest of the line fills when it isn't JSON: the one required string property, or the only string
 *  property. */
function textProperty(schema: Record<string, unknown>): string | undefined {
  const props = isObject(schema.properties) ? schema.properties : {};
  const isString = (k: string) => isObject(props[k]) && (props[k] as Record<string, unknown>).type === "string";
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
  if (required.length === 1 && isString(required[0]!)) return required[0];
  const strings = Object.keys(props).filter(isString);
  return required.length === 0 && strings.length === 1 ? strings[0] : undefined;
}

/** The command's args from the rest of the line, by its schema:
 *  - no schema: it takes nothing, so the rest must be empty;
 *  - `type: "string"`: the rest as it is;
 *  - `integer`, `number`, `boolean`: the rest read as JSON;
 *  - an object: nothing typed is `{}`, a `{…}` is read as JSON, and other text fills its one string property.
 *  The core checks the args against the schema again before the handler sees them. */
export function argsFor(schema: Record<string, unknown> | undefined, rest: string, display: string): ArgsResult {
  const text = rest.trim();
  if (schema === undefined) return text === "" ? { ok: true } : { ok: false, why: `/${display} takes nothing after its name.` };
  const type = schema.type;
  if (type === "string") return { ok: true, args: text };
  if (type === "integer" || type === "number" || type === "boolean") {
    try {
      const v = JSON.parse(text) as unknown;
      if ((type === "boolean" && typeof v === "boolean") || (type !== "boolean" && typeof v === "number")) return { ok: true, args: v };
    } catch {
      /* not JSON */
    }
    return { ok: false, why: `/${display} takes ${type === "boolean" ? "true or false" : "a number"}.` };
  }
  if (text === "") return { ok: true, args: {} };
  if (text.startsWith("{")) {
    try {
      const v = JSON.parse(text) as unknown;
      if (isObject(v)) return { ok: true, args: v };
    } catch {
      /* not JSON */
    }
    return { ok: false, why: `/${display} couldn't read that as JSON.` };
  }
  const prop = textProperty(schema);
  if (prop === undefined) return { ok: false, why: `/${display} takes its arguments as JSON, such as {"name": "value"}.` };
  return { ok: true, args: { [prop]: text } };
}

/** At most this much of a result shows in its row. */
export const RESULT_MAX = 300;

/** A command's result as one short line of text (never markup): a string as it is, an object's `text` or `message`,
 *  "Done." for nothing, else its JSON, cut to `RESULT_MAX`. */
export function resultText(result: unknown): string {
  let text: string;
  if (result === undefined || result === null) text = "Done.";
  else if (typeof result === "string") text = result;
  else if (isObject(result) && typeof result.text === "string") text = result.text;
  else if (isObject(result) && typeof result.message === "string") text = result.message;
  else {
    try {
      text = JSON.stringify(result) ?? "Done.";
    } catch {
      text = "Done.";
    }
  }
  const line = text.replace(/\s+/g, " ").trim() || "Done.";
  return line.length > RESULT_MAX ? `${line.slice(0, RESULT_MAX - 1)}…` : line;
}

/** Why a run was refused, in the core's or the app's own words, without the transport's prefix. */
export function refusalText(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const text = raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(Error|LayerError|ContractError):\s*/, "").replace(/\s+/g, " ").trim();
  if (text === "") return "The command didn't run.";
  return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX - 1)}…` : text;
}
