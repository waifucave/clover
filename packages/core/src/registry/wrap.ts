// `plugin.install { from: "wrap" }` (spec §5.1 "wrapped automatically"): a bare item becomes a small plugin the core
// generates in the plugins folder, which from then on installs, syncs, gets its OK and is switched on like any plugin.
// The user can open and edit it.
//
// * Accepted as-is: an agent-skill folder (a `SKILL.md` at its top, its front matter's `name` and `description`), and a
//   Claude-style agent file (`agents/*.md`: front matter and instructions), each copied unchanged into the generated
//   plugin (`skills/<name>/`, `agents/<name>.md`), whose manifest lists it.
// * Ids: `skill-<name>` and `agent-<name>`, the name cleaned as a server's is (`wrapperId`), a number added on a clash.
// * Recorded: the manifest's `generated` (a hint, which the user may edit) and the core's own record, the install's
//   provenance (`wrapped`: what it was made from, and the parts left unused), which the OK shows.
// * The copy is an install's (`copyTreeInto`): regular files only, links that leave the item refused, capped; and what
//   is installed is the generated folder, validated as any install is (`installStaged`).
//
// MCP configs and addresses and Claude Code plugin folders are wrapped by the same door; they come next (the network
// grant of a wrapped `stdio` server is the owner's to rule).
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { MANIFEST_FILE, wrapperId, type WrapperKind } from "@waifucave/clover-plugin-sdk";
import type { WrapKind } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import { copyTreeInto, installStaged, newStage, readSourceFile, sourceFolder, type InstallTarget } from "./install-folder";

/** The longest skill or agent file read whole. */
export const WRAP_TEXT_MAX_BYTES = 1024 * 1024;
/** The longest description a wrapper's manifest keeps from the item. */
const DESCRIPTION_MAX = 1000;

/** A Markdown file's front matter (`---` lines at its top): its `key: value` lines, quotes taken off. Nested YAML and
 *  lists are left out; a file without front matter has none. */
export function frontMatter(md: string): Record<string, string> {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(md);
  if (m === null) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (kv === null) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== "" && !(kv[1]! in out)) out[kv[1]!] = v;
  }
  return out;
}

export interface WrapResult {
  id: string;
  folder: string;
  treeHash: string;
  /** The parts of the item Clover has no point for yet, which stay in the folder unused (the OK names them). */
  unused: string[];
}

/** Wraps a bare item into a plugin, installed into `pluginsDir`, validated, waiting for its OK. */
export async function installWrapped(o: InstallTarget & { kind: WrapKind; value: string; by: "user" | "bot"; now?: () => number }): Promise<WrapResult> {
  const at = new Date((o.now ?? Date.now)()).toISOString();
  // Wrapper ids are taken by an installed plugin, a bundled one or a folder already in the plugins folder.
  const taken = { has: (id: string) => o.taken(id) || existsDir(join(o.pluginsDir, id)) } as ReadonlySet<string>;
  switch (o.kind) {
    case "skill-folder":
      return wrapSkillFolder(o, taken, at);
    case "agent-file":
      return wrapAgentFile(o, taken, at);
    default:
      throw new ContractError("refused", `wrapping ${o.kind === "claude-plugin" ? "a Claude Code plugin folder" : o.kind === "mcp-url" ? "an MCP server's address" : "an MCP server's config"} isn't served yet; a skill folder and an agent file are`);
  }
}

const existsDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function manifestFor(o: { id: string; name: string; description?: string; generated: { from: WrapKind; by: "user" | "bot"; at: string }; contributes: Record<string, unknown> }): string {
  return `${JSON.stringify({
    manifest: 1,
    id: o.id,
    name: o.name,
    ...(o.description !== undefined ? { description: o.description.slice(0, DESCRIPTION_MAX) } : {}),
    contributes: o.contributes,
    generated: o.generated,
  }, null, 2)}\n`;
}

async function wrapSkillFolder(o: InstallTarget & { value: string; by: "user" | "bot" }, taken: ReadonlySet<string>, at: string): Promise<WrapResult> {
  const root = sourceFolder(o.value, o.pluginsDir);
  if (existsFile(join(root, MANIFEST_FILE))) throw new ContractError("invalid", `${root} holds a ${MANIFEST_FILE}: it's a plugin already, so install it as a folder`);
  if (!existsFile(join(root, "SKILL.md"))) throw new ContractError("invalid", `${root} has no SKILL.md at its top, so it isn't a skill folder`);
  const md = readSourceFile(realpathSync(join(root, "SKILL.md")), "SKILL.md", WRAP_TEXT_MAX_BYTES).toString("utf8");
  const fm = frontMatter(md);
  const name = fm.name ?? basename(root);
  const { id, namespace } = wrapperId("skill" satisfies WrapperKind, name, taken);
  const stage = newStage(o.stagingDir);
  try {
    const staged = join(stage.dir, id);
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    copyTreeInto(root, join(staged, "skills", namespace));
    writeFileSync(join(staged, MANIFEST_FILE), manifestFor({
      id, name, ...(fm.description !== undefined ? { description: fm.description } : {}),
      generated: { from: "skill-folder", by: o.by, at },
      contributes: { skills: [`skills/${namespace}`] },
    }));
    const done = await installStaged(staged, o);
    return { ...done, unused: [] };
  } finally {
    stage.done();
  }
}

async function wrapAgentFile(o: InstallTarget & { value: string; by: "user" | "bot" }, taken: ReadonlySet<string>, at: string): Promise<WrapResult> {
  let file: string;
  try {
    file = realpathSync(o.value);
  } catch {
    throw new ContractError("invalid", `${o.value} doesn't exist`);
  }
  if (extname(file).toLowerCase() !== ".md") throw new ContractError("invalid", `${file} isn't an agent file (a Markdown file, agents/<name>.md)`);
  const plugins = realpathSync(o.pluginsDir);
  if (file.startsWith(plugins + sep)) throw new ContractError("invalid", "an agent file is wrapped from outside the plugins folder");
  const bytes = readSourceFile(file, basename(file), WRAP_TEXT_MAX_BYTES);
  const fm = frontMatter(bytes.toString("utf8"));
  const name = fm.name ?? basename(file, extname(file));
  const { id, namespace } = wrapperId("agent" satisfies WrapperKind, name, taken);
  const stage = newStage(o.stagingDir);
  try {
    const staged = join(stage.dir, id);
    mkdirSync(join(staged, "agents"), { recursive: true, mode: 0o700 });
    writeFileSync(join(staged, "agents", `${namespace}.md`), bytes, { flag: "wx", mode: 0o644 });
    writeFileSync(join(staged, MANIFEST_FILE), manifestFor({
      id, name, ...(fm.description !== undefined ? { description: fm.description } : {}),
      generated: { from: "agent-file", by: o.by, at },
      contributes: { agents: [`agents/${namespace}.md`] },
    }));
    const done = await installStaged(staged, o);
    return { ...done, unused: [] };
  } finally {
    stage.done();
  }
}

const existsFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
