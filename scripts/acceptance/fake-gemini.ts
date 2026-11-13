// The acceptance run's Google (Gemini) provider on loopback: the user's own endpoint for `google`
// (`providers.google.baseUrl`), which the bundled Google model plugin's adapter reaches through the plugin host's keyed
// fetch (lane A's code-adapter clause). It answers every streamed turn with one reply and records, per request, its
// path, its model and whether the key header carried the run's key (never the key itself). Nothing leaves the machine.

export interface FakeGeminiRequest {
  path: string;
  model?: string;
  keyPresent: boolean;
  keyMatched: boolean;
}

export interface FakeGemini {
  url: string;
  requests: FakeGeminiRequest[];
  stop(): void;
}

/** One streamed Gemini answer: a text part and the finish, as `streamGenerateContent?alt=sse` sends it. */
export function geminiSse(text: string, model: string): string {
  const chunk = { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 }, modelVersion: model };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function startFakeGemini(o: { key: string; reply: string }): FakeGemini {
  const requests: FakeGeminiRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const key = req.headers.get("x-goog-api-key");
      const m = /^\/v1beta\/models\/([^/:]+)(?::(streamGenerateContent|generateContent|countTokens))?$/.exec(url.pathname);
      requests.push({ path: url.pathname, ...(m?.[1] !== undefined ? { model: decodeURIComponent(m[1]) } : {}), keyPresent: key !== null, keyMatched: key === o.key });
      if (key !== o.key) return Response.json({ error: { code: 401, message: "API key not valid", status: "UNAUTHENTICATED" } }, { status: 401 });
      if (req.method === "GET" && url.pathname === "/v1beta/models") return Response.json({ models: [] });
      if (m?.[2] === "streamGenerateContent") return new Response(geminiSse(o.reply, m[1]!), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      if (m?.[2] === "countTokens") return Response.json({ totalTokens: 8 });
      return Response.json({ error: { code: 404, message: `no route for ${url.pathname}`, status: "NOT_FOUND" } }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => void server.stop(true) };
}
