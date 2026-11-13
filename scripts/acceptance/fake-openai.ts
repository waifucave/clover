// The acceptance run's OpenAI-wire providers on loopback (rows 1.41 and 4.38): the user's own endpoints for `openai`
// (the Responses wire) and `groq` (the Chat Completions wire), `providers.<id>.baseUrl`, which the declarative model
// plugins' generic adapters reach with the key the user stored for each. The streams are the provider conformance
// fakes' own (`responsesStream`, `chatStream`); each request is recorded with its path, its model and whether the
// bearer was the run's key for that provider (never the key). Nothing leaves the machine.
import { openaiChatFake, openaiResponsesFake } from "../../packages/core/node_modules/@waifucave/clover-provider-conformance/dist/fakes/index.js";

export interface FakeOpenAiRequest {
  path: string;
  model?: string;
  keyPresent: boolean;
  keyMatched: boolean;
}

export interface FakeOpenAi {
  url: string;
  requests: FakeOpenAiRequest[];
  stop(): void;
}

/** One server for one provider: `/…/responses` answers on the Responses wire, `/…/chat/completions` on the Chat
 *  Completions wire, each with `reply`, only to the bearer `key` (401 otherwise). */
export function startFakeOpenAi(o: { key: string; reply: string }): FakeOpenAi {
  const requests: FakeOpenAiRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const auth = req.headers.get("authorization");
      let model: string | undefined;
      try { model = ((await req.clone().json()) as { model?: string }).model; } catch { /* not JSON */ }
      const keyMatched = auth === `Bearer ${o.key}`;
      requests.push({ path, ...(model !== undefined ? { model } : {}), keyPresent: auth !== null, keyMatched });
      if (!keyMatched) return Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
      if (req.method === "GET" && path.endsWith("/models")) return Response.json({ object: "list", data: [] });
      if (req.method === "POST" && path.endsWith("/responses")) return openaiResponsesFake.responsesStream({ text: [o.reply], ...(model !== undefined ? { model } : {}), usage: { input: 8, output: 4 } });
      if (req.method === "POST" && path.endsWith("/chat/completions")) return openaiChatFake.chatStream({ text: [o.reply], ...(model !== undefined ? { model } : {}), usage: { prompt: 8, completion: 4 } });
      return Response.json({ error: { message: `no route for ${path}`, type: "invalid_request_error" } }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => void server.stop(true) };
}
