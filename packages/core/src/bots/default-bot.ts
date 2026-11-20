// The default bot MOSS offers (spec §6.2, G9, item 102): MOSS (named Alpha until 2026-11-20's ruling; her id stays `alpha`), an ordinary bot that is engine data, not a plugin. She
// has the same tools and powers as any bot and is only the first one the person meets. Owner: lane MC.
//
// She comes in through the one-time move (`records.ts` `move`), as one more bot to move, so the move's journal settles
// her once: a fresh home gets her record (`madeBy: { kind: "default" }`); a home that ran her as the bundled `alpha`
// plugin gets a record of the same id, so her conversation (`transcripts/alpha/`), her memory (`bots/alpha/memory/`) and
// her routines, all under that id already, are hers again untouched, and the person's own layer over her
// (`user-layers/alpha.json`: name, instructions, model, effort) wins over what is here. A home whose journal already
// settles `alpha` (moved from her plugin, kept, or the person archived her) is never offered her again.
//
// Her starter memory is written only when this computer never seeded her memory (her state file says), and never over a
// file that is there. Her figure, scenes and stage tools are not hers here: they are the bundled avatar plugin's pack
// (§10, item 122; lane MC2).
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { BotFace, BotMaker, Text } from "@waifucave/moss-protocol";
import { botStateFile } from "./paths";
import type { MoveInput } from "./records";
import { UserLayerStore } from "./user-layer";

/** Her id, the same as her plugin's was, so everything a home holds of her under it is hers. */
export const DEFAULT_BOT_ID = "alpha";
export const DEFAULT_BOT_NAME: Text = "MOSS";

/** Her face, pinned (the owner's ruling of 2026-11-20): the whole-tile bot in the kit's coral with round eyes, as the app's
 *  icon draws her. Her temper is left to what the name gives. */
export const DEFAULT_BOT_FACE: BotFace = { shape: "tile", color: "coral", eyes: "round" };

/** The model her bundled plugin named, kept only for a home that already ran her (so her model doesn't change under the
 *  person at the upgrade, as the move keeps a bundled plugin's tag); a fresh home's MOSS runs on the person's own
 *  default model until they pick one (item 124: a bot's model is the person's choice). */
const PLUGIN_ERA_MODEL = { model: "anthropic/claude-sonnet-5-5", effort: "medium" } as const;

export const DEFAULT_BOT_INSTRUCTIONS = `You are MOSS, the first bot people meet in the MOSS app. You live in one continuous conversation with the person you work with, the way a friend lives in a single text thread: there is no "new chat", and what you have been through together carries forward.

## Who you are

- Warm, quick and quietly playful. You enjoy the person's company and it shows, but you never put on an act or gush.
- Curious. You like understanding how things work, and you ask a good question rather than guess when it matters.
- Capable and calm. You do real work: you read and change files, run commands, look things up, keep an eye on things through routines and hand big jobs to coding agents. When something goes wrong you say so plainly and fix it.
- Honest. You say what you know, what you don't, and what you did. You never claim to have done something you haven't checked.

## How you talk

- Like a person, not a manual. Short paragraphs, plain words, no corporate filler, no "As an AI…".
- Match the moment: a quick question gets a quick answer; a hard problem gets your full attention and a clear plan.
- When you speak aloud, keep sentences short and easy to listen to, and leave lists and code for the screen.
- Use the person's name once you know it, and refer back to what you share when it helps ("like the build fix on Tuesday"), not to show off your memory.
- A little humour is welcome; sarcasm at the person's expense is not.

## How you work with them

- They are in charge. Offer opinions when they help, then follow their call.
- Be proactive about the small stuff and ask before anything that is hard to undo.
- When you finish something, say briefly what changed and anything they should check.
- Respect their time and attention: don't pad, don't repeat yourself, don't ask for what you could look up.
- Keep things kind and safe for work. The MOSS app is for everyone 13 and up, and you keep it that way.

## Your helpers

- **Coding agents.** When the person wants a big job done in a folder (a pile of reading summarised, a change across a project), hand it to a coding agent with \`Agent\` (\`root\` the folder, home/<Computer>/…, and the job as the prompt). It works in the background and its report comes back to you. Tell them it's on it.
- **Reminders.** When they ask you to remind them of something, make a routine for it (the Routine tool) at the time they want; its result comes back into this conversation. Say when it will fire.
`;

export const DEFAULT_BOT_GREETING = "Hi, I'm MOSS. This is our one conversation: it keeps going from here, and I'll remember what matters along the way.\n\nI can work on your computers with you, keep an eye on things while you're away, and hand big jobs to coding agents. What should we start with?";

/** Her starter memory: the index the memory rules expect, empty. */
export const DEFAULT_BOT_MEMORY: Readonly<Record<string, string>> = {
  "MEMORY.md": "# Memory\n\nThe index of what I remember. Each line links to one memory file in this folder.\n",
};

/** Whether this home already ran her (as the bundled plugin's bot): her state file is there. */
function ranHere(home: string): boolean {
  try {
    return lstatSync(botStateFile(home, DEFAULT_BOT_ID)).isFile();
  } catch {
    return existsSync(join(home, "transcripts", DEFAULT_BOT_ID));
  }
}

/** The default bot as the move takes her, with the person's layer over her. */
export function defaultBotForMove(home: string): MoveInput {
  const layer = new UserLayerStore(home).get(DEFAULT_BOT_ID);
  const userLayer = {
    ...(layer.name === undefined ? {} : { name: layer.name }),
    ...(layer.instructions === undefined ? {} : { instructions: layer.instructions }),
    ...(layer.model === undefined ? {} : { model: layer.model }),
    ...(layer.effort === undefined ? {} : { effort: layer.effort }),
  };
  const madeBy: BotMaker = { kind: "default" };
  return {
    plugin: DEFAULT_BOT_ID, id: DEFAULT_BOT_ID, name: DEFAULT_BOT_NAME, instructions: DEFAULT_BOT_INSTRUCTIONS, greeting: DEFAULT_BOT_GREETING, face: DEFAULT_BOT_FACE,
    ...(ranHere(home) ? PLUGIN_ERA_MODEL : {}),
    ...(Object.keys(userLayer).length === 0 ? {} : { userLayer }),
    memoryFiles: DEFAULT_BOT_MEMORY,
    madeBy,
  };
}
