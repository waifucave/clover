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
