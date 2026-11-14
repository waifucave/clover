import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPartLines, describeOk, validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { AGENTS_ONLY_SHORT, BOT_PARTS_LINES, BOT_SIDEBAR_REFUSAL, botPartsWrong, HELPER_REFUSAL, NODE_REFUSAL, offerWrong, writeBotOnSidebar, writeBotParts, writeClaudePlugin, writeElsewhere, writeFields, writeReach, writeRefused } from "./manifest-fields-step";

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

test("the plugin with a bot validates and its OK lines are the ones the row looks for; a bot's entry on the sidebar is refused with its words", async () => {
  const dir = writeBotParts(root, "anthropic/claude-test");
  expect(await errors(dir)).toEqual([]);
  const r = validateManifest(JSON.parse(readFileSync(join(dir, "clover.json"), "utf8")));
  expect(botPartLines(r.manifest)).toEqual([...BOT_PARTS_LINES]);
  expect(describeOk(r)).toEqual(expect.arrayContaining([...BOT_PARTS_LINES]));
  const side = await errors(writeBotOnSidebar(root));
  expect(side.length).toBe(1);
  expect(side[0]).toContain(BOT_SIDEBAR_REFUSAL);
});

test("the plugin-with-a-bot verdict names each offer that went wrong", () => {
  const notes = "mcp__acc-juniper-notes__JuniperNotes";
  const stage = "mcp__acc-juniper-stage__JuniperStage";
  expect(botPartsWrong({ alpha: [notes], bot: [notes, stage], after: [stage] })).toEqual([]);
  expect(botPartsWrong({ alpha: [notes, stage], bot: [notes], after: [stage, notes] })).toEqual([
    "Alpha was offered JuniperStage (inside Juniper: scope own-bot)",
    "Juniper wasn't offered JuniperStage (her own)",
    "with its app parts off, Juniper was still offered JuniperNotes (beside her)",
  ]);
});

test("the offer verdict names each field that went wrong", () => {
  const bot = ["mcp__acc-fields-local__FieldsLocal", "mcp__acc-fields-mac__FieldsMac", "mcp__acc-cc-tools__CcOnly"];
  const coding = [`mcp__clover_0123456789abcdef__${AGENTS_ONLY_SHORT}`];
  expect(AGENTS_ONLY_SHORT).toMatch(/^acceptance-agen__AgentsOnly_[0-9a-f]{6}$/);
  expect(offerWrong({ bot, coding })).toEqual([]);
  expect(offerWrong({ bot: [...bot, "mcp__acc-fields-win__FieldsWin"], coding: [...coding, "mcp__x__CcOnly"] })).toEqual([
    "Alpha was offered FieldsWin (when.os windows)",
    "the coding session on Clover's own agent was offered CcOnly (onlyBackends: claude-code)",
  ]);
});
