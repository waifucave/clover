// A fake model provider on 127.0.0.1 that speaks Anthropic's Messages API (`POST /v1/messages`, JSON or SSE), for the
// acceptance run. It never forwards anything anywhere. It is scripted by the user's message:
//   ACCEPTANCE-CALL <tool> <json> → a `tool_use` of the tool named <tool>, or whose name ends in `__<tool>`, with that
//                       input, once in the turn (a deferred one loaded through Glossary first); the examples' steps
//   ACCEPTANCE-ECHO   → a `tool_use` of the tool whose name ends in `Echo` (the fixture plugin's MCP tool)
//   ACCEPTANCE-STDIO  → a `tool_use` of the tool whose name ends in `StdioProbe` (the fixture's stdio server's tool)
//   ACCEPTANCE-STAGE <mood> → a `tool_use` of the tool whose name ends in `__set_mood` (Alpha's stage) with that mood
//   ACCEPTANCE-AGENT <root> → a `tool_use` of `Agent`: Alpha's study-buddy definition on clover-code in <root>, with
//                       the brief `ACCEPTANCE-CHILD …`
//   ACCEPTANCE-CHILD  → the child agent's own turn: text, `CHILD_REPORT`
//   ACCEPTANCE-STAGE-STATUS → a `tool_use` of the tool whose name ends in `__stage_status` (Alpha's read-only tool)
//   ACCEPTANCE-EDIT   → a `tool_use` of `Edit` (a few lines out, a few in) on a file in the write path's folder, for the card renders
//   ACCEPTANCE-BASH   → a `tool_use` of `Bash` with a two-line command, for the same
//   ACCEPTANCE-HOLDTOOL → the same tool with `acceptance-hold`, which the fixture never answers (a call left running)
//   ACCEPTANCE-WRITE  → a `tool_use` of `Write` to the path the run gave it (a sensitive place: a dot-folder)
//   ACCEPTANCE-WRITE-ORDINARY → a `tool_use` of `Write` to the run's ordinary path (a file in Downloads)
//   ACCEPTANCE-READ <path> → a `tool_use` of `Read` for that path
//   ACCEPTANCE-FETCH <url> → a `tool_use` of the tool whose name ends in `WebFetch`, for that address
//   ACCEPTANCE-FETCH-COMPOSED → the same, for the run's made-up address (one the user's message never gave)
//   ACCEPTANCE-FETCH-LINKED → the same, for the address a page the bot read named (one the user's message never gave)
//   ACCEPTANCE-SEARCH → a `tool_use` of the tool whose name ends in `WebSearch` (the bundled web plugin's), which the
//                       run's fake search backend answers (fake-exa.ts)
//   ACCEPTANCE-TAG-<id> → the text `ACCEPTANCE-REPLY-OK ACCEPTANCE-TAG-<id>` (a reply only this turn can have caused)
//   ACCEPTANCE-SLOW   → a turn that keeps running: the stream starts (`ACCEPTANCE-SLOW-PARTIAL`) and doesn't end for two
//                       minutes, or until the daemon drops the request (the reopen steps quit the app mid-turn)
//   ACCEPTANCE-FAIL-<id> → a turn that fails: a 400 `invalid_request_error` (nothing the runtime retries), until the run
//                       calls `heal(<id>)`; then the text `ACCEPTANCE-REPLY-OK ACCEPTANCE-FAIL-<id>` (Try again's step)
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
  answered: "text" | "tool_use" | "slow" | "400" | "401" | "404" | "torn" | "failed";
  /** When the request came (ms since the epoch), and, for a `torn` one, why its body never arrived whole (the
   *  connection closed under it: Bun's 10 s idle timeout once the sender stopped sending). The fake answered nothing. */
  at?: number;
  torn?: string;
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
  /** Stops failing the turns `ACCEPTANCE-FAIL-<id>` asks for: the next request with that id gets its reply. */
  heal(id: string): void;
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

/** The user text from its last directive on (`ACCEPTANCE-SLOW`, `-HOLDTOOL`, `-ECHO`, `-STDIO`, `-FETCH`, `-SEARCH`, `-WRITE`, `-TAG`,
 *  `-REPLY`): the newest message's, when an unanswered one came before it in the same text. All of it when it has none. */
const DIRECTIVE = /ACCEPTANCE-(?:NETPROBE|SLOW|HOLDTOOL|ECHO|STDIO|FETCH|SEARCH|WRITE|EDIT|BASH|READ|TAG|REPLY|AGENT|CHILD|FAIL)\b/;
/** What the child agent answers (`ACCEPTANCE-CHILD`): a mark no directive matches, for the run to find in the parent's
 *  transcript. */
export const CHILD_REPORT = "ACCEPTANCE_CHILD_REPORT: notes written";

export function newestDirective(text: string): string {
  let at = -1;
  for (const m of text.matchAll(new RegExp(DIRECTIVE.source, "g"))) at = m.index;
  return at < 0 ? text : text.slice(at);
}

export function startFakeAnthropic(o: { key: string; writePath: string; writeContent: string; ordinaryWritePath?: string; composedFetchUrl?: string; linkedFetchUrl?: string }): FakeProvider {
  const requests: FakeRequest[] = [];
  const healed = new Set<string>();
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
      record.at = Date.now();
      let raw: string;
      try {
        raw = await req.text();
      } catch (err) {
        // The body never came whole: not a request the fake answered, and the step must say so (try 10's upgrade pair
        // counted one as answered, with the sender's ECONNRESET as the only trace).
        record.answered = "torn";
        record.torn = `${err instanceof Error ? err.message : String(err)} (content-length ${req.headers.get("content-length") ?? "none"}, ${((Date.now() - record.at) / 1000).toFixed(1)} s after its headers)`;
        requests.push(record);
        console.error(`acceptance fake: ${new Date(record.at).toISOString()} POST ${path}: the body never arrived whole: ${record.torn}`);
        return new Response(null, { status: 400 });
      }
      try { body = JSON.parse(raw); } catch { /* an empty body */ }
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
      // A user turn that carries results AND a new message with a directive (the runtime's own results for calls a stop
      // cut off, sent with the next message): the message is what this request asks, not the results.
      const lastSaid = last?.role === "user" ? textOf(lastBlocks.filter((b) => b.type === "text")) : "";
      const carriesMessage = DIRECTIVE.test(lastSaid);
      const result = carriesMessage ? undefined : lastBlocks.find((b) => b.type === "tool_result");
      if (result !== undefined) record.toolResult = { text: textOf(result.content).slice(0, 2000), isError: result.is_error === true };
      const lastUser = carriesMessage ? last : [...messages].reverse().find((m) => m.role === "user" && !(Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")));
      record.lastUserText = (carriesMessage ? lastSaid : textOf(lastUser?.content)).slice(-4000);
      if (carriesMessage && lastBlocks.some((b) => b.type === "tool_result")) console.error(`acceptance fake: a user turn with ${lastBlocks.filter((b) => b.type === "tool_result").length} tool result(s) and a new message: acting on the message`);
      // What the fake acts on: the newest directive in that text. A turn quit before its answer (the reopen steps')
      // leaves its message unanswered, and the next request carries it into the same user text: the upgrade pair's
      // step 4 ("ACCEPTANCE-TAG-…") once got the held slow turn of an old run's "ACCEPTANCE-SLOW-…".
      const said = newestDirective(record.lastUserText);
      if (said !== record.lastUserText && DIRECTIVE.test(record.lastUserText.slice(0, record.lastUserText.length - said.length))) {
        console.error(`acceptance fake: the user text carries an earlier directive before the newest: ${JSON.stringify(record.lastUserText.slice(0, record.lastUserText.length - said.length).slice(-120))} then ${JSON.stringify(said.slice(0, 80))}; acting on the newest`);
      }
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
      const failTag = /ACCEPTANCE-FAIL-([A-Z0-9]+)/.exec(said)?.[1];
      if (failTag !== undefined && !healed.has(failTag) && result === undefined) {
        // A failure the runtime does not retry (a retried one would only wait): the turn ends in an error.
        record.answered = "failed";
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "ACCEPTANCE scripted failure" } }, { status: 400 });
      }
      const id = `msg_acceptance_${++n}`;
      const model = body.model ?? "acceptance";
      if (said.includes("ACCEPTANCE-SLOW") && result === undefined) {
        record.answered = "slow";
        return slowTurn(req.signal, id, model, record.stream);
      }
      let content: Record<string, unknown>[];
      let stop: string;
      // A plugin's network probe, the one whose tool name names the given server (two plugins offer one), called once
      // in this turn; a deferred one (a pasted server's: on-demand) is loaded through Glossary first, as a model does.
      const netWant = /ACCEPTANCE-NETPROBE (\S+)/.exec(said)?.[1];
      const netTool = netWant === undefined ? undefined : record.tools.find((t) => t.endsWith("NetProbe") && t.includes(netWant));
      const turnStart = Math.max(0, messages.lastIndexOf(lastUser as Message));
      const since = messages.slice(turnStart + 1);
      const usedSince = (name: string) => since.some((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Block[]).some((b) => b.type === "tool_use" && (b as { name?: unknown }).name === name));
      const netDeferred = netTool !== undefined && (body.tools ?? []).some((t) => t.name === netTool && (t as { defer_loading?: unknown }).defer_loading === true);
      const netLoaded = netTool !== undefined && messages.some((m) => m.role === "system" && Array.isArray(m.content) && (m.content as { type?: string; tool?: { name?: unknown } }[]).some((b) => b.type === "tool_addition" && b.tool?.name === netTool));
      const glossary = record.tools.find((t) => t === "Glossary" || t.endsWith("__Glossary"));
      // Any tool by the end of its name, with the input the line gives (`ACCEPTANCE-CALL <suffix> <json>`), called once in
      // this turn; a deferred one is loaded through Glossary first, as a model does.
      const callWant = /ACCEPTANCE-CALL (\S+) (\{.*\})\s*$/s.exec(said);
      const callTool = callWant === null ? undefined : record.tools.find((t) => t === callWant[1] || t.endsWith(`__${callWant[1]}`));
      const callInput = callWant === null ? undefined : (() => { try { return JSON.parse(callWant[2]!) as Record<string, unknown>; } catch { return undefined; } })();
      const callDeferred = callTool !== undefined && (body.tools ?? []).some((t) => t.name === callTool && (t as { defer_loading?: unknown }).defer_loading === true);
      const callLoaded = callTool !== undefined && messages.some((m) => m.role === "system" && Array.isArray(m.content) && (m.content as { type?: string; tool?: { name?: unknown } }[]).some((b) => b.type === "tool_addition" && b.tool?.name === callTool));
      if (callWant !== null && (callTool === undefined || callInput === undefined) && result === undefined) {
        content = [{ type: "text", text: `ACCEPTANCE-NO-CALL-TOOL ${callWant[1]}${callInput === undefined ? " (its input isn't JSON)" : ""}` }];
        stop = "end_turn";
      } else if (callTool !== undefined && callInput !== undefined && !usedSince(callTool) && callDeferred && !callLoaded && glossary !== undefined && !usedSince(glossary)) {
        content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: glossary, input: { load: callTool } }];
        stop = "tool_use";
        record.toolUse = glossary;
      } else if (callTool !== undefined && callInput !== undefined && !usedSince(callTool)) {
        content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: callTool, input: callInput }];
        stop = "tool_use";
        record.toolUse = callTool;
      } else if (netWant !== undefined && netTool === undefined && result === undefined) {
        content = [{ type: "text", text: `ACCEPTANCE-NO-NETPROBE-TOOL ${netWant}` }];
        stop = "end_turn";
      } else if (netTool !== undefined && !usedSince(netTool) && netDeferred && !netLoaded && glossary !== undefined && !usedSince(glossary)) {
        content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: glossary, input: { load: netTool } }];
        stop = "tool_use";
        record.toolUse = glossary;
      } else if (netTool !== undefined && !usedSince(netTool)) {
        content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: netTool, input: {} }];
        stop = "tool_use";
        record.toolUse = netTool;
      } else if (result !== undefined) {
        content = [{ type: "text", text: `ACCEPTANCE-DONE: ${record.toolResult!.text.slice(0, 500)}` }];
        stop = "end_turn";
      } else if (said.includes("ACCEPTANCE-ECHO") || said.includes("ACCEPTANCE-HOLDTOOL")) {
        const tool = record.tools.find((t) => t.endsWith("Echo"));
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-ECHO-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { text: said.includes("ACCEPTANCE-HOLDTOOL") ? "acceptance-hold" : "acceptance-ping" } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (said.includes("ACCEPTANCE-CHILD")) {
        content = [{ type: "text", text: CHILD_REPORT }];
        stop = "end_turn";
      } else if (said.includes("ACCEPTANCE-AGENT")) {
        const tool = record.tools.find((t) => t === "Agent");
        const root = /ACCEPTANCE-AGENT (\S+)/.exec(said)?.[1] ?? "";
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-AGENT-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { agent: "alpha:study-buddy", backend: "clover-code", root, description: "Study notes", prompt: "ACCEPTANCE-CHILD: read the folder and say you're done." } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (said.includes("ACCEPTANCE-STAGE-STATUS")) {
        const tool = record.tools.find((t) => t.endsWith("__stage_status"));
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-STAGE-STATUS-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: {} }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (said.includes("ACCEPTANCE-STAGE")) {
        const tool = record.tools.find((t) => t.endsWith("__set_mood"));
        const mood = /ACCEPTANCE-STAGE (\w+)/.exec(said)?.[1] ?? "joy";
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-STAGE-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { mood } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (said.includes("ACCEPTANCE-STDIO")) {
        const tool = record.tools.find((t) => t.endsWith("StdioProbe"));
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-STDIO-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: {} }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if ((said.includes("ACCEPTANCE-FETCH-COMPOSED") && o.composedFetchUrl !== undefined) || (said.includes("ACCEPTANCE-FETCH-LINKED") && o.linkedFetchUrl !== undefined)) {
        const tool = record.tools.find((t) => t.endsWith("WebFetch"));
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-FETCH-TOOL" }];
          stop = "end_turn";
        } else {
          const url = said.includes("ACCEPTANCE-FETCH-LINKED") ? o.linkedFetchUrl! : o.composedFetchUrl!;
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { url } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (/ACCEPTANCE-FETCH (\S+)/.test(said)) {
        const tool = record.tools.find((t) => t.endsWith("WebFetch"));
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-FETCH-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { url: /ACCEPTANCE-FETCH (\S+)/.exec(said)![1] } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (said.includes("ACCEPTANCE-SEARCH")) {
        const tool = record.tools.find((t) => t.endsWith("WebSearch"));
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-SEARCH-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { query: "acceptance search" } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (/ACCEPTANCE-READ (\S+)/.test(said)) {
        const tool = record.tools.find((t) => t === "Read");
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-READ-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { file_path: /ACCEPTANCE-READ (\S+)/.exec(said)![1] } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (said.includes("ACCEPTANCE-EDIT") || said.includes("ACCEPTANCE-BASH")) {
        const edit = said.includes("ACCEPTANCE-EDIT");
        const tool = record.tools.find((t) => t === (edit ? "Edit" : "Bash"));
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-TOOL" }];
          stop = "end_turn";
        } else {
          const input = edit
            ? { file_path: o.writePath.replace(/[^/\\]+$/, "story_of_egypt.md"), old_string: "The river rose each year.\nThe farmers waited.\nThen the fields were green.", new_string: "The Nile rose each summer.\nThe farmers waited for the silt.\nThen the fields were green again.\nThe harvest came in autumn." }
            : { command: "mkdir -p build\nrm -rf build/cache\nls build", description: "Clean the build folder" };
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (said.includes("ACCEPTANCE-WRITE-ORDINARY") && o.ordinaryWritePath !== undefined) {
        const tool = record.tools.find((t) => t === "Write");
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-WRITE-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { file_path: o.ordinaryWritePath, content: o.writeContent } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (said.includes("ACCEPTANCE-WRITE")) {
        const tool = record.tools.find((t) => t === "Write");
        if (tool === undefined) {
          content = [{ type: "text", text: "ACCEPTANCE-NO-WRITE-TOOL" }];
          stop = "end_turn";
        } else {
          content = [{ type: "tool_use", id: `toolu_acceptance_${n}`, name: tool, input: { file_path: o.writePath, content: o.writeContent } }];
          stop = "tool_use";
          record.toolUse = tool;
        }
      } else if (failTag !== undefined) {
        content = [{ type: "text", text: `ACCEPTANCE-REPLY-OK ACCEPTANCE-FAIL-${failTag}` }];
        stop = "end_turn";
      } else if (/ACCEPTANCE-TAG-[A-Z0-9]+/.test(said)) {
        content = [{ type: "text", text: `ACCEPTANCE-REPLY-OK ${/ACCEPTANCE-TAG-[A-Z0-9]+/.exec(said)![0]}` }];
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
  return { url: `http://127.0.0.1:${server.port}`, requests, heal: (id: string) => void healed.add(id), close: () => server.stop(true) };
}

/** A turn that keeps running (ACCEPTANCE-SLOW): the stream's start and a partial text at once, then nothing for two
 *  minutes or until the caller drops the request; a non-streaming request waits the same and then answers. */
function slowTurn(signal: AbortSignal, id: string, model: string, stream: boolean): Response | Promise<Response> {
  const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const hold = (): Promise<void> => new Promise((resolve) => {
    const t = setTimeout(resolve, 120_000);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
  if (!stream) {
    return hold().then(() => Response.json({ id, type: "message", role: "assistant", model, content: [{ type: "text", text: "ACCEPTANCE-SLOW-DONE" }], stop_reason: "end_turn", stop_sequence: null, usage }));
  }
  const enc = new TextEncoder();
  const ev = (event: string, data: unknown): Uint8Array => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(ev("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } }));
      c.enqueue(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      c.enqueue(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ACCEPTANCE-SLOW-PARTIAL " } }));
      await hold();
      if (signal.aborted) { try { c.close(); } catch { /* gone */ } return; }
      c.enqueue(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ACCEPTANCE-SLOW-DONE" } }));
      c.enqueue(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
      c.enqueue(ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }));
      c.enqueue(ev("message_stop", { type: "message_stop" }));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
