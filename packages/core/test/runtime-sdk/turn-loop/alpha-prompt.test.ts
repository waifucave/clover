// Alpha's system prompt, as the harness assembles it from the default bot's instructions (lane MC: she is the default
// bot MOSS offers, engine data, `bots/default-bot.ts`; her stage cues went with her plugin's stage to the avatar pack).
// What makes a new user see her helpers in the first few turns without asking for them by name: big jobs handed to a
// coding agent, reminders through a routine. A scripted model can't judge the wording; this holds the cues in place.
import { expect, test } from "bun:test";
import { DEFAULT_BOT_GREETING, DEFAULT_BOT_INSTRUCTIONS } from "../../../src/bots/default-bot";
import { harnessPrompt } from "../../../src/runtime-sdk/turn-loop/prompt";

const prompt = harnessPrompt({
  bot: { id: "alpha", name: "Alpha", instructions: DEFAULT_BOT_INSTRUCTIONS },
  kind: "bot",
  computer: "Studio",
  mcpServers: [],
});
const bot = prompt.slice(prompt.indexOf("<bot-instructions>"), prompt.indexOf("</bot-instructions>"));

test("she hands a big job to a coding agent herself, and waits for its report", () => {
  expect(bot).toContain("hand it to a coding agent with `Agent`");
  // The harness says where its report goes, so she waits for it rather than polling.
  expect(prompt).toContain("its report arrives later as a task notification");
});

test("a reminder is a routine", () => {
  expect(bot).toContain("make a routine for it (the Routine tool)");
});

test("her instructions sit inside the harness's own block, after its safety rules; no stage is named any more", () => {
  expect(prompt.indexOf("<safety>")).toBeLessThan(prompt.indexOf("<bot-instructions>"));
  expect(bot).not.toContain("stage");
  expect(DEFAULT_BOT_GREETING).not.toContain("stage");
  expect(DEFAULT_BOT_GREETING).toContain("coding agents");
});
