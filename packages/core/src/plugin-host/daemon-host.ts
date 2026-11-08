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
import { appendFileSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostProcess } from "@waifucave/clover-protocol";
import { SystemClock } from "../clock/system-clock";
import { commandOwner, commandsApi } from "../commands/views";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import { guardApiRouter, type InstallRecord, type PluginHost } from "../contracts/plugin-host";
import type { PluginRecord, PluginRegistry } from "../contracts/plugin-registry";
import type { SecretStore, SecretValue } from "../contracts/secret-store";
import { confirmApi } from "./api/confirm";
import { pointsApi } from "./api/points";
import { createApiRouter, type ApiHandlers } from "./api/router";
import { filePluginSettings, PluginSettings, settingsApi } from "./api/settings";
import { fileSyncedStores, storageApi, SyncedStores } from "./api/storage";
import { pluginDataFolder, pluginPath } from "./paths";
import { CorePluginHost, type HostedRecord } from "./core-host";
import { hostProcessLaunch, spawnHostProcess, type HostProcessLaunch } from "./launch";
import type { RpcPeer } from "./link";

/** The environment variables a plugin-host process gets from the daemon's. */
const HOST_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"];

export interface DaemonPluginHost {
  /** The one host: processes `clover`, `shared` and `own:<id>`, with the router and API channel inside. */
  readonly host: PluginHost;
  /** The registry it serves. */
  readonly registry: PluginRegistry;
  /** One plugin's own items, read-only: the owner is fixed as `{ kind: "plugin", pluginId }`. */
  readonly pluginSecrets: PluginSecrets;
  /** The user's side of plugin settings (`plugin.settings.get`/`set`). */
  readonly settings: PluginSettings;
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
  clock?: Clock;
  /** The bundled plugins' files as staging verified them (`stageBundledPlugins`' `digests`): a bundled plugin's entry
   *  runs only from bytes matching its digest, and not at all without one. */
  bundledDigests?: ReadonlyMap<string, string>;
  /** Test seams: the launch (default: the plugin Bun with the guard) and the environment it starts from. */
  launch?: HostProcessLaunch | (() => Promise<HostProcessLaunch>);
  env?: Readonly<Record<string, string | undefined>>;
}

/** Where a plugin's files are served from until lane E names it: the layer of its top-level plugin. */
function defaultAssetUrl(pluginId: string, path: string): string {
  const top = pluginId.split("/")[0]!;
  const rest = pluginId.includes("/") ? `${pluginId.slice(top.length + 1)}/` : "";
  return `clover-plugin://${top}/${rest}${path.replace(/^\/+/, "")}`;
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
    ...(r.source === "bundled" ? { entrySha256: verifiedDigest(verified, join(r.folder, host.entry)) } : {}),
  };
}

function verifiedDigest(verified: ReadonlyMap<string, string> | undefined, file: string): string {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return "";
  }
  return verified?.get(real) ?? "";
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
      const key = process === "own" ? `own:${pluginId}` : process;
      if (launch instanceof Error) throw new ContractError("failed", `plugin processes can't start here: ${launch.message}`);
      const live = processes.get(key);
      if (live !== undefined && !live.peer.closed) return live.peer;
      const started = spawnHostProcess({ ...launch, onOutput: (line) => log(`[plugin-host ${key}] ${line}`) });
      processes.set(key, started);
      started.peer.onClose(() => {
        if (processes.get(key) === started) processes.delete(key);
      });
      return started.peer;
    },
    log: pluginLog,
  });

  const settings = new PluginSettings({ registry: o.registry, backend: filePluginSettings(o.home), secrets: o.secrets });
  const handlers: ApiHandlers[] = [
    pointsApi({ registry: o.registry, host, assetUrl: o.assetUrl ?? defaultAssetUrl }),
    storageApi(new SyncedStores(fileSyncedStores(o.home))),
    settingsApi(settings),
    commandsApi(o.registry),
    ...(o.approvals !== undefined ? [confirmApi(o.approvals)] : []),
  ];
  const recordOf = (id: string) => {
    const r = o.registry.get(id);
    return r === undefined ? undefined : installRecordOf(r);
  };
  host.serveApi(guardApiRouter(createApiRouter({ registry: o.registry, handlers, commandOwner: (name) => commandOwner(o.registry, name) }), recordOf));

  // The registry's changes: a plugin removed or no longer startable (off, refused, its host code gone) is dropped, its
  // calls failing, and starts fresh on its next use; one running from a tree that has since changed reloads.
  const startedFrom = new Map<string, string | undefined>();
  const offHost = host.watch((s) => {
    if (s.state === "running") startedFrom.set(s.pluginId, o.registry.get(s.pluginId)?.treeHash);
  });
  const offRegistry = o.registry.watch((c) => {
    if (c.type === "entries") return;
    const fail = (err: unknown) => log(`[plugin-host] ${c.id}: ${(err as Error).message}`);
    if (c.type === "removed" || hostedRecordOf(o.registry, o.home, c.id, o.bundledDigests) === undefined) {
      startedFrom.delete(c.id);
      return void host.removed(c.id).catch(fail);
    }
    if (host.status(c.id).state === "running" && startedFrom.get(c.id) !== o.registry.get(c.id)?.treeHash) void host.reload(c.id).catch(fail);
  });

  return {
    host,
    registry: o.registry,
    pluginSecrets: pluginSecretsOf(o.secrets),
    settings,
    async close() {
      if (closed) return;
      closed = true;
      offRegistry();
      offHost();
      const running = o.registry.list().map((p) => p.id);
      await Promise.allSettled(running.map((id) => host.stop(id, "Clover is stopping")));
      for (const p of processes.values()) p.kill();
      processes.clear();
    },
  };
}
