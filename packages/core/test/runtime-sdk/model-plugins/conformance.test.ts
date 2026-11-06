// A-M2's done-when: conformance for every model plugin, against recorded fakes (no network, no real key).
//
// * DECLARATIVE (212): each runs on the generic adapter its endpoint names, as a session's registry built from the
//   plugins resolves it: one turn per plugin against its protocol's loopback fake, at the endpoint path it declares,
//   with the key in the header its manifest's placement says (or none for a local runner).
// * CODE (6): the conformance kit's model adapter cases (`runModelAdapterConformance`) on each plugin's own adapter:
//   it speaks interface 1, reads only its context, sends every request through the keyed fetch, never sets a
//   credential header itself, and stops on an abort. Bedrock and Vertex sign, so they run in a real process of their
//   own from their `host/process.ts`, reading their secret there; the kit then checks the host side made no request.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GENERIC_ADAPTER_IDS, catalogFromModelPlugins, loadCatalog, type ModelEntry, type WinterCatalog } from "@waifucave/clover-provider-catalog";
import { createGenericAdapters, createKeyedFetch, createRegistry, spawnModelAdapterProcess, type AdapterContext, type CredentialMaterial, type KeyPlacement, type ModelAdapter, type ProviderContext, type ProviderEvent } from "@waifucave/clover-provider-runtime";
import { MODEL_ADAPTER_CASES, formatConformanceReport, runModelAdapterConformance } from "@waifucave/clover-provider-conformance";
import { anthropicFake, azureFake, bedrockFake, codexFake, geminiFake, openaiChatFake, openaiResponsesFake, startFake, stalledResponse, vertexFake, type FakeServer, type RecordedRequest } from "@waifucave/clover-provider-conformance/fakes";
import { BUNDLED_CHILDREN_DIR, CODE_PLUGINS, modelPluginFolder, modelPluginId } from "../../../src/runtime-sdk/model-plugins/bundled";

const sdk = loadCatalog();
const KEY = "test-key-not-a-secret-conformance";
const declarative = sdk.providers.filter((p) => GENERIC_ADAPTER_IDS.has(p.adapterId));

async function readPlugin(id: string): Promise<{ entry: ModelEntry; file: unknown }> {
  const dir = join(BUNDLED_CHILDREN_DIR, modelPluginFolder(id));
  const manifest = (await Bun.file(join(dir, "clover.json")).json()) as { contributes: { models: ModelEntry[] } };
  return { entry: manifest.contributes.models[0]!, file: await Bun.file(join(dir, "catalog.json")).json() };
}

/** Raw credential headers as the fake received them, per request. */
interface Seen {
  path: string;
  authorization: string | null;
  xApiKey: string | null;
}

/** One loopback fake for every generic protocol: it answers by the path's last segment, whatever the prefix. */
async function genericFake(seen: Seen[]): Promise<FakeServer> {
  return startFake({
    routes: [],
    fallback: (req, recorded: RecordedRequest) => {
      seen.push({ path: recorded.path, authorization: req.headers.get("authorization"), xApiKey: req.headers.get("x-api-key") });
      if (recorded.path.endsWith("/chat/completions")) return openaiChatFake.chatStream({ text: ["ok from ", "chat"], finishReason: "stop", usage: { prompt: 2, completion: 2 } });
      if (recorded.path.endsWith("/responses")) return openaiResponsesFake.responsesStream({ text: ["ok from ", "responses"] });
      if (recorded.path.endsWith("/messages")) return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["ok from ", "messages"] }], stopReason: "end_turn" });
      return new Response(`no route for ${recorded.path}`, { status: 404 });
    },
  });
}

async function drainText(events: AsyncIterable<ProviderEvent>): Promise<string> {
  let out = "";
  for await (const e of events) {
    if (e.type === "error") throw new Error(`${e.error.code}: ${e.error.message}`);
    if (e.type === "text_delta") out += e.text;
  }
  return out;
}

describe("conformance: every declarative model plugin, on its generic adapter", () => {
  test(`all ${declarative.length} answer a turn at their declared endpoint, with the key where their manifest puts it`, async () => {
    const seen: Seen[] = [];
    const fake = await genericFake(seen);
    try {
      const inputs = await Promise.all(declarative.map(async (p) => ({ pluginId: modelPluginId(p.id), ...(await readPlugin(p.id)) })));
      const built = catalogFromModelPlugins(inputs.map((i) => ({ pluginId: i.pluginId, entry: i.entry, catalog: i.file, trusted: true })), { families: sdk.families, catalogVersion: "conformance" });
      expect(built.refused).toEqual([]);
      const catalog: WinterCatalog = built.catalog;
      const registry = createRegistry(catalog);
      for (const a of createGenericAdapters(catalog)) registry.register(a);
      const failures: string[] = [];
      for (const { entry } of inputs) {
        const provider = catalog.providers.find((p) => p.id === entry.provider)!;
        const row = catalog.models.find((m) => m.providerId === provider.id && m.status !== "blocked" && (m.endpoints.includes("chat") || m.endpoints.includes("responses")));
        const resolved = registry.resolve(row !== undefined ? { model: row.key } : { model: `${provider.id}/conformance-probe`, provider: { providerId: provider.id, allowUnlisted: true } });
        if (!("adapter" in resolved)) {
          if (provider.risk.class === "blocked") continue; // a blocked provider resolves to nothing, by design
          failures.push(`${provider.id}: ${resolved.code}`);
          continue;
        }
        const declared = entry.endpoint!.baseUrl.replace(/\$\{setting:[^}]+\}/g, "tenant");
        const base = `${fake.url}${new URL(declared).pathname.replace(/\/$/, "")}`;
        const keyed = entry.auth.find((a) => a.method === "api-key");
        const material: CredentialMaterial | null = keyed === undefined ? null : { kind: "api-key", key: KEY };
        const ctx: ProviderContext = {
          connection: { providerId: provider.id, baseUrl: base, local: true },
          credentials: { get: async () => material, set: async () => {}, delete: async () => {} },
          authRef: material === null ? { kind: "none" } : { kind: "keychain", account: `${provider.id}:default` },
          stallTimeoutMs: 5000,
          log: () => {},
        };
        const before = seen.length;
        try {
          const text = await drainText(resolved.adapter.streamTurn({ model: resolved.providerModelId, messages: [{ role: "user", content: "hi" }], maxOutputTokens: 64 }, ctx));
          if (!text.startsWith("ok from")) failures.push(`${provider.id}: answered ${JSON.stringify(text)}`);
        } catch (err) {
          failures.push(`${provider.id}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const req = seen.slice(before).at(-1);
        if (req === undefined) {
          failures.push(`${provider.id}: no request reached the fake`);
          continue;
        }
        if (!req.path.startsWith(new URL(base).pathname)) failures.push(`${provider.id}: sent to ${req.path}, not under its declared ${new URL(base).pathname}`);
        const placement = (keyed as { placement?: KeyPlacement } | undefined)?.placement;
        if (keyed === undefined) {
          if (req.authorization !== null || req.xApiKey !== null) failures.push(`${provider.id}: a key-less plugin's request carried a credential header`);
        } else if (placement?.header === "x-api-key") {
          if (req.xApiKey !== KEY || req.authorization !== null) failures.push(`${provider.id}: the key wasn't in x-api-key alone`);
        } else if (req.authorization !== `Bearer ${KEY}` || req.xApiKey !== null) {
          failures.push(`${provider.id}: the key wasn't Authorization: Bearer alone`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await fake.close();
    }
  }, 120_000);
});

// --- the six code plugins ----------------------------------------------------------------------------

/** A code plugin's adapter in a real process of its own, from its `host/process.ts` (Bedrock, Vertex). */
async function ownProcessAdapter(id: string, secrets: { get(name: string): Promise<CredentialMaterial | null> }, hosts: string[]) {
  const local = await codeAdapter(id);
  return spawnModelAdapterProcess({ command: [process.execPath, join(BUNDLED_CHILDREN_DIR, modelPluginFolder(id), "host", "process.ts")], local, secrets, hosts, env: { PATH: process.env["PATH"] ?? "" } });
}

async function codeAdapter(id: string): Promise<ModelAdapter> {
  return ((await import(join(BUNDLED_CHILDREN_DIR, modelPluginFolder(id), "host", "index.ts"))) as { modelAdapter: ModelAdapter }).modelAdapter;
}

function keyedOver(fake: FakeServer, auth: Record<string, { value: string; placement?: KeyPlacement }>) {
  return createKeyedFetch({
    hosts: [new URL(fake.url).host],
    auth: Object.fromEntries(Object.entries(auth).map(([name, a]) => [name, { source: { current: async () => ({ value: a.value, generation: 1 }), newer: async () => null }, ...(a.placement !== undefined ? { placement: a.placement } : {}) }])),
  });
}

async function kit(subject: string, adapter: ModelAdapter, context: () => AdapterContext, model: string, extra: { ownProcess?: boolean; fakeRequests?: () => number; turn?: Record<string, unknown> } = {}) {
  const report = await runModelAdapterConformance({
    subject,
    adapter,
    context,
    turn: { model, messages: [{ role: "user", content: "hi" }], maxOutputTokens: 64, ...(extra.turn ?? {}) },
    holdingTurn: { model, messages: [{ role: "user", content: "hold" }], maxOutputTokens: 64, ...(extra.turn ?? {}) },
    ...(extra.ownProcess === true ? { ownProcess: true, fakeRequests: extra.fakeRequests! } : {}),
  });
  expect(report.outcomes.map((o) => o.id)).toEqual(MODEL_ADAPTER_CASES.map((c) => c.id));
  if (!report.ok) throw new Error(formatConformanceReport(report, MODEL_ADAPTER_CASES));
  return report;
}

const holding = (recorded: RecordedRequest, answer: () => Response): Response => (recorded.body.includes("hold") ? stalledResponse(10_000) : answer());

describe("conformance: every code model plugin, on the model adapter interface", () => {
  test("the six code plugins are the ones tested here", () => {
    expect(Object.keys(CODE_PLUGINS).sort()).toEqual(["azure-openai", "bedrock", "codex-oauth", "google", "vertex", "xai-oauth"]);
  });

  test("clover/model-google, keyless on the keyed fetch (x-goog-api-key)", async () => {
    const fake = await startFake({ routes: geminiFake.geminiFakeRoutes({ stream: { "gemini-2.5-flash": (rec) => holding(rec, () => geminiFake.geminiStreamResponse([{ parts: [{ text: "ok" }], finishReason: "STOP" }])) } }) });
    try {
      await kit("clover/model-google", await codeAdapter("google"), () => ({ connection: { providerId: "google", baseUrl: fake.url, local: true }, fetch: keyedOver(fake, { "api-key": { value: KEY, placement: { header: "x-goog-api-key" } } }), stallTimeoutMs: 5000, log: () => {} }), "gemini-2.5-flash");
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("clover/model-azure-openai, keyless on the keyed fetch (api-key)", async () => {
    const fake = await azureFake.startAzureFake({ chatScenarios: { "gpt-4o": (rec) => holding(rec, () => openaiChatFake.chatStream({ text: ["ok"], finishReason: "stop" })) } });
    try {
      const adapter = await codeAdapter("azure-openai");
      const row = sdk.models.find((m) => m.providerId === "azure-openai" && m.upstreamId === "gpt-4o") ?? sdk.models.find((m) => m.providerId === "azure-openai")!;
      await kit("clover/model-azure-openai", adapter, () => ({ connection: { providerId: "azure-openai", baseUrl: fake.url, local: true, deployment: row.upstreamId, apiVersion: "2024-10-21" }, fetch: keyedOver(fake, { "api-key": { value: KEY, placement: { header: "api-key" } } }), stallTimeoutMs: 5000, log: () => {} }), row.upstreamId);
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("clover/model-codex-oauth, keyless on the keyed fetch (the core's ChatGPT sign-in as Bearer)", async () => {
    const fake = await codexFake.startCodexFake({ scenarios: { "gpt-5.6-luna": (rec) => holding(rec, () => openaiResponsesFake.responsesStream({ text: ["ok"] })) } });
    try {
      await kit("clover/model-codex-oauth", await codeAdapter("codex-oauth"), () => ({ connection: { providerId: "codex-oauth", baseUrl: fake.url, local: true, account: codexFake.FAKE_ACCOUNT_ID }, fetch: keyedOver(fake, { chatgpt: { value: codexFake.FAKE_ACCESS_TOKEN } }), stallTimeoutMs: 5000, log: () => {} }), "gpt-5.6-luna");
      // Its privileged headers (originator `clover`, the account id) go only to the reviewed endpoint: service.test.ts.
      expect(fake.bearers.every((b) => b === codexFake.FAKE_ACCESS_TOKEN)).toBe(true);
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("clover/model-xai-oauth, keyless on the keyed fetch (the core's xAI sign-in as Bearer)", async () => {
    const fake = await openaiChatFake.startOpenAiChatFake({ scenarios: {}, unknownModel: (rec) => holding(rec, () => openaiChatFake.chatStream({ text: ["ok"], finishReason: "stop" })) });
    try {
      const row = sdk.models.find((m) => m.providerId === "xai-oauth")!;
      await kit("clover/model-xai-oauth", await codeAdapter("xai-oauth"), () => ({ connection: { providerId: "xai-oauth", baseUrl: `${fake.url}/v1`, local: true }, fetch: keyedOver(fake, { signIn: { value: "test-token-xai-0001" } }), stallTimeoutMs: 5000, log: () => {} }), row.upstreamId);
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("clover/model-bedrock, signing in a process of its own (secrets.get there, SigV4 verified by the fake)", async () => {
    const fake = await bedrockFake.startBedrockFake({ scenarios: { "amazon.nova-lite-v1:0": (rec) => holding(rec, () => bedrockFake.eventStreamResponse(bedrockFake.textTurnFrames("ok"))) } });
    try {
      const secrets = { get: async (name: string): Promise<CredentialMaterial | null> => (name === "aws" ? { kind: "aws", accessKeyId: bedrockFake.FAKE_ACCESS_KEY_ID, secretAccessKey: bedrockFake.FAKE_SECRET_ACCESS_KEY } : null) };
      const proc = await ownProcessAdapter("bedrock", secrets, [new URL(fake.url).host]);
      try {
        await kit("clover/model-bedrock", proc, () => ({ connection: { providerId: "bedrock", region: bedrockFake.FAKE_REGION, baseUrl: fake.url, local: true }, fetch: createKeyedFetch({ hosts: [new URL(fake.url).host] }), stallTimeoutMs: 5000, log: () => {} }), "amazon.nova-lite-v1:0", { ownProcess: true, fakeRequests: () => fake.requests.length });
      } finally {
        await proc.close();
      }
      expect(fake.signatures.length).toBeGreaterThan(0);
      expect(fake.signatures.every((s) => s.verified)).toBe(true);
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("clover/model-vertex, signing in a process of its own (a service account's JWT, verified by the fake)", async () => {
    const { privateKeyPem, publicKey } = await vertexFake.generateTestKeyPair();
    const row = sdk.models.find((m) => m.providerId === "vertex" && m.upstreamId.startsWith("gemini")) ?? sdk.models.find((m) => m.providerId === "vertex")!;
    const opts = { publicKey, project: "clover-test-project", location: "us-central1", tokenUri: "", verified: [] as { header: Record<string, unknown>; claims: Record<string, unknown> }[], stream: { [row.upstreamId]: (rec: RecordedRequest) => holding(rec, () => geminiFake.geminiStreamResponse([{ parts: [{ text: "ok" }], finishReason: "STOP" }])) } };
    const fake = await startFake({ routes: vertexFake.vertexFakeRoutes(opts) });
    opts.tokenUri = vertexFake.vertexTokenUrl(fake.url);
    try {
      const material: CredentialMaterial = { kind: "gcp-service-account", clientEmail: "clover-test@clover-test-project.iam.gserviceaccount.com", privateKeyPem, tokenUri: opts.tokenUri };
      const secrets = { get: async (name: string): Promise<CredentialMaterial | null> => (name === "gcp-service-account" ? material : null) };
      const proc = await ownProcessAdapter("vertex", secrets, [new URL(fake.url).host]);
      try {
        await kit("clover/model-vertex", proc, () => ({ connection: { providerId: "vertex", baseUrl: fake.url, local: true, project: opts.project, location: opts.location }, fetch: createKeyedFetch({ hosts: [new URL(fake.url).host] }), stallTimeoutMs: 5000, log: () => {} }), row.upstreamId, { ownProcess: true, fakeRequests: () => fake.requests.length });
      } finally {
        await proc.close();
      }
      expect(opts.verified.length).toBeGreaterThan(0);
    } finally {
      await fake.close();
    }
  }, 30_000);
});
