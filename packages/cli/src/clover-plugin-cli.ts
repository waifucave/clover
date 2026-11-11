// `clover plugin` (spec §5.6): Clover's plugin registry from the user's own terminal. Every command but `new` and
// `validate` asks the running daemon, as the `cli` role with this run's harness token; none starts Clover.
//
//   clover plugin list                          the registry's plugins (`plugin.list`)
//   clover plugin dev <folder>                  adds a development folder (`plugin.dev.add`): from the user's own
//   clover plugin dev add <folder>              terminal it applies at once, no card (the daemon's caller check makes a
//                                               bot's or agent's shell a session, which it refuses)
//   clover plugin dev list | remove <folder> | renew <folder>
//   clover plugin logs <id> [-n <lines>]        a plugin's log, newest last (`plugin.logs`)
//   clover plugin install <folder|id|npm:name[@version]> [--index <url>] [--version <v>]
//                                               installs one; it waits for its OK on a card in the app
//   clover plugin wrap <mcp-config|mcp-url|skill-folder|agent-file|claude-plugin> <file|folder|url|json>
//   clover plugin enable|disable <id>          switches one on or off
//   clover plugin remove <id> [--yes]          asks y/N first (`--yes` doesn't)
//   clover plugin update [<id>]                checks the indexes and applies updates (all, or the one named)
//   clover plugin pin|unpin <id>               holds an index or npm plugin at its version, or lets it update
//   clover plugin restart <id>
//   clover plugin index list | add <url> <key> | remove <url>
//   clover plugin info <id>                    one plugin: where from, what it may do, its tools and settings
//   clover plugin new <template> [<folder>]     writes a plugin folder from the plugin SDK's templates
//   clover plugin validate [<folder>] [--json] [--upgrade]   (plugin-validate-cli.ts)
//
// The old Claude-plugin manager (WS-21: install, marketplace, …) is now `clover plugin claude …`.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PLUGIN_TEMPLATES, templateFiles, templateIdProblem } from "@waifucave/clover-plugin-sdk/templates";

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
  "usage: clover plugin list [--json] | info <id>",
  "       clover plugin install <folder|id|npm:name[@version]> [--index <url>] [--version <v>]",
  "       clover plugin wrap <mcp-config|mcp-url|skill-folder|agent-file|claude-plugin> <file|folder|url|json>",
  "       clover plugin enable <id> | disable <id> | restart <id> | remove <id> [--yes]",
  "       clover plugin update [<id>] | pin <id> | unpin <id>",
  "       clover plugin index list | index add <url> <key> | index remove <url>",
  "       clover plugin dev <folder> | dev add <folder> | dev list | dev remove <folder> | dev renew <folder>",
  "       clover plugin logs <id> [-n <lines>]",
  `       clover plugin new <${Object.keys(PLUGIN_TEMPLATES).join("|")}> [<folder>] [--name <name>]`,
  "       clover plugin validate [<folder>] [--json] [--upgrade]",
  "       clover plugin claude <list|install|uninstall|enable|disable|update|marketplace|restart> …  (Claude Code plugins)",
].join("\n");

/** The old manager's verbs that are now Clover's own (`install`, `remove`…): only the rest point at `claude`. */
export const CLOVER_PLUGIN_VERBS = ["install", "wrap", "remove", "enable", "disable", "update", "pin", "unpin", "restart", "index", "info"] as const;

/** A hint for a verb the old manager had, which moved under `clover plugin claude`. */
export function movedVerbHint(verb: string): string | undefined {
  return (CLAUDE_PLUGIN_VERBS as readonly string[]).includes(verb) && !(CLOVER_PLUGIN_VERBS as readonly string[]).includes(verb)
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

/** `new`'s file writer; a test passes one that fails part-way. */
export type NewFileWriter = (file: string, text: string) => void;
const writeNew: NewFileWriter = (file, text) => writeFileSync(file, text, { flag: "wx" });

export function runPluginNew(args: readonly string[], cwd = process.cwd(), write: NewFileWriter = writeNew): CliRun {
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
  const idProblem = templateIdProblem(id);
  if (idProblem) return fail(`a plugin's folder is named by its id: ${idProblem}`, 2);
  // Never over anything: a folder that exists must be empty.
  if (existsSync(folder) && (!statSync(folder).isDirectory() || readdirSync(folder).length > 0)) return fail(`${folder} already exists and isn't an empty folder`);
  const made = templateFiles(template, { id, name: name ?? titleOf(id) });
  if ("error" in made) return fail(made.error, 2);
  // All or nothing: a write that fails part-way takes back what this run made, the folder too when this run made it
  // (and any parent it made), and only this run's entries when the folder was there and empty.
  let firstMade: string | undefined;
  const madeEntries = new Set<string>();
  try {
    firstMade = mkdirSync(folder, { recursive: true });
    for (const [rel, text] of Object.entries(made.files)) {
      const file = join(folder, ...rel.split("/"));
      const dirMade = mkdirSync(dirname(file), { recursive: true });
      if (dirMade !== undefined) madeEntries.add(dirMade);
      write(file, text);
      madeEntries.add(file);
    }
  } catch (err) {
    let cleaned = true;
    try {
      if (firstMade !== undefined) rmSync(firstMade, { recursive: true, force: true });
      else for (const entry of madeEntries) rmSync(entry, { recursive: true, force: true });
    } catch {
      cleaned = false;
    }
    const why = err instanceof Error ? err.message : String(err);
    return fail(`couldn't make ${folder}: ${why}; ${cleaned ? "nothing was left behind" : "some of what it made is still there"}`);
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

// ---- install, wrap, enable, disable, remove, update, pin, restart, index, info ----

/** What the user's terminal can do for a command: its folder, and a y/N question (false when it can't ask). */
export interface CliIo {
  cwd: string;
  /** Asks a yes/no question; resolves false for anything but yes, and when there's no terminal to ask in. */
  confirm(question: string): Promise<boolean>;
  /** Reads a file the user named (a pasted config's JSON). */
  readText?(path: string): string;
}

const WRAP_KINDS = ["mcp-config", "mcp-url", "skill-folder", "agent-file", "claude-plugin"] as const;

interface Installed {
  id: string;
  state: string;
  more?: { id: string; state: string }[];
}

const okWait = (r: Installed): string =>
  [r, ...(r.more ?? [])].map((x) => (x.state === "found" ? `installed ${x.id}: it waits for your OK on a card in the app (or \`clover\` on your phone)` : `installed ${x.id} (${x.state})`)).join("\n");

function existsAt(cwd: string, raw: string): string | undefined {
  const p = resolve(cwd, raw);
  return existsSync(p) ? p : undefined;
}

async function runInstall(args: readonly string[], call: CloverPluginCall, io: CliIo): Promise<CliRun> {
  const usage = "usage: clover plugin install <folder|id|npm:name[@version]> [--index <url>] [--version <v>]";
  let index: string | undefined;
  let version: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--index") index = args[++i];
    else if (a === "--version") version = args[++i];
    else if (a.startsWith("-")) return fail(`unknown option ${a}\n${usage}`, 2);
    else pos.push(a);
  }
  if (pos.length !== 1 || (index !== undefined && index === "") || (version !== undefined && version === "")) return fail(usage, 2);
  const what = pos[0]!;
  let source: Record<string, unknown>;
  if (what.startsWith("npm:")) {
    const spec = what.slice(4);
    // `@scope/name@1.2.3`: the version is after the last @ that isn't the first character.
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const v = at > 0 ? spec.slice(at + 1) : version;
    if (name === "") return fail(usage, 2);
    source = { from: "npm", name, ...(v ? { version: v } : {}) };
  } else if (existsAt(io.cwd, what) !== undefined && (what.includes("/") || what.startsWith("."))) {
    source = { from: "folder", path: existsAt(io.cwd, what) };
  } else {
    source = { from: "index", id: what, ...(index ? { index } : {}), ...(version ? { version } : {}) };
  }
  try {
    return { code: 0, output: okWait((await call("plugin.install", { source })) as Installed) };
  } catch (err) {
    return fail(`couldn't install ${what}: ${message(err)}`);
  }
}

async function runWrap(args: readonly string[], call: CloverPluginCall, io: CliIo): Promise<CliRun> {
  const usage = `usage: clover plugin wrap <${WRAP_KINDS.join("|")}> <file|folder|url|json>`;
  const [kind, value, ...extra] = args;
  if (kind === undefined || value === undefined || extra.length > 0 || !(WRAP_KINDS as readonly string[]).includes(kind)) return fail(usage, 2);
  let v = value;
  if (kind === "mcp-config") {
    // A file holding the config, or the JSON itself.
    const file = existsAt(io.cwd, value);
    if (file !== undefined) {
      try {
        v = (io.readText ?? ((p: string) => readFileSync(p, "utf8")))(file);
      } catch (err) {
        return fail(`couldn't read ${file}: ${message(err)}`);
      }
    }
  } else if (kind !== "mcp-url") {
    const p = existsAt(io.cwd, value);
    if (p === undefined) return fail(`${resolve(io.cwd, value)} doesn't exist`);
    v = p;
  }
  try {
    return { code: 0, output: okWait((await call("plugin.install", { source: { from: "wrap", kind, value: v } })) as Installed) };
  } catch (err) {
    return fail(`couldn't wrap it: ${message(err)}`);
  }
}

const oneId = (args: readonly string[], usage: string): string | CliRun => (args.length === 1 && !args[0]!.startsWith("-") ? args[0]! : fail(usage, 2));

async function plainName(call: CloverPluginCall, id: string): Promise<string> {
  try {
    const { plugin } = (await call("plugin.get", { id })) as { plugin: { name: unknown } };
    const n = plugin.name;
    return typeof n === "string" ? n : (n as { en?: string } | undefined)?.en ?? id;
  } catch {
    return id;
  }
}

async function runRemove(args: readonly string[], call: CloverPluginCall, io: CliIo): Promise<CliRun> {
  const usage = "usage: clover plugin remove <id> [--yes]";
  const yes = args.includes("--yes") || args.includes("-y");
  const id = oneId(args.filter((a) => a !== "--yes" && a !== "-y"), usage);
  if (typeof id !== "string") return id;
  const name = await plainName(call, id);
  if (!yes && !(await io.confirm(`Remove ${name} (${id})? Its saved keys and settings on this computer are deleted. Its data is set aside. [y/N] `))) {
    return fail(`${id} wasn't removed (answer y, or add --yes)`);
  }
  try {
    await call("plugin.remove", { id });
    return { code: 0, output: `removed ${id}` };
  } catch (err) {
    return fail(`couldn't remove ${id}: ${message(err)}`);
  }
}

async function runUpdate(args: readonly string[], call: CloverPluginCall): Promise<CliRun> {
  if (args.length > 1 || args.some((a) => a.startsWith("-"))) return fail("usage: clover plugin update [<id>]", 2);
  try {
    const r = (await call("plugin.update", args[0] !== undefined ? { id: args[0] } : {})) as {
      updated: { id: string; from: string; to: string }[];
      offered?: { id: string; from: string; to: string; why: string }[];
      failed?: { id: string; from: string; to: string; why: string }[];
    };
    const lines = [
      ...r.updated.map((u) => `updated ${u.id} ${u.from} → ${u.to}`),
      ...(r.offered ?? []).map((u) => `${u.id} ${u.from} → ${u.to} not applied: ${u.why}`),
      ...(r.failed ?? []).map((u) => `${u.id} ${u.from} → ${u.to} failed: ${u.why}`),
    ];
    return { code: (r.failed ?? []).length > 0 ? 1 : 0, output: lines.length > 0 ? lines.join("\n") : "everything is up to date" };
  } catch (err) {
    return fail(`couldn't update: ${message(err)}`);
  }
}

async function runIndex(args: readonly string[], call: CloverPluginCall): Promise<CliRun> {
  const usage = "usage: clover plugin index list | index add <url> <key> | index remove <url>";
  const [sub, ...rest] = args;
  try {
    if (sub === "list" && rest.length === 0) {
      const { indexes } = (await call("plugin.index.list", {})) as { indexes: { url: string; name?: string; official: boolean; lastCheckedAt?: number; error?: string; stale?: boolean }[] };
      if (!indexes.some((i) => i.official)) indexes.unshift({ url: "(none)", name: "Clover's index: the official index isn't set up in this build", official: true });
      return { code: 0, output: indexes.map((i) => `${i.official ? "official  " : "added     "}${i.url}${i.name ? `  ${i.name}` : ""}${i.error ? `  last check failed: ${i.error}` : ""}${i.stale ? "  stale" : ""}`).join("\n") };
    }
    if (sub === "add" && rest.length === 2) {
      const [url, key] = rest as [string, string];
      if (!/^[0-9a-f]{64}$/.test(key)) return fail("the key is the index's Ed25519 public key, 64 hex characters", 2);
      await call("plugin.index.add", { url, keys: [key] });
      return { code: 0, output: `added ${url}: plugins from it aren't reviewed by Clover; each still asks for your OK` };
    }
    if (sub === "remove" && rest.length === 1) {
      await call("plugin.index.remove", { url: rest[0] });
      return { code: 0, output: `removed ${rest[0]}` };
    }
  } catch (err) {
    return fail(`couldn't ${sub} the index: ${message(err)}`);
  }
  return fail(usage, 2);
}

async function runInfo(args: readonly string[], call: CloverPluginCall): Promise<CliRun> {
  const id = oneId(args, "usage: clover plugin info <id>");
  if (typeof id !== "string") return id;
  try {
    const { plugin: p } = (await call("plugin.get", { id })) as { plugin: { id: string; name: unknown; version: string; state: string; reason?: string; source: string; enabled: boolean; pinned: boolean; capabilities: string[]; networkHosts: string[]; manifest: { contributes?: { mcpServers?: Record<string, { tools?: Record<string, unknown> }> } }; provenance: { by: string; index?: { url: string }; npm?: { name: string }; wrapped?: { from: string; network?: string; reads?: string[] } } } };
    const settings = await call("plugin.settings.get", { id }).then((r) => (r as { settings: { key: string; type: string; value?: unknown; set?: boolean }[] }).settings, () => []);
    const name = typeof p.name === "string" ? p.name : (p.name as { en?: string } | undefined)?.en ?? p.id;
    const servers = Object.entries(p.manifest.contributes?.mcpServers ?? {});
    const from = p.provenance.index ? `the index ${p.provenance.index.url}` : p.provenance.npm ? `npm (${p.provenance.npm.name})` : p.provenance.wrapped ? `a wrapped ${p.provenance.wrapped.from}` : p.source;
    const lines = [
      `${name} (${p.id}) ${p.version}`,
      `state: ${p.state}${p.reason ? `: ${p.reason}` : ""}${p.pinned ? "; updates held back" : ""}`,
      `from: ${from}, added by ${p.provenance.by}`,
      `may: ${[...p.capabilities, ...p.networkHosts.map((h) => `reach ${h}`), ...(p.provenance.wrapped?.network === "any" ? ["reach any host (a wrapped server)"] : []), ...(p.provenance.wrapped?.reads ?? []).map((r) => `read ${r}`)].join(", ") || "nothing beyond its own parts"}`,
      `tools: ${servers.flatMap(([, s]) => Object.keys(s.tools ?? {})).join(", ") || "none listed"}${servers.length > 0 ? ` (servers: ${servers.map(([n]) => n).join(", ")})` : ""}`,
      ...settings.map((s) => `setting ${s.key}: ${s.type === "secret" ? (s.set ? "a key is saved" : "no key saved") : JSON.stringify(s.value ?? null)}`),
    ];
    return { code: 0, output: lines.join("\n") };
  } catch (err) {
    return fail(`couldn't read ${id}: ${message(err)}`);
  }
}

/** The registry's change commands. Each reaches the running daemon as the `cli` role (the user's own terminal):
 *  no card for a removal (it asks y/N here), an update or a development folder, as the rulings say. */
export async function runPluginCommand(verb: string, args: readonly string[], call: CloverPluginCall, io: CliIo): Promise<CliRun> {
  const simple = async (method: string, params: unknown, done: string): Promise<CliRun> => {
    try {
      await call(method, params);
      return { code: 0, output: done };
    } catch (err) {
      return fail(`couldn't ${verb} ${(params as { id?: string }).id ?? ""}: ${message(err)}`.replace(/ +:/, ":"));
    }
  };
  switch (verb) {
    case "install":
      return runInstall(args, call, io);
    case "wrap":
      return runWrap(args, call, io);
    case "enable":
    case "disable": {
      const id = oneId(args, `usage: clover plugin ${verb} <id>`);
      if (typeof id !== "string") return id;
      return simple("plugin.setEnabled", { id, enabled: verb === "enable" }, `${id} is ${verb === "enable" ? "on" : "off"}`);
    }
    case "restart": {
      const id = oneId(args, "usage: clover plugin restart <id>");
      if (typeof id !== "string") return id;
      return simple("plugin.restart", { id }, `restarted ${id}`);
    }
    case "pin":
    case "unpin": {
      const id = oneId(args, `usage: clover plugin ${verb} <id>`);
      if (typeof id !== "string") return id;
      return simple("plugin.pin", { id, pinned: verb === "pin" }, verb === "pin" ? `${id} stays at its version` : `${id} updates again`);
    }
    case "remove":
      return runRemove(args, call, io);
    case "update":
      return runUpdate(args, call);
    case "index":
      return runIndex(args, call);
    case "info":
      return runInfo(args, call);
    default:
      return fail(PLUGIN_USAGE, 2);
  }
}
