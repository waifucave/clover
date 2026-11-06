// The waifucave account on this computer (spec §8.1: Supabase auth with email, Discord and Google; "the account is
// the root of trust"). Signing in is enough to add a device: each device registers its link key with the account
// service, and every device of the account takes the others from that list.
//
// * The Supabase session (access and refresh tokens) is a device item in the secret store: it never syncs, never
//   reaches a log or a file, and a used refresh token is never sent twice (one refresh at a time).
// * Sign-in runs Supabase's PKCE flow through a loopback redirect on 127.0.0.1: the client opens the URL, the user
//   signs in, the provider sends the browser back to the loopback with a code, and the core trades it for a session.
// * Account tokens for waifucave's services (hooks, push, the handshake) are minted by the account service from the
//   session, for one audience each, living at most 5 minutes (`ACCOUNT_TOKEN_MAX_MS`); the request is signed with the
//   device's link key, so a stolen session alone can't mint for another device. The core's `mintedTokenSource`
//   caches them per audience.
//
// The account service is lane I's to run; until it exists its wire is lane H's proposal (`account-fake.ts` speaks it):
//   POST   /v1/devices           {device, t, sig}   registers this device (sig over `registerStatement`)
//   GET    /v1/devices                               {devices: [...]}, revoked ones with `revokedAt`
//   DELETE /v1/devices/:id                           revokes a device of the account
//   POST   /v1/tokens            {aud, dev, t, sig} {token, expiresAt} (sig over `mintStatement`, which names the account)
//   GET    /.well-known/jwks.json                    the keys tokens are checked against
// Each takes the Supabase access token as `Authorization: Bearer`.
import { createHash } from "node:crypto";
import type { AccountView, DeviceKind, Os } from "@waifucave/clover-protocol";
import { encode } from "../links/codec";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import { ACCOUNT_TOKEN_MAX_MS, type KeyedTokenSource, mintedTokenSource, Secret, type SecretRef, type SecretStore } from "../contracts/secret-store";
import { randomBytes, toBase64Url, utf8 } from "./bytes";
import type { DeviceKey } from "./device-key";

export const ACCOUNT_SESSION_REF: SecretRef = { owner: { kind: "device" }, name: "account:session" };

export type AccountProvider = "email" | "discord" | "google";

/** What a device signs to register with the account: the whole record it lists, box key included, so the service (or
 *  anyone between) can't list the device with another key or name than it gave. Canonical CBOR, so no field can read
 *  as another. */
export const registerStatement = (account: string, d: { id: string; publicKey: string; boxKey: string; name: string; kind: string; os?: string }, t: number): Uint8Array =>
  encode(["clover-account-v2 register", account, d.id, d.publicKey, d.boxKey, d.name, d.kind, d.os ?? null, t]);
/** What a device signs to have a token minted: the account it's on too, as the register statement names it (lane I). */
export const mintStatement = (account: string, audience: string, device: string, t: number): Uint8Array =>
  utf8(["clover-account-v1 mint", account, audience, device, String(t)].join("\n"));

export interface AccountConfig {
  /** The Supabase project URL. */
  authUrl: string;
  /** The project's public (anon) key. */
  anonKey: string;
  /** The account service. */
  serviceUrl: string;
  /** Where email sign-in starts (waifucave's sign-in page, which sends the browser back with a PKCE code). */
  emailSignInUrl?: string;
}

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** ms */
  expiresAt: number;
  user: { id: string; email?: string };
  provider: AccountProvider;
}

export interface AccountDevice {
  id: string;
  publicKey: string;
  /** Its X25519 key for the handshake's account-scope boxes, base64url. */
  boxKey: string;
  name: string;
  kind: DeviceKind;
  os?: Os;
  addedAt: number;
  revokedAt?: number;
}

export interface AccountClientOptions {
  config: AccountConfig;
  store: Pick<SecretStore, "get" | "set" | "delete">;
  device: DeviceKey;
  clock: { now(): number };
  fetch?: (req: Request) => Promise<Response>;
}

export class AccountClient {
  readonly #o: AccountClientOptions;
  readonly #fetch: (req: Request) => Promise<Response>;
  readonly #listeners = new Listeners<AccountView>();
  #session: StoredSession | null | undefined;
  #refreshing: Promise<StoredSession | null> | undefined;
  #pending: { server: ReturnType<typeof Bun.serve>; timer: ReturnType<typeof setTimeout> } | undefined;
  readonly tokens: KeyedTokenSource;

  constructor(opts: AccountClientOptions) {
    this.#o = opts;
    this.#fetch = opts.fetch ?? ((req) => fetch(req));
    this.tokens = mintedTokenSource((aud) => this.mint(aud), opts.clock);
  }

  watch(fn: (view: AccountView) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  async status(): Promise<AccountView> {
    const s = await this.#load();
    if (!s) return { signedIn: false };
    return { signedIn: true, provider: s.provider, user: { id: s.user.id, ...(s.user.email ? { email: s.user.email } : {}) } };
  }

  /** The account's id, or null when signed out. */
  async accountId(): Promise<string | null> {
    return (await this.#load())?.user.id ?? null;
  }

  /** What two devices compare at pairing to tell whether they share an account, without telling which. */
  async accountHash(): Promise<string | null> {
    const id = await this.accountId();
    return id === null ? null : createHash("sha256").update(`clover-account-v1 hash\n${id}`).digest("base64url").slice(0, 22);
  }

  /** Starts a PKCE sign-in: returns the URL the client opens, and resolves `done` once the browser came back and the
   *  session is stored. A second start ends the first. */
  async startSignIn(provider: AccountProvider, opts: { timeoutMs?: number } = {}): Promise<{ url: string; done: Promise<AccountView> }> {
    this.#endPending();
    // Checked before the loopback server starts, so a refusal leaves nothing listening.
    if (provider === "email" && !this.#o.config.emailSignInUrl) throw new ContractError("refused", "email sign-in isn't set up here");
    const verifier = toBase64Url(randomBytes(32));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let finish!: (v: AccountView) => void;
    let fail!: (e: unknown) => void;
    const done = new Promise<AccountView>((res, rej) => {
      finish = res;
      fail = rej;
    });
    const state = toBase64Url(randomBytes(16));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
        if (url.searchParams.get("state") !== state) return new Response("This sign-in link is stale. Start again from Clover.", { status: 400 });
        const code = url.searchParams.get("code");
        if (!code) {
          fail(new ContractError("refused", "the sign-in was cancelled"));
          // After this answer is sent: stopping now would cut the browser's connection before the page arrives.
          setTimeout(() => this.#endPending(server), 0);
          return new Response("Sign-in cancelled. You can close this tab.", { status: 400 });
        }
        try {
          const session = await this.#token("pkce", { auth_code: code, code_verifier: verifier }, provider);
          await this.#save(session);
          finish(await this.status());
          return new Response("Signed in to Clover. You can close this tab.", { headers: { "content-type": "text/plain; charset=utf-8" } });
        } catch (err) {
          fail(err);
          return new Response("Sign-in failed. Start again from Clover.", { status: 400 });
        } finally {
          setTimeout(() => this.#endPending(server), 0);
        }
      },
    });
    const timer = setTimeout(() => {
      fail(new ContractError("timeout", "the sign-in wasn't finished in time"));
      this.#endPending();
    }, opts.timeoutMs ?? 10 * 60_000);
    this.#pending = { server, timer };
    const redirect = `http://127.0.0.1:${server.port}/callback?state=${state}`;
    let url: URL;
    if (provider === "email") {
      url = new URL(this.#o.config.emailSignInUrl!);
    } else {
      url = new URL(`${this.#o.config.authUrl.replace(/\/+$/, "")}/auth/v1/authorize`);
      url.searchParams.set("provider", provider);
    }
    url.searchParams.set("redirect_to", redirect);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "s256");
    return { url: url.toString(), done };
  }

  /** Email and password, for tests and a headless server's terminal. */
  async signInWithPassword(email: string, password: Secret): Promise<AccountView> {
    const session = await this.#token("password", { email, password: password.reveal() }, "email");
    await this.#save(session);
    return this.status();
  }

  async signOut(): Promise<void> {
    const s = await this.#load();
    if (s) {
      await this.#auth("POST", "/auth/v1/logout?scope=local", undefined, s.accessToken).catch(() => undefined);
    }
    await this.#o.store.delete(ACCOUNT_SESSION_REF);
    this.#session = null;
    this.#listeners.emit({ signedIn: false });
  }

  /** The session's access token, refreshed when it is near its end. */
  async accessToken(): Promise<string> {
    let s = await this.#load();
    if (!s) throw new ContractError("refused", "not signed in");
    if (s.expiresAt - this.#o.clock.now() < 60_000) s = await this.#refresh();
    if (!s) throw new ContractError("refused", "the sign-in ended: sign in again");
    return s.accessToken;
  }

  /** An account token for one audience (a host), from the account service. */
  async mint(audience: string): Promise<{ value: Secret; expiresAt: number } | null> {
    const session = await this.#load();
    if (!session) return null;
    const t = Math.floor(this.#o.clock.now());
    const body = { aud: audience, dev: this.#o.device.id, t, sig: toBase64Url(this.#o.device.sign(mintStatement(session.user.id, audience, this.#o.device.id, t))) };
    const res = await this.#service("POST", "/v1/tokens", body);
    const out = (await res.json()) as { token?: unknown; expiresAt?: unknown };
    if (typeof out.token !== "string" || typeof out.expiresAt !== "number") throw new ContractError("failed", "the account service answered without a token");
    if (out.expiresAt - this.#o.clock.now() > ACCOUNT_TOKEN_MAX_MS) throw new ContractError("refused", "the account service minted a token that lives too long");
    return { value: new Secret(out.token), expiresAt: out.expiresAt };
  }

  // ---- the account's devices ----

  async registerDevice(d: { name: string; kind: DeviceKind; os?: Os; boxKey: string }): Promise<AccountDevice> {
    const s = await this.#load();
    if (!s) throw new ContractError("refused", "not signed in");
    const t = Math.floor(this.#o.clock.now());
    const device = { id: this.#o.device.id, publicKey: this.#o.device.publicKeyBase64, boxKey: d.boxKey, name: d.name, kind: d.kind, ...(d.os ? { os: d.os } : {}) };
    const body = { device, t, sig: toBase64Url(this.#o.device.sign(registerStatement(s.user.id, device, t))) };
    return ((await (await this.#service("POST", "/v1/devices", body)).json()) as { device: AccountDevice }).device;
  }

  async listDevices(): Promise<AccountDevice[]> {
    return ((await (await this.#service("GET", "/v1/devices")).json()) as { devices: AccountDevice[] }).devices;
  }

  async revokeDevice(id: string): Promise<void> {
    try {
      await this.#service("DELETE", `/v1/devices/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof ContractError && err.code === "not_found") return;
      throw err;
    }
  }

  close(): void {
    this.#endPending();
  }

  // ---- internals ----

  /** Ends the pending sign-in; with `only`, only if it is still that one's (a deferred end never stops a newer one). */
  #endPending(only?: ReturnType<typeof Bun.serve>): void {
    if (!this.#pending || (only !== undefined && this.#pending.server !== only)) return;
    clearTimeout(this.#pending.timer);
    this.#pending.server.stop(true);
    this.#pending = undefined;
  }

  async #load(): Promise<StoredSession | null> {
    if (this.#session !== undefined) return this.#session;
    const v = await this.#o.store.get(ACCOUNT_SESSION_REF);
    try {
      this.#session = v ? (JSON.parse(v.value.reveal()) as StoredSession) : null;
    } catch {
      this.#session = null;
    }
    return this.#session;
  }

  async #save(s: StoredSession): Promise<void> {
    await this.#o.store.set(ACCOUNT_SESSION_REF, new Secret(JSON.stringify(s)), { synced: false });
    this.#session = s;
    this.#listeners.emit(await this.status());
  }

  /** One refresh at a time: a refresh token is good once. A refused one ends the session here. */
  #refresh(): Promise<StoredSession | null> {
    this.#refreshing ??= (async () => {
      const s = await this.#load();
      if (!s) return null;
      try {
        const next = await this.#token("refresh_token", { refresh_token: s.refreshToken }, s.provider);
        await this.#save(next);
        return next;
      } catch (err) {
        if (err instanceof ContractError && err.code === "refused") {
          await this.#o.store.delete(ACCOUNT_SESSION_REF);
          this.#session = null;
          this.#listeners.emit({ signedIn: false });
          return null;
        }
        throw err;
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  async #token(grant: string, body: Record<string, string>, provider: AccountProvider): Promise<StoredSession> {
    const res = await this.#auth("POST", `/auth/v1/token?grant_type=${grant}`, body);
    const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number; user?: { id?: string; email?: string } };
    if (!j.access_token || !j.refresh_token || !j.user?.id) throw new ContractError("failed", "the sign-in service answered without a session");
    const expiresAt = typeof j.expires_at === "number" ? j.expires_at * 1000 : this.#o.clock.now() + (j.expires_in ?? 3600) * 1000;
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt, user: { id: j.user.id, ...(j.user.email ? { email: j.user.email } : {}) }, provider };
  }

  async #auth(method: string, path: string, body?: unknown, bearer?: string): Promise<Response> {
    const req = new Request(`${this.#o.config.authUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        apikey: this.#o.config.anonKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const res = await this.#fetch(req);
    if (res.ok) return res;
    // Never the body: it may echo what was sent.
    throw new ContractError(res.status === 400 || res.status === 401 || res.status === 403 ? "refused" : "failed", `the sign-in service answered ${res.status}`);
  }

  async #service(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.accessToken();
    const send = async (bearer: string) => this.#fetch(new Request(`${this.#o.config.serviceUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    let res = await send(token);
    if (res.status === 401) {
      const s = await this.#refresh();
      if (!s) throw new ContractError("refused", "the sign-in ended: sign in again");
      res = await send(s.accessToken);
    }
    if (res.ok) return res;
    const code = res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : res.status === 401 || res.status === 403 ? "refused" : "failed";
    throw new ContractError(code, `the account service answered ${res.status}`);
  }
}
