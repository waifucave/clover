// A stub of the waifucave sign-in stack (spec §8.1: Supabase auth, with email, Discord and Google), for tests that
// sign in before the live gates (plan §8). It speaks the subset of Supabase Auth (GoTrue) that a client of
// waifucave's accounts uses, over HTTP on 127.0.0.1, so `@supabase/supabase-js` works against it unchanged:
//   POST /auth/v1/token?grant_type=password        email and password
//   POST /auth/v1/token?grant_type=pkce            an OAuth code and its PKCE verifier
//   POST /auth/v1/token?grant_type=refresh_token   rotation; a used refresh token is refused, as the refresher expects
//   GET  /auth/v1/authorize?provider=…             OAuth start: consents at once as the provider's stub user
//   GET  /auth/v1/user                             the bearer's user
//   POST /auth/v1/logout                           revokes the session's refresh tokens
//   POST /auth/v1/admin/users                      creates a user (service key only)
//   GET  /auth/v1/settings                         the enabled providers
// Access tokens are HS256 JWTs signed with this stub's own random secret (the project's `jwt_secret` shape), valid
// for `accessTokenTtlSeconds` (default 3600, the project's `jwt_expiry`). Nothing here is a real account or key.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type StubProvider = "email" | "discord" | "google";

export interface StubUser {
  id: string;
  email: string;
  provider: StubProvider;
  password?: string;
  createdAt: string;
}

export interface SignInStub {
  /** The project URL a client is given (`createClient(url, anonKey)`). */
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  /** The HS256 secret access tokens are signed with, so a test can verify one. */
  jwtSecret: string;
  addUser(user: { email: string; password?: string; provider?: StubProvider }): StubUser;
  readonly users: readonly StubUser[];
  /** Moves the stub's clock (seconds), to expire tokens without waiting. */
  advanceClock(seconds: number): void;
  stop(): void;
}

interface Session { id: string; userId: string; method: string }
interface RefreshToken { token: string; sessionId: string; used: boolean; revoked: boolean }
interface AuthCode { code: string; userId: string; challenge: string; method: "s256" | "plain"; provider: StubProvider; expiresAt: number }

const PROVIDERS: readonly StubProvider[] = ["email", "discord", "google"];

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** The payload of an HS256 JWT signed with `secret`, or undefined if the signature is wrong or it is malformed. */
export function verifyHs256(token: string, secret: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** GoTrue's error shape, which supabase-js reads (`error_code`). */
function fail(status: number, code: string, msg: string): Response {
  return json(status, { code: status, error_code: code, msg });
}

/** Starts the stub on 127.0.0.1 (a free port). */
export function startSignInStub(opts: { accessTokenTtlSeconds?: number } = {}): SignInStub {
  const ttl = opts.accessTokenTtlSeconds ?? 3600;
  const jwtSecret = randomBytes(32).toString("hex");
  let clockOffset = 0;
  const now = (): number => Math.floor(Date.now() / 1000) + clockOffset;
  const users: StubUser[] = [];
  const sessions = new Map<string, Session>();
  const refreshTokens = new Map<string, RefreshToken>();
  const codes = new Map<string, AuthCode>();
  let issuer = "";
  // The keys are JWTs too, as Supabase's are; only their role matters here.
  const anonKey = signHs256({ iss: "supabase-stub", role: "anon", iat: now() }, jwtSecret);
  const serviceRoleKey = signHs256({ iss: "supabase-stub", role: "service_role", iat: now() }, jwtSecret);

  const addUser = (u: { email: string; password?: string; provider?: StubProvider }): StubUser => {
    const email = u.email.toLowerCase();
    if (users.some((x) => x.email === email)) throw new Error(`a stub user ${email} already exists`);
    const user: StubUser = { id: randomUUID(), email, provider: u.provider ?? "email", ...(u.password !== undefined ? { password: u.password } : {}), createdAt: new Date().toISOString() };
    users.push(user);
    return user;
  };

  const userJson = (user: StubUser): Record<string, unknown> => ({
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    email_confirmed_at: user.createdAt,
    phone: "",
    confirmed_at: user.createdAt,
    last_sign_in_at: new Date(now() * 1000).toISOString(),
    app_metadata: { provider: user.provider, providers: [user.provider] },
    user_metadata: {},
    identities: [],
    created_at: user.createdAt,
    updated_at: user.createdAt,
    is_anonymous: false,
  });

  const issue = (user: StubUser, method: string, sessionId: string = randomUUID()): Response => {
    sessions.set(sessionId, { id: sessionId, userId: user.id, method });
    const iat = now();
    const access = signHs256({
      aud: "authenticated", exp: iat + ttl, iat, iss: issuer, sub: user.id, email: user.email, phone: "",
      app_metadata: { provider: user.provider, providers: [user.provider] }, user_metadata: {},
      role: "authenticated", aal: "aal1", amr: [{ method, timestamp: iat }], session_id: sessionId, is_anonymous: false,
    }, jwtSecret);
    const refresh = randomBytes(16).toString("hex");
    refreshTokens.set(refresh, { token: refresh, sessionId, used: false, revoked: false });
    return json(200, { access_token: access, token_type: "bearer", expires_in: ttl, expires_at: iat + ttl, refresh_token: refresh, user: userJson(user) });
  };

  /** The bearer's live session and user, or the refusal to send. */
  const bearer = (req: Request): { user: StubUser; claims: Record<string, unknown> } | Response => {
    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const claims = verifyHs256(token, jwtSecret);
    if (claims === undefined || claims.role !== "authenticated") return fail(401, "bad_jwt", "invalid JWT: unable to parse or verify signature");
    if (typeof claims.exp !== "number" || claims.exp <= now()) return fail(401, "bad_jwt", "invalid JWT: token is expired");
    if (typeof claims.session_id !== "string" || !sessions.has(claims.session_id)) return fail(403, "session_not_found", "Session from session_id claim in JWT does not exist");
    const user = users.find((u) => u.id === claims.sub);
    if (user === undefined) return fail(403, "user_not_found", "User from sub claim in JWT does not exist");
    return { user, claims };
  };

  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/auth/v1/")) return json(404, { message: "no route" });
      const route = url.pathname.slice("/auth/v1".length);
      // The project's gateway wants the anon or service key on every request but the browser's authorize hop.
      const apikey = req.headers.get("apikey") ?? url.searchParams.get("apikey");
      if (route !== "/authorize" && apikey !== anonKey && apikey !== serviceRoleKey) return json(401, { message: "No API key found in request" });

      if (route === "/settings" && req.method === "GET") {
        return json(200, { external: Object.fromEntries(PROVIDERS.map((p) => [p, true])), disable_signup: false, mailer_autoconfirm: true });
      }
      if (route === "/token" && req.method === "POST") {
        const grant = url.searchParams.get("grant_type");
        const b = await body(req);
        if (grant === "password") {
          const user = users.find((u) => u.email === String(b.email ?? "").toLowerCase());
          if (user === undefined || user.password === undefined || user.password !== b.password) return fail(400, "invalid_credentials", "Invalid login credentials");
          return issue(user, "password");
        }
        if (grant === "refresh_token") {
          const r = refreshTokens.get(String(b.refresh_token ?? ""));
          if (r === undefined || r.revoked) return fail(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
          if (r.used) {
            // Reuse means a copy leaked or two devices refreshed at once: the whole session ends (the refresher rule).
            for (const t of refreshTokens.values()) if (t.sessionId === r.sessionId) t.revoked = true;
            sessions.delete(r.sessionId);
            return fail(400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
          }
          r.used = true;
          const session = sessions.get(r.sessionId);
          const user = users.find((u) => u.id === session?.userId);
          if (session === undefined || user === undefined) return fail(400, "session_not_found", "Session not found");
          return issue(user, session.method, session.id);
        }
        if (grant === "pkce") {
          const code = codes.get(String(b.auth_code ?? ""));
          if (code === undefined || code.expiresAt <= now()) return fail(400, "flow_state_not_found", "invalid flow state, no valid flow state found");
          codes.delete(code.code);
          const verifier = String(b.code_verifier ?? "");
          const derived = code.method === "s256" ? createHash("sha256").update(verifier).digest("base64url") : verifier;
          if (derived !== code.challenge) return fail(400, "bad_code_verifier", "code challenge does not match previously saved code verifier");
          const user = users.find((u) => u.id === code.userId)!;
          return issue(user, "oauth");
        }
        return fail(400, "unsupported_grant_type", `unsupported grant_type ${grant ?? "(none)"}`);
      }
      if (route === "/authorize" && req.method === "GET") {
        const provider = url.searchParams.get("provider") as StubProvider | null;
        const redirectTo = url.searchParams.get("redirect_to");
        if (provider === null || provider === "email" || !PROVIDERS.includes(provider)) return fail(400, "validation_failed", "Unsupported provider");
        if (redirectTo === null) return fail(400, "validation_failed", "redirect_to is required");
        const user = users.find((u) => u.provider === provider) ?? addUser({ email: `${provider}-user@example.invalid`, provider });
        const challenge = url.searchParams.get("code_challenge");
        const method = (url.searchParams.get("code_challenge_method") ?? "s256").toLowerCase();
        if (challenge === null || (method !== "s256" && method !== "plain")) return fail(400, "validation_failed", "PKCE code_challenge is required");
        const code = randomUUID();
        codes.set(code, { code, userId: user.id, challenge, method, provider, expiresAt: now() + 300 });
        const target = new URL(redirectTo);
        target.searchParams.set("code", code);
        return new Response(null, { status: 302, headers: { location: target.toString() } });
      }
      if (route === "/user" && req.method === "GET") {
        const who = bearer(req);
        return who instanceof Response ? who : json(200, userJson(who.user));
      }
      if (route === "/logout" && req.method === "POST") {
        const who = bearer(req);
        if (who instanceof Response) return who;
        const scope = url.searchParams.get("scope") ?? "global";
        const ended = scope === "local" ? [String(who.claims.session_id)] : [...sessions.values()].filter((s) => s.userId === who.user.id).map((s) => s.id);
        for (const id of ended) {
          sessions.delete(id);
          for (const t of refreshTokens.values()) if (t.sessionId === id) t.revoked = true;
        }
        return new Response(null, { status: 204 });
      }
      if (route === "/admin/users" && req.method === "POST") {
        if (apikey !== serviceRoleKey && req.headers.get("authorization") !== `Bearer ${serviceRoleKey}`) return fail(403, "not_admin", "User not allowed");
        const b = await body(req);
        try {
          const user = addUser({ email: String(b.email ?? ""), ...(typeof b.password === "string" ? { password: b.password } : {}) });
          return json(200, userJson(user));
        } catch (err) {
          return fail(422, "email_exists", err instanceof Error ? err.message : "exists");
        }
      }
      return json(404, { message: "no route" });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  issuer = `${url}/auth/v1`;

  return {
    url,
    anonKey,
    serviceRoleKey,
    jwtSecret,
    addUser,
    get users() {
      return users;
    },
    advanceClock: (seconds) => {
      clockOffset += seconds;
    },
    stop: () => server.stop(true),
  };
}
