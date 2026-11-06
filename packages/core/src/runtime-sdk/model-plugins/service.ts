// The model plugins on this computer (spec §3.3, §5.3 `models`): every provider a session can use is an enabled
// model plugin's entry, loaded through the plugin registry and, for a code plugin, the plugin host (lane B's
// contracts; their fakes until B-M1 and B-M2). Owner: lane A.
//
// What it keeps, rebuilt whenever the registry changes:
// * the catalog of the enabled entries (`load.ts`), written to `<home>/run/models/catalog-<sha256>.json`, content-
//   addressed, which each session reads at its start (`Options.modelProviders.catalog`; a session's options carry the
//   path and the digest, never the megabytes);
// * for each code plugin, its adapter's identity (`describe`, asked once per load), so a session registers a stub
//   for it and its calls come back here (`sessionOption`'s `serve`), to run on the plugin through the plugin host.
// A code plugin whose adapter can't describe itself, or describes another id than its bundled catalog file names,
// is left out of the served set with the reason: its rows stay, and a turn on them refuses `no-adapter`, typed.
//
// The keys: a declarative provider's key reaches its session as today (the host credential broker, by provider
// slot); a code plugin's key never reaches a session at all. The plugin reaches its provider through the core's
// keyed fetch (`plugin-api.ts`), which reads it through `tokens`.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import type { HostServedAdapter, ModelProvidersOption } from "@waifucave/clover-agent-sdk";
import { createHostModelAdapterServer, hostServedProviderAdapter, ProviderRequestError, type HostModelAdapter, type ModelAdapterDescription, type ProviderAdapter } from "@waifucave/clover-provider-runtime";
import type { WinterCatalog } from "@waifucave/clover-provider-catalog";
import type { Unsubscribe } from "../../contracts/common";
import type { PluginHost } from "../../contracts/plugin-host";
import type { PluginRegistry } from "../../contracts/plugin-registry";
import { describeModelAdapter, pluginHostModelAdapter } from "./host-adapter";
import { buildModelPluginSet, readModelPlugins, type ModelPluginSet } from "./load";

/** A served code adapter: which plugin's handler it is, and who it says it is. */
export interface ServedModelAdapter {
  adapterId: string;
  pluginId: string;
  provider: string;
  handler: string;
  description: ModelAdapterDescription;
}

export interface ModelPluginRefusalView {
  pluginId: string;
  provider: string;
  code: string;
  message: string;
}

export interface ModelPluginsOptions {
  registry: PluginRegistry;
  host: PluginHost;
  /** The Clover home: the catalog file goes in `<home>/run/models/`. */
  home: string;
  /** Fills what a code adapter reads off its connection beside the key (a sign-in's account id), per plugin. */
  connectionFor?: (pluginId: string, connection: HostModelAdapterContextConnection) => HostModelAdapterContextConnection;
  readFile?: (path: string) => string;
  log?: (line: string) => void;
}

type HostModelAdapterContextConnection = Parameters<HostModelAdapter["validateCredential"]>[0]["connection"];

export interface ModelPluginsSnapshot {
  set: ModelPluginSet;
  catalogPath: string;
  catalogSha256: string;
  served: Map<string, ServedModelAdapter>;
  refused: ModelPluginRefusalView[];
}

/** How many catalog files are kept: the current one and the one before it, which a session starting during a rebuild may still be reading. */
const KEPT_CATALOG_FILES = 2;

export class ModelPlugins {
  readonly #o: ModelPluginsOptions;
  #snapshot: ModelPluginsSnapshot | undefined;
  #pending: Promise<ModelPluginsSnapshot> | undefined;
  #dirty = false;
  #off: Unsubscribe | undefined;

  constructor(opts: ModelPluginsOptions) {
    this.#o = opts;
  }

  /** The current snapshot; undefined before the first `refresh`. */
  get snapshot(): ModelPluginsSnapshot | undefined {
    return this.#snapshot;
  }

  /** The catalog the sessions resolve against. */
  get catalog(): WinterCatalog | undefined {
    return this.#snapshot?.set.catalog;
  }

  /** Loads now, then follows the registry: each change rebuilds (one rebuild at a time, the last change always seen). */
  async start(): Promise<ModelPluginsSnapshot> {
    this.#off ??= this.#o.registry.watch((change) => {
      if (change.type === "entries" && change.point !== "models") return;
      void this.refresh().catch((err: unknown) => this.#o.log?.(`model plugins: rebuild failed (${err instanceof Error ? err.message : String(err)})`));
    });
    return this.refresh();
  }

  stop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  /** Rebuilds from the registry. Calls made while one runs are folded into one more run after it. */
  async refresh(): Promise<ModelPluginsSnapshot> {
    if (this.#pending !== undefined) {
      this.#dirty = true;
      return this.#pending;
    }
    const run = async (): Promise<ModelPluginsSnapshot> => {
      try {
        let snap: ModelPluginsSnapshot;
        do {
          this.#dirty = false;
          snap = await this.#build();
        } while (this.#dirty);
        this.#snapshot = snap;
        return snap;
      } finally {
        this.#pending = undefined;
      }
    };
    this.#pending = run();
    return this.#pending;
  }

  async #build(): Promise<ModelPluginsSnapshot> {
    const set = buildModelPluginSet(readModelPlugins(this.#o.registry, this.#o.readFile));
    const refused: ModelPluginRefusalView[] = set.refused.map((r) => ({ pluginId: r.pluginId, provider: r.provider, code: r.code, message: r.message }));
    const served = new Map<string, ServedModelAdapter>();
    for (const [provider, a] of set.adapters) {
      if (a.handler === undefined) continue;
      try {
        const description = await describeModelAdapter(this.#o.host, { pluginId: a.pluginId, handler: a.handler });
        const trusted = set.byProvider.get(provider)?.input.trusted === true;
        if (trusted && description.id !== a.adapterId) throw new Error(`its adapter says it is ${description.id}, and its catalog file names ${a.adapterId}`);
        served.set(a.adapterId, { adapterId: a.adapterId, pluginId: a.pluginId, provider, handler: a.handler, description });
      } catch (err) {
        refused.push({ pluginId: a.pluginId, provider, code: "adapter-unavailable", message: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const r of refused) this.#o.log?.(`model plugins: ${r.pluginId} (${r.provider}) left out: ${r.code}: ${r.message}`);
    const { path, sha256 } = this.#writeCatalog(set.catalog);
    return { set, catalogPath: path, catalogSha256: sha256, served, refused };
  }

  #writeCatalog(catalog: WinterCatalog): { path: string; sha256: string } {
    const dir = join(this.#o.home, "run", "models");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify(catalog);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(dir, `catalog-${sha256}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, path);
    // Keep the newest few: the file names carry no time, so order by when this process wrote them.
    this.#written = [path, ...this.#written.filter((p) => p !== path)];
    for (const old of this.#written.splice(KEPT_CATALOG_FILES)) rmSync(old, { force: true });
    for (const name of readdirSync(dir)) if (name.endsWith(".tmp")) rmSync(join(dir, name), { force: true });
    return { path, sha256 };
  }

  #written: string[] = [];

  /**
   * One session's `Options.modelProviders`: the current catalog file and the code adapters it may call, answered
   * here through the plugin host as `caller` (the session, R7). Undefined before the first load.
   */
  sessionOption(opts: { caller: Caller; session?: string }): ModelProvidersOption | undefined {
    const snap = this.#snapshot;
    if (snap === undefined) return undefined;
    const served = snap.served;
    const hostAdapters: HostServedAdapter[] = [...served.values()].map((s) => ({ id: s.adapterId, version: s.description.version, family: s.description.family, protocol: s.description.protocol, ...(s.description.countTokens ? { countTokens: true } : {}) }));
    const connectionFor = this.#o.connectionFor;
    const server = createHostModelAdapterServer((id) => {
      const s = served.get(id);
      if (s === undefined) return undefined;
      const adapter = pluginHostModelAdapter(this.#o.host, { pluginId: s.pluginId, handler: s.handler }, { caller: opts.caller, ...(opts.session !== undefined ? { session: opts.session } : {}), countTokens: s.description.countTokens });
      if (connectionFor === undefined) return adapter;
      const fill = <C extends { connection: HostModelAdapterContextConnection }>(ctx: C): C => ({ ...ctx, connection: connectionFor(s.pluginId, ctx.connection) });
      const filled: HostModelAdapter = {
        streamTurn: (req, ctx) => adapter.streamTurn(req, fill(ctx)),
        listModels: (ctx) => adapter.listModels(fill(ctx)),
        validateCredential: (ctx) => adapter.validateCredential(fill(ctx)),
      };
      if (adapter.countTokens !== undefined) {
        const count = adapter.countTokens.bind(adapter);
        filled.countTokens = (req, ctx) => count(req, fill(ctx));
      }
      return filled;
    });
    return {
      catalog: { path: snap.catalogPath, sha256: snap.catalogSha256 },
      ...(hostAdapters.length > 0 ? { hostAdapters, serve: (subtype: string, payload: unknown) => server.handle(subtype, payload) } : {}),
    };
  }

  /**
   * The core's own calls on a provider (its internal jobs: titles, the bash reviewer, the dreamer, the cleaner): the
   * provider's code adapter as a `ProviderAdapter`, run on its plugin through the plugin host as `caller`, the same
   * path a session's stub takes. Undefined when the provider has no served code adapter (a declarative provider runs
   * on its protocol's generic adapter in the core, which the caller builds as before).
   */
  providerAdapterFor(providerId: string, opts: { caller: Caller }): ProviderAdapter | undefined {
    const served = this.#snapshot === undefined ? undefined : [...this.#snapshot.served.values()].find((s) => s.provider === providerId);
    if (served === undefined) return undefined;
    const option = this.sessionOption({ caller: opts.caller });
    const identity = option?.hostAdapters?.find((a) => a.id === served.adapterId);
    const serve = option?.serve;
    if (identity === undefined || serve === undefined) return undefined;
    // The agent SDK spells `family` as a string on the wire; the identity came from this adapter's own `describe`.
    return hostServedProviderAdapter(identity as Parameters<typeof hostServedProviderAdapter>[0], {
      async request<T>(subtype: string, payload: unknown): Promise<T> {
        const answer = await serve(subtype, payload, { signal: new AbortController().signal });
        if (!answer.ok) throw new ProviderRequestError({ code: "network", message: answer.error.message, retryable: false });
        return answer.value as T;
      },
    });
  }
}
