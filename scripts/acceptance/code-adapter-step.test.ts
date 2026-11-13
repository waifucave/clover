import { expect, test } from "bun:test";
import { codeAdapterWrong, GEMINI_REPLY } from "./code-adapter-step";
import { geminiSse, startFakeGemini } from "./fake-gemini";

const streamed = (o: Partial<{ keyMatched: boolean; keyPresent: boolean; model: string }> = {}) => ({ path: "/v1beta/models/gemini-2.5-flash:streamGenerateContent", model: "gemini-2.5-flash", keyPresent: true, keyMatched: true, ...o });

test("the verdict: the reply in the conversation and a keyed streamed request for the model pass; each missing part says what", () => {
  expect(codeAdapterWrong({ replyText: GEMINI_REPLY, requests: [streamed()] })).toBeUndefined();
  expect(codeAdapterWrong({ replyText: "", requests: [], stop: "error", error: "no-adapter" })).toContain("never reached the Google fake");
  expect(codeAdapterWrong({ replyText: GEMINI_REPLY, requests: [streamed({ keyMatched: false, keyPresent: false })] })).toContain("without the key");
  expect(codeAdapterWrong({ replyText: GEMINI_REPLY, requests: [streamed({ model: "gemini-2.5-pro" })] })).toContain("not google/gemini-2.5-flash");
  expect(codeAdapterWrong({ replyText: "something else", requests: [streamed()] })).toContain("isn't in the conversation");
});

test("the fake answers a keyed streamed turn, refuses a request without the key, and records no key", async () => {
  const fake = startFakeGemini({ key: "AIza-test-only", reply: GEMINI_REPLY });
  try {
    const ok = await fetch(`${fake.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`, { method: "POST", headers: { "x-goog-api-key": "AIza-test-only" }, body: "{}" });
    expect(await ok.text()).toBe(geminiSse(GEMINI_REPLY, "gemini-2.5-flash"));
    expect((await fetch(`${fake.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(fake.requests.map((r) => [r.model, r.keyPresent, r.keyMatched])).toEqual([["gemini-2.5-flash", true, true], ["gemini-2.5-flash", false, false]]);
    expect(JSON.stringify(fake.requests)).not.toContain("AIza-test-only");
  } finally {
    fake.stop();
  }
});

test("the OpenAI-wire verdict: its wire's path, the key, its model and the reply; each missing part says what", async () => {
  const { openAiWireWrong, OPENAI_REPLY } = await import("./code-adapter-step");
  const base = { provider: "openai", wire: "responses", model: "openai/gpt-4.1-mini" };
  const req = (o: Partial<{ path: string; model: string; keyMatched: boolean; keyPresent: boolean }> = {}) => ({ path: "/v1/responses", model: "gpt-4.1-mini", keyPresent: true, keyMatched: true, ...o });
  expect(openAiWireWrong({ ...base, replyText: OPENAI_REPLY, requests: [req()] })).toBeUndefined();
  expect(openAiWireWrong({ ...base, replyText: "", requests: [req({ path: "/v1/chat/completions" })] })).toContain("never reached its fake's responses");
  expect(openAiWireWrong({ ...base, replyText: OPENAI_REPLY, requests: [req({ keyMatched: false })] })).toContain("without the key");
  expect(openAiWireWrong({ ...base, replyText: OPENAI_REPLY, requests: [req({ model: "gpt-4o" })] })).toContain("not gpt-4.1-mini");
  expect(openAiWireWrong({ ...base, replyText: "else", requests: [req()] })).toContain("isn't in the conversation");
});

test("the OpenAI-wire fake streams both wires to its key only, and records no key", async () => {
  const { startFakeOpenAi } = await import("./fake-openai");
  const fake = startFakeOpenAi({ key: "sk-test-only", reply: "R" });
  try {
    const post = (path: string, key?: string) => fetch(`${fake.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: "m1" }) });
    expect(await (await post("/v1/responses", "sk-test-only")).text()).toContain("response.output_text.delta");
    expect(await (await post("/openai/v1/chat/completions", "sk-test-only")).text()).toContain("[DONE]");
    expect((await post("/v1/responses")).status).toBe(401);
    expect(fake.requests.map((r) => [r.path, r.model, r.keyMatched])).toEqual([["/v1/responses", "m1", true], ["/openai/v1/chat/completions", "m1", true], ["/v1/responses", "m1", false]]);
    expect(JSON.stringify(fake.requests)).not.toContain("sk-test-only");
  } finally {
    fake.stop();
  }
});

test("the OAuth fake: a PKCE authorize redirects with a code; the code buys the token only with its verifier, once; the token is the only bearer it answers", async () => {
  const { createHash, randomBytes } = await import("node:crypto");
  const { startFakeOAuth } = await import("./fake-oauth");
  const fake = startFakeOAuth({ reply: "R" });
  try {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirect = "http://localhost:1/auth/callback";
    const q = new URLSearchParams({ response_type: "code", client_id: "c", redirect_uri: redirect, scope: "models", state: "s1", code_challenge: challenge, code_challenge_method: "S256" });
    const a = await fetch(`${fake.url}/authorize?${q}`, { redirect: "manual" });
    expect(a.status).toBe(302);
    const code = new URL(a.headers.get("location")!).searchParams.get("code")!;
    expect(new URL(a.headers.get("location")!).searchParams.get("state")).toBe("s1");
    const exchange = (v: string) => fetch(`${fake.url}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: "c", code, redirect_uri: redirect, code_verifier: v }) });
    expect((await exchange("not-the-verifier")).status).toBe(400);
    const t = (await (await exchange(verifier)).json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(t.expires_in).toBeLessThan(60);
    expect((await exchange(verifier)).status).toBe(400); // a code buys one token
    expect(await (await fetch(`${fake.url}/v1/turn`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}` } })).text()).toBe("R");
    expect((await fetch(`${fake.url}/v1/turn`, { method: "POST", headers: { authorization: "Bearer other" } })).status).toBe(401);
    // A refresh token buys a new token, once; a revoked token is refused.
    const refreshed = (await (await fetch(`${fake.url}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: "acceptance-oauth-client", refresh_token: t.refresh_token }) })).json()) as { access_token: string };
    expect((await fetch(`${fake.url}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: "acceptance-oauth-client", refresh_token: t.refresh_token }) })).status).toBe(400);
    fake.revoke();
    expect((await fetch(`${fake.url}/v1/turn`, { method: "POST", headers: { authorization: `Bearer ${refreshed.access_token}` } })).status).toBe(401);
    expect(fake.seen).toEqual({ authorized: 1, exchanged: 1, refusedExchanges: 3, refreshed: 1, turns: [{ bearerMatched: true }, { bearerMatched: false }, { bearerMatched: false }] });
    expect((await fetch(`${fake.url}/authorize?${new URLSearchParams({ response_type: "code", redirect_uri: "https://evil.example/cb", state: "s", code_challenge: challenge, code_challenge_method: "S256" })}`, { redirect: "manual" })).status).toBe(400);
  } finally {
    fake.stop();
  }
});

test("the third-party fixtures' model rows are ones a picker offers (supported: never deprecated or blocked, which models.list leaves out)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const fixture of ["acceptance-models", "acceptance-oauth"]) {
    const { rows } = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", fixture, "catalog.json"), "utf8")) as { rows: { key: string; status: string }[] };
    expect(rows.map((r) => [r.key, r.status])).toEqual(rows.map((r) => [r.key, "supported"]));
  }
});

test("each model the code-adapter row moves Alpha to is one the picker offers (bot.setUserLayer refuses any other)", async () => {
  const { catalogModelListings } = await import("../../packages/core/src/runtime-sdk/models-list");
  const { loadCatalog } = await import("../../packages/core/node_modules/@waifucave/clover-provider-catalog");
  const { GEMINI_MODEL, OPENAI_WIRE_PROVIDERS } = await import("./code-adapter-step");
  const listed = new Set(catalogModelListings(loadCatalog(), new Set()).map((m) => m.id));
  for (const model of [GEMINI_MODEL, ...OPENAI_WIRE_PROVIDERS.map((p) => p.model)]) expect([model, listed.has(model)]).toEqual([model, true]);
});
