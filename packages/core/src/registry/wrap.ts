// `plugin.install { from: "wrap" }` (spec §5.1 "wrapped automatically"): a bare item becomes a small plugin the core
// generates in the plugins folder, which from then on installs, syncs, gets its OK and is switched on like any plugin.
// The user can open and edit it.
//
// * Accepted as-is: an agent-skill folder (a `SKILL.md` at its top, its front matter's `name` and `description`), and a
//   Claude-style agent file (`agents/*.md`: front matter and instructions), each copied unchanged into the generated
//   plugin (`skills/<name>/`, `agents/<name>.md`), whose manifest lists it.
// * An MCP server's config (`.mcp.json`'s `mcpServers`, or the same map pasted alone) gives one plugin per server,
//   `mcp-<server>`, whose namespace is the server's name (`mcp-blender` gives `mcp__blender__Render`). Every `env` and
//   `headers` value goes into the plugin's own secrets, a `${secret:<name>}` in its place, with a secret setting so the
//   user can see and change it. An MCP server's address gives one `http` server.
// * A Claude Code plugin folder (`.claude-plugin/plugin.json`, or no `clover.json` but `skills/`, `commands/`, `agents/`
//   or `hooks/hooks.json`) is copied whole into `claude-<name>`, and its manifest written around it: its skills and its
//   commands (each a generated skill folder) as `skills`, its agents as `agents`, its MCP servers as `mcpServers` and
//   its hooks as Claude-style `hooks`; `${CLAUDE_PLUGIN_ROOT}` becomes `${plugin}`, `${CLAUDE_PLUGIN_DATA}` `${data}`,
//   `${user_config.K}` `${setting:K}` (or `${secret:K}` for a `sensitive` option), and `userConfig` its settings. Its
//   hooks run under `sh` with `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_OPTION_<KEY>`; its stdio
//   servers get the two paths. What has no Clover point yet stays in the folder unused, and the OK names it.
// * Ids: `skill-`, `agent-`, `mcp-`, `claude-<name>`, the name cleaned (`wrapperId`), a number added on a clash.
// * Recorded: the manifest's `generated` (a hint, which the user may edit) and the core's own record, the install's
//   provenance (`wrapped`: what it was made from, and the parts left unused), which the OK shows.
// * The copy is an install's (`copyTreeInto`): regular files only, links that leave the item refused, capped; and what
//   is installed is the generated folder, validated as any install is (`installStaged`).
// * The network (the owner's ruling, 2026-11-10, §5.3): a wrapper that runs a local server or a hook gets
//   `network: "any"` on its install record: those processes reach any host, fenced for files as any plugin's, and the
//   OK says so. Once its manifest declares `network:` hosts it is held to them (`wrapperNetworkOpen`).
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { CLAUDE_HOOK_DEFAULT_TIMEOUT_MS, CLAUDE_HOOK_EVENTS, cleanName, KEY_RE, MANIFEST_FILE, parseJsonc, PLUGIN_API_VERSION, wrapperId, type WrapperKind } from "@waifucave/clover-plugin-sdk";
import { SemverVersion, topPluginIdOf, type PluginProvenance, type WrapKind } from "@waifucave/clover-protocol";
import type { PluginRecord } from "../contracts/plugin-registry";
import type { SecretStore } from "../contracts/secret-store";
import { ContractError } from "../contracts/common";
import { copyTreeInto, installStaged, newStage, readSourceFile, sourceFolder, type InstallTarget } from "./install-folder";

/** The longest skill or agent file read whole. */
export const WRAP_TEXT_MAX_BYTES = 1024 * 1024;
/** The longest description a wrapper's manifest keeps from the item. */
const DESCRIPTION_MAX = 1000;

/** A Markdown file's front matter (`---` lines at its top): its `key: value` lines, quotes taken off. Nested YAML and
 *  lists are left out; a file without front matter has none. */
export function frontMatter(md: string): Record<string, string> {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(md);
  if (m === null) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (kv === null) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== "" && !(kv[1]! in out)) out[kv[1]!] = v;
  }
  return out;
}

export interface WrapResult {
  id: string;
  folder: string;
  treeHash: string;
  /** The parts of the item Clover has no point for yet, which stay in the folder unused (the OK names them). */
  unused: string[];
  /** The network grant for the install record (`wrapperNetworkOpen`): set when the plugin runs a local server or a
   *  hook, which the fence holds. An http server's address is reached by the runtime, not a plugin process. */
  network?: "any";
}

/** Whether a wrapper's local servers and hooks reach the whole network (the fence's `open`, no proxy): the owner's
 *  ruling of 2026-11-10 (§5.3) for a server the user brought, which declares no hosts. The grant is the install
 *  record's (`wrapped.network`), never the manifest's; and once the plugin's tree declares any `network:` capability
 *  (the user edited it, which re-asks its OK), it is held to those hosts like any other plugin. A plugin that isn't a
 *  wrapper never gets it, hosts or none. */
export function wrapperNetworkOpen(wrapped: PluginProvenance["wrapped"] | undefined, declared: readonly string[]): boolean {
  return wrapped?.network === "any" && !declared.some((c) => c.startsWith("network:"));
}

/** `wrapperNetworkOpen` for a running plugin (any id in its tree): the top plugin's install record, and every
 *  capability its tree declares now. */
export function wrapperOpensNetwork(registry: { get(id: string): PluginRecord | undefined; list(): readonly PluginRecord[] }, pluginId: string): boolean {
  const top = topPluginIdOf(pluginId);
  const record = registry.get(top);
  if (record === undefined) return false;
  return wrapperNetworkOpen(record.provenance.wrapped, registry.list().filter((r) => topPluginIdOf(r.id) === top).flatMap((r) => r.capabilities));
}

export interface WrapOptions extends InstallTarget {
  kind: WrapKind;
  value: string;
  by: "user" | "bot";
  now?: () => number;
  /** Where a pasted config's `env` and `headers` values go: the plugin's own secrets. */
  secrets?: Pick<SecretStore, "set" | "delete">;
}

/** Wraps a bare item into plugins, installed into `pluginsDir`, validated, each waiting for its OK: one for most items,
 *  one per server for an MCP config. */
export async function installWrapped(o: WrapOptions): Promise<WrapResult[]> {
  const at = new Date((o.now ?? Date.now)()).toISOString();
  // Wrapper ids are taken by an installed plugin, a bundled one, a folder already in the plugins folder, or another
  // plugin of this same wrap.
  const chosen = new Set<string>();
  const taken = { has: (id: string) => chosen.has(id) || o.taken(id) || existsDir(join(o.pluginsDir, id)) } as ReadonlySet<string>;
  const ctx: WrapCtx = { o, taken, chosen, at };
  switch (o.kind) {
    case "skill-folder":
      return [await wrapSkillFolder(o, taken, at)];
    case "agent-file":
      return [await wrapAgentFile(o, taken, at)];
    case "mcp-config":
      return wrapMcpConfig(ctx);
    case "mcp-url":
      return [await wrapMcpUrl(ctx)];
    case "claude-plugin":
      return [await wrapClaudePlugin(ctx)];
  }
}

interface WrapCtx {
  o: WrapOptions;
  taken: ReadonlySet<string>;
  chosen: Set<string>;
  at: string;
}

const existsDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function manifestFor(o: { id: string; name: string; description?: string; generated: { from: WrapKind; by: "user" | "bot"; at: string }; contributes: Record<string, unknown>; extra?: Record<string, unknown> }): string {
  return `${JSON.stringify({
    manifest: 1,
    id: o.id,
    name: o.name,
    ...(o.description !== undefined ? { description: o.description.slice(0, DESCRIPTION_MAX) } : {}),
    ...(o.extra ?? {}),
    contributes: o.contributes,
    generated: o.generated,
  }, null, 2)}\n`;
}

async function wrapSkillFolder(o: InstallTarget & { value: string; by: "user" | "bot" }, taken: ReadonlySet<string>, at: string): Promise<WrapResult> {
  const root = sourceFolder(o.value, o.pluginsDir);
  if (existsFile(join(root, MANIFEST_FILE))) throw new ContractError("invalid", `${root} holds a ${MANIFEST_FILE}: it's a plugin already, so install it as a folder`);
  if (!existsFile(join(root, "SKILL.md"))) throw new ContractError("invalid", `${root} has no SKILL.md at its top, so it isn't a skill folder`);
  const md = readSourceFile(realpathSync(join(root, "SKILL.md")), "SKILL.md", WRAP_TEXT_MAX_BYTES).toString("utf8");
  const fm = frontMatter(md);
  const name = fm.name ?? basename(root);
  const { id, namespace } = wrapperId("skill" satisfies WrapperKind, name, taken);
  const stage = newStage(o.stagingDir);
  try {
    const staged = join(stage.dir, id);
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    copyTreeInto(root, join(staged, "skills", namespace));
    writeFileSync(join(staged, MANIFEST_FILE), manifestFor({
      id, name, ...(fm.description !== undefined ? { description: fm.description } : {}),
      generated: { from: "skill-folder", by: o.by, at },
      contributes: { skills: [`skills/${namespace}`] },
    }));
    const done = await installStaged(staged, o);
    return { ...done, unused: [] };
  } finally {
    stage.done();
  }
}

async function wrapAgentFile(o: InstallTarget & { value: string; by: "user" | "bot" }, taken: ReadonlySet<string>, at: string): Promise<WrapResult> {
  let file: string;
  try {
    file = realpathSync(o.value);
  } catch {
    throw new ContractError("invalid", `${o.value} doesn't exist`);
  }
  if (extname(file).toLowerCase() !== ".md") throw new ContractError("invalid", `${file} isn't an agent file (a Markdown file, agents/<name>.md)`);
  const plugins = realpathSync(o.pluginsDir);
  if (file.startsWith(plugins + sep)) throw new ContractError("invalid", "an agent file is wrapped from outside the plugins folder");
  const bytes = readSourceFile(file, basename(file), WRAP_TEXT_MAX_BYTES);
  const fm = frontMatter(bytes.toString("utf8"));
  const name = fm.name ?? basename(file, extname(file));
  const { id, namespace } = wrapperId("agent" satisfies WrapperKind, name, taken);
  const stage = newStage(o.stagingDir);
  try {
    const staged = join(stage.dir, id);
    mkdirSync(join(staged, "agents"), { recursive: true, mode: 0o700 });
    writeFileSync(join(staged, "agents", `${namespace}.md`), bytes, { flag: "wx", mode: 0o644 });
    writeFileSync(join(staged, MANIFEST_FILE), manifestFor({
      id, name, ...(fm.description !== undefined ? { description: fm.description } : {}),
      generated: { from: "agent-file", by: o.by, at },
      contributes: { agents: [`agents/${namespace}.md`] },
    }));
    const done = await installStaged(staged, o);
    return { ...done, unused: [] };
  } finally {
    stage.done();
  }
}

const existsFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// ---- MCP servers ------------------------------------------------------------------------------------------------

/** The most servers one pasted config wraps. */
export const WRAP_MAX_SERVERS = 32;

interface RawServer {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
const stringMap = (v: unknown): Record<string, string> | undefined =>
  isObject(v) && Object.values(v).every((x) => typeof x === "string") ? (v as Record<string, string>) : undefined;

/** A pasted config's servers: `{ "mcpServers": { name: server } }` (`.mcp.json`, Claude Code's shape), or the map
 *  alone. */
export function mcpServersOf(text: string): Record<string, RawServer> {
  const parsed = parseJsonc(text);
  if (!parsed.ok) throw new ContractError("invalid", `the config isn't JSON: ${parsed.error.message}`);
  const root = parsed.value;
  if (!isObject(root)) throw new ContractError("invalid", "an MCP config is a JSON object of servers by name");
  const map = isObject(root.mcpServers) ? root.mcpServers : root;
  const out: Record<string, RawServer> = {};
  for (const [name, server] of Object.entries(map)) {
    if (!isObject(server) || (server.command === undefined && server.url === undefined)) {
      throw new ContractError("invalid", `${JSON.stringify(name)} isn't an MCP server (it needs a \`command\` or a \`url\`)`);
    }
    out[name] = server;
  }
  if (Object.keys(out).length === 0) throw new ContractError("invalid", "the config names no MCP server");
  if (Object.keys(out).length > WRAP_MAX_SERVERS) throw new ContractError("invalid", `a config wraps at most ${WRAP_MAX_SERVERS} servers at once`);
  return out;
}

const isStdio = (s: RawServer): boolean => s.type === "stdio" || (s.type === undefined && s.command !== undefined);

/** A secret's name from an `env` or header name: KEY_RE's shape (`A-Za-z0-9_.-`, a letter first), at most 64. */
function secretName(raw: string, prefix: string, used: Set<string>): string {
  let base = `${prefix}${raw}`.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[^A-Za-z]+/, "").slice(0, 60) || "secret";
  if (!/^[A-Za-z]/.test(base)) base = `k${base}`;
  let name = base;
  for (let n = 2; used.has(name) || !KEY_RE.test(name); n++) name = `${base.slice(0, 58)}_${n}`;
  used.add(name);
  return name;
}

/** One server of a pasted config as a Clover `mcpServers` entry, its `env` and `headers` values moved into secrets. */
function pastedServer(raw: RawServer, secrets: Record<string, string>, settings: Record<string, unknown>): Record<string, unknown> {
  const used = new Set(Object.keys(secrets));
  const move = (values: Record<string, string> | undefined, prefix: string, label: string): Record<string, string> | undefined => {
    if (values === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      const name = secretName(k, prefix, used);
      secrets[name] = v;
      settings[name] = { type: "secret", title: `${label} ${k}` };
      out[k] = `\${secret:${name}}`;
    }
    return out;
  };
  if (isStdio(raw)) {
    if (typeof raw.command !== "string" || raw.command === "") throw new ContractError("invalid", "a stdio server needs a `command`");
    const args = raw.args === undefined ? undefined : strings(raw.args);
    if (raw.args !== undefined && args === undefined) throw new ContractError("invalid", "a server's `args` is a list of strings");
    if (raw.env !== undefined && stringMap(raw.env) === undefined) throw new ContractError("invalid", "a server's `env` is an object of strings");
    const env = move(stringMap(raw.env), "", "Environment variable");
    return { type: "stdio", command: raw.command, ...(args !== undefined ? { args } : {}), ...(env !== undefined ? { env } : {}) };
  }
  if (typeof raw.url !== "string") throw new ContractError("invalid", "an http server needs a `url`");
  const url = httpUrl(raw.url);
  if (raw.headers !== undefined && stringMap(raw.headers) === undefined) throw new ContractError("invalid", "a server's `headers` is an object of strings");
  const headers = move(stringMap(raw.headers), "header.", "Header");
  return { type: "http", url, ...(headers !== undefined ? { headers } : {}) };
}

function httpUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ContractError("invalid", `${JSON.stringify(raw.slice(0, 200))} isn't a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ContractError("invalid", "an MCP server's address is an http or https URL");
  if (u.username !== "" || u.password !== "") throw new ContractError("invalid", "an MCP server's address carries no user name or password; put a key in a header");
  return u.href;
}

/** Installs one generated MCP plugin: its secrets stored first (and taken back if the install fails). */
async function installMcpPlugin(ctx: WrapCtx, name: string, server: Record<string, unknown>, secrets: Record<string, string>, settings: Record<string, unknown>, from: WrapKind): Promise<WrapResult & { secretNames: string[] }> {
  const { id, namespace } = wrapperId("mcp" satisfies WrapperKind, name, ctx.taken);
  ctx.chosen.add(id);
  const stdio = server.type === "stdio";
  const stage = newStage(ctx.o.stagingDir);
  const stored: string[] = [];
  try {
    const staged = join(stage.dir, id);
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    writeFileSync(join(staged, MANIFEST_FILE), manifestFor({
      id, name,
      extra: {
        namespace,
        ...(stdio ? { engines: { clover: `^${PLUGIN_API_VERSION}` } } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      },
      generated: { from, by: ctx.o.by, at: ctx.at },
      contributes: { mcpServers: { [namespace]: server } },
    }));
    if (Object.keys(secrets).length > 0 && ctx.o.secrets === undefined) throw new ContractError("failed", "the credential store isn't open here, so a config with keys can't be wrapped");
    for (const [k, v] of Object.entries(secrets)) {
      await ctx.o.secrets!.set({ owner: { kind: "plugin", pluginId: id }, name: k }, v);
      stored.push(k);
    }
    const done = await installStaged(staged, ctx.o);
    return { ...done, unused: [], ...(stdio ? { network: "any" as const } : {}), secretNames: stored };
  } catch (err) {
    for (const k of stored) await ctx.o.secrets?.delete({ owner: { kind: "plugin", pluginId: id }, name: k }).catch(() => false);
    throw err;
  } finally {
    stage.done();
  }
}

async function wrapMcpConfig(ctx: WrapCtx): Promise<WrapResult[]> {
  const servers = mcpServersOf(ctx.o.value);
  // Every server is checked before any is installed: a config that's half wrong installs nothing.
  const built = Object.entries(servers).map(([name, raw]) => {
    const secrets: Record<string, string> = {};
    const settings: Record<string, unknown> = {};
    return { name, server: pastedServer(raw, secrets, settings), secrets, settings };
  });
  const out: (WrapResult & { secretNames: string[] })[] = [];
  try {
    for (const b of built) out.push(await installMcpPlugin(ctx, b.name, b.server, b.secrets, b.settings, "mcp-config"));
  } catch (err) {
    // One that fails takes back the ones installed before it (their folders and secrets): a config installs whole or not.
    for (const done of out) {
      rmSync(done.folder, { recursive: true, force: true });
      for (const k of done.secretNames) await ctx.o.secrets?.delete({ owner: { kind: "plugin", pluginId: done.id }, name: k }).catch(() => false);
    }
    throw err;
  }
  return out.map(({ secretNames: _, ...r }) => r);
}

async function wrapMcpUrl(ctx: WrapCtx): Promise<WrapResult> {
  const url = httpUrl(ctx.o.value.trim());
  // Its name: the host, without a leading `mcp.` (`mcp.example.com` gives `mcp-example-com`).
  const name = new URL(url).hostname.replace(/^mcp\./, "");
  const { secretNames: _, ...r } = await installMcpPlugin(ctx, name, { type: "http", url }, {}, {}, "mcp-url");
  return r;
}

// ---- Claude Code plugin folders -----------------------------------------------------------------------------------

/** The `plugin.json` fields with no Clover point yet: they stay in the folder unused, and the OK names them. */
const CLAUDE_UNUSED_FIELDS: Readonly<Record<string, string>> = {
  outputStyles: "output styles", lspServers: "LSP servers", monitors: "monitors", workflows: "workflows", themes: "themes",
  dependencies: "dependencies", mods: "mods",
};
/** Folders with no Clover point yet. */
const CLAUDE_UNUSED_FOLDERS: Readonly<Record<string, string>> = { "output-styles": "output styles", bin: "bin/", monitors: "monitors", workflows: "workflows", themes: "themes" };

interface ClaudeOption {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  sensitive?: unknown;
  default?: unknown;
  required?: unknown;
  multiple?: unknown;
}

/** Whether a folder is a Claude Code plugin (§5.1): `.claude-plugin/plugin.json`, or no `clover.json` but a part where
 *  Claude Code looks for one. */
export function isClaudePluginFolder(root: string): boolean {
  if (existsFile(join(root, ".claude-plugin", "plugin.json"))) return true;
  if (existsFile(join(root, MANIFEST_FILE))) return false;
  return ["skills", "commands", "agents"].some((d) => existsDir(join(root, d))) || existsFile(join(root, "hooks", "hooks.json"));
}

/** `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${user_config.K}` in a server's fields, as Clover writes them.
 *  A sensitive option is a secret, which only `env` and `headers` may hold: elsewhere it can't be written, and is
 *  recorded as unused. */
function claudeFields(text: string, where: "secret-ok" | "plain", options: Readonly<Record<string, ClaudeOption>>, unused: string[]): string {
  return text.replace(/\$\{([^}]*)\}/g, (_m, body: string) => {
    if (body === "CLAUDE_PLUGIN_ROOT") return "${plugin}";
    if (body === "CLAUDE_PLUGIN_DATA") return "${data}";
    const opt = /^user_config\.([A-Za-z0-9_.-]+)$/.exec(body);
    if (opt === null) throw new Unsupported(body);
    const k = opt[1]!;
    if (options[k]?.sensitive === true) {
      if (where === "secret-ok") return `\${secret:${k}}`;
      unused.push(`the sensitive option ${k} outside a server's env or headers`);
      return "";
    }
    return `\${setting:${k}}`;
  });
}

/** A `${…}` Clover can't fill: Claude Code reads it from the user's environment, which a plugin's process doesn't get. */
class Unsupported extends Error {}

/** A Claude hook's command for `sh -c`: Claude Code's own variables as Clover's (textually, as Claude Code does), and a
 *  shell variable's braces (`${HOME}`) as `$HOME` (with `""` when a name character follows), since a manifest's `${`
 *  is Clover's. A shell expansion with more than a name (`${X:-y}`) can't be written: `Unsupported`. */
function claudeHookCommand(command: string, options: Readonly<Record<string, ClaudeOption>>, unused: string[]): string {
  return command.replace(/\$\{([^}]*)\}/g, (m, body: string, at: number) => {
    if (body === "CLAUDE_PLUGIN_ROOT" || body === "CLAUDE_PLUGIN_DATA" || body.startsWith("user_config.")) return claudeFields(m, "plain", options, unused);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body)) throw new Unsupported(body);
    return `$${body}${/[A-Za-z0-9_]/.test(command[at + m.length] ?? "") ? '""' : ""}`;
  });
}

const readJson = (file: string, rel: string): unknown => {
  const parsed = parseJsonc(readSourceFile(realpathSync(file), rel, WRAP_TEXT_MAX_BYTES).toString("utf8"));
  if (!parsed.ok) throw new ContractError("invalid", `${rel} isn't JSON: ${parsed.error.message}`);
  return parsed.value;
};

/** A path `plugin.json` names, inside the copied folder (whose files are all regular, links refused by the copy). */
function inside(staged: string, rel: string): string {
  const p = resolve(staged, rel);
  if (isAbsolute(rel) || (p !== staged && !p.startsWith(staged + sep))) throw new ContractError("invalid", `${JSON.stringify(rel.slice(0, 200))} in .claude-plugin/plugin.json leaves the plugin's folder`);
  return p;
}

async function wrapClaudePlugin(ctx: WrapCtx): Promise<WrapResult> {
  const root = sourceFolder(ctx.o.value, ctx.o.pluginsDir);
  if (existsFile(join(root, MANIFEST_FILE))) throw new ContractError("invalid", `${root} holds a ${MANIFEST_FILE}: it's a plugin already, so install it as a folder`);
  if (!isClaudePluginFolder(root)) throw new ContractError("invalid", `${root} isn't a Claude Code plugin folder (no .claude-plugin/plugin.json, skills/, commands/, agents/ or hooks/hooks.json)`);
  const pj = existsFile(join(root, ".claude-plugin", "plugin.json")) ? readJson(join(root, ".claude-plugin", "plugin.json"), ".claude-plugin/plugin.json") : {};
  if (!isObject(pj)) throw new ContractError("invalid", ".claude-plugin/plugin.json isn't a JSON object");
  const unused: string[] = [];
  for (const [field, label] of Object.entries(CLAUDE_UNUSED_FIELDS)) if (pj[field] !== undefined) unused.push(label);
  for (const [dir, label] of Object.entries(CLAUDE_UNUSED_FOLDERS)) if (existsDir(join(root, dir)) && !unused.includes(label)) unused.push(label);

  const name = typeof pj.name === "string" && pj.name !== "" ? pj.name : basename(root);
  const { id, namespace } = wrapperId("claude" satisfies WrapperKind, name, ctx.taken);
  ctx.chosen.add(id);

  // userConfig → settings (`directory` and `file` as strings; a sensitive one a secret; `multiple` unused).
  const options: Record<string, ClaudeOption> = isObject(pj.userConfig) ? (pj.userConfig as Record<string, ClaudeOption>) : {};
  const settings: Record<string, unknown> = {};
  for (const [k, opt] of Object.entries(options)) {
    if (!KEY_RE.test(k) || !isObject(opt)) {
      unused.push(`the option ${k}`);
      continue;
    }
    if (opt.multiple === true) unused.push(`the option ${k}'s several values (it keeps one)`);
    const type = opt.sensitive === true ? "secret" : opt.type === "number" ? "number" : opt.type === "boolean" ? "boolean" : "string";
    settings[k] = {
      type,
      title: typeof opt.title === "string" && opt.title !== "" ? opt.title : k,
      ...(typeof opt.description === "string" ? { description: opt.description } : {}),
      ...(opt.default !== undefined && opt.sensitive !== true ? { default: opt.default } : {}),
      ...(opt.required === true ? { required: true } : {}),
    };
  }

  const stage = newStage(ctx.o.stagingDir);
  try {
    const staged = join(stage.dir, id);
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    copyTreeInto(root, staged);
    const contributes: Record<string, unknown> = {};

    // Skills, and each command as a generated skill folder.
    const skills: string[] = [];
    if (existsDir(join(staged, "skills"))) skills.push("skills/*");
    const commands = existsDir(join(staged, "commands")) ? readdirSync(join(staged, "commands")).filter((f) => f.toLowerCase().endsWith(".md")).sort() : [];
    for (const file of commands) {
      const body = readSourceFile(join(staged, "commands", file), `commands/${file}`, WRAP_TEXT_MAX_BYTES).toString("utf8");
      const fm = frontMatter(body);
      const cmd = cleanName(basename(file, extname(file)), 60) || "command";
      const dir = join(staged, "command-skills", cmd);
      mkdirSync(dir, { recursive: true });
      const text = body.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/, "");
      const description = fm.description ?? text.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? cmd;
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${cmd}\ndescription: ${JSON.stringify(description.slice(0, DESCRIPTION_MAX))}\n---\n${text}`, { flag: "wx" });
    }
    if (commands.length > 0) skills.push("command-skills/*");
    if (skills.length > 0) contributes.skills = skills;

    // Agents, as they are.
    const agents = existsDir(join(staged, "agents")) ? readdirSync(join(staged, "agents")).filter((f) => f.toLowerCase().endsWith(".md")).sort().slice(0, 256) : [];
    if (agents.length > 0) contributes.agents = agents.map((f) => `agents/${f}`);

    // MCP servers: `.mcp.json` beside it, or `plugin.json`'s own `mcpServers` (an object, or a file's path).
    let mcpRaw: unknown;
    if (isObject(pj.mcpServers)) mcpRaw = { mcpServers: pj.mcpServers };
    else if (typeof pj.mcpServers === "string") mcpRaw = readJson(inside(staged, pj.mcpServers), pj.mcpServers);
    else if (existsFile(join(staged, ".mcp.json"))) mcpRaw = readJson(join(staged, ".mcp.json"), ".mcp.json");
    let code = false;
    if (mcpRaw !== undefined) {
      const servers = mcpServersOf(JSON.stringify(mcpRaw));
      const out: Record<string, unknown> = {};
      const keys = new Set<string>();
      for (const [serverName, raw] of Object.entries(servers)) {
        let key = cleanName(serverName, 40) || "server";
        for (let n = 2; keys.has(key); n++) key = `${cleanName(serverName, 36) || "server"}-${n}`;
        try {
          if (isStdio(raw)) {
            const env = { ...(stringMap(raw.env) ?? {}) };
            for (const [k, v] of Object.entries(env)) env[k] = claudeFields(v, "secret-ok", options, unused);
            out[key] = {
              type: "stdio",
              command: claudeFields(String(raw.command), "plain", options, unused),
              ...(strings(raw.args) !== undefined ? { args: strings(raw.args)!.map((a) => claudeFields(a, "plain", options, unused)) } : {}),
              env: { ...env, CLAUDE_PLUGIN_ROOT: "${plugin}", CLAUDE_PLUGIN_DATA: "${data}" },
            };
            code = true;
          } else {
            const headers = stringMap(raw.headers);
            const url = claudeFields(String(raw.url), "plain", options, unused);
            out[key] = {
              type: "http",
              // A URL built from a setting is checked once it's filled; a plain one now.
              url: url.includes("${") ? (/^https?:\/\//.test(url) ? url : httpUrl(url)) : httpUrl(url),
              ...(headers !== undefined ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, claudeFields(v, "secret-ok", options, unused)])) } : {}),
            };
          }
          keys.add(key);
        } catch (err) {
          if (!(err instanceof Unsupported)) throw err;
          unused.push(`the server ${serverName}, which reads \${${err.message.slice(0, 60)}} from your environment`);
        }
      }
      if (Object.keys(out).length > 0)       contributes.mcpServers = out;
    }

    // Hooks: Claude-style (`hooks/hooks.json`, or `plugin.json`'s `hooks`), under `sh` with Claude Code's variables.
    let hooksRaw: unknown;
    if (isObject(pj.hooks)) hooksRaw = pj.hooks;
    else if (typeof pj.hooks === "string") hooksRaw = readJson(inside(staged, pj.hooks), pj.hooks);
    else if (existsFile(join(staged, "hooks", "hooks.json"))) hooksRaw = readJson(join(staged, "hooks", "hooks.json"), "hooks/hooks.json");
    if (hooksRaw !== undefined) {
      const hooks = claudeHooks(hooksRaw, options, unused);
      if (hooks.length > 0) {
        contributes.hooks = hooks;
        code = true;
      }
    }

    writeFileSync(join(staged, MANIFEST_FILE), manifestFor({
      id, name,
      ...(typeof pj.description === "string" ? { description: pj.description } : {}),
      extra: {
        namespace,
        ...(typeof pj.version === "string" && SemverVersion.safeParse(pj.version).success ? { version: pj.version } : {}),
        ...(code ? { engines: { clover: `^${PLUGIN_API_VERSION}` } } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      },
      generated: { from: "claude-plugin", by: ctx.o.by, at: ctx.at },
      contributes,
    }));
    const done = await installStaged(staged, ctx.o);
    return { ...done, unused: [...new Set(unused)].slice(0, 64).map((u) => u.slice(0, 200)), ...(code ? { network: "any" as const } : {}) };
  } finally {
    stage.done();
  }
}

/** Claude-style hooks (`{ hooks: { <Event>: [{ matcher?, hooks: [{ type, command, timeout? }] }] } }`) as Clover's:
 *  each `command` hook under `sh -c`, Claude Code's `${…}` in it written as Clover's (`claudeHookCommand`), with
 *  `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and each plain option's `CLAUDE_PLUGIN_OPTION_<KEY>` exported from its
 *  arguments (each its own argument, so no path or value needs quoting), its own timeout kept (600 s when unset). An event with no Clover counterpart, a hook that isn't a `command`, and a
 *  matcher that's a regular expression rather than tool names stay unused. */
export function claudeHooks(raw: unknown, options: Readonly<Record<string, ClaudeOption>>, unused: string[]): Record<string, unknown>[] {
  const map = isObject(raw) && isObject(raw.hooks) ? raw.hooks : raw;
  if (!isObject(map)) return [];
  const plain = Object.entries(options).filter(([k, opt]) => isObject(opt) && opt.sensitive !== true && KEY_RE.test(k)).map(([k]) => k);
  for (const k of Object.keys(options)) if (options[k]?.sensitive === true) unused.push(`the sensitive option ${k} in hooks (a hook's arguments carry no secret)`);
  const exports = ["CLAUDE_PLUGIN_ROOT=\"$1\"", "CLAUDE_PLUGIN_DATA=\"$2\"", ...plain.map((k, i) => `CLAUDE_PLUGIN_OPTION_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}="$${i + 3}"`)];
  const out: Record<string, unknown>[] = [];
  let n = 0;
  for (const [event, groups] of Object.entries(map)) {
    const on = CLAUDE_HOOK_EVENTS[event];
    if (on === undefined) {
      unused.push(`the hook event ${event}`);
      continue;
    }
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g.hooks)) continue;
      const matcher = typeof g.matcher === "string" ? g.matcher.trim() : "";
      let tools: string[] | undefined;
      if (matcher !== "" && matcher !== "*") {
        // Tool names alone (`Write|Edit`); anything else is a regular expression, which a Clover pattern isn't.
        if (!/^[A-Za-z0-9_-]+(\|[A-Za-z0-9_-]+)*$/.test(matcher)) {
          unused.push(`a ${event} hook whose matcher is a regular expression (${matcher.slice(0, 80)})`);
          continue;
        }
        tools = matcher.split("|");
      }
      for (const h of g.hooks) {
        if (!isObject(h)) continue;
        if (h.type !== "command" || typeof h.command !== "string" || h.command === "") {
          unused.push(`a ${event} hook of type ${typeof h.type === "string" ? h.type : "unknown"}`);
          continue;
        }
        if (n >= 256) break;
        let command: string;
        try {
          command = claudeHookCommand(h.command, options, unused);
        } catch (err) {
          if (!(err instanceof Unsupported)) throw err;
          unused.push(`a ${event} hook that reads \${${err.message.slice(0, 60)}}`);
          continue;
        }
        const script = `export ${exports.join(" ")}; ${command}`;
        const timeout = typeof h.timeout === "number" && h.timeout > 0 ? Math.min(600_000, Math.round(h.timeout * 1000)) : CLAUDE_HOOK_DEFAULT_TIMEOUT_MS;
        out.push({
          id: `hook-${++n}`,
          on: [on],
          ...(tools !== undefined && (on === "tool.before" || on === "tool.after") ? { tools } : {}),
          command: "sh",
          args: ["-c", script, "sh", "${plugin}", "${data}", ...plain.map((k) => `\${setting:${k}}`)],
          timeoutMs: timeout,
        });
      }
    }
  }
  return out;
}

