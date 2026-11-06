// The memory block of a bot's system prompt (spec §6.1 "The harness owns the system prompt", §6.5 "Where it lives").
// Owner: lane D; lane A's runtime puts it in the prompt, with the other harness blocks, when it (re)builds the prompt.
//
// It names the bot's three folders and gives its memory index. Until C5 there is no folder tree, so it names real
// local paths (`<home>/bots/<bot>/memory/` and so on); C5 changes this block, not the files. There is no memory tool:
// the bot reads and writes its memory with Bash and the file tools (§6.5).
//
// `MEMORY.md` is the bot's own file, read by the core, which runs outside the fence: it is read only as a regular
// file of its own (no link, one name), inside folders that are real folders, and capped, so a bot can't have the core
// read something else into its prompt.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_INDEX } from "./memory";
import type { BotPaths } from "./paths";

/** How much of `MEMORY.md` the prompt holds, as Claude Code's memory does: the first 200 lines, at most 25 KB. */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25_000;

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** The first `MEMORY_INDEX_MAX_BYTES` of the bot's memory index, or undefined when there is none or it can't be read
 *  safely (a link, a folder swapped for a link, a file with a second name). */
export function readMemoryIndex(paths: BotPaths): { text: string; cut: boolean } | undefined {
  for (const dir of [paths.root, paths.memory]) {
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
  }
  const file = join(paths.memory, MEMORY_INDEX);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) return undefined;
    const buf = Buffer.alloc(Math.min(st.size, MEMORY_INDEX_MAX_BYTES + 4));
    const n = readSync(fd, buf, 0, buf.length, 0);
    let text = buf.subarray(0, Math.min(n, MEMORY_INDEX_MAX_BYTES)).toString("utf8");
    let cut = st.size > MEMORY_INDEX_MAX_BYTES;
    // A cut through a character leaves a replacement mark at the end; it goes.
    if (cut) text = text.replace(/�+$/, "");
    const lines = text.split("\n");
    if (lines.length > MEMORY_INDEX_MAX_LINES) {
      text = lines.slice(0, MEMORY_INDEX_MAX_LINES).join("\n");
      cut = true;
    }
    return { text, cut };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The block's own tags written in the bot's file can't close it early: their `<` becomes `‹`. */
function escapeTags(text: string): string {
  return text.replace(/<(\/?)(memory-index|memory)\b/gi, "‹$1$2");
}

/** The block itself. `computer` is the one whose scratch folder it names (the session's own computer). */
export function memoryBlock(o: { paths: BotPaths; computer: string }): string {
  const { paths } = o;
  const index = readMemoryIndex(paths);
  const lines = [
    "<memory>",
    "You keep a persistent memory of your own, across every conversation and restart: Markdown files in one folder, which you read and write with Bash and your file tools. There is no memory tool.",
    `- Your memory folder: ${paths.memory}/`,
    `  ${MEMORY_INDEX} there is its index: one line for each memory file, with a link to it. Read the files it links to when they bear on what you are doing. When you learn something worth keeping (about the user, what they want, how they work, what you agreed), write it to a memory file and link it from ${MEMORY_INDEX}; when a memory turns out wrong, fix or remove it. Keep ${MEMORY_INDEX} short: only its first ${MEMORY_INDEX_MAX_LINES} lines are shown to you here.`,
    `- Your background agents' transcripts: ${paths.agents}/ (each task notification names its file).`,
    `- Scratch, for working files: ${paths.scratch}/ on ${o.computer}. It is never synced and isn't memory.`,
  ];
  if (index === undefined || index.text.trim() === "") lines.push(`${MEMORY_INDEX} is empty so far.`);
  else {
    lines.push(`${MEMORY_INDEX} now${index.cut ? " (cut here; read the file for the rest)" : ""}:`, "<memory-index>", escapeTags(index.text.trimEnd()), "</memory-index>");
  }
  lines.push("</memory>");
  return lines.join("\n");
}
