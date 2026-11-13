// The oauth-pkce plugin's OAuth server and provider (fixtures/acceptance-oauth, row 1.16), one server on this computer:
// `/authorize` checks a PKCE request (S256 challenge, state, a loopback redirect) and redirects to the redirect URI with
// a code; `/token` gives its access token for that code only with the verifier whose SHA-256 is the challenge; `/v1/turn`
// answers only that token as the bearer. It records counts and whether the bearer matched, never a code or a token.
import { createHash, randomBytes } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeOAuth {
  url: string;
  port: number;
  seen: { authorized: number; exchanged: number; refusedExchanges: number; turns: { bearerMatched: boolean }[] };
  stop(): void;
}

export function startFakeOAuth(o: { reply: string }): FakeOAuth {
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  const token = `acceptance-oauth-access-${randomBytes(12).toString("hex")}`;
  const seen: FakeOAuth["seen"] = { authorized: 0, exchanged: 0, refusedExchanges: 0, turns: [] };
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
        const c = codes.get(f.get("code") ?? "");
        const ok = c !== undefined && f.get("grant_type") === "authorization_code" && f.get("redirect_uri") === c.redirect && f.get("client_id") === c.client
          && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
        if (!ok) { seen.refusedExchanges += 1; return Response.json({ error: "invalid_grant" }, { status: 400 }); }
        codes.delete(f.get("code")!);
        seen.exchanged += 1;
        return Response.json({ access_token: token, refresh_token: "acceptance-oauth-refresh", expires_in: 3600, token_type: "Bearer" });
      }
      if (u.pathname === "/v1/turn" && req.method === "POST") {
        const bearerMatched = req.headers.get("authorization") === `Bearer ${token}`;
        seen.turns.push({ bearerMatched });
        return bearerMatched ? new Response(o.reply) : new Response("no token", { status: 401 });
      }
      return new Response("not here", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, seen, stop: () => void server.stop(true) };
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
