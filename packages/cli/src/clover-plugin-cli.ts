// `clover plugin` (spec §5.6): Clover's plugin registry from the user's own terminal. Every command but `new` and
// `validate` asks the running daemon, as the `cli` role with this run's harness token; none starts Clover.
//
//   clover plugin list                          the registry's plugins (`plugin.list`)
//   clover plugin dev <folder>                  adds a development folder (`plugin.dev.add`): from the user's own
//   clover plugin dev add <folder>              terminal it applies at once, no card (the daemon's caller check makes a
//                                               bot's or agent's shell a session, which it refuses)
//   clover plugin dev list | remove <folder> | renew <folder>
//   clover plugin logs <id> [-n <lines>]        a plugin's log, newest last (`plugin.logs`)
//   clover plugin new <template> [<folder>]     writes a plugin folder from the plugin SDK's templates
//   clover plugin validate [<folder>] [--json] [--upgrade]   (plugin-validate-cli.ts)
//
// The old Claude-plugin manager (WS-21: install, marketplace, …) is now `clover plugin claude …`.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PLUGIN_TEMPLATES, TEMPLATE_ID_RE, templateFiles } from "@waifucave/clover-plugin-sdk/templates";

/** One request to the daemon's Clover server, as the CLI. Rejects with the JSON-RPC error (`code`, `message`). */
export type CloverPluginCall = (method: string, params: unknown) => Promise<unknown>;

export interface CliRun {
  code: number;
  output: string;
}

/** The old manager's verbs, now under `clover plugin claude`. */
export const CLAUDE_PLUGIN_VERBS = ["install", "uninstall", "remove", "enable", "disable", "update", "marketplace", "restart"] as const;

const fail = (output: string, code = 1): CliRun => ({ code, output });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

export const PLUGIN_USAGE = [
  "usage: clover plugin list",
  "       clover plugin dev <folder> | dev add <folder> | dev list | dev remove <folder> | dev renew <folder>",
  "       clover plugin logs <id> [-n <lines>]",
  `       clover plugin new <${Object.keys(PLUGIN_TEMPLATES).join("|")}> [<folder>] [--name <name>]`,
  "       clover plugin validate [<folder>] [--json] [--upgrade]",
  "       clover plugin claude <list|install|uninstall|enable|disable|update|marketplace|restart> …  (Claude Code plugins)",
].join("\n");

/** A hint for a verb the old manager had, which moved under `clover plugin claude`. */
export function movedVerbHint(verb: string): string | undefined {
  return (CLAUDE_PLUGIN_VERBS as readonly string[]).includes(verb)
    ? `\`clover plugin ${verb}\` manages Claude Code plugins, and is now \`clover plugin claude ${verb}\`; \`clover plugin\` is Clover's own plugins.`
    : undefined;
}

// ---- list ----

interface Summary {
  id: string;
  name: string;
  version: string;
  state: string;
  reason?: string;
  enabled: boolean;
  source: string;
  dev: boolean;
}

export async function runPluginList(args: readonly string[], call: CloverPluginCall): Promise<CliRun> {
  const json = args.includes("--json");
  if (args.some((a) => a !== "--json")) return fail(`usage: clover plugin list [--json]`, 2);
  let r: { plugins: Summary[] };
  try {
    r = (await call("plugin.list", {})) as { plugins: Summary[] };
  } catch (err) {
    return fail(`couldn't list plugins: ${message(err)}`);
  }
  if (json) return { code: 0, output: JSON.stringify(r.plugins, null, 2) };
  if (r.plugins.length === 0) return { code: 0, output: "no plugins" };
  const rows = r.plugins.map((p) => `${p.id}  ${p.version || "-"}  ${p.enabled ? p.state : "off"}${p.dev ? "  (development folder)" : ""}${p.reason ? `  ${p.reason}` : ""}`);
  return { code: 0, output: rows.join("\n") };
}

// ---- dev ----

interface DevFolder {
  path: string;
  pluginId?: string;
  addedAt: number;
  expiresAt: number;
}

/** A folder the daemon is told about: absolute, and one that exists here as a folder. */
function devPath(raw: string | undefined, cwd: string): { path: string } | { error: string } {
  if (raw === undefined || raw === "") return { error: "which folder?" };
  const path = resolve(cwd, raw);
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    return { error: `${path} doesn't exist` };
  }
  if (!isDir) return { error: `${path} isn't a folder` };
  return { path };
}

const untilText = (expiresAt: number, now: number): string => {
  const h = Math.max(0, Math.round((expiresAt - now) / 3_600_000));
  return h >= 1 ? `on for ${h} more hour${h === 1 ? "" : "s"}` : "on for less than an hour";
};

export async function runPluginDev(args: readonly string[], call: CloverPluginCall, cwd = process.cwd(), now = Date.now()): Promise<CliRun> {
  const [first, ...rest] = args;
  const usage = "usage: clover plugin dev <folder> | dev add <folder> | dev list | dev remove <folder> | dev renew <folder>";
  if (first === undefined) return fail(usage, 2);
  if (first === "list") {
    if (rest.length > 0) return fail(usage, 2);
    try {
      const { folders } = (await call("plugin.dev.list", {})) as { folders: DevFolder[] };
      if (folders.length === 0) return { code: 0, output: "no development folders" };
      return { code: 0, output: folders.map((f) => `${f.path}  ${f.pluginId ?? "(no plugin)"}  ${untilText(f.expiresAt, now)}`).join("\n") };
    } catch (err) {
      return fail(`couldn't list development folders: ${message(err)}`);
    }
  }
  if (first === "remove" || first === "renew") {
    if (rest.length !== 1) return fail(usage, 2);
    // A folder already gone from disk can still be removed: the daemon matches what it holds.
    const path = resolve(cwd, rest[0]!);
    try {
      if (first === "remove") {
        await call("plugin.dev.remove", { path });
        return { code: 0, output: `removed ${path} from development` };
      }
      const { expiresAt } = (await call("plugin.dev.renew", { path })) as { expiresAt: number };
      return { code: 0, output: `${path} stays a development folder, ${untilText(expiresAt, now)}` };
    } catch (err) {
      return fail(`couldn't ${first} ${path}: ${message(err)}`);
    }
  }
  const target = first === "add" ? rest : [first, ...rest];
  if (target.length !== 1) return fail(usage, 2);
  const p = devPath(target[0], cwd);
  if ("error" in p) return fail(p.error);
  try {
    const r = (await call("plugin.dev.add", { path: p.path })) as { applied: boolean; card?: string };
    if (!r.applied) return { code: 0, output: `adding ${p.path} waits for your answer on its card in Clover` };
    return {
      code: 0,
      output: `${p.path} is a development folder on this computer: it reloads on every change, and turns off in 24 hours unless you renew it (\`clover plugin dev renew ${p.path}\`)`,
    };
  } catch (err) {
    return fail(`couldn't add ${p.path}: ${message(err)}`);
  }
}

// ---- logs ----

export async function runPluginLogs(args: readonly string[], call: CloverPluginCall): Promise<CliRun> {
  const usage = "usage: clover plugin logs <id> [-n <lines>]";
  let id: string | undefined;
  let lines: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-n" || a === "--lines") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 5000) return fail("-n takes a number of lines from 1 to 5000", 2);
      lines = n;
    } else if (a.startsWith("-")) return fail(`unknown option ${a}\n${usage}`, 2);
    else if (id === undefined) id = a;
    else return fail(usage, 2);
  }
  if (id === undefined) return fail(usage, 2);
  try {
    const r = (await call("plugin.logs", { id, ...(lines === undefined ? {} : { lines }) })) as { lines: string[] };
    return { code: 0, output: r.lines.length === 0 ? `${id} has logged nothing` : r.lines.join("\n") };
  } catch (err) {
    return fail(`couldn't read ${id}'s log: ${message(err)}`);
  }
}

// ---- new ----

export function runPluginNew(args: readonly string[], cwd = process.cwd()): CliRun {
  const usage = `usage: clover plugin new <${Object.keys(PLUGIN_TEMPLATES).join("|")}> [<folder>] [--name <name>]`;
  const positionals: string[] = [];
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--name") {
      name = args[++i];
      if (name === undefined || name.trim() === "") return fail("--name takes a name", 2);
    } else if (a.startsWith("-")) return fail(`unknown option ${a}\n${usage}`, 2);
    else positionals.push(a);
  }
  const [template, folderArg, ...extra] = positionals;
  if (template === undefined || extra.length > 0) {
    const list = Object.entries(PLUGIN_TEMPLATES).map(([k, t]) => `  ${k.padEnd(8)} ${t.description}`).join("\n");
    return fail(`${usage}\n\ntemplates:\n${list}`, 2);
  }
  if (!(template in PLUGIN_TEMPLATES)) return fail(`no template "${template}": ${Object.keys(PLUGIN_TEMPLATES).join(", ")}`, 2);
  const folder = resolve(cwd, folderArg ?? `my-${template}`);
  const id = basename(folder);
  if (!TEMPLATE_ID_RE.test(id) || id.length > 64) return fail(`a plugin's folder is named by its id: lowercase letters, digits and hyphens ("${id}" isn't one)`, 2);
  // Never over anything: a folder that exists must be empty.
  if (existsSync(folder) && (!statSync(folder).isDirectory() || readdirSync(folder).length > 0)) return fail(`${folder} already exists and isn't an empty folder`);
  const made = templateFiles(template, { id, name: name?.trim() || titleOf(id) });
  if ("error" in made) return fail(made.error, 2);
  for (const [rel, text] of Object.entries(made.files)) {
    const file = join(folder, ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { flag: "wx" });
  }
  return {
    code: 0,
    output: [
      `made ${folder} from the ${template} template:`,
      ...Object.keys(made.files).sort().map((f) => `  ${f}`),
      "",
      `check it with \`clover plugin validate ${folder}\`, and try it here with \`clover plugin dev ${folder}\``,
    ].join("\n"),
  };
}

/** A name from an id: `my-tool` becomes `My tool`. */
const titleOf = (id: string): string => {
  const words = id.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};
