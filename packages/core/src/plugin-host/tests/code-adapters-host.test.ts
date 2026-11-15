// The model plugins' code adapters through a REAL plugin host (rows 1.42 and 1.92): the bundled `clover` tree built
// and staged as a dev run stages it, the real plugin host (processes, workers, the fd-3 link), the model plugins
// started on it with their adapters served (`serveCodeAdapters`), and a fake provider wire under the core's keyed
// fetch: the daemon's platform fetch seam sends each request to a loopback fake of its provider, and records what was
// really sent (the key included, which no fake records). A turn goes the way a session's does: the host-served stub,
// the core's adapter server, `PluginHost.stream` into the plugin's worker (or its own process), the plugin's
// `net.fetch` back across the link, the keyed fetch, the fake. The plugin processes are fenced as the daemon fences
// them. That the key reaches the plugin in no form, on either leg of the link, is net-fetch-link.test.ts's (and a
// streamed request body's); here the key is checked where the core places it. Temp home, the fake approval broker,
// in-memory secret stores; nothing opens a window.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bedrockFake, codexFake, geminiFake, openaiResponsesFake, startFake, sseResponse, vertexFake, type FakeServer } from "@waifucave/clover-provider-conformance/fakes";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "@waifucave/clover-provider-runtime";
import { startXaiChatFake } from "@waifucave/clover-provider-runtime/testing";
import type { SecretStore as DaemonSecretStore } from "../../auth/secret-store";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { buildDevBundledPlugins, devBundledSource, stageBundledPlugins, stagedBundledDir } from "../../registry/bundled-stage";
import { openPluginRegistry } from "../../registry/open";
import { CODE_PLUGINS } from "../../runtime-sdk/model-plugins/bundled";
import { startModelPlugins, type StartedModelPlugins } from "../../runtime-sdk/model-plugins/start";
import { userEndpointOf } from "../../runtime-sdk/model-plugins/user-endpoint";
import type { Settings } from "../../settings";
import { startPluginHost } from "../daemon-host";

const REPO_PLUGINS = join(import.meta.dir, "..", "..", "..", "..", "..", "plugins");
const GOOGLE_KEY = "AIza-codeadapters-0123456789abcdef";

/** The daemon's own store (the provider slots), in memory. */
class DaemonStore implements DaemonSecretStore {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | null> { return this.values.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.values.set(name, value); }
  async delete(name: string): Promise<boolean> { return this.values.delete(name); }
}

/** What the platform fetch under the keyed fetch was asked to send: the real request, before any fake redacts it. */
interface Sent { host: string; path: string; headers: Record<string, string>; signal?: AbortSignal }

let home: string;
let ph: Awaited<ReturnType<typeof startPluginHost>>;
let opened: Awaited<ReturnType<typeof openPluginRegistry>>;
let started: StartedModelPlugins;
const daemonStore = new DaemonStore();
const sent: Sent[] = [];
/** Each provider host's fake, by host name. */
const wires = new Map<string, FakeServer>();
const lines: string[] = [];
let refreshed = 0;
/** The user's settings, as the daemon holds them live: `providers.<id>.baseUrl` is read at each call. */
let userSettings: Settings | null = null;

/** The fake provider wire: the keyed fetch's platform fetch, to each host's loopback fake. */
async function wire(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  sent.push({ host: u.hostname, path: u.pathname, headers, ...(init.signal ? { signal: init.signal } : {}) });
  const fake = wires.get(u.hostname);
  if (fake === undefined) return new Response(`no fake for ${u.hostname}`, { status: 599 });
  // The request goes to the loopback fake under its real host's name (a signed request signs its host).
  const forwarded = new Headers(init.headers);
  forwarded.set("host", u.host);
  return globalThis.fetch(`${fake.url}${u.pathname}${u.search}`, { ...init, headers: forwarded });
}

async function text(events: AsyncIterable<ProviderEvent>): Promise<string> {
  let out = "";
  for await (const e of events) {
    if (e.type === "error") throw new Error(`${e.error.code}: ${e.error.message}`);
    if (e.type === "text_delta") out += e.text;
  }
  return out;
}

const ctxOf = (providerId: string, extra: Record<string, unknown> = {}) => ({
  connection: { providerId, ...extra } as never,
  credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
  authRef: { kind: "none" as const }, stallTimeoutMs: 20_000, log: () => {},
}) as never;

function adapterOf(provider: string): ProviderAdapter {
  const a = started.plugins.providerAdapterFor(provider, { caller: { kind: "core" } });
  if (a === undefined) throw new Error(`${provider} has no served adapter`);
  return a;
}

const turn = (model: string, signal?: AbortSignal): TurnRequest => ({ model, messages: [{ role: "user", content: "hi" }], ...(signal ? { signal } : {}) }) as TurnRequest;

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-codeadapters-")));
  await buildDevBundledPlugins({ sources: REPO_PLUGINS, ids: ["clover"], cloverHome: home });
  const staged = stageBundledPlugins({ ...devBundledSource(home)!, out: stagedBundledDir(home) });
  mkdirSync(join(home, "plugins"), { recursive: true });
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50 });
  const userEndpoint = (id: string) => userEndpointOf(opened.registry.get(id), userSettings);
  ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, bundledDigests: staged.digests, userEndpoint });
  started = await startModelPlugins({
    registry: opened.registry, host: ph.host, pluginSecrets: ph.pluginSecrets, home, secrets: daemonStore,
    fetch: wire, addApiHandlers: (h) => ph.addApiHandlers(h), serveCodeAdapters: true, log: (l) => lines.push(l), userEndpoint,
    // Codex's sign-in renews as the daemon's refresher does: a newer access token in its slot.
    refreshers: { "codex-oauth:default": async () => { refreshed += 1; daemonStore.values.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: codexFake.FAKE_REFRESHED_ACCESS_TOKEN, accountId: codexFake.FAKE_ACCOUNT_ID })); } },
  });
}, 300_000);

afterAll(async () => {
  started?.stop();
  await ph?.close();
  opened?.close();
  for (const f of wires.values()) await f.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the bundled code adapters through a real plugin host", () => {
  test("all six describe themselves from their plugins and are served; none is left on the compiled path", () => {
    const snap = started.plugins.snapshot!;
    expect(snap.refused).toEqual([]);
    expect([...snap.served.values()].map((s) => s.provider).sort()).toEqual(Object.keys(CODE_PLUGINS).sort());
    expect(lines.some((l) => l.includes("compiled path"))).toBe(false);
  });

  test("Google: a turn streams from the fake through the plugin's worker; the key is placed in x-goog-api-key by the core", async () => {
    wires.set("generativelanguage.googleapis.com", await startFake({ routes: geminiFake.geminiFakeRoutes({ stream: { "gemini-2.5-flash": [geminiFake.geminiStreamResponse([{ parts: [{ text: "hello from " }] }, { parts: [{ text: "gemini" }], finishReason: "STOP" }])] } }) }));
    daemonStore.values.set("google:default", JSON.stringify({ kind: "api-key", key: GOOGLE_KEY }));
    sent.length = 0;
    expect(await text(adapterOf("google").streamTurn(turn("gemini-2.5-flash"), ctxOf("google", { baseUrl: "https://generativelanguage.googleapis.com" })))).toBe("hello from gemini");
    const req = sent.find((s) => s.path.includes(":streamGenerateContent"))!;
    expect(req.headers["x-goog-api-key"]).toBe(GOOGLE_KEY);
  }, 60_000);

  test("Google: response headers cross back (a 429's Retry-After sets the adapter's retry delay); the plugin's own request headers reach the wire", async () => {
    await wires.get("generativelanguage.googleapis.com")?.close();
    wires.set("generativelanguage.googleapis.com", await startFake({ routes: geminiFake.geminiFakeRoutes({ stream: { "gemini-2.5-pro": [
      geminiFake.geminiError(429, "RESOURCE_EXHAUSTED", "slow down", { "retry-after": "2" }),
      geminiFake.geminiStreamResponse([{ parts: [{ text: "after the wait" }], finishReason: "STOP" }]),
    ] } }) }));
    sent.length = 0;
    const events: ProviderEvent[] = [];
    for await (const e of adapterOf("google").streamTurn(turn("gemini-2.5-pro"), ctxOf("google", { baseUrl: "https://generativelanguage.googleapis.com" }))) events.push(e);
    const retry = events.find((e) => e.type === "retry") as Extract<ProviderEvent, { type: "retry" }> | undefined;
    expect(retry?.errorStatus).toBe(429);
    expect(retry?.retryDelayMs).toBe(2000);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("after the wait");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers["content-type"]).toContain("application/json");
  }, 60_000);

  test("an abort mid-stream reaches the wire: the request's signal ends and the stream stops", async () => {
    await wires.get("generativelanguage.googleapis.com")?.close();
    const slow = Array.from({ length: 40 }, (_, i) => ({ parts: [{ text: `piece${i} ` }], delayMs: 100 }));
    wires.set("generativelanguage.googleapis.com", await startFake({ routes: geminiFake.geminiFakeRoutes({ stream: { "gemini-2.5-flash-lite": [geminiFake.geminiStreamResponse([...slow, { parts: [{ text: "end" }], finishReason: "STOP" }])] } }) }));
    sent.length = 0;
    const abort = new AbortController();
    let got = "";
    try {
      for await (const e of adapterOf("google").streamTurn(turn("gemini-2.5-flash-lite", abort.signal), ctxOf("google", { baseUrl: "https://generativelanguage.googleapis.com" }))) {
        if (e.type === "text_delta") { got += e.text; if (got.includes("piece1 ")) abort.abort(); }
      }
    } catch {
      // the internal-jobs stub ends a cancelled call with an error; what matters is where the abort went
    }
    expect(got).not.toContain("end");
    const req = sent.find((s) => s.path.includes(":streamGenerateContent"))!;
    for (let i = 0; i < 100 && req.signal?.aborted !== true; i++) await Bun.sleep(20);
    expect(req.signal?.aborted).toBe(true);
  }, 60_000);

  test("Codex: a turn on its plugin with the slot's sign-in, the account id filled in and Clover's originator; a 401 renews the token once and retries", async () => {
    const fake = await codexFake.startCodexFake({ scenarios: { "gpt-5.6-luna": [openaiResponsesFake.responsesStream({ text: ["hello from ", "codex"] })] }, requireRefreshFor: ["gpt-5.6-luna"] });
    wires.set("chatgpt.com", fake);
    daemonStore.values.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: codexFake.FAKE_ACCESS_TOKEN, accountId: codexFake.FAKE_ACCOUNT_ID }));
    sent.length = 0;
    expect(await text(adapterOf("codex-oauth").streamTurn(turn("gpt-5.6-luna"), ctxOf("codex-oauth")))).toBe("hello from codex");
    expect(refreshed).toBe(1);
    expect((fake as unknown as { bearers: string[] }).bearers).toEqual([codexFake.FAKE_ACCESS_TOKEN, codexFake.FAKE_REFRESHED_ACCESS_TOKEN]);
    const last = sent.filter((s) => s.path.endsWith("/responses")).at(-1)!;
    expect(last.headers["chatgpt-account-id"]).toBe(codexFake.FAKE_ACCOUNT_ID);
    expect(last.headers["originator"]).toBe("clover");
  }, 60_000);

  test("Bedrock: in a Bun process of its own, it reads its secret with secrets.get and signs each request (SigV4), which the fake verifies", async () => {
    const fake = await bedrockFake.startBedrockFake({ scenarios: { "amazon.nova-lite-v1:0": [bedrockFake.eventStreamResponse(bedrockFake.textTurnFrames("hello from bedrock"))] } });
    wires.set(`bedrock-runtime.${bedrockFake.FAKE_REGION}.amazonaws.com`, fake);
    daemonStore.values.set("bedrock:default", JSON.stringify({ kind: "aws", accessKeyId: bedrockFake.FAKE_ACCESS_KEY_ID, secretAccessKey: bedrockFake.FAKE_SECRET_ACCESS_KEY }));
    expect(ph.host.status("clover/model-bedrock").state).toBeDefined();
    expect(await text(adapterOf("bedrock").streamTurn(turn("amazon.nova-lite-v1:0"), ctxOf("bedrock", { region: bedrockFake.FAKE_REGION })))).toBe("hello from bedrock");
    expect((fake as unknown as { signatures: { verified: boolean; accessKeyId: string }[] }).signatures.map((x) => [x.verified, x.accessKeyId])).toEqual([[true, bedrockFake.FAKE_ACCESS_KEY_ID]]);
  }, 60_000);

  test("Vertex: in a Bun process of its own, it reads its service account with secrets.get, signs its JWT, exchanges it at Google's token endpoint (a declared host) and streams the turn", async () => {
    const { privateKeyPem, publicKey } = await vertexFake.generateTestKeyPair();
    const tokenPath = new URL(vertexFake.vertexTokenUrl("http://127.0.0.1:1")).pathname;
    const opts = {
      publicKey, project: "clover-test-project", location: "us-central1", tokenUri: `https://oauth2.googleapis.com${tokenPath}`,
      verified: [] as { header: Record<string, unknown>; claims: Record<string, unknown> }[],
      stream: { "gemini-2.5-flash": [geminiFake.geminiStreamResponse([{ parts: [{ text: "hello from vertex" }], finishReason: "STOP" }])] },
    };
    const fake = await startFake({ routes: vertexFake.vertexFakeRoutes(opts) });
    wires.set("us-central1-aiplatform.googleapis.com", fake);
    wires.set("oauth2.googleapis.com", fake);
    daemonStore.values.set("vertex:default", JSON.stringify({ kind: "gcp-service-account", clientEmail: "clover-test@clover-test-project.iam.gserviceaccount.com", privateKeyPem, tokenUri: opts.tokenUri }));
    sent.length = 0;
    expect(await text(adapterOf("vertex").streamTurn(turn("gemini-2.5-flash"), ctxOf("vertex", { project: opts.project, location: opts.location })))).toBe("hello from vertex");
    // Its own process, apart from the clover process's workers.
    expect(ph.pidOf("clover/model-vertex")).toBeDefined();
    expect(ph.pidOf("clover/model-vertex")).not.toBe(ph.pidOf("clover/model-google"));
    // The JWT it signed was verified against the service account's public key, and both hosts were its declared ones.
    expect(opts.verified.length).toBeGreaterThan(0);
    expect([...new Set(sent.map((x) => x.host))].sort()).toEqual(["oauth2.googleapis.com", "us-central1-aiplatform.googleapis.com"]);
    // The private key never travelled in a request.
    expect(JSON.stringify(sent)).not.toContain("PRIVATE KEY");
  }, 60_000);

  test("xAI (its subscription): a turn on its plugin with the slot's sign-in as the bearer", async () => {
    const fake = await startXaiChatFake();
    wires.set("cli-chat-proxy.grok.com", { url: fake.url, requests: [], close: () => fake.close() } as unknown as FakeServer);
    daemonStore.values.set("xai-oauth:default", JSON.stringify({ kind: "oauth", accessToken: "test-token-xai-access", refreshToken: "r" }));
    sent.length = 0;
    expect(await text(adapterOf("xai-oauth").streamTurn(turn("grok-4.5"), ctxOf("xai-oauth")))).toBe("ok");
    expect(fake.requests.map((r) => r.path)).toEqual(["/v1/chat/completions"]);
    expect(sent.map((x) => [x.host, x.headers.authorization])).toEqual([["cli-chat-proxy.grok.com", "Bearer test-token-xai-access"]]);
  }, 60_000);

  test("Google pointed at the user's own endpoint (providers.google.baseUrl, on loopback): its plugin serves the turn there with the key, through the real pinned fetch; unset, it goes back to its declared host", async () => {
    const keys: (string | null)[] = [];
    const routes = geminiFake.geminiFakeRoutes({ stream: { "gemini-2.5-flash": (_r) => geminiFake.geminiStreamResponse([{ parts: [{ text: "from your own endpoint" }], finishReason: "STOP" }]) } })
      .map((r) => ({ ...r, handler: (req: Request, rec: Parameters<typeof r.handler>[1]) => { keys.push(req.headers.get("x-goog-api-key")); return r.handler(req, rec); } }));
    const own = await startFake({ routes });
    try {
      userSettings = { providers: { google: { baseUrl: own.url } } } as unknown as Settings;
      sent.length = 0;
      const connection = { baseUrl: own.url, endpointOrigin: "user", local: true };
      expect(await text(adapterOf("google").streamTurn(turn("gemini-2.5-flash"), ctxOf("google", connection)))).toBe("from your own endpoint");
      expect(keys).toEqual([GOOGLE_KEY]);
      // The declared-host wire saw nothing: the request went to the user's endpoint itself.
      expect(sent).toEqual([]);
      // The setting gone, the same plugin is held to its declared hosts again: the loopback endpoint is refused.
      userSettings = null;
      const events: ProviderEvent[] = [];
      for await (const e of adapterOf("google").streamTurn(turn("gemini-2.5-flash"), ctxOf("google", connection))) events.push(e);
      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(keys).toEqual([GOOGLE_KEY]);
    } finally {
      userSettings = null;
      await own.close();
    }
  }, 60_000);
});

/** A turn's outcome: its text, its error (an error event, or what the stream threw), and how long after `t0` it ended. */
async function outcome(events: AsyncIterable<ProviderEvent>, onText?: (soFar: string) => void): Promise<{ text: string; error?: string; endedAt: number }> {
  let text = "";
  try {
    for await (const e of events) {
      if (e.type === "error") return { text, error: e.error.message, endedAt: Date.now() };
      if (e.type === "text_delta") { text += e.text; onText?.(text); }
    }
    return { text, endedAt: Date.now() };
  } catch (err) {
    return { text, error: err instanceof Error ? err.message : String(err), endedAt: Date.now() };
  }
}

describe("a model plugin dying mid-turn", () => {
  beforeAll(() => {
    daemonStore.values.set("google:default", JSON.stringify({ kind: "api-key", key: GOOGLE_KEY }));
    daemonStore.values.set("bedrock:default", JSON.stringify({ kind: "aws", accessKeyId: bedrockFake.FAKE_ACCESS_KEY_ID, secretAccessKey: bedrockFake.FAKE_SECRET_ACCESS_KEY }));
  });
  const slowGoogle = async () => {
    await wires.get("generativelanguage.googleapis.com")?.close();
    const slow = Array.from({ length: 30 }, (_, i) => ({ parts: [{ text: `p${i} ` }], delayMs: 100 }));
    const answer = () => geminiFake.geminiStreamResponse([...slow, { parts: [{ text: "end" }], finishReason: "STOP" }]);
    wires.set("generativelanguage.googleapis.com", await startFake({ routes: geminiFake.geminiFakeRoutes({ stream: { "gemini-2.5-flash": () => answer() } }) }));
  };
  const googleCtx = () => ctxOf("google", { baseUrl: "https://generativelanguage.googleapis.com" });

  const NAME = "Google Gemini API";

  test("Google (a worker): its plugin host killed mid-reply ends the turn at once, in words; the crash rules start it again and the next turn works", async () => {
    await slowGoogle();
    let killedAt = 0;
    const out = await outcome(adapterOf("google").streamTurn(turn("gemini-2.5-flash"), googleCtx()), (t) => {
      if (killedAt === 0 && t.includes("p1 ")) {
        const pid = ph.pidOf("clover/model-google");
        if (pid === undefined) throw new Error("the clover plugin process isn't up");
        killedAt = Date.now();
        process.kill(pid, "SIGKILL"); // the process this test's plugin host started
      }
    });
    expect(killedAt).toBeGreaterThan(0);
    expect(out.endedAt - killedAt).toBeLessThan(5_000);
    expect(out.text).not.toContain("end");
    expect(out.error).toStartWith(`The ${NAME} model plugin stopped during this reply`);
    expect(out.error).toContain("send again to retry");
    const again = await outcome(adapterOf("google").streamTurn(turn("gemini-2.5-flash"), googleCtx()));
    expect(again.error).toBeUndefined();
    expect(again.text).toEndWith("end");
  }, 60_000);

  test("Google: stopped mid-reply ends the turn at once; a turn started while it is stopped fails at once, saying how to turn it on; started again, the next turn works", async () => {
    await slowGoogle();
    let at = 0;
    const out = await outcome(adapterOf("google").streamTurn(turn("gemini-2.5-flash"), googleCtx()), (t) => {
      if (at === 0 && t.includes("p1 ")) { at = Date.now(); void ph.host.stop("clover/model-google", "stopped from Settings"); }
    });
    expect(out.endedAt - at).toBeLessThan(5_000);
    expect(out.error).toBe(`The ${NAME} model plugin is stopped (stopped from Settings), so this reply couldn't run. Turn it on in Settings → Plugins, then send again.`);
    const t0 = Date.now();
    const whileStopped = await outcome(adapterOf("google").streamTurn(turn("gemini-2.5-flash"), googleCtx()));
    expect(whileStopped.endedAt - t0).toBeLessThan(5_000);
    expect(whileStopped.error).toStartWith(`The ${NAME} model plugin is stopped`);
    await ph.host.restart("clover/model-google");
    const again = await outcome(adapterOf("google").streamTurn(turn("gemini-2.5-flash"), googleCtx()));
    expect(again.error).toBeUndefined();
    expect(again.text).toEndWith("end");
  }, 60_000);

  test("Bedrock (a process of its own): its process killed mid-reply ends the turn at once, in words; the next turn works", async () => {
    const fake = await bedrockFake.startBedrockFake({ scenarios: { "amazon.nova-micro-v1:0": () => bedrockFake.eventStreamResponse(bedrockFake.textTurnFrames("slow reply"), { delayMs: 1500 }) } });
    await wires.get(`bedrock-runtime.${bedrockFake.FAKE_REGION}.amazonaws.com`)?.close();
    wires.set(`bedrock-runtime.${bedrockFake.FAKE_REGION}.amazonaws.com`, fake);
    const bedrockCtx = () => ctxOf("bedrock", { region: bedrockFake.FAKE_REGION });
    // Its process up first (a turn), then one held mid-reply by the slow fake.
    expect((await outcome(adapterOf("bedrock").streamTurn(turn("amazon.nova-micro-v1:0"), bedrockCtx()))).error).toBeUndefined();
    const pending = outcome(adapterOf("bedrock").streamTurn(turn("amazon.nova-micro-v1:0"), bedrockCtx()));
    await Bun.sleep(700);
    const pid = ph.pidOf("clover/model-bedrock");
    expect(pid).toBeDefined();
    const at = Date.now();
    process.kill(pid!, "SIGKILL"); // the own process this test's plugin host started
    const out = await pending;
    expect(out.endedAt - at).toBeLessThan(5_000);
    expect(out.error).toStartWith("The AWS Bedrock model plugin stopped during this reply");
    const again = await outcome(adapterOf("bedrock").streamTurn(turn("amazon.nova-micro-v1:0"), bedrockCtx()));
    expect(again.error).toBeUndefined();
    expect(again.text).toBe("slow reply");
  }, 60_000);
});
