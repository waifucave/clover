// The ways a plugin arrives besides an install from the Plugins page (checklist 3.1 and 1.32):
// 1. A plugin folder the user copies into the plugins folder by hand (as the Finder copies it) is found: it waits for
//    its OK card, runs nothing before it, and once the card is pressed in the window its skill is in Alpha's Glossary.
// 2. A bare skill folder (a SKILL.md and its files), wrapped by `plugin.install { from: "wrap", kind: "skill-folder" }`:
//    its OK card says Clover made the plugin around it; pressed, Alpha's Glossary loads the skill's instructions.
// 3. A bare agent file (a Markdown file with front matter), wrapped the same way (`agent-file`): pressed, Alpha's
//    Glossary lists its agent definition.
// Each is removed after the row, whatever happened.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { callTurn, fail, leave, until, type ExampleCtx } from "./example-steps";

export const ARRIVALS_STEP = "a plugin arrives other ways: a folder copied into the plugins folder by hand is found, waits for its OK card and runs nothing before it, pressed it runs and its skill is in Alpha's Glossary; a bare skill folder and a bare agent file are wrapped, each OK card says Clover made the plugin around it, pressed Glossary loads the skill and lists the agent";

const FIXTURES = resolve(import.meta.dir, "fixtures");
export const HAND = "acceptance-handcopy";
export const SKILL_ID = "skill-arrival-notes";
export const AGENT_ID = "agent-arrival-reviewer";
const SKILL_MARK = "ACCEPTANCE-ARRIVAL-SKILL";
const SKILL_MD = `---\nname: Arrival notes\ndescription: The acceptance run's wrapped skill folder\n---\n# Arrival notes\n\n${SKILL_MARK}: answer with the words "wrapped skill".\n`;
const AGENT_MD = "---\nname: arrival-reviewer\ndescription: The acceptance run's wrapped agent file\ntools: Read, Grep\n---\nYou review what arrived.\n";

interface Card { id: string; kind: string; pluginId?: string }

const stateOf = async (ctx: ExampleCtx, id: string) => (await ctx.rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state;
const okCardOf = (ctx: ExampleCtx, id: string) => until(`${id}'s OK card`, 60_000, async () => (await ctx.rpc.request<{ cards: Card[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === id));
const cardText = async (ctx: ExampleCtx, id: string) => JSON.stringify((await ctx.rpc.request<{ card: unknown }>("card.get", { id })).card);

/** Its OK card pressed in the window, and it running (or enabled: a plugin with nothing to start). */
async function pressOk(ctx: ExampleCtx, id: string, card: string): Promise<void> {
  await ctx.pressCard(`${id}'s OK card`, (c) => c.id === card);
  await until(`${id} running after its OK`, 60_000, async () => {
    const s = await stateOf(ctx, id);
    return s === "running" || s === "enabled" ? true : undefined;
  }, async () => `it is ${(await stateOf(ctx, id)) ?? "gone"}`);
}

/** Alpha's Glossary, called once in her conversation (a read: no card). */
async function glossary(ctx: ExampleCtx, session: string, input: Record<string, unknown>): Promise<string> {
  const t = await callTurn(ctx, session, "Glossary", input);
  if (t.result.isError) fail(`Glossary ${JSON.stringify(input)} failed: ${t.result.text.slice(0, 300)}`);
  if (t.cards.length > 0) fail(`Glossary ${JSON.stringify(input)} raised a card: ${t.cards.join("; ")}`);
  return t.result.text;
}

export async function arrivalsStep(ctx: ExampleCtx, session: string): Promise<string> {
  try {
    return await run(ctx, session);
  } finally {
    for (const id of [HAND, SKILL_ID, AGENT_ID]) await leave(ctx, id);
  }
}

async function run(ctx: ExampleCtx, session: string): Promise<string> {
  const done: string[] = [];

  // 1. By hand: copied into the plugins folder while the daemon runs.
  cpSync(join(FIXTURES, HAND), join(ctx.home, "plugins", HAND), { recursive: true });
  const hand = await okCardOf(ctx, HAND);
  const before = await stateOf(ctx, HAND);
  if (before !== "found") fail(`copied in by hand, ${HAND} is ${before ?? "not listed"} before its OK, not found`);
  const handText = await cardText(ctx, hand.id);
  if (!handText.includes("Acceptance hand copy")) fail(`${HAND}'s OK card doesn't name it: ${handText.slice(0, 300)}`);
  await pressOk(ctx, HAND, hand.id);
  const found = await glossary(ctx, session, { query: "hand-note" });
  if (!found.includes(`${HAND}:hand-note`)) fail(`after its OK, Alpha's Glossary search for its skill answered "${found.slice(0, 300)}"`);
  done.push(`1 copied in by hand: found, its OK card (naming it) pressed, running; Glossary lists ${HAND}:hand-note`);

  // 2. A bare skill folder, wrapped.
  const skillDir = join(ctx.userHome, "Downloads", "arrival-notes");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), SKILL_MD);
  writeFileSync(join(skillDir, "scripts", "note.sh"), "#!/bin/sh\necho note\n", { mode: 0o755 });
  const skill = await ctx.rpc.request<{ id: string; state?: string; card?: string }>("plugin.install", { source: { from: "wrap", kind: "skill-folder", value: skillDir } }, 60_000);
  if (skill.id !== SKILL_ID) fail(`the skill folder was wrapped as ${skill.id}, not ${SKILL_ID}`);
  const skillCard = skill.card !== undefined ? { id: skill.card } : await okCardOf(ctx, SKILL_ID);
  const skillText = await cardText(ctx, skillCard.id);
  if (!skillText.includes("Clover made this plugin around a skill folder (SKILL.md)")) fail(`${SKILL_ID}'s OK card doesn't say Clover made it around a skill folder: ${skillText.slice(0, 400)}`);
  if ((await stateOf(ctx, SKILL_ID)) !== "found") fail(`${SKILL_ID} is ${await stateOf(ctx, SKILL_ID)} before its OK, not found`);
  await pressOk(ctx, SKILL_ID, skillCard.id);
  const loaded = await glossary(ctx, session, { load: `${SKILL_ID}:Arrival notes` });
  if (!loaded.includes(SKILL_MARK)) fail(`Alpha's Glossary load of ${SKILL_ID}:Arrival notes answered "${loaded.slice(0, 300)}"`);
  done.push(`2 skill folder wrapped as ${SKILL_ID}: its OK card says Clover made it around a SKILL.md, pressed; Glossary loads its instructions`);

  // 3. A bare agent file, wrapped.
  const agentFile = join(ctx.userHome, "Downloads", "arrival-reviewer.md");
  writeFileSync(agentFile, AGENT_MD);
  const agent = await ctx.rpc.request<{ id: string; card?: string }>("plugin.install", { source: { from: "wrap", kind: "agent-file", value: agentFile } }, 60_000);
  if (agent.id !== AGENT_ID) fail(`the agent file was wrapped as ${agent.id}, not ${AGENT_ID}`);
  const agentCard = agent.card !== undefined ? { id: agent.card } : await okCardOf(ctx, AGENT_ID);
  const agentText = await cardText(ctx, agentCard.id);
  if (!/Clover made this plugin around an? agent/i.test(agentText)) fail(`${AGENT_ID}'s OK card doesn't say Clover made it around an agent file: ${agentText.slice(0, 400)}`);
  await pressOk(ctx, AGENT_ID, agentCard.id);
  const listed = await glossary(ctx, session, { query: "arrival-reviewer" });
  if (!listed.includes(`${AGENT_ID}:arrival-reviewer`)) fail(`Alpha's Glossary search for the agent answered "${listed.slice(0, 300)}"`);
  done.push(`3 agent file wrapped as ${AGENT_ID}: its OK card says Clover made it around the agent file, pressed; Glossary lists ${AGENT_ID}:arrival-reviewer`);

  return done.join("; ");
}
