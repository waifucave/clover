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
// * **Refused** (the endpoint answers 4xx: a revoked or expired refresh token, an endpoint that changed): the access
//   token and the kept material are deleted, so the plugin is signed out, and `onSignedOut` is told, with the reason
//   the user reads ("…: sign in again"). A network failure changes nothing; the next call tries again.
import { createHash } from "node:crypto";
import type { KeyedToken, KeyedTokenSource } from "@waifucave/clover-provider-runtime";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import { secretTokenSource, type SecretRef, type SecretStore } from "../../contracts/secret-store";
import { refreshTokens, type OAuthTokens } from "../../providers/pkce";

/** A token this close to its expiry is renewed before a keyed call. */
export const RENEW_BEFORE_MS = 60_000;

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
  /** The refresh-token grant (a test seam): `refreshTokens` at the token endpoint. */
  refresh?: (tokenUrl: string, clientId: string, refreshToken: string) => Promise<OAuthTokens>;
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
  /** Why the sign-in ended, when a renewal was refused; undefined otherwise. */
  refusedReason(pluginId: string, secret: string): string | undefined;
  /** The keyed fetch's token source for the entry: renews near expiry and after a 401. */
  tokens(pluginId: string, secret: string): KeyedTokenSource;
  /** Renews now: `renewed`, `none` (nothing kept to renew with), `refused` (signed out), `failed` (try later). */
  renew(pluginId: string, secret: string): Promise<"renewed" | "none" | "refused" | "failed">;
}

export function createOAuthRenewal(o: OAuthRenewalOptions): OAuthRenewal {
  const now = o.now ?? Date.now;
  const refresh = o.refresh ?? refreshTokens;
  const refused = new Map<string, string>();
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
      o.log?.(`[plugin-auth] ${pluginId}'s sign-in ${secret} wasn't renewed (${why}); signed out`);
      await o.onSignedOut?.(pluginId, secret, reason);
      return "refused";
    };
    // Only the endpoint the sign-in used, while the manifest still names it.
    if (entry === undefined || entry.tokenUrl !== k.tokenUrl || entry.clientId !== k.clientId) return signOut("its sign-in changed since");
    try {
      const t = await refresh(k.tokenUrl, k.clientId, k.refreshToken);
      await o.store.set(own(pluginId, secret), t.accessToken);
      await keep(pluginId, secret, { ...k, refreshToken: t.refreshToken ?? k.refreshToken, expiresAt: t.expiresAt });
      return "renewed";
    } catch (err) {
      const status = /token exchange failed: HTTP (\d{3})/.exec(err instanceof Error ? err.message : "")?.[1];
      if (status !== undefined && Number(status) >= 400 && Number(status) < 500) return signOut(`the service answered ${status}`);
      // The error's class only: its message could carry what the service sent back.
      o.log?.(`[plugin-auth] renewing ${pluginId}'s sign-in ${secret} failed (${err instanceof Error ? err.name : "error"}); tried again at the next call`);
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
      refused.delete(key(pluginId, secret));
      const entry = oauthEntryOf(o.registry.get(pluginId), secret);
      if (entry === undefined || tokens.refreshToken === null) {
        await o.store.delete(oauthKeptRef(pluginId, secret)).catch(() => false);
        return;
      }
      await keep(pluginId, secret, { refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, tokenUrl: entry.tokenUrl, clientId: entry.clientId });
    },
    async forget(pluginId, secret) {
      refused.delete(key(pluginId, secret));
      await o.store.delete(oauthKeptRef(pluginId, secret)).catch(() => false);
    },
    refusedReason(pluginId, secret) {
      return refused.get(key(pluginId, secret));
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
