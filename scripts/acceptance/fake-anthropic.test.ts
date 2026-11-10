// The acceptance fake's documented rules (`requestRefusal`): what the real API refuses with a 400 is refused, what its
// docs accept is accepted. Each case names the rule in fake-anthropic.ts it exercises.
import { describe, expect, test } from "bun:test";
import { requestRefusal } from "./fake-anthropic";

const BETA = "mid-conversation-output-config-2026-07-01";
const effort = { role: "system", content: [], output_config: { effort: "high" } };
const u = (text = "hi") => ({ role: "user", content: [{ type: "text", text }] });
const a = (text = "ok") => ({ role: "assistant", content: [{ type: "text", text }] });
const added = (tool: Record<string, unknown> = { type: "tool_definition", definition: { name: "Echo", input_schema: { type: "object" } } }) => ({ role: "system", content: [{ type: "tool_addition", tool }] });
const ask = (model: string, messages: unknown[], beta: string | null = BETA, tools: unknown[] = []) => requestRefusal({ model, messages, tools } as never, beta);

describe("the strict fake's per-message effort rule", () => {
  test("the leading effort marker on a per-message-effort model, with its beta, is accepted", () => {
    expect(ask("claude-sonnet-5-5", [effort, u()])).toBeUndefined();
    expect(ask("claude-opus-5-5", [effort, u(), a(), effort, u()])).toBeUndefined();
  });
  test("an empty system message (no content, no effort) is refused", () => {
    expect(ask("claude-sonnet-5-5", [{ role: "system", content: [] }, u()])).toContain("no output_config.effort");
    expect(ask("claude-sonnet-5-5", [{ role: "system", content: "" }, u()])).toContain("no output_config.effort");
  });
  test("an effort marker without its beta, or on a model without per-message effort, is refused", () => {
    expect(ask("claude-sonnet-5-5", [effort, u()], null)).toContain(BETA);
    expect(ask("claude-sonnet-5-5", [effort, u()], "inline-tools-2026-09-15")).toContain(BETA);
    expect(ask("claude-fable-5", [effort, u()])).toContain("no per-message effort");
    expect(ask("claude-sonnet-5", [effort, u()])).toContain("no per-message effort");
  });
  test("a request with no system message needs no beta", () => {
    expect(ask("claude-sonnet-5", [u(), a(), u()], null)).toBeUndefined();
  });
  test("an unknown role is refused", () => {
    expect(ask("claude-sonnet-5-5", [{ role: "developer", content: "x" }, u()])).toContain("role must be");
  });
});

describe("the strict fake's mid-conversation system message rules", () => {
  test("a tool_addition after the user's turn, last or before an assistant turn, is accepted", () => {
    expect(ask("claude-sonnet-5-5", [effort, u(), a(), u(), added()])).toBeUndefined();
    expect(ask("claude-sonnet-5-5", [effort, u(), a(), u(), added(), a(), u()])).toBeUndefined();
  });
  test("a model the docs don't list for mid-conversation system messages refuses one with content", () => {
    expect(ask("claude-sonnet-5", [u(), added()], null)).toContain("takes no mid-conversation system messages");
    expect(ask("claude-haiku-5-5", [effort, u(), added()])).toContain("takes no mid-conversation system messages");
  });
  test("one with content that doesn't follow a user turn, or that a user turn follows, is refused", () => {
    expect(ask("claude-sonnet-5-5", [effort, u(), a(), added()])).toContain("immediately follow a user turn");
    expect(ask("claude-sonnet-5-5", [effort, u(), added(), u()])).toContain("precede an assistant turn");
  });
  test("an effort marker next to one with content makes the run follow the content rule", () => {
    // Leading marker then a text system message: the run has no user turn before it.
    expect(ask("claude-sonnet-5-5", [effort, added(), u()])).toContain("immediately follow a user turn");
    // After the user's turn, marker and content together, then the assistant: accepted.
    expect(ask("claude-sonnet-5-5", [effort, u(), effort, added(), a()])).toBeUndefined();
  });
  test("a tool_reference must name a tools entry declared with defer_loading", () => {
    const ref = added({ type: "tool_reference", name: "Echo" });
    expect(ask("claude-sonnet-5-5", [effort, u(), ref])).toContain("tool_reference_unresolved");
    expect(ask("claude-sonnet-5-5", [effort, u(), ref], BETA, [{ name: "Echo" }])).toContain("tool_reference_unresolved");
    expect(ask("claude-sonnet-5-5", [effort, u(), ref], BETA, [{ name: "Echo", defer_loading: true }])).toBeUndefined();
  });
});
