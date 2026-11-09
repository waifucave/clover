// The plugin API a model plugin's host half calls, as far as an adapter needs it: `net.fetch` (the keyed fetch,
// spec §5.4) and `secrets.get` (only in a process of the plugin's own, §5.2). Owner: lane A, as an INTERIM: lane B's
// router (B-M2, `ApiRouter` in the plugin host contract) serves the whole plugin API and replaces this; until then
// the core serves these two calls to model plugins with lane A's reference keyed fetch (`createKeyedFetch`), which
// lane B's `net.fetch` matches case for case (the conformance kit's `runKeyedFetchConformance`).
//
// It RELIES ON `guardApiRouter` (the plugin host contract) in front of it: the guard refuses a call whose plugin
// doesn't run in the process it came from, which is what makes `call.pluginId` and `call.process` trustworthy here.
// Never serve it to a host without the guard.
//
// * The fetch is built per plugin from its install record's manifest, never from anything the call says: its hosts
//   are its `network:` capabilities; its keys are its `auth` entries (top-level and each model's), each placed where
//   the entry says, from the closed list (`keyPlacementsFor`'s rule; a placement off it builds no fetch at all).
// * A key is named by the entry's `secret` (a `custom` entry by its handler); the core reads it from `tokens`, and the
//   plugin never sees it: it exists only in the request the core sends, and every response header echoing it is gone.
// * `secrets.get` answers only a plugin the core put in a process of its own (`hostProcessFor` from the install
//   record), and only for a secret its own `auth` entries name.
import { hostProcessFor, type ApiRouter } from "../../contracts/plugin-host";
import { ContractError } from "../../contracts/common";
import { pinnedFetch } from "../../plugin-host/net-proxy";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import { secretTokenSource, type SecretStore } from "../../contracts/secret-store";
import { clampKeyedIdleTimeoutMs, createKeyedFetch, type KeyedFetch, type KeyedFetchInit, type KeyedFetchOptions, type KeyedTokenSource, type KeyPlacement } from "@waifucave/clover-provider-runtime";

export interface ModelPluginApiOptions {
  registry: Pick<PluginRegistry, "get">;
  /** Where one `auth` entry's key or token comes from (the core's credential store and refresher). */
  tokens(pluginId: string, authName: string): KeyedTokenSource;
  /** A plugin's own secret's value, for a process of its own. */
  secret(pluginId: string, name: string): Promise<string | undefined>;
  /** The platform fetch (a test seam). Default: `pinnedFetch`, the plugin proxy's address rules. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The keyed fetch's idle limit (a test seam), held to the keyed fetch's own bounds (`clampKeyedIdleTimeoutMs`). */
  idleTimeoutMs?: number;
}

interface AuthLike {
  method: string;
  secret?: string;
  handler?: string;
  placement?: KeyPlacement;
}

/** Every `auth` entry of a plugin, top-level and each model's, by the name a fetch names it with. */
export function authEntriesOf(record: Pick<PluginRecord, "manifest">): Map<string, AuthLike> {
  const out = new Map<string, AuthLike>();
  const m = record.manifest;
  const add = (list: readonly unknown[] | undefined) => {
    for (const a of (list ?? []) as AuthLike[]) {
      const name = a.secret ?? a.handler;
      if (name !== undefined && !out.has(name)) out.set(name, a);
    }
  };
  add(m?.auth as unknown[] | undefined);
  for (const model of m?.contributes?.models ?? []) add(model.auth as unknown[]);
  return out;
}

/** A plugin's `network:` hosts. */
export function networkHostsOf(record: Pick<PluginRecord, "capabilities">): string[] {
  return record.capabilities.filter((c) => c.startsWith("network:")).map((c) => c.slice("network:".length));
}

function keyedInit(init: RequestInit | undefined): KeyedFetchInit {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const body = init?.body;
  const out: KeyedFetchInit = { method: init?.method ?? "GET", headers };
  if (typeof body === "string" || body instanceof Uint8Array || body instanceof ReadableStream) out.body = body as KeyedFetchInit["body"];
  else if (body instanceof ArrayBuffer) out.body = new Uint8Array(body);
  else if (body !== undefined && body !== null) throw new ContractError("refused", "the keyed fetch takes a string, bytes or a stream as a body");
  if (init?.signal) out.signal = init.signal;
  return out;
}

/** The interim router for a model plugin's `net.fetch` and `secrets.get` (see this file's header). */
export function modelPluginApiRouter(opts: ModelPluginApiOptions): ApiRouter {
  const fetches = new Map<string, { key: string; fetch: KeyedFetch }>();
  const fetchFor = (record: PluginRecord): KeyedFetch => {
    // Keyed on everything the fetch is built from (the A-M2 review): a changed grant or `auth` entry builds a new
    // fetch even when the tree hash is the same (a capability granted later, an override).
    const key = JSON.stringify([record.treeHash ?? null, networkHostsOf(record), [...authEntriesOf(record)].map(([n, a]) => [n, a.method, a.placement ?? null])]);
    const held = fetches.get(record.id);
    if (held !== undefined && held.key === key) return held.fetch;
    const auth: Record<string, { source: KeyedTokenSource; placement?: KeyPlacement }> = {};
    for (const [name, a] of authEntriesOf(record)) auth[name] = { source: opts.tokens(record.id, name), ...(a.placement !== undefined ? { placement: a.placement } : {}) };
    // The platform fetch under the plugin proxy's address rules: no private address, no second lookup (#371's review).
    const fetch = createKeyedFetch({ hosts: networkHostsOf(record), auth, fetch: opts.fetch ?? pinnedFetch(), ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: clampKeyedIdleTimeoutMs(opts.idleTimeoutMs) } : {}) });
    fetches.set(record.id, { key, fetch });
    return fetch;
  };
  return async (call) => {
    const record = opts.registry.get(call.pluginId);
    if (record === undefined || record.manifest === undefined) throw new ContractError("refused", `${call.pluginId} isn't running`);
    if (call.path === "net.fetch") {
      const [url, init, fetchOpts] = call.args as [string, RequestInit | undefined, KeyedFetchOptions | undefined];
      return fetchFor(record)(url, keyedInit(init), fetchOpts);
    }
    if (call.path === "secrets.get") {
      if (call.process !== "own" || hostProcessFor({ id: record.id, source: record.source, ...(record.manifest.host?.runtime ? { runtime: record.manifest.host.runtime } : {}) }) !== "own") {
        throw new ContractError("refused", "secrets.get exists only in a process of the plugin's own (spec §5.2)");
      }
      const [name] = call.args as [string];
      const entry = authEntriesOf(record).get(name);
      if (entry === undefined || entry.secret !== name) throw new ContractError("refused", `${record.id} has no secret ${JSON.stringify(name)}`);
      return opts.secret(record.id, name);
    }
    throw new ContractError("refused", `${call.path} isn't served to model plugins until lane B's plugin API (B-M2)`);
  };
}

/** `tokens` and `secret` over the core's secret store (lane C's `SecretStore`): a plugin's items, by name. */
export function secretStoreCredentials(store: Pick<SecretStore, "get">, refresh?: (pluginId: string, name: string, generation: number) => Promise<void>): Pick<ModelPluginApiOptions, "tokens" | "secret"> {
  return {
    tokens(pluginId, name) {
      const ref = { owner: { kind: "plugin" as const, pluginId }, name };
      const source = secretTokenSource(store, ref, refresh === undefined ? undefined : (g) => refresh(pluginId, name, g));
      return {
        current: async () => {
          const t = await source.current("");
          return t === null ? null : { value: t.value.reveal(), generation: t.generation };
        },
        newer: async (generation) => {
          const t = await source.newer(generation, "");
          return t === null ? null : { value: t.value.reveal(), generation: t.generation };
        },
      };
    },
    async secret(pluginId, name) {
      const v = await store.get({ owner: { kind: "plugin", pluginId }, name });
      return v === null ? undefined : v.value.reveal();
    },
  };
}
