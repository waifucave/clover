// The sign-in stub against the real Supabase client, the one waifucave's own apps use.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { startSignInStub, verifyHs256, type SignInStub } from "../src/signin-stub";

let stub: SignInStub | undefined;
afterEach(() => {
  stub?.stop();
  stub = undefined;
});

function client(s: SignInStub, key = s.anonKey) {
  return createClient(s.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" } });
}

describe("the sign-in stub", () => {
  test("email and password: sign in, read the user, refresh, sign out", async () => {
    stub = startSignInStub();
    const user = stub.addUser({ email: "Someone@Example.invalid", password: "a test password" });
    const supabase = client(stub);

    const wrong = await supabase.auth.signInWithPassword({ email: "someone@example.invalid", password: "nope" });
    expect(wrong.error?.code).toBe("invalid_credentials");

    const signedIn = await supabase.auth.signInWithPassword({ email: "someone@example.invalid", password: "a test password" });
    expect(signedIn.error).toBeNull();
    const session = signedIn.data.session!;
    expect(session.user.id).toBe(user.id);
    expect(session.expires_in).toBe(3600);
    const claims = verifyHs256(session.access_token, stub.jwtSecret)!;
    expect(claims).toMatchObject({ sub: user.id, role: "authenticated", aud: "authenticated", email: "someone@example.invalid", iss: `${stub.url}/auth/v1` });

    const me = await supabase.auth.getUser(session.access_token);
    expect(me.data.user?.email).toBe("someone@example.invalid");

    const refreshed = await supabase.auth.refreshSession({ refresh_token: session.refresh_token });
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session!.refresh_token).not.toBe(session.refresh_token);

    const signedOut = await supabase.auth.signOut();
    expect(signedOut.error).toBeNull();
    const after = await client(stub).auth.getUser(refreshed.data.session!.access_token);
    expect(after.error).not.toBeNull();
  });

  test("a refresh token works once; reusing it ends the session (only the refresher refreshes)", async () => {
    stub = startSignInStub();
    stub.addUser({ email: "a@example.invalid", password: "pw" });
    const raw = async (body: unknown) => fetch(`${stub!.url}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: stub!.anonKey, "content-type": "application/json" }, body: JSON.stringify(body) });
    const first = await (await fetch(`${stub.url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: stub.anonKey, "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.invalid", password: "pw" }) })).json() as { refresh_token: string };
    const second = await (await raw({ refresh_token: first.refresh_token })).json() as { refresh_token: string };
    const reused = await raw({ refresh_token: first.refresh_token });
    expect(reused.status).toBe(400);
    expect(((await reused.json()) as { error_code: string }).error_code).toBe("refresh_token_already_used");
    // The reuse revoked the session's newer token too.
    expect(((await (await raw({ refresh_token: second.refresh_token })).json()) as { error_code: string }).error_code).toBe("refresh_token_not_found");
  });

  test("OAuth with PKCE: Discord consents as its stub user, and the code is exchanged once", async () => {
    stub = startSignInStub();
    const supabase = client(stub);
    const started = await supabase.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: "http://127.0.0.1:9/callback", skipBrowserRedirect: true } });
    expect(started.error).toBeNull();
    const authorize = await fetch(started.data.url!, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const code = new URL(authorize.headers.get("location")!).searchParams.get("code")!;
    const exchanged = await supabase.auth.exchangeCodeForSession(code);
    expect(exchanged.error).toBeNull();
    expect(exchanged.data.session!.user.app_metadata.provider).toBe("discord");
    expect(stub.users.map((u) => u.provider)).toEqual(["discord"]);
    // A code is good for one exchange.
    const again = await fetch(`${stub.url}/auth/v1/token?grant_type=pkce`, { method: "POST", headers: { apikey: stub.anonKey, "content-type": "application/json" }, body: JSON.stringify({ auth_code: code, code_verifier: "x" }) });
    expect(again.status).toBe(400);
  });

  test("the email sign-in page: a form for the client's challenge, and a code back to the loopback for the right password", async () => {
    stub = startSignInStub();
    const user = stub.addUser({ email: "d@example.invalid", password: "pw <&>" });
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectTo = "http://127.0.0.1:9/callback?state=abc";
    const start = new URL(stub.emailSignInUrl);
    start.search = new URLSearchParams({ redirect_to: redirectTo, code_challenge: challenge, code_challenge_method: "s256" }).toString();

    // GET: the form carries the challenge and where to go back, and needs no project key (it's the browser's page).
    const form = await fetch(start);
    expect(form.status).toBe(200);
    expect(form.headers.get("content-type")).toContain("text/html");
    const html = await form.text();
    expect(html).toContain(`name="code_challenge" value="${challenge}"`);
    expect(html).toContain('name="redirect_to" value="http://127.0.0.1:9/callback?state=abc"');
    expect(html).toContain('type="password"');

    const post = (fields: Record<string, string>) => fetch(stub!.emailSignInUrl, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ redirect_to: redirectTo, code_challenge: challenge, code_challenge_method: "s256", ...fields }).toString(),
    });
    // A wrong password shows the form again, with the email kept and no code issued.
    const wrong = await post({ email: "d@example.invalid", password: "nope", action: "signin" });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('value="d@example.invalid"');

    const right = await post({ email: "D@example.invalid", password: "pw <&>", action: "signin" });
    expect(right.status).toBe(302);
    const back = new URL(right.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("http://127.0.0.1:9/callback");
    expect(back.searchParams.get("state")).toBe("abc");
    const code = back.searchParams.get("code")!;

    const exchange = (auth_code: string, code_verifier: string) => fetch(`${stub!.url}/auth/v1/token?grant_type=pkce`, {
      method: "POST", headers: { apikey: stub!.anonKey, "content-type": "application/json" }, body: JSON.stringify({ auth_code, code_verifier }),
    });
    const session = await (await exchange(code, verifier)).json() as { access_token: string; user: { id: string } };
    expect(session.user.id).toBe(user.id);
    expect(verifyHs256(session.access_token, stub.jwtSecret)).toMatchObject({ sub: user.id, app_metadata: { provider: "email" }, amr: [{ method: "password" }] });
    // Once only.
    expect((await exchange(code, verifier)).status).toBe(400);

    // Cancel goes back with an error and no code.
    const cancelled = new URL((await post({ action: "cancel" })).headers.get("location")!);
    expect(cancelled.searchParams.get("code")).toBeNull();
    expect(cancelled.searchParams.get("error")).toBe("access_denied");
  });

  test("the email sign-in page sends the browser only back to the loopback, and only with a PKCE challenge", async () => {
    stub = startSignInStub();
    const at = (q: Record<string, string>) => fetch(`${stub!.emailSignInUrl}?${new URLSearchParams(q)}`, { redirect: "manual" });
    expect((await at({ redirect_to: "https://example.invalid/callback", code_challenge: "x" })).status).toBe(400);
    expect((await at({ redirect_to: "http://127.0.0.1:9/callback" })).status).toBe(400);
    expect((await at({ redirect_to: "http://127.0.0.1:9/callback", code_challenge: "x", code_challenge_method: "md5" })).status).toBe(400);
    expect((await at({ redirect_to: "http://127.0.0.1:9/callback", code_challenge: "x" })).status).toBe(200);
    // The markup can't be broken out of through the query.
    const html = await (await at({ redirect_to: "http://127.0.0.1:9/callback?x=\"><script>", code_challenge: "\"><b>" })).text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
  });

  test("tokens expire on the stub's clock, and every call needs the project key", async () => {
    stub = startSignInStub({ accessTokenTtlSeconds: 60 });
    stub.addUser({ email: "b@example.invalid", password: "pw" });
    const supabase = client(stub);
    const { data } = await supabase.auth.signInWithPassword({ email: "b@example.invalid", password: "pw" });
    expect((await supabase.auth.getUser(data.session!.access_token)).error).toBeNull();
    stub.advanceClock(61);
    expect((await supabase.auth.getUser(data.session!.access_token)).error).not.toBeNull();
    expect((await fetch(`${stub.url}/auth/v1/settings`)).status).toBe(401);
    expect((await fetch(`${stub.url}/auth/v1/settings`, { headers: { apikey: stub.anonKey } })).status).toBe(200);
  });

  test("the admin door creates users with the service key only", async () => {
    stub = startSignInStub();
    const anon = await client(stub).auth.admin.createUser({ email: "c@example.invalid", password: "pw", email_confirm: true });
    expect(anon.error).not.toBeNull();
    const admin = await client(stub, stub.serviceRoleKey).auth.admin.createUser({ email: "c@example.invalid", password: "pw", email_confirm: true });
    expect(admin.error).toBeNull();
    expect(admin.data.user?.email).toBe("c@example.invalid");
  });
});
