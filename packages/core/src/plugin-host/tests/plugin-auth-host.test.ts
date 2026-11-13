// A plugin's sign-ins through a REAL plugin host (rows 1.16 and 1.17), each ending in a keyed call that carries what the
// sign-in stored:
//   1.17 `custom`: the bundled xAI plugin's `signIn` handler, run in the clover plugin-host process, names the core's
//        device flow; the token it lands in the slot is the one the plugin's adapter sends to its provider. A third
//        party's handler that names no core flow, or throws, is refused.
//   1.16 `oauth-pkce`: a folder-installed plugin's entry, against a fake OAuth server on loopback: the core's PKCE flow
//        (its loopback callback listener, the code exchanged with the verifier) stores the access token as the plugin's
//        own item, and the plugin's keyed fetch sends it as its bearer. The browser is the test: it fetches the
//        authorize URL the sign-in answers with and delivers the redirect to the callback.
// Temp homes, the fake approval broker, in-memory secret stores, loopback servers; nothing opens a window.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { ProviderEvent, TurnRequest } from "@waifucave/clover-provider-runtime";
import { startXaiChatFake } from "@waifucave/clover-provider-runtime/testing";
import type { SecretStore as DaemonSecretStore } from "../../auth/secret-store";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { runLoginFlow } from "../../providers/pkce";
import { buildDevBundledPlugins, devBundledSource, stageBundledPlugins, stagedBundledDir } from "../../registry/bundled-stage";
import { openPluginRegistry } from "../../registry/open";
import { startModelPlugins } from "../../runtime-sdk/model-plugins/start";
import { createPluginAuth, type OAuthRun } from "../../runtime-sdk/plugin-auth";
import { createOAuthRenewal } from "../../runtime-sdk/model-plugins/oauth-renewal";
import { startPluginHost } from "../daemon-host";

const REPO_PLUGINS = join(import.meta.dir, "..", "..", "..", "..", "..", "plugins");
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temps.push(d); return d; };

class DaemonStore implements DaemonSecretStore {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | null> { return this.values.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.values.set(name, value); }
  async delete(name: string): Promise<boolean> { return this.values.delete(name); }
}

async function text(events: AsyncIterable<ProviderEvent>): Promise<{ text: string; error?: string }> {
  let out = "";
  for await (const e of events) {
    if (e.type === "error") return { text: out, error: `${e.error.code}: ${e.error.message}` };
    if (e.type === "text_delta") out += e.text;
  }
  return { text: out };
}
const ctxOf = (providerId: string) => ({ connection: { providerId }, credentials: { get: async () => null, set: async () => {}, delete: async () => {} }, authRef: { kind: "none" }, stallTimeoutMs: 10_000, log: () => {} }) as never;
const turn = (model: string) => ({ model, messages: [{ role: "user", content: "hi" }] }) as TurnRequest;

async function approve(opened: Awaited<ReturnType<typeof openPluginRegistry>>, broker: FakeApprovalBroker, id: string): Promise<void> {
  const { card } = await opened.registry.installed(id, "app");
  const shown = broker.cards().find((c) => c.id === card)!;
  await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
  for (let i = 0; i < 200 && opened.registry.get(id)?.state === "found"; i++) await Bun.sleep(20);
}

describe("auth custom (row 1.17): the bundled xAI plugin's handler in a real plugin host", () => {
  let home: string;
  beforeAll(async () => {
    home = temp("clover-a-auth-custom-");
    await buildDevBundledPlugins({ sources: REPO_PLUGINS, ids: ["clover"], cloverHome: home });
  }, 300_000);

  test("its signIn handler names the core's device flow; the token that flow stores is what the plugin's adapter sends; a third party's handler naming no core flow, or throwing, is refused", async () => {
    const staged = stageBundledPlugins({ ...devBundledSource(home)!, out: stagedBundledDir(home) });
    const folder = join(home, "plugins", "acme-custom");
    mkdirSync(join(folder, "host"), { recursive: true });
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id: "acme-custom", name: "Acme custom", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" },
      auth: [{ method: "custom", handler: "signIn" }, { method: "custom", handler: "broken" }],
    }));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(folder, "host", "index.js"), `export const signIn = async () => ({ flow: "mine", url: "https://evil.example/login" }); export const broken = async () => { throw new Error("no"); };`);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const slots = new DaemonStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, bundledDigests: staged.digests });
    const chat = await startXaiChatFake();
    const sent: (string | null)[] = [];
    const wire = async (url: string, init: RequestInit): Promise<Response> => {
      const u = new URL(url);
      sent.push(new Headers(init.headers).get("authorization"));
      return u.hostname === "cli-chat-proxy.grok.com" ? globalThis.fetch(`${chat.url}${u.pathname}`, init) : new Response("no", { status: 599 });
    };
    let started: Awaited<ReturnType<typeof startModelPlugins>> | undefined;
    try {
      await approve(opened, broker, "acme-custom");
      started = await startModelPlugins({ registry: opened.registry, host: ph.host, pluginSecrets: ph.pluginSecrets, home, secrets: slots, fetch: wire, addApiHandlers: (h) => ph.addApiHandlers(h) });
      const auth = createPluginAuth({
        registry: opened.registry, host: ph.host, secrets: slots, pluginSecrets: secrets,
        // The device flow itself (xAI's servers) stands in here: its URL, then the token it would store.
        xaiDevice: async (store, onUrl) => {
          onUrl("https://accounts.x.ai/device?user_code=TEST");
          await store.set({ kind: "keychain", account: "xai-oauth:x" }, { kind: "oauth", accessToken: "xai-token-from-the-device-flow", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
        },
      });
      expect(await auth.list("clover/model-xai-oauth")).toEqual([expect.objectContaining({ method: "custom", state: "signed-out" })]);
      expect(await auth.signIn("clover/model-xai-oauth", 0)).toEqual({ state: "refreshing", authorizeUrl: "https://accounts.x.ai/device?user_code=TEST" });
      for (let i = 0; i < 100 && (await auth.list("clover/model-xai-oauth"))[0]!.state !== "signed-in"; i++) await Bun.sleep(20);
      expect((await auth.list("clover/model-xai-oauth"))[0]!.state).toBe("signed-in");
      // The keyed call: the plugin's adapter, its fetch keyed by the `custom` entry, carries that token.
      const adapter = started.plugins.providerAdapterFor("xai-oauth", { caller: { kind: "core" } })!;
      expect(await text(adapter.streamTurn(turn("grok-4.5"), ctxOf("xai-oauth")))).toEqual({ text: "ok" });
      expect(sent).toEqual(["Bearer xai-token-from-the-device-flow"]);
      // A third party's handler: one naming a flow of its own, one that throws. Neither runs anything.
      await expect(auth.signIn("acme-custom", 0)).rejects.toThrow(/names no sign-in flow the core runs/);
      await expect(auth.signIn("acme-custom", 1)).rejects.toThrow();
      expect((await auth.list("acme-custom")).map((v) => v.state)).toEqual(["signed-out", "signed-out"]);
    } finally {
      started?.stop();
      await ph.close();
      opened.close();
      await chat.close();
    }
  }, 120_000);
});

/** An OAuth server on loopback: `/authorize` redirects to the redirect URI with a code, `/token` exchanges the code
 *  for a token only with the verifier matching the challenge, and `/v1/turn` answers only that token. */
function fakeOAuth() {
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  const seen = { authorized: 0, verified: 0, bearer: [] as (string | null)[] };
  const token = `oauth-access-${randomBytes(6).toString("hex")}`;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/authorize") {
        const q = u.searchParams;
        if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state")) return new Response("bad authorize", { status: 400 });
        const redirect = q.get("redirect_uri") ?? "";
        if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(redirect)) return new Response("redirect must be loopback", { status: 400 });
        const code = randomBytes(8).toString("hex");
        codes.set(code, { challenge: q.get("code_challenge")!, redirect, client: q.get("client_id") ?? "" });
        seen.authorized += 1;
        return new Response(null, { status: 302, headers: { location: `${redirect}?code=${code}&state=${encodeURIComponent(q.get("state")!)}` } });
      }
      if (u.pathname === "/token" && req.method === "POST") {
        const f = new URLSearchParams(await req.text());
        const c = codes.get(f.get("code") ?? "");
        const verifier = f.get("code_verifier") ?? "";
        if (c === undefined || f.get("grant_type") !== "authorization_code" || f.get("redirect_uri") !== c.redirect || f.get("client_id") !== c.client) return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return Response.json({ error: "invalid_grant", error_description: "PKCE" }, { status: 400 });
        codes.delete(f.get("code")!);
        seen.verified += 1;
        return Response.json({ access_token: token, refresh_token: "oauth-refresh", expires_in: 3600, token_type: "Bearer" });
      }
      if (u.pathname === "/v1/turn") {
        seen.bearer.push(req.headers.get("authorization"));
        return req.headers.get("authorization") === `Bearer ${token}` ? new Response("hello over oauth") : new Response("no", { status: 401 });
      }
      return new Response("not here", { status: 404 });
    },
  });
  return { port: server.port!, url: `http://127.0.0.1:${server.port}`, seen, token, stop: () => void server.stop(true) };
}

describe("auth oauth-pkce (row 1.16): a third-party plugin's sign-in against a fake OAuth server", () => {
  test("the core's PKCE flow (its loopback callback, the code exchanged with the verifier) stores the token as the plugin's own item; its keyed fetch carries it", async () => {
    const home = temp("clover-a-auth-oauth-");
    const oauth = fakeOAuth();
    const folder = join(home, "plugins", "acme-oauth");
    mkdirSync(join(folder, "host"), { recursive: true });
    const row = (await import("@waifucave/clover-provider-catalog")).loadCatalog().models.find((m) => m.providerId === "groq")!;
    writeFileSync(join(folder, "catalog.json"), JSON.stringify({ catalog: 1, rows: [{ ...row, key: "acme-oauth/fast", providerId: "acme-oauth", upstreamId: "fast", displayName: "Fast", aliases: [] }] }));
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id: "acme-oauth", name: "Acme OAuth", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" },
      capabilities: [`network:127.0.0.1:${oauth.port}`],
      contributes: { models: [{ provider: "acme-oauth", name: "Acme OAuth", catalog: "catalog.json", adapter: "adapter",
        auth: [{ method: "oauth-pkce", authorizeUrl: `${oauth.url}/authorize`, tokenUrl: `${oauth.url}/token`, clientId: "acme-client", scopes: ["models"], secret: "oauth" }] }] },
    }));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(folder, "host", "index.js"), `
export const adapter = {
  describe: () => ({ interfaceVersion: 1, id: "plugin.acme-oauth.adapter", version: "1.0.0", family: "custom", protocol: "openai-chat", countTokens: false }),
  async *streamTurn(args, ctx) {
    const r = await ctx.api.net.fetch(${JSON.stringify(`${oauth.url}/v1/turn`)}, { method: "POST", body: "{}", signal: ctx.signal }, { auth: "oauth" });
    if (!r.ok) { yield { type: "error", error: { code: "auth", message: "status " + r.status, retryable: false } }; return; }
    yield { type: "text_delta", text: await r.text() };
    yield { type: "done", stopReason: "end_turn" };
  },
  listModels: async () => ({ models: [] }),
  validateCredential: async () => ({ ok: true }),
};`);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false });
    let started: Awaited<ReturnType<typeof startModelPlugins>> | undefined;
    try {
      expect(opened.registry.get("acme-oauth")?.issues ?? []).toEqual([]);
      // The OK card names the OAuth server's address, as every host the plugin reaches.
      expect(opened.folders.okText("acme-oauth", "macos").lines.join(" ")).toContain(`127.0.0.1:${oauth.port}`);
      await approve(opened, broker, "acme-oauth");
      started = await startModelPlugins({ registry: opened.registry, host: ph.host, pluginSecrets: ph.pluginSecrets, home, secrets: new DaemonStore(), addApiHandlers: (h) => ph.addApiHandlers(h) });
      // The daemon's own flow, on a free callback port here (the daemon's is OAUTH_CALLBACK_PORT, Codex's registration).
      const oauthRun = (entry: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] }): OAuthRun => {
        let resolveUrl!: (u: string) => void;
        const authorizeUrl = new Promise<string>((r) => { resolveUrl = r; });
        const tokens = runLoginFlow({ clientId: entry.clientId, authorizeUrl: entry.authorizeUrl, tokenUrl: entry.tokenUrl, callbackPort: 0, scope: (entry.scopes ?? []).join(" "), openBrowser: async (u) => { resolveUrl(u); } });
        return { authorizeUrl, tokens };
      };
      const auth = createPluginAuth({ registry: opened.registry, host: ph.host, secrets: new DaemonStore(), pluginSecrets: secrets, oauth: oauthRun as never });
      const signing = await auth.signIn("acme-oauth", 0);
      expect(signing.state).toBe("refreshing");
      expect(signing.authorizeUrl).toStartWith(`${oauth.url}/authorize?`);
      // The browser's part: open the authorize URL, follow its redirect to the core's loopback callback.
      const consent = await fetch(signing.authorizeUrl!, { redirect: "manual" });
      expect(consent.status).toBe(302);
      const back = await fetch(consent.headers.get("location")!);
      expect(back.status).toBe(200);
      for (let i = 0; i < 100 && (await auth.list("acme-oauth"))[0]!.state !== "signed-in"; i++) await Bun.sleep(20);
      expect((await auth.list("acme-oauth"))[0]!.state).toBe("signed-in");
      expect(oauth.seen).toMatchObject({ authorized: 1, verified: 1 });
      // Its own item now: the access token, nothing else of the exchange.
      expect((await secrets.get({ owner: { kind: "plugin", pluginId: "acme-oauth" }, name: "oauth" }))?.value.reveal()).toBe(oauth.token);
      // The keyed call carries it.
      const adapter = started.plugins.providerAdapterFor("acme-oauth", { caller: { kind: "core" } })!;
      expect(await text(adapter.streamTurn(turn("fast"), ctxOf("acme-oauth")))).toEqual({ text: "hello over oauth" });
      expect(oauth.seen.bearer).toEqual([`Bearer ${oauth.token}`]);
    } finally {
      started?.stop();
      await ph.close();
      opened.close();
      oauth.stop();
    }
  }, 120_000);

  test("the acceptance run's fixture (scripts/acceptance/fixtures/acceptance-oauth), placed as the run places it, signs in and its turn carries the token", async () => {
    const home = temp("clover-a-auth-oauth-fixture-");
    const oauth = fakeOAuth();
    const dest = join(home, "plugins", "acceptance-oauth");
    cpSync(join(import.meta.dir, "..", "..", "..", "..", "..", "scripts", "acceptance", "fixtures", "acceptance-oauth"), dest, { recursive: true });
    const m = JSON.parse(readFileSync(join(dest, "clover.json"), "utf8")) as { capabilities: string[]; contributes: { models: { auth: { authorizeUrl: string; tokenUrl: string }[] }[] } };
    m.capabilities = [`network:127.0.0.1:${oauth.port}`];
    m.contributes.models[0]!.auth[0]!.authorizeUrl = `${oauth.url}/authorize`;
    m.contributes.models[0]!.auth[0]!.tokenUrl = `${oauth.url}/token`;
    writeFileSync(join(dest, "clover.json"), JSON.stringify(m));
    writeFileSync(join(dest, "host", "endpoint.json"), JSON.stringify({ url: `${oauth.url}/v1/turn` }));
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false });
    let started: Awaited<ReturnType<typeof startModelPlugins>> | undefined;
    try {
      expect(opened.registry.get("acceptance-oauth")?.issues ?? []).toEqual([]);
      await approve(opened, broker, "acceptance-oauth");
      started = await startModelPlugins({ registry: opened.registry, host: ph.host, pluginSecrets: ph.pluginSecrets, home, secrets: new DaemonStore(), addApiHandlers: (h) => ph.addApiHandlers(h) });
      const oauthRun = (entry: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] }): OAuthRun => {
        let resolveUrl!: (u: string) => void;
        const authorizeUrl = new Promise<string>((r) => { resolveUrl = r; });
        return { authorizeUrl, tokens: runLoginFlow({ clientId: entry.clientId, authorizeUrl: entry.authorizeUrl, tokenUrl: entry.tokenUrl, callbackPort: 0, scope: (entry.scopes ?? []).join(" "), openBrowser: async (u) => { resolveUrl(u); } }) };
      };
      const auth = createPluginAuth({ registry: opened.registry, host: ph.host, secrets: new DaemonStore(), pluginSecrets: secrets, oauth: oauthRun as never });
      const signing = await auth.signIn("acceptance-oauth", 0);
      const consent = await fetch(signing.authorizeUrl!, { redirect: "manual" });
      expect((await fetch(consent.headers.get("location")!)).status).toBe(200);
      for (let i = 0; i < 100 && (await auth.list("acceptance-oauth"))[0]!.state !== "signed-in"; i++) await Bun.sleep(20);
      const adapter = started.plugins.providerAdapterFor("acceptance-oauth", { caller: { kind: "core" } })!;
      expect(await text(adapter.streamTurn(turn("oauth-fast"), ctxOf("acceptance-oauth")))).toEqual({ text: "hello over oauth" });
      expect(oauth.seen.bearer).toEqual([`Bearer ${oauth.token}`]);
    } finally {
      started?.stop();
      await ph.close();
      opened.close();
      oauth.stop();
    }
  }, 120_000);
});

/** The fake OAuth server with renewal: each token it issues is new and lives `expiresIn` seconds; a refresh-token
 *  grant gives a new token (and a new refresh token) unless refused; a token can be revoked, so the provider answers
 *  it 401. */
function renewingOAuth(o: { expiresIn: number }) {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const live = new Set<string>();
  const refreshTokens = new Set<string>();
  const seen = { refreshes: 0, refusedRefreshes: 0, bearer: [] as string[] };
  let refuse = false;
  const issue = () => {
    const access = `acc-${randomBytes(6).toString("hex")}`;
    const refresh = `ref-${randomBytes(6).toString("hex")}`;
    live.add(access);
    refreshTokens.add(refresh);
    return Response.json({ access_token: access, refresh_token: refresh, expires_in: o.expiresIn, token_type: "Bearer" });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/authorize") {
        const q = u.searchParams;
        const code = randomBytes(8).toString("hex");
        codes.set(code, { challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")! });
        return new Response(null, { status: 302, headers: { location: `${q.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(q.get("state")!)}` } });
      }
      if (u.pathname === "/token") {
        const f = new URLSearchParams(await req.text());
        if (f.get("grant_type") === "authorization_code") {
          const c = codes.get(f.get("code") ?? "");
          if (c === undefined || createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
          codes.delete(f.get("code")!);
          return issue();
        }
        if (f.get("grant_type") === "refresh_token") {
          const r = f.get("refresh_token") ?? "";
          if (refuse || !refreshTokens.has(r) || f.get("client_id") !== "acme-client") { seen.refusedRefreshes += 1; return Response.json({ error: "invalid_grant" }, { status: 400 }); }
          refreshTokens.delete(r);
          seen.refreshes += 1;
          return issue();
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      if (u.pathname === "/v1/turn") {
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        seen.bearer.push(token);
        return live.has(token) ? new Response("hello again") : new Response("no", { status: 401 });
      }
      return new Response("not here", { status: 404 });
    },
  });
  return {
    port: server.port!, url: `http://127.0.0.1:${server.port}`, seen,
    revokeAll: () => live.clear(),
    refuseRefresh: () => { refuse = true; },
    stop: () => void server.stop(true),
  };
}

describe("auth oauth-pkce renewal: a third party's token renewed at its own token endpoint", () => {
  test("near expiry it is renewed before the call; after a 401 it is renewed once and the call retried; a refused renewal signs the plugin out and says to sign in again; the refresh token never reaches the plugin", async () => {
    const home = temp("clover-a-auth-renew-");
    // A token that lives 30 s: inside RENEW_BEFORE_MS from the start.
    const oauth = renewingOAuth({ expiresIn: 30 });
    const folder = join(home, "plugins", "acme-oauth");
    mkdirSync(join(folder, "host"), { recursive: true });
    const row = (await import("@waifucave/clover-provider-catalog")).loadCatalog().models.find((m) => m.providerId === "groq")!;
    writeFileSync(join(folder, "catalog.json"), JSON.stringify({ catalog: 1, rows: [{ ...row, key: "acme-oauth/fast", providerId: "acme-oauth", upstreamId: "fast", displayName: "Fast", aliases: [] }] }));
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id: "acme-oauth", name: "Acme OAuth", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js", process: "own" },
      capabilities: [`network:127.0.0.1:${oauth.port}`],
      contributes: { models: [{ provider: "acme-oauth", name: "Acme OAuth", catalog: "catalog.json", adapter: "adapter",
        auth: [{ method: "oauth-pkce", authorizeUrl: `${oauth.url}/authorize`, tokenUrl: `${oauth.url}/token`, clientId: "acme-client", scopes: ["models"], secret: "oauth" }] }] },
    }));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(folder, "host", "index.js"), `
export const peek = async (args, ctx) => { try { return await ctx.api.secrets.get(args.name); } catch (e) { return "refused: " + e.message; } };
export const adapter = {
  describe: () => ({ interfaceVersion: 1, id: "plugin.acme-oauth.adapter", version: "1.0.0", family: "custom", protocol: "openai-chat", countTokens: false }),
  async *streamTurn(args, ctx) {
    const r = await ctx.api.net.fetch(${JSON.stringify(`${oauth.url}/v1/turn`)}, { method: "POST", body: "{}", signal: ctx.signal }, { auth: "oauth" });
    if (!r.ok) { yield { type: "error", error: { code: "auth", message: "status " + r.status, retryable: false } }; return; }
    yield { type: "text_delta", text: await r.text() };
    yield { type: "done", stopReason: "end_turn" };
  },
  listModels: async () => ({ models: [] }),
  validateCredential: async () => ({ ok: true }),
};`);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false });
    const signedOut: string[] = [];
    const renewal = createOAuthRenewal({ store: secrets, registry: opened.registry, onSignedOut: (id, _s, reason) => { signedOut.push(`${id}: ${reason}`); } });
    let started: Awaited<ReturnType<typeof startModelPlugins>> | undefined;
    try {
      await approve(opened, broker, "acme-oauth");
      started = await startModelPlugins({ registry: opened.registry, host: ph.host, pluginSecrets: ph.pluginSecrets, home, secrets: new DaemonStore(), addApiHandlers: (h) => ph.addApiHandlers(h), oauth: renewal });
      const oauthRun = (entry: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] }): OAuthRun => {
        let resolveUrl!: (u: string) => void;
        const authorizeUrl = new Promise<string>((r) => { resolveUrl = r; });
        return { authorizeUrl, tokens: runLoginFlow({ clientId: entry.clientId, authorizeUrl: entry.authorizeUrl, tokenUrl: entry.tokenUrl, callbackPort: 0, scope: (entry.scopes ?? []).join(" "), openBrowser: async (u) => { resolveUrl(u); } }) };
      };
      const auth = createPluginAuth({ registry: opened.registry, host: ph.host, secrets: new DaemonStore(), pluginSecrets: secrets, oauth: oauthRun as never, oauthRenewal: renewal });
      const signing = await auth.signIn("acme-oauth", 0);
      await fetch((await fetch(signing.authorizeUrl!, { redirect: "manual" })).headers.get("location")!);
      for (let i = 0; i < 100 && (await auth.list("acme-oauth"))[0]!.state !== "signed-in"; i++) await Bun.sleep(20);
      const first = (await secrets.get({ owner: { kind: "plugin", pluginId: "acme-oauth" }, name: "oauth" }))!.value.reveal();
      // The plugin's own items hold the access token alone; the refresh token is a device item it has no name for.
      expect((await secrets.list({ kind: "plugin", pluginId: "acme-oauth" })).map((m) => m.ref.name)).toEqual(["oauth"]);
      expect(await ph.host.invoke({ pluginId: "acme-oauth", handler: "peek", args: { name: "oauth" }, caller: { kind: "user", client: "app" } })).toBe(first);
      expect(String(await ph.host.invoke({ pluginId: "acme-oauth", handler: "peek", args: { name: "plugin-oauth" }, caller: { kind: "user", client: "app" } }))).toStartWith("refused");
      const adapter = started.plugins.providerAdapterFor("acme-oauth", { caller: { kind: "core" } })!;
      // 1. Near expiry: renewed before the call, which carries the new token.
      expect(await text(adapter.streamTurn(turn("fast"), ctxOf("acme-oauth")))).toEqual({ text: "hello again" });
      expect(oauth.seen.refreshes).toBeGreaterThanOrEqual(1);
      expect(oauth.seen.bearer.at(-1)).not.toBe(first);
      // 2. A 401 (the token revoked): renewed once, the call retried once, and it goes through.
      const refreshes = oauth.seen.refreshes;
      oauth.revokeAll();
      const bearers = oauth.seen.bearer.length;
      expect(await text(adapter.streamTurn(turn("fast"), ctxOf("acme-oauth")))).toEqual({ text: "hello again" });
      expect(oauth.seen.refreshes).toBeGreaterThan(refreshes);
      expect(oauth.seen.bearer.length - bearers).toBeLessThanOrEqual(3);
      // 3. The service refuses the renewal: signed out, with the reason the user reads; the call fails.
      oauth.revokeAll();
      oauth.refuseRefresh();
      const out = await text(adapter.streamTurn(turn("fast"), ctxOf("acme-oauth")));
      expect(out.error).toBeDefined();
      expect(signedOut).toEqual([expect.stringContaining("acme-oauth: Your sign-in to Acme OAuth expired and couldn't be renewed (the service answered 400 invalid_grant): sign in again.")]);
      expect(await auth.list("acme-oauth")).toEqual([expect.objectContaining({ state: "signed-out", reason: expect.stringContaining("sign in again") })]);
      expect(await secrets.get({ owner: { kind: "plugin", pluginId: "acme-oauth" }, name: "oauth" })).toBeNull();
      // Signing in again clears the notice.
      const again = await auth.signIn("acme-oauth", 0);
      await fetch((await fetch(again.authorizeUrl!, { redirect: "manual" })).headers.get("location")!);
      for (let i = 0; i < 100 && (await auth.list("acme-oauth"))[0]!.state !== "signed-in"; i++) await Bun.sleep(20);
      expect((await auth.list("acme-oauth"))[0]).toEqual(expect.not.objectContaining({ reason: expect.anything() }));
    } finally {
      started?.stop();
      await ph.close();
      opened.close();
      oauth.stop();
    }
  }, 120_000);
});
