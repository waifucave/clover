// The sign-in stub against the real Supabase client, the one waifucave's own apps use.
import { afterEach, describe, expect, test } from "bun:test";
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
