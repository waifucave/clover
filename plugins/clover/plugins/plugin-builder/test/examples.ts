// The examples in skills/plugin-examples/SKILL.md, read the way a bot reads them: each `### Example: … (\`<folder>\`)`
// section, its files as "File `<path>`:" followed by a fenced block. A `From the template` line names the PluginNew
// template whose files the example must equal.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Example { title: string; folder: string; template?: string; files: Record<string, string> }

export const EXAMPLES_SKILL = join(import.meta.dir, "..", "skills", "plugin-examples", "SKILL.md");

export function readExamples(text = readFileSync(EXAMPLES_SKILL, "utf8")): Example[] {
  const out: Example[] = [];
  const sections = text.split(/^### Example: /m).slice(1);
  for (const s of sections) {
    const head = /^(.*?)\(`([a-z][a-z0-9-]*)`\)\s*$/m.exec(s.split("\n")[0]!);
    if (!head) throw new Error(`an example heading names no folder: ${s.split("\n")[0]}`);
    const template = /^From the template `([a-z]+)`/m.exec(s)?.[1];
    const files: Record<string, string> = {};
    const re = /^File `([^`]+)`:\n```[a-z]*\n([\s\S]*?)^```$/gm;
    for (let m = re.exec(s); m !== null; m = re.exec(s)) files[m[1]!] = m[2]!;
    out.push({ title: head[1]!.trim(), folder: head[2]!, ...(template === undefined ? {} : { template }), files });
  }
  return out;
}
