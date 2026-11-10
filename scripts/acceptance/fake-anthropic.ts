// A fake model provider on 127.0.0.1 that speaks Anthropic's Messages API (`POST /v1/messages`, JSON or SSE), for the
// acceptance run. It never forwards anything anywhere. It is scripted by the user's message:
//   ACCEPTANCE-ECHO   → a `tool_use` of the tool whose name ends in `Echo` (the fixture plugin's MCP tool)
//   ACCEPTANCE-WRITE  → a `tool_use` of `Write` to the path the run gave it
//   ACCEPTANCE-TAG-<id> → the text `ACCEPTANCE-REPLY-OK ACCEPTANCE-TAG-<id>` (a reply only this turn can have caused)
//   anything else     → the text `ACCEPTANCE-REPLY-OK`
// and after a `tool_result`, the text `ACCEPTANCE-DONE: <the result's text>`. A request whose `x-api-key` isn't the
// run's dummy key gets the 401 the real provider gives; the run reports only whether it matched, never a key.
//
// It is STRICT where the provider documents a rule (`requestRefusal`): a request the real API would refuse gets the
// 400 it would give, so the run can't pass on a request the owner's first real turn would fail. Each rule names its
// source; a rule with no source isn't checked.
import { activeCatalog } from "../../packages/core/src/runtime-sdk/model-plugins/catalog-source";

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
  answered: "text" | "tool_use" | "400" | "401" | "404";
  /** The documented rule a refused request broke (a 400). */
  refused?: string;
  /** The request as sent, for a test of the wire (holds the dummy key's run's prompt text, never a key). */
  body?: unknown;
  /** Its `anthropic-beta` header. */
  beta?: string | null;
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

type WireMessage = { role?: unknown; content?: unknown; output_config?: { effort?: unknown } };
type WireBody = { model?: unknown; tools?: { name?: unknown; defer_loading?: unknown }[]; messages?: WireMessage[] };

/** What the catalog's official-doc evidence says of an Anthropic model (by its wire id): its per-message effort beta,
 *  and whether it takes mid-conversation system messages. */
function evidenceOf(model: unknown): { perMessageBeta?: string; midConversationSystem: boolean } {
  const row = activeCatalog().models.find((m) => m.providerId === "anthropic" && m.upstreamId === model) as
    | { reasoning?: { perMessageEffort?: { value?: { beta?: unknown } } }; midConversationSystem?: { value?: unknown } }
    | undefined;
  const beta = row?.reasoning?.perMessageEffort?.value?.beta;
  return { ...(typeof beta === "string" ? { perMessageBeta: beta } : {}), midConversationSystem: row?.midConversationSystem?.value === true };
}

const blocksOf = (m: WireMessage): Record<string, unknown>[] => (Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : typeof m.content === "string" && m.content !== "" ? [{ type: "text", text: m.content }] : []);

/**
 * The rule a request breaks that the real API refuses with a 400, or undefined. Sources: the SDK catalog's
 * official-doc evidence (`reasoning.perMessageEffort`, `midConversationSystem`, quoting
 * platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta and
 * platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages), the placement rules the SDK's
 * request layout quotes from the latter page (runtime/src/context/request-layout.ts), and the API's
 * `tool_reference_unresolved` error the provider runtime's adapter cites.
 */
export function requestRefusal(body: WireBody, betaHeader: string | null): string | undefined {
  const messages = body.messages ?? [];
  const betas = (betaHeader ?? "").split(",").map((b) => b.trim()).filter((b) => b !== "");
  const evidence = evidenceOf(body.model);
  const deferred = new Set((body.tools ?? []).filter((t) => t.defer_loading === true).map((t) => String(t.name ?? "")));
  for (const [i, m] of messages.entries()) {
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") return `messages.${i}: role must be user, assistant or system`;
    if (m.role !== "system") continue;
    const blocks = blocksOf(m);
    if (blocks.length === 0) {
      // Effort page: per-message effort is "a role:"system" message with empty content and output_config.effort",
      // with the beta header; "Models without per-message effort ... return a 400 error".
      if (typeof m.output_config?.effort !== "string") return `messages.${i}: a system message with no content carries nothing (no output_config.effort)`;
      if (evidence.perMessageBeta === undefined) return `messages.${i}: ${String(body.model)} has no per-message effort (an effort-only system message is a 400)`;
      if (!betas.includes(evidence.perMessageBeta)) return `messages.${i}: an effort-only system message needs the anthropic-beta ${evidence.perMessageBeta}`;
      continue;
    }
    // Mid-conversation system messages page: "This feature is not available on Claude Sonnet 5" (and every model the
    // evidence doesn't list).
    if (!evidence.midConversationSystem) return `messages.${i}: ${String(body.model)} takes no mid-conversation system messages`;
    for (const b of blocks) {
      if (b.type === "tool_addition" && (b.tool as { type?: unknown } | undefined)?.type === "tool_reference") {
        const name = String((b.tool as { name?: unknown }).name ?? "");
        if (!deferred.has(name)) return `messages.${i}: tool_reference_unresolved: ${name} isn't declared in tools with defer_loading`;
      }
    }
  }
  // Placement (mid-conversation system messages page, as the SDK's request layout quotes it): a system message
  // carrying content "must immediately follow a user turn" and "must either be the last entry in messages or be
  // immediately followed by an assistant turn"; effort-only ones are "accepted anywhere in messages, including as the
  // first entry", but "adding a text-carrying message next to an effort-only one makes the whole group follow the
  // content rule". So each run of system messages that holds content follows the content rule as a whole.
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role !== "system") continue;
    let j = i;
    while (j + 1 < messages.length && messages[j + 1]!.role === "system") j++;
    const run = messages.slice(i, j + 1);
    if (run.some((m) => blocksOf(m).length > 0)) {
      const before = messages[i - 1];
      const after = messages[j + 1];
      if (before?.role !== "user") return `messages.${i}: a system message with content must immediately follow a user turn`;
      if (after !== undefined && after.role !== "assistant") return `messages.${j}: a system message with content must end messages or precede an assistant turn`;
    }
    i = j;
  }
  return undefined;
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
      record.body = body;
      record.beta = req.headers.get("anthropic-beta");
      record.stream = body.stream === true;
      record.tools = (body.tools ?? []).map((t) => String(t.name ?? ""));
      const messages = body.messages ?? [];
      // Tools added mid-conversation (a plugin installed after the first turn) come as `tool_addition` blocks in a
      // `role: "system"` message, by definition or by reference to a deferred `tools` entry, not in `tools` (the cached
      // prefix stays as it was): Anthropic's mid-conversation system messages. They're offered from then on.
      for (const m of messages) {
        if (m.role !== "system" || !Array.isArray(m.content)) continue;
        for (const b of m.content as { type?: string; tool?: { definition?: { name?: unknown }; name?: unknown } }[]) {
          if (b.type !== "tool_addition") continue;
          const name = b.tool?.definition?.name ?? b.tool?.name;
          if (typeof name === "string" && !record.tools.includes(name)) record.tools.push(name);
        }
      }
      const last = messages[messages.length - 1];
      const lastBlocks = Array.isArray(last?.content) ? (last!.content as Block[]) : [];
      const result = lastBlocks.find((b) => b.type === "tool_result");
      if (result !== undefined) record.toolResult = { text: textOf(result.content).slice(0, 2000), isError: result.is_error === true };
      const lastUser = [...messages].reverse().find((m) => m.role === "user" && !(Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")));
      record.lastUserText = textOf(lastUser?.content).slice(-4000);
      requests.push(record);
      const refused = requestRefusal(body as WireBody, record.beta);
      if (refused !== undefined && record.keyMatched) {
        record.answered = "400";
        record.refused = refused;
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: refused } }, { status: 400 });
      }
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
      } else if (/ACCEPTANCE-TAG-[A-Z0-9]+/.test(record.lastUserText)) {
        content = [{ type: "text", text: `ACCEPTANCE-REPLY-OK ${/ACCEPTANCE-TAG-[A-Z0-9]+/.exec(record.lastUserText)![0]}` }];
        stop = "end_turn";
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
