// A fake model provider on 127.0.0.1 that speaks Anthropic's Messages API (`POST /v1/messages`, JSON or SSE), for the
// acceptance run. It never forwards anything anywhere. It is scripted by the user's message:
//   ACCEPTANCE-ECHO   → a `tool_use` of the tool whose name ends in `Echo` (the fixture plugin's MCP tool)
//   ACCEPTANCE-WRITE  → a `tool_use` of `Write` to the path the run gave it
//   anything else     → the text `ACCEPTANCE-REPLY-OK`
// and after a `tool_result`, the text `ACCEPTANCE-DONE: <the result's text>`. A request whose `x-api-key` isn't the
// run's dummy key gets the 401 the real provider gives; the run reports only whether it matched, never a key.

export interface FakeRequest {
  path: string;
  /** Whether the request carried the run's dummy key. */
  keyMatched: boolean;
  /** Whether it carried any key at all. */
  keyPresent: boolean;
  model?: string;
  stream: boolean;
  tools: string[];
  lastUserText: string;
  toolResult?: { text: string; isError: boolean };
  answered: "text" | "tool_use" | "401" | "404";
  toolUse?: string;
}

export interface FakeProvider {
  url: string;
  requests: FakeRequest[];
  close(): void;
}

type Block = { type: string; text?: string; content?: unknown; is_error?: boolean };
type Message = { role: string; content: string | Block[] };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: Block) => (b.type === "text" && typeof b.text === "string" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n");
}

export function startFakeAnthropic(o: { key: string; writePath: string; writeContent: string }): FakeProvider {
  const requests: FakeRequest[] = [];
  let n = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const key = req.headers.get("x-api-key");
      const record: FakeRequest = { path, keyMatched: key === o.key, keyPresent: key !== null && key !== "", stream: false, tools: [], lastUserText: "", answered: "404" };
      if (req.method !== "POST" || !path.endsWith("/messages")) {
        requests.push(record);
        return Response.json({ type: "error", error: { type: "not_found_error", message: `the acceptance fake serves only POST /v1/messages, not ${req.method} ${path}` } }, { status: 404 });
      }
      let body: { model?: string; stream?: boolean; tools?: { name?: string }[]; messages?: Message[] } = {};
      try { body = await req.json(); } catch { /* an empty body */ }
      record.model = body.model;
      record.stream = body.stream === true;
      record.tools = (body.tools ?? []).map((t) => String(t.name ?? ""));
      const messages = body.messages ?? [];
      const last = messages[messages.length - 1];
      const lastBlocks = Array.isArray(last?.content) ? (last!.content as Block[]) : [];
      const result = lastBlocks.find((b) => b.type === "tool_result");
      if (result !== undefined) record.toolResult = { text: textOf(result.content).slice(0, 2000), isError: result.is_error === true };
      const lastUser = [...messages].reverse().find((m) => m.role === "user" && !(Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")));
      record.lastUserText = textOf(lastUser?.content).slice(-4000);
      requests.push(record);
      if (!record.keyMatched) {
        record.answered = "401";
        return Response.json({ type: "error", error: { type: "authentication_error", message: record.keyPresent ? "invalid x-api-key" : "x-api-key header is required" } }, { status: 401 });
      }
      const id = `msg_acceptance_${++n}`;
      const model = body.model ?? "acceptance";
      let content: Record<string, unknown>[];
      let stop: string;
      if (result !== undefined) {
        content = [{ type: "text", text: `ACCEPTANCE-DONE: ${record.toolResult!.text.slice(0, 500)}` }];
        stop = "end_turn";
      } else if (record.lastUserText.includes("ACCEPTANCE-ECHO")) {
        const tool = record.tools.find((t) => t.endsWith("Echo"));
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-ECHO-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { text: "acceptance-ping" } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (record.lastUserText.includes("ACCEPTANCE-WRITE")) {
        const tool = record.tools.find((t) => t === "Write");
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-WRITE-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { file_path: o.writePath, content: o.writeContent } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else {
        content = [{ type: "text", text: "ACCEPTANCE-REPLY-OK" }];
        stop = "end_turn";
      }
      record.answered = stop === "tool_use" ? "tool_use" : "text";
      const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      if (!record.stream) {
        return Response.json({ id, type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage });
      }
      const events: [string, unknown][] = [["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }]];
      content.forEach((block, index) => {
        if (block.type === "text") {
          events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
          events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
        } else {
          events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
          events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
        }
        events.push(["content_block_stop", { type: "content_block_stop", index }]);
      });
      events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }]);
      events.push(["message_stop", { type: "message_stop" }]);
      const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
      return new Response(text, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, close: () => server.stop(true) };
}
