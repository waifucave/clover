// The daemon's one plugin host (B-M2; spec §5.2, §5.4): a `CorePluginHost` over the plugin registry, its processes
// launched on the plugin Bun with Clover's load guard, and the plugin API's router served to them.
//
// * Processes: one per key, `clover` (the bundled `clover` tree), `shared` (every other Bun plugin) and `own:<id>` (a
//   plugin that asks for its own), started when a plugin first needs one and started again after it exits. A Node
//   plugin's process isn't served yet: starting one fails with why, under the crash rules.
// * A process gets only a small environment (the path, home, temp folder and locale), never the daemon's: its workers
//   copy theirs from it.
// * The router: the process check (S4) and the capability gate, in front of the areas served here (points, synced
//   storage, settings, commands and, with an approval broker, confirm cards).
// * Logs: a worker's console lines go to `<home>/logs/plugins/<id>.log` (rate-limited, rotated at a cap:
//   `pluginLogWriter`), a process's own output to the daemon's log.
// * `pluginSecrets`: one plugin's own items, read-only, for the model plugins (lane A): `forPlugin(id).get(name)`
//   reads `{ owner: { kind: "plugin", pluginId: id }, name }` (where plugin settings put their `secret` fields) and
//   nothing else, so no reference to the core's, the user's or another plugin's items passes through (#322's review, S3).
import { wrapperOpensNetwork } from "../registry/wrap";
import { appendFileSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import { fencedCommand, fencedSpawn, pluginFenceAvailable, type PluginFenceInput } from "../registry/plugin-fence";
import { stagedBundledDir } from "../registry/bundled-stage";
import { API_CALLS, reachesPublicNetwork, type ApiCallPath } from "@waifucave/clover-plugin-sdk";
import { hostAllowed, hostRules, startPluginProxy, type PluginProxy } from "./net-proxy";
import { dirname, join, sep } from "node:path";
import type { HostProcess } from "@waifucave/clover-protocol";
import { SystemClock } from "../clock/system-clock";
import { commandOwner, commandsApi } from "../commands/views";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import { guardApiRouter, type ApiRouter, type InstallRecord, type PluginHost } from "../contracts/plugin-host";
import type { PluginRecord, PluginRegistry } from "../contracts/plugin-registry";
import type { SecretStore, SecretValue } from "../contracts/secret-store";
import { areasParts, type AreaServices } from "./api/areas";
import { confirmApi } from "./api/confirm";
import { pointsApi } from "./api/points";
import { createApiRouter, handlerOf, type ApiHandlers } from "./api/router";
import { filePluginSettings, PluginSettings, settingsApi } from "./api/settings";
import { fileSyncedStores, storageApi, SyncedStores } from "./api/storage";
import { assetPath, pluginDataFolder, pluginPath } from "./paths";
import { CorePluginHost, type HostedRecord } from "./core-host";
import type { VerifiedFiles } from "./runtime";
import { hostProcessLaunch, spawnHostProcess, type HostProcessLaunch } from "./launch";
import type { RpcPeer } from "./link";

/** The environment variables a plugin-host process gets from the daemon's. */
const HOST_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"];

/** B's gate's network rule for `net.fetch`: a host on the plugin's GRANTED `network:` list, read as its proxy reads it
 *  (`hostRules`/`hostAllowed`, net-proxy.ts: no port means 443 and 80), or, when the granted set holds `network:public`
 *  (bundled only), any host on 443 or 80 (that fetch is keyless, through Clover's web safeguards:
 *  runtime-sdk/model-plugins/public-fetch.ts, which takes https on the default port only). `port` is the URL's, or its
 *  scheme's (the router's `targetOf`). */
export function pluginNetworkAllowed(caps: readonly string[], host: string, port?: number): boolean {
  if (port === undefined) return false;
  return hostAllowed(hostRules(caps), host, port) || (reachesPublicNetwork(caps) && (port === 443 || port === 80));
}

export interface DaemonPluginHost {
  /** The one host: processes `clover`, `shared` and `own:<id>`, with the router and API channel inside. */
  readonly host: PluginHost;
  /** The registry it serves. */
  readonly registry: PluginRegistry;
  /** One plugin's own items, read-only: the owner is fixed as `{ kind: "plugin", pluginId }`. */
  readonly pluginSecrets: PluginSecrets;
  /** A plugin tree's network proxy, for a hook or MCP server of one of its plugins (2g); undefined once closed. */
  proxyFor(pluginId: string): PluginProxy | undefined;
  /** The user's side of plugin settings (`plugin.settings.get`/`set`). */
  readonly settings: PluginSettings;
  /** The capability gate without the process check, for a component's call (`plugin.layer.api`, process `ui`). */
  readonly gate: ApiRouter;
  /** Serves more of the API after start (a core area that starts later, like the model plugins' keyed `net.fetch` and
   *  `secrets.get`). The router's gate (the call exists there, the plugin is on and running, its OK granted the call's
   *  capability) runs before any of them. A path another handler already serves is refused, never silently replaced.
   *  The result takes them away again. */
  addApiHandlers(handlers: ApiHandlers): () => void;
  /** Adds lines to a plugin's own log (`<home>/logs/plugins`), which its Settings page shows. */
  pluginLog(pluginId: string, lines: string[]): void;
  /** Stops every plugin and ends the processes. */
  close(): Promise<void>;
}

/** A plugin's own secrets, read-only, by name: the owner is the plugin the handle was made for, never a reference. */
export interface PluginSecrets {
  forPlugin(pluginId: string): { get(name: string): Promise<SecretValue | null> };
}

/** `PluginSecrets` over the contract store. */
export function pluginSecretsOf(store: Pick<SecretStore, "get">): PluginSecrets {
  return {
    forPlugin(pluginId) {
      if (typeof pluginId !== "string" || pluginId === "") throw new ContractError("invalid", "a plugin's secrets need its id");
      const owner = Object.freeze({ kind: "plugin" as const, pluginId });
      return Object.freeze({
        get: (name: string) => {
          if (typeof name !== "string" || name === "") return Promise.reject(new ContractError("invalid", `${pluginId}'s secret needs a name`));
          return store.get({ owner, name });
        },
      });
    },
  };
}

export interface StartPluginHostOptions {
  /** The Clover home: `plugin-data/`, `settings/plugins/`, `settings/plugin-stores/`, `logs/plugins/`, `run/`. */
  home: string;
  computer: string;
  registry: PluginRegistry;
  /** The contract secret store (lane C's). */
  secrets: SecretStore;
  /** For `confirm` cards; absent, they're refused as not served. */
  approvals?: Pick<ApprovalBroker, "request">;
  /** The URL a component or host fetches a plugin's file from (lane E's asset server). */
  assetUrl?: (pluginId: string, path: string) => string;
  /** The daemon's log, for a process's own output. */
  log?: (line: string) => void;
  /** The other lanes' services the API's areas run on (`conversation`, `bots`, `computers`, `devices`, `files`,
   *  `terminal`), each read when a call arrives. */
  areas?: AreaServices;
  /** Sends a core event to the app (a host half's `ui.send` becomes `plugin_ui_message`). */
  emit?: (event: { type: string; [key: string]: unknown }) => void;
  clock?: Clock;
  /** The bundled plugins' files as staging verified them (`stageBundledPlugins`' `digests`): a bundled plugin's entry
   *  runs only from bytes matching its digest, and not at all without one. */
  bundledDigests?: ReadonlyMap<string, string>;
  /** False runs plugin processes unfenced (tests of what the fence doesn't cover). Default: fenced where the OS has one. */
  fence?: false;
  /** Test seam: how the proxies open their upstream connections (default `Bun.connect`). */
  netConnect?: typeof Bun.connect;
  /** Test seam: how the proxies resolve a listed name (default: the system's resolver). */
  netResolve?: (host: string) => Promise<string[]>;
  /** The user's home the fence denies (default: `os.homedir()`; tests pass a temp one). */
  userHome?: string;
  /** Test seams: the launch (default: the plugin Bun with the guard) and the environment it starts from. */
  launch?: HostProcessLaunch | (() => Promise<HostProcessLaunch>);
  env?: Readonly<Record<string, string | undefined>>;
}

/** `ui.send`'s limits: the serialized value's size, and messages per plugin per second. */
export const UI_SEND_MAX_BYTES = 64 * 1024;
export const UI_SEND_PER_SECOND = 50;

/** Where a plugin's files are served from until lane E names it: the layer of its top-level plugin. */
export function defaultAssetUrl(pluginId: string, encodedPath: string): string {
  // Given encoded (`assetPath`'s form); anything that isn't exactly that form is refused.
  let decoded: string | undefined;
  try {
    decoded = encodedPath.split("/").map((p) => decodeURIComponent(p)).join("/");
  } catch {
    decoded = undefined;
  }
  const safe = decoded === undefined ? undefined : assetPath(decoded);
  if (safe === undefined || safe !== encodedPath) throw new ContractError("invalid", `${JSON.stringify(encodedPath.slice(0, 200))} isn't a path inside ${pluginId}'s folder`);
  const top = pluginId.split("/")[0]!;
  const rest = pluginId.includes("/") ? `${pluginId.slice(top.length + 1)}/` : "";
  return `clover-plugin://${top}/${rest}${safe}`;
}

/** A plugin's log file's cap: past it, the file moves to `<id>.log.1` (replacing the one before) and a new one starts. */
export const PLUGIN_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Lines a plugin may log per `PLUGIN_LOG_WINDOW_MS`; the rest of that window's are counted, then noted once. */
export const PLUGIN_LOG_LINES_PER_WINDOW = 1_000;
export const PLUGIN_LOG_WINDOW_MS = 10_000;

/** Writes plugins' console lines to `<dir>/<id>.log`, rate-limited per plugin and rotated at `PLUGIN_LOG_MAX_BYTES`
 *  (#322's review): a noisy plugin can't fill the disk. */
export function pluginLogWriter(o: { dir: string; log: (line: string) => void; now: () => number; maxBytes?: number; perWindow?: number; windowMs?: number }): (pluginId: string, lines: readonly string[]) => void {
  const maxBytes = o.maxBytes ?? PLUGIN_LOG_MAX_BYTES;
  const perWindow = o.perWindow ?? PLUGIN_LOG_LINES_PER_WINDOW;
  const windowMs = o.windowMs ?? PLUGIN_LOG_WINDOW_MS;
  const windows = new Map<string, { start: number; written: number; dropped: number }>();
  return (pluginId, lines) => {
    const now = o.now();
    let w = windows.get(pluginId);
    const out: string[] = [];
    const stamp = new Date(now).toISOString();
    if (w === undefined || now - w.start >= windowMs) {
      if (w !== undefined && w.dropped > 0) out.push(`${stamp} [clover] ${w.dropped} more lines dropped (over ${perWindow} in ${windowMs / 1000} s)`);
      w = { start: now, written: 0, dropped: 0 };
      windows.set(pluginId, w);
    }
    for (const l of lines) {
      if (w.written < perWindow) {
        w.written++;
        out.push(`${stamp} ${l}`);
      } else w.dropped++;
    }
    if (out.length === 0) return;
    try {
      const file = `${pluginPath(o.dir, pluginId)}.log`;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
      if (size >= maxBytes) renameSync(file, `${file}.1`);
      appendFileSync(file, out.map((l) => `${l}\n`).join(""), { mode: 0o600 });
    } catch (err) {
      o.log(`[plugin-host] ${pluginId}'s log not written: ${(err as Error).message}`);
    }
  };
}

/** The registry states a plugin's host half may run in: OK'd and on (`running`, `waiting`), or stopped by the crash
 *  rules (`stopped`, which the user's restart starts again). Never `found` (no OK yet), `refused`, `invalid`, `off` or
 *  `blocked`. */
const STARTABLE = new Set(["running", "waiting", "stopped"]);

/** The core's record of a plugin it may start, from the registry's: undefined when it isn't installed, isn't OK'd and
 *  on, or has no host code. */
export function hostedRecordOf(registry: Pick<PluginRegistry, "get">, home: string, pluginId: string, verified?: ReadonlyMap<string, string>): HostedRecord | undefined {
  const r = registry.get(pluginId);
  const host = r?.manifest?.host;
  if (r === undefined || host === undefined || !r.enabled || !STARTABLE.has(r.state)) return undefined;
  const top = r.parent === undefined ? r : registry.get(r.parent);
  return {
    ...installRecordOf(r),
    folder: r.folder,
    root: top?.folder ?? r.folder,
    entry: host.entry,
    dataFolder: pluginDataFolder(home, pluginId),
    // A bundled plugin runs only the entry bytes its staging verified (S2); with no digest recorded, it doesn't run.
    ...(r.source === "bundled" ? { verified: verifiedTree(verified, top?.folder ?? r.folder) } : {}),
  };
}

function verifiedTree(verified: ReadonlyMap<string, string> | undefined, tree: string): VerifiedFiles {
  let root: string;
  try {
    root = realpathSync(tree);
  } catch {
    return { root: tree, files: {} };
  }
  const files: Record<string, string> = {};
  const prefix = root.endsWith(sep) ? root : root + sep;
  for (const [path, sha] of verified ?? []) if (path.startsWith(prefix)) files[path] = sha;
  return { root, files };
}

function installRecordOf(r: PluginRecord): InstallRecord {
  const host = r.manifest?.host;
  return {
    id: r.id,
    source: r.source,
    ...(host?.runtime !== undefined ? { runtime: host.runtime } : {}),
    ...(host?.process !== undefined ? { process: host.process } : {}),
  };
}

export async function startPluginHost(o: StartPluginHostOptions): Promise<DaemonPluginHost> {
  const log = o.log ?? (() => {});
  const base: Record<string, string> = {};
  const env = o.env ?? process.env;
  for (const k of HOST_ENV_KEYS) if (typeof env[k] === "string") base[k] = env[k]!;
  // A launch that can't be made (a compiled core without the host's bundles, until lane M ships them) fails every
  // plugin's start with why, under the crash rules, and leaves the rest of the daemon running.
  let launch: HostProcessLaunch | Error;
  try {
    launch = typeof o.launch === "function" ? await o.launch()
      : o.launch ?? await hostProcessLaunch({ runDir: join(o.home, "run", "plugin-host"), computer: o.computer, base, cloverHome: o.home });
  } catch (err) {
    launch = err instanceof Error ? err : new Error(String(err));
    log(`[plugin-host] plugin processes can't start: ${launch.message}`);
  }
  const processes = new Map<string, { peer: RpcPeer; kill(): void }>();
  // Each plugin tree's network proxy (2g): what its host process, hooks and MCP servers reach the network through, only
  // to the hosts the tree's OKs granted (`network:`), read at each connection. The clover tree's is the union of its
  // plugins' lists, as they share a process.
  const proxies = new Map<string, PluginProxy>();
  const proxyFor = (pluginId: string): PluginProxy | undefined => {
    if (closed) return undefined;
    const top = topPluginIdOf(pluginId);
    let p = proxies.get(top);
    if (p === undefined) {
      p = startPluginProxy({
        pluginId: top,
        capabilities: () => o.registry.list().filter((r) => topPluginIdOf(r.id) === top && r.enabled).flatMap((r) => r.granted),
        log,
        ...(o.netConnect !== undefined ? { connect: o.netConnect } : {}),
        ...(o.netResolve !== undefined ? { resolve: o.netResolve } : {}),
      });
      proxies.set(top, p);
    }
    return p;
  };
  // The fence for one process (2f): its plugin tree's folder (for `clover`, the verified copy of the bundled plugins),
  // its data folder and its own temp folder, with what every host process reads.
  const fencedLaunch = (l: HostProcessLaunch, key: string, top: string, dataOf: string): HostProcessLaunch => {
    if (o.fence === false || !pluginFenceAvailable()) return l;
    const tree = top === "clover" ? join(stagedBundledDir(o.home), "clover") : o.registry.get(top)?.folder;
    if (tree === undefined) return l;
    const tmp = join(o.home, "run", "plugin-tmp", key.replace(/[^a-z0-9-]/g, "_"));
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    // Its data folder: the tree's, or for a process of one plugin's own, that plugin's alone.
    const data = pluginPath(join(o.home, "plugin-data"), dataOf);
    mkdirSync(data, { recursive: true, mode: 0o700 });
    // The network: its tree's proxy; a wrapper with the grant on its install record, any host (the same fact the
    // stdio servers' and hooks' guard reads, `wrapperOpensNetwork`).
    const open = top !== "clover" && wrapperOpensNetwork(o.registry, top);
    const proxy = open ? undefined : proxyFor(top);
    const fence: PluginFenceInput = {
      cloverHome: o.home, userHome: o.userHome ?? homedir(),
      read: [tree, ...(l.reads ?? [])], write: [data, tmp], exec: "plugin", execs: [l.cmd[0]!], fork: false,
      network: open ? "open" : proxy !== undefined ? { proxyPort: proxy.port } : "none",
      ...(key === "clover" ? { noNativeCode: true } : {}),
    };
    const env = { ...l.env, ...(proxy?.env ?? {}), TMPDIR: tmp, TMP: tmp, TEMP: tmp };
    // Through the spawn trampoline, keeping its link (descriptor 3): its own TCC-responsible process (the controller's
    // ruling after #345). A launch that names no run files (a test's) is fenced without it.
    if (l.files === undefined) return { ...l, cmd: fencedCommand(l.cmd, fence), env };
    const spawned = fencedSpawn({ cmd: l.cmd, env, fence, files: l.files, fds: [0, 1, 2, 3] });
    return { ...l, cmd: spawned.cmd, env: spawned.env, ...(spawned.cwd !== undefined ? { cwd: spawned.cwd } : {}) };
  };
  let closed = false;

  const pluginLog = pluginLogWriter({ dir: join(o.home, "logs", "plugins"), log, now: () => Date.now() });

  const host = new CorePluginHost({
    clock: o.clock ?? new SystemClock(),
    computer: o.computer,
    record: (id) => hostedRecordOf(o.registry, o.home, id, o.bundledDigests),
    connect(process: HostProcess, pluginId: string): RpcPeer {
      if (closed) throw new ContractError("cancelled", "the plugin host is closing");
      if (process === "own" && o.registry.get(pluginId)?.manifest?.host?.runtime === "node") {
        throw new ContractError("refused", `${pluginId} runs on Node, whose plugin processes this Clover doesn't start yet`);
      }
      // One process per plugin tree (the coordinator's ruling on 2f, a change to spec §5.2): a third-party plugin, and
      // its children, never share a process with another plugin, so each process's fence names that plugin's folder
      // and data only. The bundled `clover` tree keeps its one process. The cost is a Bun process per installed plugin
      // with host code (about 30 to 50 MB each).
      const top = topPluginIdOf(pluginId);
      // A plugin that asks for a process of its own (`host.process: "own"`, a Node plugin, or a bundled one with native
      // code, which the clover process doesn't load) gets one by its id; any other third-party tree, one by its top id.
      const key = process === "clover" ? "clover" : process === "own" ? `own:${pluginId}` : `${process}:${top}`;
      if (launch instanceof Error) throw new ContractError("failed", `plugin processes can't start here: ${launch.message}`);
      const live = processes.get(key);
      if (live !== undefined && !live.peer.closed) return live.peer;
      // The clover process holds many plugins: none of them runs native code there (B3, its guard's flag).
      const forKey = process === "clover" ? { ...launch, env: { ...launch.env, CLOVER_PLUGIN_NO_NATIVES: "1" } } : launch;
      const fenced = fencedLaunch(forKey, key, process === "clover" ? "clover" : top, process === "own" ? pluginId : top);
      const started = spawnHostProcess({ ...fenced, onOutput: (line) => log(`[plugin-host ${key}] ${line}`) });
      processes.set(key, started);
      started.peer.onClose(() => {
        if (processes.get(key) === started) processes.delete(key);
      });
      return started.peer;
    },
    log: pluginLog,
  });

  const settings = new PluginSettings({ registry: o.registry, backend: filePluginSettings(o.home), secrets: o.secrets });
  const uiSendWindows = new Map<string, { start: number; n: number }>();
  const areas = o.areas !== undefined ? areasParts(o.areas) : undefined;
  const handlers: ApiHandlers[] = [
    pointsApi({ registry: o.registry, host, assetUrl: o.assetUrl ?? defaultAssetUrl }),
    storageApi(new SyncedStores(fileSyncedStores(o.home))),
    settingsApi(settings),
    commandsApi(o.registry),
    ...(areas !== undefined ? [areas.handlers] : []),
    ...(o.approvals !== undefined ? [confirmApi(o.approvals)] : []),
    {
      // A component runs one of its plugin's host handlers for the session it shows. It acts as the plugin, never the
      // user: a layer's caller is `{ kind: "plugin", pluginId }` (#333's ruling), and the handler gets that caller.
      // Its arguments are `HostApi.call`'s, in order: the handler's name, its args, and options (`timeoutMs`).
      "host.call": async (ctx, args) => {
        const [handler, callArgs, opts] = args as [unknown, unknown, { timeoutMs?: unknown } | undefined];
        if (typeof handler !== "string" || handler === "") throw new ContractError("invalid", "host.call takes the handler's name first");
        const timeoutMs = typeof opts?.timeoutMs === "number" ? opts.timeoutMs : undefined;
        return host.invoke({ pluginId: ctx.pluginId, handler, args: callArgs ?? null, caller: ctx.caller, ...(ctx.session !== undefined ? { session: ctx.session } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      },
      // A host half's message to its components, relayed by the app to their `host.on`.
      // The value is capped at UI_SEND_MAX_BYTES serialized, and each plugin at UI_SEND_PER_SECOND (#333's review).
      "ui.send": (ctx, args) => {
        const event = args[0];
        if (typeof event !== "string" || event === "" || event.length > 128) throw new ContractError("invalid", "ui.send takes an event name");
        let text: string | undefined;
        try {
          text = JSON.stringify(args[1] ?? null);
        } catch {
          text = undefined;
        }
        if (text === undefined) throw new ContractError("invalid", "ui.send takes a JSON value");
        const size = new TextEncoder().encode(text).length;
        if (size > UI_SEND_MAX_BYTES) throw new ContractError("invalid", `ui.send's value is ${size} bytes; at most ${UI_SEND_MAX_BYTES}`);
        const now = Date.now();
        const w = uiSendWindows.get(ctx.pluginId);
        if (w === undefined || now - w.start >= 1000) uiSendWindows.set(ctx.pluginId, { start: now, n: 1 });
        else if (++w.n > UI_SEND_PER_SECOND) throw new ContractError("refused", `${ctx.pluginId} sent more than ${UI_SEND_PER_SECOND} UI messages this second`);
        o.emit?.({ type: "plugin_ui_message", pluginId: ctx.pluginId, event, value: JSON.parse(text) });
      },
    },
  ];
  const recordOf = (id: string) => {
    const r = o.registry.get(id);
    return r === undefined ? undefined : installRecordOf(r);
  };
  // `net.fetch` reaches the hosts the plugin's OK granted, read the way its process's proxy reads them (2g): an entry
  // without a port is 443 and 80, one with a port only that port (the router hands every call its URL's port, or its
  // scheme's). A host named by a setting (`${setting:region}`) fails closed. A host outside the list passes only when
  // the GRANTED set holds `network:public` (the SDK's catalog: bundled only), on 443 or 80: that fetch is keyless,
  // through Clover's web safeguards (runtime-sdk/model-plugins/public-fetch.ts, which allows https and the default port
  // only).
  const gate = createApiRouter({ registry: o.registry, handlers, commandOwner: (name) => commandOwner(o.registry, name), allowNetwork: pluginNetworkAllowed });
  host.serveApi(guardApiRouter(gate, recordOf));

  // The registry's changes: a plugin removed or no longer startable (off, refused, its host code gone) is dropped, its
  // calls failing, and starts fresh on its next use; one running from a tree that has since changed reloads.
  const startedFrom = new Map<string, string | undefined>();
  const offHost = host.watch((s) => {
    if (s.state === "running") startedFrom.set(s.pluginId, o.registry.get(s.pluginId)?.treeHash);
    // Stopped (by the user or the crash rules): what it had open in the areas closes (#334's review).
    if (s.state === "stopped") void areas?.forget(s.pluginId);
  });
  const offRegistry = o.registry.watch((c) => {
    if (c.type === "entries") return;
    const fail = (err: unknown) => log(`[plugin-host] ${c.id}: ${(err as Error).message}`);
    if (c.type === "removed" || hostedRecordOf(o.registry, o.home, c.id, o.bundledDigests) === undefined) {
      startedFrom.delete(c.id);
      void areas?.forget(c.id);
      return void host.removed(c.id).catch(fail);
    }
    if (host.status(c.id).state === "running" && startedFrom.get(c.id) !== o.registry.get(c.id)?.treeHash) void host.reload(c.id).catch(fail);
  });

  return {
    host,
    registry: o.registry,
    pluginSecrets: pluginSecretsOf(o.secrets),
    proxyFor,
    settings,
    gate,
    pluginLog: (pluginId, lines) => pluginLog(pluginId, lines),
    addApiHandlers(added) {
      const paths = Object.keys(added) as ApiCallPath[];
      for (const p of paths) {
        if (!Object.hasOwn(API_CALLS, p)) throw new ContractError("invalid", `${p} isn't a call of the plugin API`);
        if (typeof added[p] !== "function") throw new ContractError("invalid", `${p}'s handler isn't a function`);
        if (handlerOf(handlers, p) !== undefined) throw new ContractError("invalid", `${p} is already served`);
      }
      const entry: ApiHandlers = Object.freeze({ ...added });
      handlers.push(entry);
      return () => {
        const i = handlers.indexOf(entry);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      offRegistry();
      offHost();
      const running = o.registry.list().map((p) => p.id);
      await Promise.allSettled(running.map((id) => host.stop(id, "Clover is stopping")));
      for (const p of processes.values()) p.kill();
      for (const p of proxies.values()) p.close();
      proxies.clear();
      processes.clear();
    },
  };
}

