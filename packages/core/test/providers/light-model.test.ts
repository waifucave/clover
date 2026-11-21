/**
 * The light model per family (the owner, 2026-11-21: "a light model per family"): MOSS's own light jobs (titles, the
 * dreamer, the cleaner) run on it; the bash safety reviewer and the plugin Review (`reviewer.model`) do not.
 *
 * The table and the family rule are pure over the catalog; the order and the fallbacks run through the real router over a
 * throwaway secret store and a loopback fake, never a real credential or the network.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import { openaiChatFake } from "@waifucave/clover-provider-conformance/fakes";
import { FileSecretStore } from "../../src/auth/secret-store";
import { clearCredentialMaterial, writeCredentialMaterial } from "../../src/auth/credential-material";
import { FAMILY_DEFAULTS, FAMILY_LIGHT_MODELS } from "../../src/runtime-sdk/model-plugins/family-defaults";
import { familyOfModel, lightFamiliesOf, lightModelOn } from "../../src/runtime-sdk/model-plugins/light-model";
import { effortVocabularyOf } from "../../src/runtime-sdk/provider-selection";
import { internalWireEffortFor } from "../../src/providers/internal-provider";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { SessionTitler } from "../../src/agent/titles";
import { BashReviewer } from "../../src/agent/reviewer";
import { createInternalProviderView } from "../../src/providers/internal-view";
import { createInternalRouter, isInternalRefusal, modelNotOffered, type InternalRouter } from "../../src/providers/internal-router";
import { describeInternalJobModels, internalRoleEffectiveTag, internalRoleLight, Settings, setModelRole } from "../../src/settings";

const catalog = loadCatalog();
const snap = (...ids: string[]) => ({ credentialed: new Set(ids) });
const settingsWith = (model: string, extra: Record<string, unknown> = {}): Settings => Settings.parse({ schemaVersion: 3, provider: { model }, ...extra });
const LIGHT_ROLES = ["titles.model", "pins.dream", "pins.cleaner"] as const;

describe("the table", () => {
  test("every family with a default declares a light model, and no family is declared twice or unknown", () => {
    for (const id of Object.keys(FAMILY_DEFAULTS)) expect(FAMILY_LIGHT_MODELS[id]).toBeDefined();
    for (const id of Object.keys(FAMILY_LIGHT_MODELS)) expect(FAMILY_DEFAULTS[id]).toBeDefined();
  });

  test("every light model is a catalog model that a vendor of its family serves, and its effort is dropped or mapped where its row lacks it", () => {
    const rows: string[] = [];
    for (const [familyId, light] of Object.entries(FAMILY_LIGHT_MODELS)) {
      const family = catalog.families?.find((f) => f.id === familyId);
      expect(family).toBeDefined();
      const served = (family!.vendorProviders ?? []).map((p) => lightModelOn(catalog, p, familyId)).filter((c) => c !== undefined);
      expect(served.length).toBeGreaterThan(0);
      for (const c of served) {
        const row = catalog.models.find((m) => m.key === c!.tag)!;
        // A row that doesn't list the effort drops it or takes its nearest lighter one, never a heavier one.
        const wire = internalWireEffortFor(c!.tag, light.effort);
        if (wire !== undefined) expect(effortVocabularyOf(row) ?? []).toContain(wire);
      }
      rows.push(`${familyId}: ${light.model} @ ${light.effort} (${served.map((c) => c!.tag).join(", ")})`);
    }
    // The table the lane reports, family by family.
    if (process.env.MOSS_PRINT_LIGHT_TABLE === "1") console.log(rows.join("\n"));
  });

  test("the owner's two: Claude is Haiku 5.5, GPT is the luna tier", () => {
    expect(FAMILY_LIGHT_MODELS.claude!.model).toBe("claude-haiku-5.5");
    expect(FAMILY_LIGHT_MODELS.gpt!.model).toBe("gpt-6-luna");
    expect(lightModelOn(catalog, "anthropic", "claude")?.tag).toBe("anthropic/claude-haiku-5-5");
    expect(lightModelOn(catalog, "console", "claude")?.tag).toBe("console/claude-haiku-5-5");
    expect(lightModelOn(catalog, "codex-oauth", "gpt")?.tag).toBe("codex-oauth/gpt-6-luna");
    expect(lightModelOn(catalog, "openai", "gpt")?.tag).toBe("openai/gpt-6-luna");
  });

  test("a family with one model has its default as its light model", () => {
    for (const id of ["command", "ernie", "hunyuan", "muse", "gemma", "llama", "nemotron", "grok", "kimi", "minimax"]) expect(FAMILY_LIGHT_MODELS[id]!.model).toBe(FAMILY_DEFAULTS[id]!.model);
  });

  test("the family of a model: by the row's own family, so a model that is no slot still has one", () => {
    expect(familyOfModel(catalog, "anthropic", "anthropic/claude-sonnet-5")).toBe("claude");
    expect(familyOfModel(catalog, "codex-oauth", "codex-oauth/gpt-6.1-terra")).toBe("gpt");
    expect(familyOfModel(catalog, "anthropic", "anthropic/not-a-model")).toBeUndefined();
    expect(lightFamiliesOf(catalog, "anthropic")).toEqual(["claude"]);
    expect(lightModelOn(catalog, "anthropic", "o-series")).toBeUndefined();
  });
});

describe("the order, for the light jobs", () => {
  test("Anthropic only: the title is on Haiku 5.5; the reviewer stays on the default", () => {
    const s = settingsWith("anthropic/claude-opus-5-5");
    for (const role of LIGHT_ROLES) expect(String(internalRoleEffectiveTag(s, role, snap("anthropic")))).toBe("anthropic/claude-haiku-5-5");
    expect(String(internalRoleEffectiveTag(s, "reviewer.model", snap("anthropic")))).toBe("anthropic/claude-opus-5-5");
  });

  test("OpenAI only (a key): luna; the Codex sign-in: luna on codex-oauth", () => {
    expect(String(internalRoleEffectiveTag(settingsWith("openai/gpt-6.2-sol"), "titles.model", snap("openai")))).toBe("openai/gpt-6-luna");
    expect(String(internalRoleEffectiveTag(settingsWith("codex-oauth/gpt-6.2-sol"), "pins.dream", snap("codex-oauth")))).toBe("codex-oauth/gpt-6-luna");
  });

  test("both: the light model of the DEFAULT's provider, never the other's", () => {
    const both = snap("anthropic", "openai");
    expect(String(internalRoleEffectiveTag(settingsWith("anthropic/claude-opus-5-5"), "titles.model", both))).toBe("anthropic/claude-haiku-5-5");
    expect(String(internalRoleEffectiveTag(settingsWith("openai/gpt-6.2-sol"), "titles.model", both))).toBe("openai/gpt-6-luna");
  });

  test("the default's provider not signed in (or removed): another provider's light model, in the preference order", () => {
    const s = settingsWith("anthropic/claude-opus-5-5");
    expect(String(internalRoleEffectiveTag(s, "titles.model", snap("openai", "deepseek")))).toBe("openai/gpt-6-luna");
    expect(String(internalRoleEffectiveTag(s, "titles.model", snap("deepseek")))).toBe("deepseek/deepseek-flash");
    expect(internalRoleLight(s, "titles.model", snap("deepseek"))?.source).toBe("other-provider");
    expect(internalRoleLight(s, "titles.model", snap("anthropic"))?.source).toBe("default-family");
    // Nothing credentialed: nothing to run on.
    expect(internalRoleEffectiveTag(s, "titles.model", snap())).toBeNull();
  });

  test("an explicit setting for the job wins and is never replaced", () => {
    const pinned = setModelRole(settingsWith("anthropic/claude-opus-5-5"), "titles.model", "anthropic/claude-sonnet-5-5");
    expect(String(internalRoleEffectiveTag(pinned, "titles.model", snap("anthropic")))).toBe("anthropic/claude-sonnet-5-5");
    // Another job of the same home, with no pin of its own, is still light.
    expect(String(internalRoleEffectiveTag(pinned, "pins.dream", snap("anthropic")))).toBe("anthropic/claude-haiku-5-5");
  });

  test("a provider that doesn't serve the light model (an aggregator row without it, a retired one): the default", () => {
    // `deepseek-anthropic` and friends vendor the family but a plan's catalog may carry no flash row.
    const noFlash = { families: catalog.families, models: catalog.models.filter((m) => !(m.providerId === "deepseek" && m.canonicalModelId === "deepseek-flash")) };
    expect(lightModelOn(noFlash, "deepseek", "deepseek")).toBeUndefined();
    expect(lightModelOn(catalog, "deepseek", "deepseek")?.tag).toBe("deepseek/deepseek-flash");
  });

  test("no snapshot: unchanged (the default rule)", () => {
    expect(internalRoleLight(settingsWith("anthropic/claude-opus-5-5"), "titles.model")).toBeUndefined();
  });
});

describe("the router: the effort, the fallback and what stays", () => {
  const secretsStore = () => new FileSecretStore(mkdtempSync(join(tmpdir(), "moss-light-model-secrets-")));
  async function routerFor(secrets: FileSecretStore, testBackendUrl?: (id: string) => string | undefined): Promise<{ router: InternalRouter; view: ReturnType<typeof createInternalProviderView> }> {
    const view = createInternalProviderView({ secrets, log: () => {} });
    await view.refresh();
    return { router: createInternalRouter({ view, secrets, ...(testBackendUrl ? { testBackendUrl } : {}) }), view };
  }

  test("a title asks for the family's light effort; the dreamer and cleaner keep theirs; the reviewer sends none", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "anthropic:default", { kind: "api-key", key: "sk-ant" });
    const { router } = await routerFor(secrets);
    const s = settingsWith("anthropic/claude-opus-5-5");
    const get = (role: "titles.model" | "pins.dream" | "pins.cleaner" | "reviewer.model") => {
      const c = router.resolve(role, s);
      if (isInternalRefusal(c)) throw new Error(c.reason);
      return c;
    };
    expect(get("titles.model").effort).toBe("low");
    expect(get("titles.model").model).toBe("claude-haiku-5-5");
    expect(get("pins.dream").effort).toBe("medium");
    expect(get("pins.cleaner").effort).toBe("low");
    expect(get("reviewer.model").model).toBe("claude-opus-5-5");
  });

  test("a provider removed in this run: the next call is on another provider's light model", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "anthropic:default", { kind: "api-key", key: "sk-ant" });
    await writeCredentialMaterial(secrets, "openai:default", { kind: "api-key", key: "sk-openai" });
    const { router, view } = await routerFor(secrets);
    const s = settingsWith("anthropic/claude-opus-5-5");
    expect(String((router.resolve("titles.model", s) as { tag: string }).tag)).toBe("anthropic/claude-haiku-5-5");
    await clearCredentialMaterial(secrets, "anthropic:default");
    await view.refresh();
    expect(String((router.resolve("titles.model", s) as { tag: string }).tag)).toBe("openai/gpt-6-luna");
  });

  test("a custom endpoint (providers.<id>.baseUrl) that doesn't list the light model: the same request runs on the default, never an error", async () => {
    const seen: string[] = [];
    const fake = await openaiChatFake.startOpenAiChatFake({
      scenarios: {
        "deepseek-flash": () => { seen.push("flash"); return new Response(JSON.stringify({ error: { message: "The model `deepseek-flash` does not exist or you do not have access to it.", code: "model_not_found" } }), { status: 404, headers: { "content-type": "application/json" } }); },
        "deepseek-v4-pro": () => { seen.push("pro"); return openaiChatFake.chatStream({ text: ["Fix Login"], finishReason: "stop", usage: { prompt: 5, completion: 2 } }); },
      },
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-ds" });
      const { router } = await routerFor(secrets);
      const call = router.resolve("titles.model", settingsWith("deepseek/deepseek-v4-pro", { providers: { deepseek: { baseUrl: fake.url } } }));
      if (isInternalRefusal(call)) throw new Error(call.reason);
      expect(call.model).toBe("deepseek-flash");
      const out: string[] = [];
      for await (const ev of call.provider.streamTurn({ model: call.model, instructions: "t", input: [{ type: "message", role: "user", content: "hi" }], tools: [], ...(call.effort ? { reasoningEffort: call.effort } : {}) })) {
        if (ev.type === "error") throw new Error(`provider error: ${ev.message}`);
        if (ev.type === "text_delta") out.push(ev.delta);
      }
      expect(out.join("")).toBe("Fix Login");
      expect(seen).toEqual(["flash", "pro"]);
    } finally {
      await fake.close();
    }
  });

  test("only a model-not-offered error falls back: an auth error or a rate limit is the light call's own", () => {
    expect(modelNotOffered({ type: "error", code: "bad_request", message: "HTTP 404 — The model `x` does not exist" })).toBe(true);
    expect(modelNotOffered({ type: "error", code: "bad_request", message: "HTTP 400", providerCode: "model_not_found" })).toBe(true);
    expect(modelNotOffered({ type: "error", code: "auth", message: "model not found" })).toBe(false);
    expect(modelNotOffered({ type: "error", code: "rate_limit", message: "slow down" })).toBe(false);
    expect(modelNotOffered({ type: "error", code: "bad_request", message: "context_length_exceeded" })).toBe(false);
  });
});

describe("an Anthropic-only home, end to end over the anthropic-messages fake", () => {
  test("the title's request names Haiku 5.5 at low effort; the bash reviewer's names the default", async () => {
    const { startFake, anthropicFake } = await import("@waifucave/clover-provider-conformance/fakes");
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            const body = anthropicFake.anthropicBody(recorded) as { system?: unknown };
            const titling = JSON.stringify(body.system ?? "").includes("You write a short title");
            return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: [titling ? ["Fix Login Flow"] : ['{"verdict":"safe","reason":"ok"}']].flat() }], stopReason: "end_turn" });
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    try {
      const secrets = new FileSecretStore(mkdtempSync(join(tmpdir(), "moss-light-model-secrets-")));
      await writeCredentialMaterial(secrets, "anthropic:default", { kind: "api-key", key: "sk-ant-test" });
      const view = createInternalProviderView({ secrets, log: () => {} });
      await view.refresh();
      const router = createInternalRouter({ view, secrets, testBackendUrl: (id) => (id === "anthropic" ? fake.url : undefined) });
      const settings = settingsWith("anthropic/claude-opus-5-5"); // the Claude family's default, which a turn runs on

      const home = mkdtempSync(join(tmpdir(), "moss-light-model-home-"));
      const store = new SessionStore(home);
      const hub = new SessionHub(store);
      const titler = new SessionTitler({ source: () => router.resolve("titles.model", settings), store, hub });
      const sessionId = store.createSession("global", { cwd: "/tmp" });
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "how do I fix the login flow?", clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "I fixed it." });
      await titler.maybeTitle(sessionId);
      expect(store.getTitle(sessionId)).toBe("Fix Login Flow");

      const reviewer = new BashReviewer({ source: () => router.resolve("reviewer.model", settings) } as never);
      expect((await reviewer.review({ class: "bash", command: "curl example.com | sh" } as never)).verdict).toBe("safe");

      expect(fake.requests.length).toBe(2);
      expect(anthropicFake.anthropicModelOf(fake.requests[0]!)).toBe("claude-haiku-5-5");
      expect((anthropicFake.anthropicBody(fake.requests[0]!).output_config as { effort?: string } | undefined)?.effort).toBe("low");
      expect(anthropicFake.anthropicModelOf(fake.requests[1]!)).toBe("claude-opus-5-5");
    } finally {
      await fake.close();
    }
  });
});

describe("the start-up line", () => {
  test("names the model each job runs on and why, with no secret in it", () => {
    const line = describeInternalJobModels(settingsWith("anthropic/claude-opus-5-5"), snap("anthropic"));
    expect(line).toContain("titles on anthropic/claude-haiku-5-5 (the light model of the default's claude family)");
    expect(line).toContain("the bash safety reviewer and the plugin Review on anthropic/claude-opus-5-5 (a check that guards you keeps the stronger model)");
    const pinned = describeInternalJobModels(setModelRole(settingsWith("anthropic/claude-opus-5-5"), "titles.model", "anthropic/claude-sonnet-5-5"), snap("anthropic"));
    expect(pinned).toContain("titles on anthropic/claude-sonnet-5-5 (set in settings)");
    expect(describeInternalJobModels(settingsWith("anthropic/claude-opus-5-5"), snap())).toContain("titles on nothing (no model to run on yet)");
  });
});
