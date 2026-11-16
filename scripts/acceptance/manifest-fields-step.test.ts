import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPartLines, describeOk, validateManifest } from "../../packages/plugin-sdk/src/manifest/validate";
import { validatePluginFolder } from "../../packages/core/src/registry/validate";
import { CAPABILITIES } from "../../packages/plugin-sdk/src/catalogs/capabilities";
import { asksAllWrong, ONCE_MOSS_OWN, writeAsksAll, AGENTS_ONLY_SHORT, BACKGROUND_IDS, writeBackground, MIC_IDS, writeMicrophone, BOT_COMMAND_REFUSAL, BOT_PARTS_LINES, BOT_SIDEBAR_REFUSAL, botPartsWrong, HELPER_REFUSAL, NODE_REFUSAL, oldSidebarTaken, offerWrong, OWN_BOT_ITEMS, ownBotWrong, writeBotOnSidebar, writeBotParts, writeClaudePlugin, writeElsewhere, writeFields, writeOldSidebarTheme, writeReach, writeRefusals, writeRefused } from "./manifest-fields-step";

const root = mkdtempSync(join(tmpdir(), "moss-b-fields-"));
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
  // The Claude Code folder isn't a MOSS plugin until wrapped: it has no moss.json.
  expect(writeClaudePlugin(root)).toEndWith("acc-claude-plugin");
});

test("the background fixtures validate; the OK says it keeps a part running, and only the sound one holds audio", async () => {
  const sound = writeBackground(root, BACKGROUND_IDS.sound, { audio: true });
  const quiet = writeBackground(root, BACKGROUND_IDS.quiet, { audio: false });
  for (const dir of [sound, quiet]) expect([dir, await errors(dir)]).toEqual([dir, []]);
  const read = (dir: string) => validateManifest(JSON.parse(readFileSync(join(dir, "moss.json"), "utf8")));
  expect(describeOk(read(sound))).toContain("It keeps a part running in the background while MOSS is open.");
  expect(read(sound).capabilities).toEqual(["audio"]);
  expect(read(quiet).capabilities).toEqual([]);
});

test("the microphone fixtures validate; only the holder holds `microphone`, and its OK says it hears the microphone", async () => {
  const holder = writeMicrophone(root, MIC_IDS.holder, { mic: true });
  const other = writeMicrophone(root, MIC_IDS.other, { mic: false });
  for (const dir of [holder, other]) expect([dir, await errors(dir)]).toEqual([dir, []]);
  const read = (dir: string) => validateManifest(JSON.parse(readFileSync(join(dir, "moss.json"), "utf8")));
  expect(read(holder).capabilities).toEqual(["microphone"]);
  expect(describeOk(read(holder))).toContain("It hears your microphone, also while no window of it shows.");
  expect(read(other).capabilities).toEqual([]);
});

test("R1: the plugin that asks for the six that were MOSS's own validates, its OK lines are the catalog's warnings, and the verdict names each miss", async () => {
  const dir = writeAsksAll(root);
  expect(await errors(dir)).toEqual([]);
  const v = await validatePluginFolder(dir, { os: "macos" });
  const card = JSON.stringify(v.okText ?? []);
  const okLines = Object.fromEntries(ONCE_MOSS_OWN.map((cap) => [cap, CAPABILITIES.find((x) => x.name === cap)!.ok]));
  for (const cap of ONCE_MOSS_OWN) expect(CAPABILITIES.find((x) => x.name === cap)?.warns).toBe(true);
  const all = { card, granted: [...ONCE_MOSS_OWN], okLines, terminal: "opened t1", avatar: "answered", install: "found acc-asked-npm", fetched: "{\"text\":\"ACCEPTANCE-ARTICLE-TEXT\"}" };
  expect(asksAllWrong(all)).toEqual([]);
  expect(asksAllWrong({ card, granted: [...ONCE_MOSS_OWN], okLines })).toEqual([]);
  expect(asksAllWrong({ ...all, granted: ["browser"], terminal: "refused: terminal isn't granted" })).toHaveLength(6);
});

test("the plugin with a bot validates and its OK lines are the ones the row looks for; a bot's entry on the sidebar is refused with its words", async () => {
  const dir = writeBotParts(root, "anthropic/claude-test");
  expect(await errors(dir)).toEqual([]);
  const r = validateManifest(JSON.parse(readFileSync(join(dir, "moss.json"), "utf8")));
  expect(botPartLines(r.manifest)).toEqual([...BOT_PARTS_LINES]);
  expect(describeOk(r)).toEqual(expect.arrayContaining([...BOT_PARTS_LINES]));
  const side = await errors(writeBotOnSidebar(root));
  expect(side.length).toBe(1);
  expect(side[0]).toContain(BOT_SIDEBAR_REFUSAL);
});

test("Bots' offer list: each refusal fixture fails validation with its own code and the words the row reads, and nothing else", async () => {
  const refusals = writeRefusals(root);
  expect(refusals.map((r) => r.code)).toEqual(["bot_panel_not_offered", "bot_when_other_bot", "bot_spot_not_offered", ...Array(5).fill("bot_tied_not_offered")]);
  for (const r of refusals) {
    const issues = (await validatePluginFolder(r.folder, { os: "macos" })).issues.filter((i) => i.severity === "error");
    expect([r.what, issues.map((i) => i.code)]).toEqual([r.what, [r.code]]);
    expect(issues[0]!.message).toContain(r.words);
  }
});

test("a theme with the sidebar's old shell names loads with a shell_not_offered warning for each, and the window takes none of them", async () => {
  const v = await validatePluginFolder(writeOldSidebarTheme(root), { os: "macos" });
  expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(v.issues.filter((i) => i.code === "shell_not_offered").map((i) => i.path).sort()).toEqual(["/shell/sidebar", "/shell/sidebar.mode"]);
  expect(oldSidebarTaken()).toEqual([]);
});

test("the per-entry own-bot verdict names each read that went wrong", () => {
  const all = `${OWN_BOT_ITEMS.skill} ${OWN_BOT_ITEMS.agent} ${OWN_BOT_ITEMS.shared}`;
  const ok = { juniperGlossary: all, alphaGlossary: OWN_BOT_ITEMS.shared, juniperRun: "{\"text\":\"scene-ran\"}", alphaRun: `refused: ${BOT_COMMAND_REFUSAL}` };
  expect(ownBotWrong(ok)).toEqual([]);
  expect(ownBotWrong({ ...ok, alphaGlossary: all, alphaRun: "{\"text\":\"scene-ran\"}" })).toEqual([
    "Alpha's Glossary lists Juniper's own-bot skill acc-juniper:mine",
    "Alpha's Glossary lists Juniper's own-bot agent definition acc-juniper:helper",
    "Alpha's session running acc-juniper.scene wasn't refused as hers: {\"text\":\"scene-ran\"}",
  ]);
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
  const coding = [`mcp__moss_0123456789abcdef__${AGENTS_ONLY_SHORT}`];
  expect(AGENTS_ONLY_SHORT).toMatch(/^acceptance-agen__AgentsOnly_[0-9a-f]{6}$/);
  expect(offerWrong({ bot, coding })).toEqual([]);
  expect(offerWrong({ bot: [...bot, "mcp__acc-fields-win__FieldsWin"], coding: [...coding, "mcp__x__CcOnly"] })).toEqual([
    "Alpha was offered FieldsWin (when.os windows)",
    "the coding session on MOSS's own agent was offered CcOnly (onlyBackends: claude-code)",
  ]);
});
