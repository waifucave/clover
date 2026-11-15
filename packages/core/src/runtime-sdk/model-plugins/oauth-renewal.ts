// Renewing a third-party plugin's oauth-pkce sign-in (spec §3.3, §5.4 "The keyed fetch": "after a 401 gets a newer
// token from the refresher and retries once"). Owner: lane A.
//
// A bundled model plugin's OAuth sign-in lives in its provider's slot and its provider's refresher renews it (Codex's).
// Any other plugin's access token is its own item (`{ owner: plugin, name: <the entry's secret> }`, what its keyed fetch
// sends); this renews it:
//
// * **What is kept:** at sign-in, the refresh token, the expiry and the token endpoint and client the sign-in used, as
//   a device item the core alone reads (`plugin-oauth:<the plugin's slug>:<secret>`, like `keys.*`' pairs): never the
//   plugin's own item, so neither `secrets.get` (which reads only an auth entry's own name) nor anything else gives the
//   refresh token to the plugin. Never synced: a renewal is this computer's.
// * **When:** before a keyed call when the token is within RENEW_BEFORE_MS of its expiry, and after a keyed call answers
//   401 (the keyed fetch asks `newer` once, then retries the call once). One renewal at a time per sign-in.
// * **Where:** the token endpoint the sign-in used, and only while the plugin's manifest still names it (no new host).
// * **How:** through the plugin's pinned fetch (`pluginTokenFetch`: public addresses, or a host on this computer its OK
//   names with its port), given up after TOKEN_TIMEOUT_MS, and a redirect is never followed.
// * **Refused** only by an answer that means the refresh token is dead (400 `invalid_grant`, 401), or a token endpoint
//   the manifest no longer names: the access token and the kept material are deleted, so the plugin is signed out, and
//   `onSignedOut` is told, with the reason the user reads ("…: sign in again"). That reason is kept as a device item
//   too, so it survives a restart, until the next sign-in or sign-out.
// * **Failed** (a network failure, a timeout, 408, 429, 5xx, any other answer): nothing changes, and the sign-in isn't
//   tried again for a while (BACKOFF_MIN_MS, doubling to BACKOFF_MAX_MS), so a plugin looping on 401 can't hammer its
//   endpoint; a renewal that works ends the wait.
import { createHash } from "node:crypto";
import type { KeyedToken, KeyedTokenSource } from "@waifucave/clover-provider-runtime";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import { secretTokenSource, type SecretRef, type SecretStore } from "../../contracts/secret-store";
import { refreshTokens, TokenExchangeError, type ExchangeOptions, type OAuthTokens } from "../../providers/pkce";
import { pluginTokenFetch } from "./plugin-api";

/** A token this close to its expiry is renewed before a keyed call. */
export const RENEW_BEFORE_MS = 60_000;
/** A token request (a renewal, a sign-in's code exchange) is given up after this long. */
export const TOKEN_TIMEOUT_MS = 15_000;
/** After a failed renewal the sign-in waits this long before the next try, doubling up to BACKOFF_MAX_MS. */
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

/** Whether a token endpoint's answer means the refresh token is dead (sign in again), not "try later". */
export function refreshTokenDead(err: unknown): boolean {
  if (!(err instanceof TokenExchangeError)) return false;
  return err.status === 401 || (err.status === 400 && err.oauthError === "invalid_grant");
}

interface Kept {
  refreshToken: string;
  expiresAt: number;
  tokenUrl: string;
  clientId: string;
}

type OAuthEntry = { method: "oauth-pkce"; tokenUrl: string; clientId: string; secret: string };

const slug = (pluginId: string): string => createHash("sha256").update(pluginId).digest("hex").slice(0, 24);

/** The device item holding what renews a plugin's sign-in. */
export function oauthKeptRef(pluginId: string, secret: string): SecretRef {
  return { owner: { kind: "device" }, name: `plugin-oauth:${slug(pluginId)}:${secret}` };
}

/** The device item holding why a refused renewal signed a plugin out (what the user reads), across a restart. */
export function oauthEndedRef(pluginId: string, secret: string): SecretRef {
  return { owner: { kind: "device" }, name: `plugin-oauth-ended:${slug(pluginId)}:${secret}` };
}

/** A plugin's oauth-pkce entry named `secret`, top-level or a model's. */
function oauthEntryOf(record: Pick<PluginRecord, "manifest"> | undefined, secret: string): OAuthEntry | undefined {
  const m = record?.manifest as { auth?: unknown[]; contributes?: { models?: { auth?: unknown[] }[] } } | undefined;
  const all = [...(m?.auth ?? []), ...(m?.contributes?.models ?? []).flatMap((x) => x.auth ?? [])] as Partial<OAuthEntry>[];
  return all.find((a): a is OAuthEntry => a.method === "oauth-pkce" && a.secret === secret && typeof a.tokenUrl === "string" && typeof a.clientId === "string");
}

export interface OAuthRenewalOptions {
  /** The core's secret store: the plugins' own items and the device items. */
  store: Pick<SecretStore, "get" | "set" | "delete">;
  registry: Pick<PluginRegistry, "get">;
  /** The refresh-token grant (a test seam): `refreshTokens` at the token endpoint, with the plugin's pinned fetch, the
   *  timeout and no redirect. */
  refresh?: (tokenUrl: string, clientId: string, refreshToken: string, o: ExchangeOptions) => Promise<OAuthTokens>;
  /** The fetch a plugin's token requests go through (a test seam): `pluginTokenFetch` of its record. */
  tokenFetch?: (pluginId: string) => (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  /** A refused renewal signed the plugin out: what the user reads, to announce. */
  onSignedOut?: (pluginId: string, secret: string, reason: string) => void | Promise<void>;
  log?: (line: string) => void;
}

export interface OAuthRenewal {
  /** Whether `secret` is one of the plugin's oauth-pkce entries (and the plugin not a bundled one's provider slot). */
  handles(pluginId: string, secret: string): boolean;
  /** At a sign-in: keeps what renews it (the access token itself is the caller's to store). */
  remember(pluginId: string, secret: string, tokens: OAuthTokens): Promise<void>;
  /** At a sign-out: drops it. */
  forget(pluginId: string, secret: string): Promise<void>;
  /** Why the sign-in ended, when a renewal was refused (kept across a restart); undefined otherwise. */
  refusedReason(pluginId: string, secret: string): Promise<string | undefined>;
  /** The keyed fetch's token source for the entry: renews near expiry and after a 401. */
  tokens(pluginId: string, secret: string): KeyedTokenSource;
  /** Renews now: `renewed`, `none` (nothing kept to renew with), `refused` (signed out), `failed` (try later; also
   *  while a failed one's wait lasts, without asking the endpoint). */
  renew(pluginId: string, secret: string): Promise<"renewed" | "none" | "refused" | "failed">;
}

export function createOAuthRenewal(o: OAuthRenewalOptions): OAuthRenewal {
  const now = o.now ?? Date.now;
  const refresh = o.refresh ?? refreshTokens;
  const tokenFetch = o.tokenFetch ?? ((pluginId: string) => pluginTokenFetch(o.registry.get(pluginId)));
  /** Read-through cache of the kept reasons (undefined: not read yet; null: none). */
  const refused = new Map<string, string | null>();
  /** A failed renewal's wait: no try before `until`; the next failure waits `delay` twice as long. */
  const waits = new Map<string, { until: number; delay: number }>();
  const running = new Map<string, Promise<"renewed" | "none" | "refused" | "failed">>();
  const key = (pluginId: string, secret: string) => `${pluginId}\u0000${secret}`;
  const own = (pluginId: string, secret: string): SecretRef => ({ owner: { kind: "plugin", pluginId }, name: secret });
  const kept = async (pluginId: string, secret: string): Promise<Kept | undefined> => {
    const v = await o.store.get(oauthKeptRef(pluginId, secret)).catch(() => null);
    if (v === null) return undefined;
    try {
      const k = JSON.parse(v.value.reveal()) as Partial<Kept>;
      return typeof k.refreshToken === "string" && typeof k.expiresAt === "number" && typeof k.tokenUrl === "string" && typeof k.clientId === "string" ? (k as Kept) : undefined;
    } catch {
      return undefined;
    }
  };
  const keep = (pluginId: string, secret: string, k: Kept) => o.store.set(oauthKeptRef(pluginId, secret), JSON.stringify(k), { synced: false });
  const name = (pluginId: string): string => {
    const n = o.registry.get(pluginId)?.manifest?.name as string | { en?: string } | undefined;
    return (typeof n === "string" ? n : n?.en) ?? pluginId;
  };

  const renewOnce = async (pluginId: string, secret: string): Promise<"renewed" | "none" | "refused" | "failed"> => {
    const k = await kept(pluginId, secret);
    if (k === undefined) return "none";
    const entry = oauthEntryOf(o.registry.get(pluginId), secret);
    const signOut = async (why: string): Promise<"refused"> => {
      await o.store.delete(own(pluginId, secret)).catch(() => false);
      await o.store.delete(oauthKeptRef(pluginId, secret)).catch(() => false);
      const reason = `Your sign-in to ${name(pluginId)} expired and couldn't be renewed (${why}): sign in again.`;
      refused.set(key(pluginId, secret), reason);
      waits.delete(key(pluginId, secret));
      await o.store.set(oauthEndedRef(pluginId, secret), reason, { synced: false }).catch(() => undefined);
      o.log?.(`[plugin-auth] ${pluginId}'s sign-in ${secret} wasn't renewed (${why}); signed out`);
      await o.onSignedOut?.(pluginId, secret, reason);
      return "refused";
    };
    // Only the endpoint the sign-in used, while the manifest still names it.
    if (entry === undefined || entry.tokenUrl !== k.tokenUrl || entry.clientId !== k.clientId) return signOut("its sign-in changed since");
    const w = waits.get(key(pluginId, secret));
    if (w !== undefined && now() < w.until) return "failed";
    try {
      const t = await refresh(k.tokenUrl, k.clientId, k.refreshToken, { fetch: tokenFetch(pluginId), timeoutMs: TOKEN_TIMEOUT_MS, noRedirect: true });
      await o.store.set(own(pluginId, secret), t.accessToken);
      await keep(pluginId, secret, { ...k, refreshToken: t.refreshToken ?? k.refreshToken, expiresAt: t.expiresAt });
      waits.delete(key(pluginId, secret));
      return "renewed";
    } catch (err) {
      if (refreshTokenDead(err)) {
        const e = err as TokenExchangeError;
        return signOut(`the service answered ${e.status}${e.oauthError !== undefined ? ` ${e.oauthError}` : ""}`);
      }
      const delay = w === undefined ? BACKOFF_MIN_MS : Math.min(w.delay * 2, BACKOFF_MAX_MS);
      waits.set(key(pluginId, secret), { until: now() + delay, delay });
      // The status or the error's class only: a message could carry what the service sent back.
      const what = err instanceof TokenExchangeError ? `HTTP ${err.status}` : err instanceof Error ? err.name : "error";
      o.log?.(`[plugin-auth] renewing ${pluginId}'s sign-in ${secret} failed (${what}); kept, tried again in ${Math.round(delay / 1000)} s or later`);
      return "failed";
    }
  };
  const renew = (pluginId: string, secret: string) => {
    const k = key(pluginId, secret);
    let p = running.get(k);
    if (p === undefined) {
      p = renewOnce(pluginId, secret).finally(() => running.delete(k));
      running.set(k, p);
    }
    return p;
  };

  return {
    handles(pluginId, secret) {
      return oauthEntryOf(o.registry.get(pluginId), secret) !== undefined;
    },
    async remember(pluginId, secret, tokens) {
      refused.set(key(pluginId, secret), null);
      waits.delete(key(pluginId, secret));
      await o.store.delete(oauthEndedRef(pluginId, secret)).catch(() => false);
      const entry = oauthEntryOf(o.registry.get(pluginId), secret);
      if (entry === undefined || tokens.refreshToken === null) {
        await o.store.delete(oauthKeptRef(pluginId, secret)).catch(() => false);
        return;
      }
      await keep(pluginId, secret, { refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, tokenUrl: entry.tokenUrl, clientId: entry.clientId });
    },
    async forget(pluginId, secret) {
      refused.set(key(pluginId, secret), null);
      waits.delete(key(pluginId, secret));
      await o.store.delete(oauthEndedRef(pluginId, secret)).catch(() => false);
      await o.store.delete(oauthKeptRef(pluginId, secret)).catch(() => false);
    },
    async refusedReason(pluginId, secret) {
      const k = key(pluginId, secret);
      const cached = refused.get(k);
      if (cached !== undefined) return cached ?? undefined;
      const v = await o.store.get(oauthEndedRef(pluginId, secret)).catch(() => null);
      const reason = v === null ? null : v.value.reveal().slice(0, 2000);
      refused.set(k, reason);
      return reason ?? undefined;
    },
    renew,
    tokens(pluginId, secret) {
      const base = secretTokenSource(o.store, own(pluginId, secret), async () => { await renew(pluginId, secret); });
      const plain = async (t: Promise<{ value: { reveal(): string }; generation: number } | null>): Promise<KeyedToken | null> => {
        const v = await t;
        return v === null ? null : { value: v.value.reveal(), generation: v.generation };
      };
      return {
        async current() {
          const k = await kept(pluginId, secret);
          if (k !== undefined && k.expiresAt - now() < RENEW_BEFORE_MS) await renew(pluginId, secret);
          return plain(base.current("" as never) as never);
        },
        newer: (generation) => plain(base.newer(generation, "" as never) as never),
      };
    },
  };
}
