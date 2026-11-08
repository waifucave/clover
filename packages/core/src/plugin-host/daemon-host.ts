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
// * Logs: a worker's console lines go to `<home>/logs/plugins/<id>.log`, a process's own output to the daemon's log.
// * `pluginSecrets`: the contract store narrowed to `get`, for the model plugins (lane A). A plugin's own secrets sit
//   under `{ owner: { kind: "plugin", pluginId }, name }`, where plugin settings put their `secret` fields.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostProcess } from "@waifucave/clover-protocol";
import { SystemClock } from "../clock/system-clock";
import { commandOwner, commandsApi } from "../commands/views";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import { guardApiRouter, type ApiRouter, type InstallRecord, type PluginHost } from "../contracts/plugin-host";
import type { PluginRecord, PluginRegistry } from "../contracts/plugin-registry";
import type { SecretStore } from "../contracts/secret-store";
import { areasApi, type AreaServices } from "./api/areas";
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
  /** The contract store narrowed to `get`: a plugin's own items are `{ owner: { kind: "plugin", pluginId }, name }`. */
  readonly pluginSecrets: Pick<SecretStore, "get">;
  /** The user's side of plugin settings (`plugin.settings.get`/`set`). */
  readonly settings: PluginSettings;
  /** The capability gate without the process check, for a component's call (`plugin.layer.api`, process `ui`). */
  readonly gate: ApiRouter;
  /** Stops every plugin and ends the processes. */
  close(): Promise<void>;
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

/** The registry states a plugin's host half may run in: OK'd and on (`running`, `waiting`), or stopped by the crash
 *  rules (`stopped`, which the user's restart starts again). Never `found` (no OK yet), `refused`, `invalid`, `off` or
 *  `blocked`. */
const STARTABLE = new Set(["running", "waiting", "stopped"]);

/** The core's record of a plugin it may start, from the registry's: undefined when it isn't installed, isn't OK'd and
 *  on, or has no host code. */
export function hostedRecordOf(registry: Pick<PluginRegistry, "get">, home: string, pluginId: string): HostedRecord | undefined {
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
  };
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
      : o.launch ?? await hostProcessLaunch({ runDir: join(o.home, "run", "plugin-host"), computer: o.computer, base });
  } catch (err) {
    launch = err instanceof Error ? err : new Error(String(err));
    log(`[plugin-host] plugin processes can't start: ${launch.message}`);
  }
  const processes = new Map<string, { peer: RpcPeer; kill(): void }>();
  let closed = false;

  const pluginLog = (pluginId: string, lines: readonly string[]) => {
    try {
      const file = `${pluginPath(join(o.home, "logs", "plugins"), pluginId)}.log`;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, lines.map((l) => `${new Date().toISOString()} ${l}\n`).join(""), { mode: 0o600 });
    } catch (err) {
      log(`[plugin-host] ${pluginId}'s log not written: ${(err as Error).message}`);
    }
  };

  const host = new CorePluginHost({
    clock: o.clock ?? new SystemClock(),
    computer: o.computer,
    record: (id) => hostedRecordOf(o.registry, o.home, id),
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
    ...(o.areas !== undefined ? [areasApi(o.areas)] : []),
    ...(o.approvals !== undefined ? [confirmApi(o.approvals)] : []),
    {
      // A component runs one of its plugin's host handlers, as the user, for the session it shows.
      // Its arguments are `HostApi.call`'s, in order: the handler's name, its args, and options (`timeoutMs`).
      "host.call": async (ctx, args) => {
        const [handler, callArgs, opts] = args as [unknown, unknown, { timeoutMs?: unknown } | undefined];
        if (typeof handler !== "string" || handler === "") throw new ContractError("invalid", "host.call takes the handler's name first");
        const timeoutMs = typeof opts?.timeoutMs === "number" ? opts.timeoutMs : undefined;
        return host.invoke({ pluginId: ctx.pluginId, handler, args: callArgs ?? null, caller: ctx.caller, ...(ctx.session !== undefined ? { session: ctx.session } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      },
      // A host half's message to its components, relayed by the app to their `host.on`.
      "ui.send": (ctx, args) => {
        const event = args[0];
        if (typeof event !== "string" || event === "" || event.length > 128) throw new ContractError("invalid", "ui.send takes an event name");
        o.emit?.({ type: "plugin_ui_message", pluginId: ctx.pluginId, event, value: args[1] ?? null });
      },
    },
  ];
  const recordOf = (id: string) => {
    const r = o.registry.get(id);
    return r === undefined ? undefined : installRecordOf(r);
  };
  const gate = createApiRouter({ registry: o.registry, handlers, commandOwner: (name) => commandOwner(o.registry, name) });
  host.serveApi(guardApiRouter(gate, recordOf));

  // The registry's changes: a plugin removed or no longer startable (off, refused, its host code gone) is dropped, its
  // calls failing, and starts fresh on its next use; one running from a tree that has since changed reloads.
  const startedFrom = new Map<string, string | undefined>();
  const offHost = host.watch((s) => {
    if (s.state === "running") startedFrom.set(s.pluginId, o.registry.get(s.pluginId)?.treeHash);
  });
  const offRegistry = o.registry.watch((c) => {
    if (c.type === "entries") return;
    const fail = (err: unknown) => log(`[plugin-host] ${c.id}: ${(err as Error).message}`);
    if (c.type === "removed" || hostedRecordOf(o.registry, o.home, c.id) === undefined) {
      startedFrom.delete(c.id);
      return void host.removed(c.id).catch(fail);
    }
    if (host.status(c.id).state === "running" && startedFrom.get(c.id) !== o.registry.get(c.id)?.treeHash) void host.reload(c.id).catch(fail);
  });

  return {
    host,
    registry: o.registry,
    pluginSecrets: { get: (ref) => o.secrets.get(ref) },
    settings,
    gate,
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
