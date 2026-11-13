// The acceptance run's third-party code model adapter (row 1.91): a turn is one POST to its provider through the
// core's keyed fetch (`net.fetch`, its `api-key` entry, which the core places in `x-api-key`); the provider's answer is
// the reply. It never sees the key.
type Ctx = { signal: AbortSignal; api: { net: { fetch(url: string, init?: RequestInit, opts?: { auth?: string }): Promise<Response> } } };
type Args = { req: { model: string } };

export const adapter = {
  describe: () => ({ interfaceVersion: 1, id: "plugin.acceptance-models.adapter", version: "0.0.1", family: "custom", protocol: "openai-chat", countTokens: false }),
  async *streamTurn(args: Args, ctx: Ctx) {
    let r: Response;
    try {
      r = await ctx.api.net.fetch("https://api.acceptance-models.com/v1/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: args.req.model }), signal: ctx.signal }, { auth: "api-key" });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      yield { type: "error", error: { code: "network", message: `${err.code ? `${err.code}: ` : ""}${err.message ?? String(e)}`, retryable: false } };
      return;
    }
    if (!r.ok) {
      yield { type: "error", error: { code: r.status === 401 ? "auth" : "server", message: `the acceptance provider answered ${r.status}`, retryable: false } };
      return;
    }
    yield { type: "message_start", model: args.req.model };
    yield { type: "text_delta", text: await r.text() };
    yield { type: "usage", inputTokens: 3, outputTokens: 4 };
    yield { type: "done", stopReason: "end_turn" };
  },
  listModels: async () => ({ models: [] }),
  validateCredential: async () => ({ ok: true }),
};
