// The oauth-pkce plugin's OAuth server and provider (fixtures/acceptance-oauth, row 1.16), one server on this computer:
// `/authorize` checks a PKCE request (S256 challenge, state, a loopback redirect) and redirects to the redirect URI with
// a code; `/token` gives a token for that code only with the verifier whose SHA-256 is the challenge, and a new one for a
// refresh token it issued (each token lives TOKEN_LIFETIME_S, inside the core's renewal window, so the core renews it
// before a turn); `/v1/turn` answers only a live token as the bearer. `revoke` ends every live token (the provider then
// answers 401, and the core renews after it). It records counts and matches, never a code or a token.
import { createHash, randomBytes } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How long a token it issues lives: under the core's RENEW_BEFORE_MS (60 s), so each keyed call renews first. */
export const TOKEN_LIFETIME_S = 30;

export interface FakeOAuth {
  url: string;
  port: number;
  seen: { authorized: number; exchanged: number; refusedExchanges: number; refreshed: number; turns: { bearerMatched: boolean }[] };
  /** Ends every live token: the provider answers them 401. */
  revoke(): void;
  stop(): void;
}

export function startFakeOAuth(o: { reply: string }): FakeOAuth {
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  const live = new Set<string>();
  const refreshes = new Set<string>();
  const issue = (): Response => {
    const access = `acceptance-oauth-access-${randomBytes(12).toString("hex")}`;
    const refresh = `acceptance-oauth-refresh-${randomBytes(12).toString("hex")}`;
    live.add(access);
    refreshes.add(refresh);
    return Response.json({ access_token: access, refresh_token: refresh, expires_in: TOKEN_LIFETIME_S, token_type: "Bearer" });
  };
  const seen: FakeOAuth["seen"] = { authorized: 0, exchanged: 0, refusedExchanges: 0, refreshed: 0, turns: [] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/authorize" && req.method === "GET") {
        const q = u.searchParams;
        const redirect = q.get("redirect_uri") ?? "";
        if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state") || !/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(redirect)) return new Response("not a PKCE request with a loopback redirect", { status: 400 });
        const code = randomBytes(12).toString("hex");
        codes.set(code, { challenge: q.get("code_challenge")!, redirect, client: q.get("client_id") ?? "" });
        seen.authorized += 1;
        return new Response(null, { status: 302, headers: { location: `${redirect}?code=${code}&state=${encodeURIComponent(q.get("state")!)}` } });
      }
      if (u.pathname === "/token" && req.method === "POST") {
        const f = new URLSearchParams(await req.text());
        if (f.get("grant_type") === "refresh_token") {
          const r = f.get("refresh_token") ?? "";
          if (!refreshes.has(r) || f.get("client_id") !== "acceptance-oauth-client") { seen.refusedExchanges += 1; return Response.json({ error: "invalid_grant" }, { status: 400 }); }
          refreshes.delete(r);
          seen.refreshed += 1;
          return issue();
        }
        const c = codes.get(f.get("code") ?? "");
        const ok = c !== undefined && f.get("grant_type") === "authorization_code" && f.get("redirect_uri") === c.redirect && f.get("client_id") === c.client
          && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
        if (!ok) { seen.refusedExchanges += 1; return Response.json({ error: "invalid_grant" }, { status: 400 }); }
        codes.delete(f.get("code")!);
        seen.exchanged += 1;
        return issue();
      }
      if (u.pathname === "/v1/turn" && req.method === "POST") {
        const bearerMatched = live.has((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
        seen.turns.push({ bearerMatched });
        return bearerMatched ? new Response(o.reply) : new Response("no token", { status: 401 });
      }
      return new Response("not here", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, seen, revoke: () => live.clear(), stop: () => void server.stop(true) };
}

/** Copies the fixture to `dest` with its OAuth server and provider at `port` on this computer. */
export function placeOAuthFixture(src: string, dest: string, port: number): void {
  cpSync(src, dest, { recursive: true });
  const base = `http://127.0.0.1:${port}`;
  const m = JSON.parse(readFileSync(join(dest, "clover.json"), "utf8")) as { capabilities: string[]; contributes: { models: { auth: { authorizeUrl: string; tokenUrl: string }[] }[] } };
  m.capabilities = [`network:127.0.0.1:${port}`];
  m.contributes.models[0]!.auth[0]!.authorizeUrl = `${base}/authorize`;
  m.contributes.models[0]!.auth[0]!.tokenUrl = `${base}/token`;
  writeFileSync(join(dest, "clover.json"), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(join(dest, "host", "endpoint.json"), `${JSON.stringify({ url: `${base}/v1/turn` }, null, 2)}\n`);
}
