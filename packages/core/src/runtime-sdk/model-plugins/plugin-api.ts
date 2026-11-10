// The plugin API a model plugin's host half calls, as far as an adapter needs it: `net.fetch` (the keyed fetch,
// spec §5.4) and `secrets.get` (only in a process of the plugin's own, §5.2). Owner: lane A. These are HANDLERS in
// lane B's router (`DaemonPluginHost.addApiHandlers`), never a router of their own (#302's review B1): B's gate runs
// first (the call exists in the process it came from, the plugin is on and running, the capability is granted, and a
// fetch's host is among its granted `network:` entries), so `ctx.record` is the calling plugin's own install record.
//
// * The fetch is built per plugin from its install record's manifest, never from anything the call says: its hosts
//   are its `network:` capabilities; its keys are its `auth` entries (top-level and each model's), each placed where
//   the entry says, from the closed list (`keyPlacementsFor`'s rule; a placement off it builds no fetch at all).
// * A key is named by the entry's `secret` (a `custom` entry by its handler); the core reads it from `tokens`, and the
//   plugin never sees it: it exists only in the request the core sends, and every response header echoing it is gone.
// * `secrets.get` answers only a plugin the core put in a process of its own (`hostProcessFor` from the install
//   record), and only for a secret its own `auth` entries name.
import type { ApiHandlers } from "../../plugin-host/api/router";
import { isBundledClover } from "./load";
import { pinnedFetch } from "../../plugin-host/pinned-fetch";
import { maskError, maskResponse, noteKeys } from "./key-redaction";
import { publicFetch } from "./public-fetch";
import { networkAllows, reachesPublicNetwork } from "@waifucave/clover-plugin-sdk";

/** Whether a URL's host is on the plugin's declared `network:` list (the keyed fetch's hosts). */
function declaredHost(record: Pick<PluginRecord, "capabilities">, raw: string): boolean {
  try {
    const u = new URL(raw);
    return networkAllows(record.capabilities, u.hostname.replace(/^\[|\]$/g, ""), u.port === "" ? undefined : Number(u.port));
  } catch {
    return false;
  }
}
import { ContractError } from "../../contracts/common";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import { secretTokenSource, type SecretStore } from "../../contracts/secret-store";
import { clampKeyedIdleTimeoutMs, createKeyedFetch, type KeyedFetch, type KeyedFetchInit, type KeyedFetchOptions, type KeyedTokenSource, type KeyPlacement } from "@waifucave/clover-provider-runtime";

export interface ModelPluginApiOptions {
  registry: Pick<PluginRegistry, "get">;
  /** Where one `auth` entry's key or token comes from (the core's credential store and refresher). */
  tokens(pluginId: string, authName: string): KeyedTokenSource;
  /** A plugin's own secret's value, for a process of its own. */
  secret(pluginId: string, name: string): Promise<string | undefined>;
  /** The platform fetch under the keyed fetch: the pinned fetch (`plugin-host/pinned-fetch.ts`), which reaches only
   *  public addresses, unless a test passes its own. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The keyed fetch's idle limit (a test seam), held to the keyed fetch's own bounds (`clampKeyedIdleTimeoutMs`). */
  idleTimeoutMs?: number;
  /** A `network:public` fetch's audit line (`<home>/audit.jsonl`) and the user's dangerous-domain additions
   *  (public-fetch.ts). */
  audit?: (line: Record<string, unknown>) => void;
  dangerousAdded?: () => readonly string[];
  /** The daemon's log: a public fetch's refusal detail the plugin doesn't get. */
  log?: (line: string) => void;
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
/**
 * The model plugins' two calls of the plugin API, `net.fetch` (keyed) and `secrets.get`, as handlers in B's router
 * (`DaemonPluginHost.addApiHandlers`, #302's review B1): B's gate runs first (the call exists where it was made, the
 * plugin is on and running, the capability is granted, and `net.fetch`'s host is in its GRANTED `network:` entries).
 * Until B's fence and network rules land (2f, 2g), a third-party plugin is refused here with the reason: only the
 * bundled tree's plugins get a keyed fetch or a secret.
 */
export function modelPluginApiHandlers(opts: ModelPluginApiOptions): ApiHandlers {
  const fetches = new Map<string, { key: string; fetch: KeyedFetch }>();
  /** Each plugin's keys and tokens as its sources hand them out (key-redaction.ts): masked in all it gets back. */
  const keySets = new Map<string, Set<string>>();
  const keysOf = (pluginId: string): Set<string> => {
    let s = keySets.get(pluginId);
    if (s === undefined) keySets.set(pluginId, (s = new Set()));
    return s;
  };
  const fetchFor = (record: PluginRecord): KeyedFetch => {
    // Keyed on everything the fetch is built from (the A-M2 review): a changed grant or `auth` entry builds a new
    // fetch even when the tree hash is the same (a capability granted later, an override).
    const key = JSON.stringify([record.treeHash ?? null, networkHostsOf(record), [...authEntriesOf(record)].map(([n, a]) => [n, a.method, a.placement ?? null])]);
    const held = fetches.get(record.id);
    if (held !== undefined && held.key === key) return held.fetch;
    const auth: Record<string, { source: KeyedTokenSource; placement?: KeyPlacement }> = {};
    for (const [name, a] of authEntriesOf(record)) auth[name] = { source: noteKeys(opts.tokens(record.id, name), keysOf(record.id)), ...(a.placement !== undefined ? { placement: a.placement } : {}) };
    const fetch = createKeyedFetch({ hosts: networkHostsOf(record), auth, fetch: opts.fetch ?? pinnedFetch(), ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: clampKeyedIdleTimeoutMs(opts.idleTimeoutMs) } : {}) });
    fetches.set(record.id, { key, fetch });
    return fetch;
  };
  const publicOf = publicFetch({ fetch: opts.fetch ?? pinnedFetch(), ...(opts.log !== undefined ? { log: opts.log } : {}), ...(opts.audit !== undefined ? { audit: opts.audit } : {}), ...(opts.dangerousAdded !== undefined ? { dangerousAdded: opts.dangerousAdded } : {}) });
  const bundledOnly = (record: PluginRecord, what: string): void => {
    if (!isBundledClover(record)) throw new ContractError("refused", `${what} is served to Clover's own bundled plugins only until the plugin API's fence and network rules land; ${record.id} is a third-party plugin`);
  };
  return {
    "net.fetch": async (ctx, args) => {
      bundledOnly(ctx.record, "a keyed net.fetch");
      const [url, init, fetchOpts] = args as [string, RequestInit | undefined, KeyedFetchOptions | undefined];
      const keys = keysOf(ctx.record.id);
      try {
        // A host on the plugin's declared network: list goes through its keyed fetch; any other only with
        // `network:public` granted (B's gate checked it too), keyless, through Clover's web safeguards.
        if (!declaredHost(ctx.record, url) && reachesPublicNetwork(ctx.record.granted)) {
          return maskResponse(await publicOf(ctx.record.id, url, init ?? {}, fetchOpts as Record<string, unknown> | undefined), keys);
        }
        return maskResponse(await fetchFor(ctx.record)(url, keyedInit(init), fetchOpts), keys);
      } catch (err) {
        throw maskError(err, keys);
      }
    },
    "secrets.get": async (ctx, args) => {
      bundledOnly(ctx.record, "secrets.get");
      // B's gate already holds it to a process of the plugin's own; said again here, where the secret is read.
      if (ctx.process !== "own") throw new ContractError("refused", "secrets.get exists only in a process of the plugin's own (spec §5.2)");
      const [name] = args as [string];
      const entry = authEntriesOf(ctx.record).get(name);
      if (entry === undefined || entry.secret !== name) throw new ContractError("refused", `${ctx.record.id} has no secret ${JSON.stringify(name)}`);
      return opts.secret(ctx.record.id, name);
    },
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
