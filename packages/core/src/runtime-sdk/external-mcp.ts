// Fix wave (whole-branch review row 7): Clover's CONFIGURED MCP servers, forwarded to a Clover child.
//
// The sources (WS-21: see the paragraph below for the current three): originally the user's
// `settings.mcpServers` (source "user") and a TRUSTED project's MCP file (source "project", trust-gated
// exactly as `McpManager.ensureProject` gates it — an untrusted directory contributes nothing, and
// nothing is read from it). The repo-root `.mcp.json` named in the history below is no longer read. Daemon settings surface
// batch 3 (item 3b) widened the USER side (`settings.mcpServers`) to accept the HTTP/SSE shapes both
// SDKs' `Options.mcpServers` support; a later parity fix (controller-directed) widened the PROJECT
// side to match — `.mcp.json` now accepts stdio/http/sse too, PER ENTRY (`parseProjectMcpServers`,
// `agent/mcp/project-file.ts`), same as claude's own `.mcp.json` reader accepts (claude Code's own
// file format). Forwarded to both legs UNDER THE SAME KEY the manager registers them under, so the
// child names their tools `mcp__<key>__<tool>` — the names `tool.list` and the Mac's tool rows
// already carry.
//
// THE CHILD SPAWNS/CONNECTS ITS OWN COPY. The daemon's `McpManager` only PROBES servers for `mcp.list`
// (WS-24: connect, list, close; WS-25: http/sse too, lazily, through the runtime's `/mcp-client`) — it
// keeps nothing running a child could reach, so each session's child starts/connects the
// configured servers itself from these configs. One extra process/connection per configured server
// per live session — recorded in the fix-wave report as the cost of this door for stdio; unchanged
// for HTTP/SSE, which were never proxied through the daemon to begin with.
//
// WS-21 (spec §3.4.5, §4.4): THREE sources, claude's scopes — the LOCAL servers for this project
// (`sdk/.clover.json` `projects[<root>].mcpServers`, the caller's `localMcpServers`), a TRUSTED project's
// `<root>/.clover/mcp.json` (the repo-root `.mcp.json` is no longer read), and the USER servers
// (`sdk/.clover.json` `mcpServers`). PRECEDENCE is claude's: local > project > user. None may shadow a
// daemon-owned `clover__<key>` server — that is `assertNoCapabilityCollision`'s job at the driver, which
// refuses the SESSION (typed) rather than choose. (This is the pre-run-home path: once the router applies
// run homes, the run folder's `.clover.json` carries the same fold and the daemon hands over none.)
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@waifucave/clover-agent-sdk";
import type { McpServerSettingsEntry, Settings } from "../settings";
import { extractRawMcpServers, parseProjectMcpServers, projectMcpConfigPath } from "../agent/mcp/project-file";
import { projectScopeRootFor, projectScopeTrusted } from "./run-home-input";
import { guardedMcpServer, type PluginRunGuard } from "../registry/plugin-run";
import type { ProjectAccess } from "../registry/plugin-fence";
import { interpolate, type InterpolationValues } from "@waifucave/clover-plugin-sdk";
import { PluginSecretFiles } from "../registry/secret-files";

// The project `.mcp.json` schema/parser now lives in `../agent/mcp/project-file` — shared with
// `agent/mcp/manager.ts`'s own reader and the CLI's `mcp add/remove --scope project`/`mcp get`
// (`mcp-cli.ts`), which previously would have been a THIRD hand-copied duplicate of this exact
// shape (this file and the manager each had their own before). `parseProjectMcpServers` is the
// PARITY FIX (controller-directed): validates the project's `mcpServers` map PER ENTRY against
// `ProjectMcpEntrySchema` — the stdio/http/sse shapes `settings.mcpServers` accepts but WITHOUT the
// settings write door's credential-header refusal, so a project entry's headers reach the child
// verbatim as they do in claude (never swap in `McpServerSettingsEntry` here) — instead of the old one-shot
// `ProjectMcpConfig.parse(...)` that failed the WHOLE map (and so contributed NOTHING to the
// session) the moment any single entry — an http/sse one, most commonly — didn't fit.

export interface ConfiguredMcpInput {
  /** THE LIVE settings (a getter's answer, never a boot snapshot) — read for `mcp.disabled` only. */
  settings: Settings | null | undefined;
  /** WS-21: the USER-scope servers — `sdk/.clover.json` `mcpServers` (`sdkUserMcpServers`), read live
   *  by the caller. They moved out of `settings.json`; absent ⇒ none. */
  userMcpServers?: Readonly<Record<string, McpServerSettingsEntry>>;
  /** WS-21: the LOCAL-scope servers for this session's project root (`sdkLocalMcpServers(home, root)`),
   *  read live by the caller. Not trust-gated: they are the user's own file, like the user scope. */
  localMcpServers?: Readonly<Record<string, McpServerSettingsEntry>>;
  /** The session's cwd. WS-21: the project file is `<projectScopeRootFor(cwd)>/.clover/mcp.json` — the
   *  project ROOT (a linked worktree's own top, R.3 residual), where the run home's builder reads it too. */
  cwd: string | undefined;
  /** `TrustStore.isTrusted` — an untrusted cwd contributes no project servers and is never read. */
  trusted: (dir: string) => boolean;
  /** Test seam: how `<cwd>/.mcp.json` is read. */
  readFile?: (path: string) => string;
  /** One log line per project-scope entry this function could not forward to the child — named,
   *  with why (`parseProjectMcpServers`' own per-branch message). Optional: a caller with no logger
   *  (every existing test) simply gets silence, matching this function's own pre-existing "a
   *  malformed file contributes nothing, quietly" posture for the file-level failure modes. */
  log?: (message: string) => void;
}

type VersionNegotiation = NonNullable<McpServerSettingsEntry["versionNegotiation"]>;

/** WS-23: a server's own `versionNegotiation`, copied (never shared — the `pin` form is an object)
 *  and forwarded verbatim; absent stays absent, so the runtime's per-transport default applies. */
function negotiation(v: VersionNegotiation | undefined): { versionNegotiation?: VersionNegotiation } {
  if (v === undefined) return {};
  return { versionNegotiation: typeof v === "string" ? v : { pin: v.pin } };
}

function stdio(cfg: { command: string; args?: string[]; env?: Record<string, string>; versionNegotiation?: VersionNegotiation }): McpServerConfig {
  return {
    type: "stdio",
    command: cfg.command,
    ...(cfg.args === undefined ? {} : { args: [...cfg.args] }),
    ...(cfg.env === undefined ? {} : { env: { ...cfg.env } }),
    ...negotiation(cfg.versionNegotiation),
  };
}

/** A plugin's own stdio MCP server as the runtime's config (#234's check 4): through `guardedMcpServer`, so a Bun one
 *  runs on Clover's Bun with the load guard held to `pluginRoot`. The only door a plugin-sourced stdio entry takes
 *  into a runtime's config: the daemon's `entries("mcpServers")` wiring uses it. The user's own servers (the three
 *  scopes below) aren't a plugin's, and take `stdio` as they are. */
export function pluginStdioMcpServer(
  entry: { command: string; args?: string[]; env?: Record<string, string>; versionNegotiation?: VersionNegotiation },
  pluginRoot: string,
  guard: PluginRunGuard,
  pluginId?: string,
  /** The session's project folders, and whether the plugin holds `project.write` (readable always, writable with it). */
  project?: ProjectAccess,
): McpServerConfig {
  return stdio(guardedMcpServer(entry, pluginRoot, guard, pluginId, project));
}

/** `settings.mcpServers`' own entry shape (already `type`-discriminated by the schema, batch 3 item
 *  3b) straight onto the matching SDK config — no translation beyond copying the fields the SDK
 *  type actually has (`tools`/`timeout`/`alwaysLoad` are NOT in Clover's settings grammar today, so
 *  they are never set here; the SDK treats an absent optional field the same as one explicitly
 *  omitted). WS-23: `versionNegotiation` IS in the grammar, and rides every transport. */
function toMcpServerConfig(entry: McpServerSettingsEntry): McpServerConfig {
  if (entry.type === "stdio") return stdio(entry);
  return {
    type: entry.type,
    url: entry.url,
    ...(entry.headers === undefined ? {} : { headers: { ...entry.headers } }),
    ...negotiation(entry.versionNegotiation),
    // WS-25: the server's sign-in settings, forwarded (a copy, never shared) so the child's session
    // provider finds a pre-registered client, its scopes and its metadata URL. Already validated by the
    // entry schema (`validateMcpOAuthConfig`); it never carries a secret.
    ...(entry.oauth === undefined ? {} : { oauth: structuredClone(entry.oauth) as NonNullable<Extract<McpServerConfig, { type: "http" }>["oauth"]> }),
  };
}

/** The `Options.mcpServers` entries Clover's configuration contributes to ONE session, keyed as the
 *  daemon's registry keys them. Never throws: a missing `.mcp.json`, or one that isn't even
 *  shaped like a project MCP config, contributes nothing (the manager's own "record none" posture)
 *  — but a project file that IS shaped right contributes every entry that validates, PER ENTRY
 *  (`parseProjectMcpServers`): one bad or differently-shaped sibling entry no longer takes the rest
 *  down with it (the parity fix this function's own header describes). Batch 3 (item 3a): a server
 *  named in `settings.mcp.disabled` is withheld entirely — neither leg ever sees it, the same
 *  "absent, not a present-but-inert entry" posture every other disable switch in this codebase
 *  takes. */
export function configuredMcpServersFor(input: ConfiguredMcpInput): Record<string, McpServerConfig> {
  const disabled = new Set(input.settings?.mcp?.disabled ?? []);
  const project: Record<string, McpServerConfig> = {};
  if (input.cwd !== undefined && input.cwd !== "") {
    let dir = input.cwd;
    try { dir = realpathSync(dir); } catch { /* the manager falls back to the given path too */ }
    // R.3 residual: the project scope's root and trust (`projectScopeRootFor`/`projectScopeTrusted`).
    if (projectScopeTrusted(dir, { isTrusted: input.trusted })) {
      const root = projectScopeRootFor(dir);
      let extracted: ReturnType<typeof extractRawMcpServers>;
      try {
        const raw = (input.readFile ?? ((p: string) => readFileSync(p, "utf8")))(projectMcpConfigPath(root));
        extracted = extractRawMcpServers(JSON.parse(raw));
      } catch {
        extracted = undefined; // missing file, unreadable, or malformed JSON → nothing from the project, unchanged
      }
      if (extracted) {
        const { servers, skipped } = parseProjectMcpServers(extracted.servers);
        for (const { name, reason } of skipped) input.log?.(`mcp: project server '${name}' (${root}) skipped — ${reason}`);
        // THE CHILD speaks stdio/http/sse directly (this file's own header) — every valid entry,
        // whichever transport, is forwarded via the SAME `toMcpServerConfig` a user-scope entry
        // goes through below.
        for (const [name, entry] of Object.entries(servers)) project[name] = toMcpServerConfig(entry);
      }
    }
  }
  const out: Record<string, McpServerConfig> = {};
  // claude's precedence, lowest first so a later tier overwrites: user < project < local.
  for (const [name, sc] of Object.entries(input.userMcpServers ?? {})) out[name] = toMcpServerConfig(sc);
  Object.assign(out, project);
  for (const [name, sc] of Object.entries(input.localMcpServers ?? {})) out[name] = toMcpServerConfig(sc);
  for (const name of disabled) delete out[name];
  return out;
}

/**
 * WS-25 (review r1 (i)): the http/sse MCP servers the ENABLED plugins ship, read the way the Clover runtime's
 * own plugin loader reads them (`runtime/src/plugins/loader.ts`: the first of `<root>/.mcp.json` and
 * `<root>/mcp.json`, a `{ mcpServers }` wrapper or a bare name→config map, then the manifest's own
 * `mcpServers`, which wins) and named as it names them (the raw key). Only the URL-bearing servers are
 * returned — this is for the MCP sign-in allowlist, which keys a sign-in by its server URL; the child loads
 * the plugins itself from the run folder. First plugin wins a name. Never throws: an unreadable plugin
 * contributes nothing.
 */
export function pluginMcpServersFor(pluginRoots: readonly string[], readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const parse = (path: string): unknown => {
    try { return JSON.parse(readFile(path)); } catch { return undefined; }
  };
  for (const root of pluginRoots) {
    const servers: Record<string, unknown> = {};
    for (const file of [".mcp.json", "mcp.json"]) {
      const parsed = parse(join(root, file));
      if (!isObject(parsed)) continue;
      const block = isObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
      for (const [name, config] of Object.entries(block)) servers[name] ??= config;
      break;
    }
    const manifest = parse(join(root, ".claude-plugin", "plugin.json")) ?? parse(join(root, "plugin.json"));
    if (isObject(manifest) && isObject(manifest.mcpServers)) Object.assign(servers, manifest.mcpServers);
    for (const [name, config] of Object.entries(servers)) {
      if (out[name] !== undefined || !isObject(config)) continue;
      const type = config.type;
      if ((type === "http" || type === "sse") && typeof config.url === "string") out[name] = { type, url: config.url };
    }
  }
  return out;
}

/** What a plugin's stdio server's `${…}` are filled from (spec §5.9): its folder, its data folder, its settings and its
 *  own secrets; `${secretFile:k}` becomes the path of a 0600 file holding secret `k` (`PluginSecretFiles`), in a
 *  folder of this instance's own, which `release` removes. The launcher calls `release` on every stop path (an exit,
 *  a crash, a stop, a failed start). */
export interface PluginServerValues {
  pluginId: string;
  /** The server's name in the manifest's `mcpServers`. */
  server: string;
  dataDir: string;
  setting(key: string): string | undefined;
  secret(key: string): string | undefined;
  secretFiles: PluginSecretFiles;
}

/** `pluginStdioMcpServer` with the entry's placeholders filled; a missing setting or secret throws (a server never
 *  starts half-configured), and any secret file written on the way is removed again. */
export function resolvedPluginStdioMcpServer(
  entry: { command: string; args?: string[]; env?: Record<string, string>; versionNegotiation?: VersionNegotiation },
  pluginRoot: string,
  guard: PluginRunGuard,
  values: PluginServerValues,
): { config: McpServerConfig; release(): void } {
  // This instance's own folder (`PluginSecretFiles.instance`): its `release` never takes another running one's keys.
  const instance = PluginSecretFiles.instance();
  const release = () => values.secretFiles.release(values.pluginId, values.server, instance);
  const fill: InterpolationValues = {
    plugin: pluginRoot, data: values.dataDir, setting: values.setting, secret: values.secret,
    secretFile: (key) => {
      const v = values.secret(key);
      return v === undefined ? undefined : values.secretFiles.write(values.pluginId, values.server, key, v, instance);
    },
  };
  try {
    const resolved = {
      ...entry,
      command: interpolate(entry.command, fill),
      ...(entry.args !== undefined ? { args: entry.args.map((a) => interpolate(a, fill)) } : {}),
      ...(entry.env !== undefined ? { env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, interpolate(v, fill)])) } : {}),
    };
    return { config: pluginStdioMcpServer(resolved, pluginRoot, guard, values.pluginId), release };
  } catch (err) {
    release();
    throw err;
  }
}
