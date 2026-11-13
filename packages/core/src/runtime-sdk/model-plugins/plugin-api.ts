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
import { pinnedFetch, PinnedFetchRefused } from "../../plugin-host/pinned-fetch";
import { originOf } from "./user-endpoint";
import { maskError, maskResponse, noteKeys } from "./key-redaction";
import { publicFetch } from "./public-fetch";
import { reachesPublicNetwork } from "@waifucave/clover-plugin-sdk";
import { hostAllowed, hostRules } from "../../plugin-host/net-proxy";

/** Whether a URL's host is on the plugin's declared `network:` list (the keyed fetch's hosts), read as B's gate and the
 *  plugin's proxy read a host (`hostRules`/`hostAllowed`: a trailing dot dropped, no port meaning 443 and 80), so a
 *  spelling the gate counts as a listed host never takes the keyless public path instead. */
function declaredHost(record: Pick<PluginRecord, "capabilities">, raw: string): boolean {
  try {
    const u = new URL(raw);
    const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : undefined;
    return port !== undefined && hostAllowed(hostRules(record.capabilities), u.hostname, port);
  } catch {
    return false;
  }
}
import { ContractError } from "../../contracts/common";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import { secretTokenSource, type SecretStore } from "../../contracts/secret-store";
import { clampKeyedIdleTimeoutMs, createKeyedFetch, isLoopbackHost, type KeyedFetch, type KeyedFetchInit, type KeyedFetchOptions, type KeyedTokenSource, type KeyPlacement } from "@waifucave/clover-provider-runtime";

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
  /** The origin the USER set for a plugin's provider (`providers.<id>.baseUrl`, `user-endpoint.ts`), read at each
   *  call: the plugin's fetch reaches that origin (with its key: the provider's API calls) beside its declared hosts. */
  userEndpoint?: (pluginId: string) => string | undefined;
  /** The platform fetch to a user's own endpoint: by default the pinned fetch, reaching that one host even at a
   *  loopback or private address. A test passes its own. */
  userFetch?: (origin: string) => (url: string, init: RequestInit) => Promise<Response>;
}

/** The pinned fetch to one origin the user set: its host may be at a loopback or private address, and every hop
 *  (the keyed fetch follows redirects by hand, through here) must be that origin. */
function userOriginFetch(origin: string, platform: (url: string, init: RequestInit) => Promise<Response>): (url: string, init: RequestInit) => Promise<Response> {
  return (url, init) => {
    if (originOf(url) !== origin) return Promise.reject(new PinnedFetchRefused(`the user's endpoint for this provider is ${origin}; ${originOf(url) ?? "that URL"} is another`));
    return platform(url, init);
  };
}

/** The keyed fetch's host entry for an origin: its host, with its port when the URL names one. */
function hostEntryOf(origin: string): string {
  const u = new URL(origin);
  return u.port === "" ? u.hostname : `${u.hostname}:${u.port}`;
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
 * They serve every plugin, a third party's as a bundled one's (spec §5.4; B's fence and network rules, 2f and 2g,
 * hold its processes to its own hosts too): a plugin's fetch reaches only its declared hosts, with only its own keys
 * (a third party's are its own items, which the user stored for it; never a provider slot, `keychain-tokens.ts`), and
 * `secrets.get` reads only its own `auth` entries' secrets, in a process of its own. The keyless `network:public` path
 * is the bundled tree's alone (the capability is `bundledOnly`, and is checked here again).
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
  const userFetches = new Map<string, { key: string; fetch: KeyedFetch }>();
  /** A plugin's keyed fetch to the user's own endpoint for its provider: that origin alone, its own keys. */
  const userFetchFor = (record: PluginRecord, origin: string): KeyedFetch => {
    const key = JSON.stringify([origin, record.treeHash ?? null, [...authEntriesOf(record)].map(([n, a]) => [n, a.method, a.placement ?? null])]);
    const held = userFetches.get(record.id);
    if (held !== undefined && held.key === key) return held.fetch;
    const auth: Record<string, { source: KeyedTokenSource; placement?: KeyPlacement }> = {};
    for (const [name, a] of authEntriesOf(record)) auth[name] = { source: noteKeys(opts.tokens(record.id, name), keysOf(record.id)), ...(a.placement !== undefined ? { placement: a.placement } : {}) };
    const platform = opts.userFetch?.(origin) ?? pinnedFetch({ reach: (host) => host === new URL(origin).hostname.replace(/^\[|\]$/g, "") });
    const fetch = createKeyedFetch({ hosts: [hostEntryOf(origin)], auth, fetch: userOriginFetch(origin, platform), ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: clampKeyedIdleTimeoutMs(opts.idleTimeoutMs) } : {}) });
    userFetches.set(record.id, { key, fetch });
    return fetch;
  };
  const publicOf = publicFetch({ fetch: opts.fetch ?? pinnedFetch(), ...(opts.log !== undefined ? { log: opts.log } : {}), ...(opts.audit !== undefined ? { audit: opts.audit } : {}), ...(opts.dangerousAdded !== undefined ? { dangerousAdded: opts.dangerousAdded } : {}) });
  return {
    "net.fetch": async (ctx, args) => {
      const [url, init, fetchOpts] = args as [string, RequestInit | undefined, KeyedFetchOptions | undefined];
      const keys = keysOf(ctx.record.id);
      // The user pointed this plugin's provider at an endpoint of their own: a request to that origin (the provider's API
      // calls, which carry its key) goes there; every other request keeps the plugin's declared hosts (a token
      // exchange, discovery), below.
      const userOrigin = opts.userEndpoint?.(ctx.record.id);
      if (userOrigin !== undefined && originOf(url) === userOrigin) {
        // Plain http reaches only this computer (the keyed fetch's rule); say so in words, not as `insecure_url`.
        if (new URL(userOrigin).protocol === "http:" && !isLoopbackHost(new URL(userOrigin))) {
          throw new ContractError("refused", `your endpoint for this provider (${userOrigin}) is on the local network over plain http: an endpoint on the local network needs https; plain http reaches only this computer (localhost or 127.0.0.1)`);
        }
        try {
          return maskResponse(await userFetchFor(ctx.record, userOrigin)(url, keyedInit(init), fetchOpts), keys);
        } catch (err) {
          throw maskError(err, keys);
        }
      }
      try {
        // A host on the plugin's declared network: list goes through its keyed fetch; any other only with
        // `network:public` granted (B's gate checked it too), keyless, through Clover's web safeguards.
        if (!declaredHost(ctx.record, url) && isBundledClover(ctx.record) && reachesPublicNetwork(ctx.record.granted)) {
          return maskResponse(await publicOf(ctx.record.id, url, init ?? {}, fetchOpts as Record<string, unknown> | undefined), keys);
        }
        return maskResponse(await fetchFor(ctx.record)(url, keyedInit(init), fetchOpts), keys);
      } catch (err) {
        throw maskError(err, keys);
      }
    },
    "secrets.get": async (ctx, args) => {
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
