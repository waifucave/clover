// The daemon's account settings (account-config.ts): production's by default, account.json read strictly, the
// environment only in dev and test builds, and plain http only to this machine there.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { ACCOUNT_CONFIG_FILE, PRODUCTION_ACCOUNT_SERVICE, PRODUCTION_ACCOUNT_SETTINGS, resolveAccountConfig, waifucaveAccount } from "../account-config";
import { DeviceKey } from "../device-key";

const PROD_HANDSHAKE = "https://handshake.waifucave.com";

function home(file?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "clover-account-config-"));
  if (file !== undefined) writeFileSync(join(dir, ACCOUNT_CONFIG_FILE), typeof file === "string" ? file : JSON.stringify(file));
  return dir;
}

const quiet = () => {};

describe("the account settings", () => {
  test("by default: production's service and handshake, and the account off for want of a sign-in project", () => {
    const r = resolveAccountConfig({ home: home(), env: {}, distBuild: true, log: quiet });
    expect(r.account).toBeNull();
    expect(r.off).toContain("authUrl, anonKey");
    expect(r.handshakeUrl).toBe(PROD_HANDSHAKE);
    expect(r.sources).toEqual({ serviceUrl: "default", handshakeUrl: "default" });
    expect(r.problems).toEqual([]);
  });

  test("account.json sets the sign-in project; the service stays production's", () => {
    const r = resolveAccountConfig({
      home: home({ authUrl: "https://abc.supabase.co/", anonKey: "eyJhbGciOiJIUzI1NiJ9.public", emailSignInUrl: "https://waifucave.com/sign-in" }),
      env: {},
      distBuild: true,
      log: quiet,
    });
    expect(r.account).toEqual({ authUrl: "https://abc.supabase.co", anonKey: "eyJhbGciOiJIUzI1NiJ9.public", serviceUrl: PRODUCTION_ACCOUNT_SERVICE, emailSignInUrl: "https://waifucave.com/sign-in" });
    expect(r.off).toBeUndefined();
  });

  test("a key the file doesn't take refuses the whole file, and its value is never repeated", () => {
    const secret = "super-secret-refresh-token-value";
    const r = resolveAccountConfig({ home: home({ authUrl: "https://abc.supabase.co", anonKey: "k", refreshToken: secret }), env: {}, distBuild: true, log: quiet });
    expect(r.account).toBeNull();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('"refreshToken"');
    expect(r.problems[0]).toContain("secret store");
    expect(r.problems.join(" ")).not.toContain(secret);
    for (const bad of ["{not json", "[]", JSON.stringify({ authUrl: 7 })]) {
      const b = resolveAccountConfig({ home: home(bad), env: {}, distBuild: true, log: quiet });
      expect(b.account).toBeNull();
      expect(b.problems[0]).toContain("nothing in it was used");
    }
  });

  test("inherited names are keys it doesn't take: each refuses the file", () => {
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      // Raw JSON, so "__proto__" is a key of the file and not the literal's prototype.
      const raw = `{"authUrl":"https://abc.supabase.co","anonKey":"k",${JSON.stringify(name)}:"https://evil.example"}`;
      const r = resolveAccountConfig({ home: home(raw), env: {}, distBuild: false, log: quiet });
      expect(r.account).toBeNull();
      expect(r.problems[0]).toContain("nothing in it was used");
      expect(r.problems.join(" ")).not.toContain("evil.example");
    }
  });

  test("a refused key is named only when it looks like a setting's name", () => {
    const pasted = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln";
    const r = resolveAccountConfig({ home: home({ authUrl: "https://abc.supabase.co", [pasted]: "x" }), env: {}, distBuild: true, log: quiet });
    expect(r.problems[0]).toContain("an unexpected key");
    expect(r.problems.join(" ")).not.toContain(pasted);
    const named = resolveAccountConfig({ home: home({ refresh_token: "x" }), env: {}, distBuild: true, log: quiet });
    expect(named.problems[0]).toContain('("refresh_token")');
  });

  test("a file that can't be read is reported as unreadable, not as bad JSON", () => {
    const dir = home();
    mkdirSync(join(dir, ACCOUNT_CONFIG_FILE));
    const r = resolveAccountConfig({ home: dir, env: {}, distBuild: true, log: quiet });
    expect(r.problems[0]).toContain("can't be read");
    expect(r.problems[0]).not.toContain("isn't JSON");
  });

  test("a release build takes from the file only what production lacks, and says so once", () => {
    const file = { authUrl: "https://abc.supabase.co", anonKey: "k", serviceUrl: "https://other.example/auth", handshakeUrl: "https://other.example" };
    const lines: string[] = [];
    const dist = resolveAccountConfig({ home: home(file), env: {}, distBuild: true, log: (l) => lines.push(l) });
    expect(dist.account).toEqual({ authUrl: "https://abc.supabase.co", anonKey: "k", serviceUrl: PRODUCTION_ACCOUNT_SERVICE });
    expect(dist.handshakeUrl).toBe(PROD_HANDSHAKE);
    expect(dist.sources).toEqual({ authUrl: "file", anonKey: "file", serviceUrl: "default", handshakeUrl: "default" });
    expect(dist.problems.filter((p) => p.includes("a release build keeps production's"))).toHaveLength(2);
    expect(lines).toEqual([`[account] the account settings came from ${ACCOUNT_CONFIG_FILE}`]);

    // A dev build takes the whole file.
    const dev = resolveAccountConfig({ home: home(file), env: {}, distBuild: false, log: quiet });
    expect(dev.account?.serviceUrl).toBe("https://other.example/auth");
    expect(dev.handshakeUrl).toBe("https://other.example");

    // Once production has every setting, a release build ignores the file entirely, and says nothing of it.
    const full = { ...PRODUCTION_ACCOUNT_SETTINGS, authUrl: "https://prod.supabase.co", anonKey: "prod-anon" };
    const later: string[] = [];
    const sealed = resolveAccountConfig({ home: home(file), env: {}, distBuild: true, production: full, log: (l) => later.push(l) });
    expect(sealed.account).toEqual({ authUrl: "https://prod.supabase.co", anonKey: "prod-anon", serviceUrl: PRODUCTION_ACCOUNT_SERVICE });
    expect(Object.values(sealed.sources)).not.toContain("file");
    expect(later).toEqual([]);
  });

  test("the environment overrides in dev and test builds only; a release build ignores it", () => {
    const env = {
      CLOVER_ACCOUNT_AUTH_URL: "http://127.0.0.1:54321",
      CLOVER_ACCOUNT_ANON_KEY: "dev-anon",
      CLOVER_ACCOUNT_SERVICE_URL: "http://localhost:8787",
      CLOVER_HANDSHAKE_URL: "http://[::1]:8788",
    };
    const file = { authUrl: "https://abc.supabase.co", anonKey: "file-anon" };
    const dev = resolveAccountConfig({ home: home(file), env, distBuild: false, log: quiet });
    expect(dev.account).toEqual({ authUrl: "http://127.0.0.1:54321", anonKey: "dev-anon", serviceUrl: "http://localhost:8787" });
    expect(dev.handshakeUrl).toBe("http://[::1]:8788");
    expect(dev.sources.authUrl).toBe("env");

    const logged: string[] = [];
    const dist = resolveAccountConfig({ home: home(file), env, distBuild: true, log: (l) => logged.push(l) });
    expect(dist.account).toEqual({ authUrl: "https://abc.supabase.co", anonKey: "file-anon", serviceUrl: PRODUCTION_ACCOUNT_SERVICE });
    expect(dist.handshakeUrl).toBe(PROD_HANDSHAKE);
    expect(Object.values(dist.sources)).not.toContain("env");
  });

  test("https only; plain http just to this machine, and only where the environment may override", () => {
    const loopback = { authUrl: "http://127.0.0.1:54321", anonKey: "k", serviceUrl: "http://localhost:8787", handshakeUrl: "http://127.0.0.1:8788" };
    const dev = resolveAccountConfig({ home: home(loopback), env: {}, distBuild: false, log: quiet });
    expect(dev.account?.authUrl).toBe("http://127.0.0.1:54321");
    expect(dev.handshakeUrl).toBe("http://127.0.0.1:8788");

    const dist = resolveAccountConfig({ home: home(loopback), env: {}, distBuild: true, log: quiet });
    expect(dist.account).toBeNull();
    expect(dist.handshakeUrl).toBe(PROD_HANDSHAKE);
    expect(dist.problems.some((p) => p.startsWith("authUrl") && p.includes("dev and test builds only"))).toBe(true);

    for (const authUrl of ["http://abc.supabase.co", "ftp://abc.supabase.co", "https://user:pw@abc.supabase.co", "not a url"]) {
      const r = resolveAccountConfig({ home: home({ authUrl, anonKey: "k" }), env: {}, distBuild: false, log: quiet });
      expect(r.account).toBeNull();
      expect(r.problems[0]?.startsWith("authUrl")).toBe(true);
      expect(r.problems.join(" ")).not.toContain("pw@");
    }
    const spaced = resolveAccountConfig({ home: home({ authUrl: "https://abc.supabase.co", anonKey: "a key" }), env: {}, distBuild: true, log: quiet });
    expect(spaced.account).toBeNull();
  });
});

describe("what the daemon hands its links", () => {
  test("an account client on this device's key from the secret store, and the handshake's rendezvous", async () => {
    const store = new MemorySecretStore();
    const made = await waifucaveAccount({ home: home({ authUrl: "https://abc.supabase.co", anonKey: "k" }), store, clock: { now: () => Date.now() }, env: {}, distBuild: true, log: quiet });
    expect(made.account).toBeDefined();
    expect(made.handshakeUrl).toBe(PROD_HANDSHAKE);
    expect(typeof made.rendezvous.publish).toBe("function");
    // The links load the same key.
    const key = await DeviceKey.loadOrCreate(store);
    expect(key.id).toBe((await DeviceKey.loadOrCreate(store)).id);
    expect(await made.account!.accountId()).toBeNull();
  });

  test("no account client when the account is off, and no key made for it", async () => {
    const store = new MemorySecretStore();
    const lines: string[] = [];
    const made = await waifucaveAccount({ home: home(), store, clock: { now: () => Date.now() }, env: {}, distBuild: true, log: (l) => lines.push(l) });
    expect(made.account).toBeUndefined();
    expect(made.config.off).toBeDefined();
    expect(lines.some((l) => l.includes("runs signed out"))).toBe(true);
    expect(await store.list()).toEqual([]);
  });
});
