import { describe, expect, test } from "bun:test";
import { liveAgents } from "../client/agents";
import type { ConversationItem } from "../client/types";

describe("liveAgents", () => {
  test("names the agent by its definition, with its backend, status and latest line", () => {
    const items = [
      { id: "r1", kind: "agent-report", at: 1, from: { kind: "agent", id: "s1", name: "x" }, text: "Reading chapter 2\nmore" },
      { id: "r2", kind: "agent-report", at: 2, from: { kind: "agent", id: "s1", name: "x" }, text: "Writing questions" },
    ] as unknown as ConversationItem[];
    const [a] = liveAgents(items, { s1: { definition: "alpha:study-buddy", backend: "claude", status: "prompting" } });
    expect(a).toEqual({ id: "s1", name: "study-buddy", backend: "claude", status: "prompting", line: "Writing questions" });
  });
  test("a finish wins over the session's last status", () => {
    const items = [{ id: "f1", kind: "task-notification", at: 3, task: { kind: "agent", agentId: "s1", name: "x", backend: "codex" }, status: "failed" }] as unknown as ConversationItem[];
    expect(liveAgents(items, { s1: { definition: "p:d", status: "idle" } })[0]).toMatchObject({ name: "d", backend: "codex", status: "failed" });
  });
  test("nothing, with no agents", () => expect(liveAgents([], undefined)).toEqual([]));
});
