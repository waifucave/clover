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
