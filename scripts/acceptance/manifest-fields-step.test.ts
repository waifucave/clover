import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { HELPER_REFUSAL, NODE_REFUSAL, offerWrong, writeClaudePlugin, writeElsewhere, writeFields, writeReach, writeRefused } from "./manifest-fields-step";

const root = mkdtempSync(join(tmpdir(), "clover-b-fields-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const errors = async (dir: string) => (await validatePluginFolder(dir, { os: "macos" })).issues.filter((i) => i.severity === "error").map((i) => i.message);

test("the refused fixtures fail validation with their instead-messages, and nothing else", async () => {
  const { node, helper } = writeRefused(root);
  const n = await errors(node);
  expect(n.length).toBe(1);
  expect(n[0]).toContain(NODE_REFUSAL);
  const h = await errors(helper);
  expect(h.length).toBe(1);
  expect(h[0]).toContain(HELPER_REFUSAL);
});

test("the other fixtures validate", async () => {
  const { agents, cc } = writeReach(root);
  for (const dir of [writeFields(root), writeElsewhere(root, "darwin-arm64"), agents, cc]) expect([dir, await errors(dir)]).toEqual([dir, []]);
  // The Claude Code folder isn't a Clover plugin until wrapped: it has no clover.json.
  expect(writeClaudePlugin(root)).toEndWith("acc-claude-plugin");
});

test("the offer verdict names each field that went wrong", () => {
  const bot = ["mcp__acceptance-fields-local__FieldsLocal", "mcp__acceptance-fields-mac__FieldsMac", "mcp__acceptance-cc-only-tools__CcOnly"];
  const coding = ["mcp__clover_0123456789abcdef__acceptance-agents-only-tools__AgentsOnly"];
  expect(offerWrong({ bot, coding })).toEqual([]);
  expect(offerWrong({ bot: [...bot, "mcp__acceptance-fields-win__FieldsWin"], coding: [...coding, "mcp__x__CcOnly"] })).toEqual([
    "Alpha was offered FieldsWin (when.os windows)",
    "the coding session on Clover's own agent was offered CcOnly (onlyBackends: claude-code)",
  ]);
});
