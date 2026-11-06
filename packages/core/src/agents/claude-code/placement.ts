// What Clover places in Claude Code for one session (spec §9.3): the plugins' skills in its skills folder, their agent
// definitions in its agents folder, and their command hooks in its settings through Clover's shim (hook-shim.ts).
//
// None of it touches the user's own Claude Code setup (`~/.claude`, the project's `.claude/`): Clover writes one local
// Claude Code plugin per session into the session's setup folder, inside the fenced run folder, and hands it to the
// Claude adapter at `session/new` as `_meta.claudeCode.options.plugins` (the Claude Agent SDK's local plugins). Claude
// Code still loads what the user installed in it, as it would outside Clover (§9.3). That the adapter passes the
// option through, and Claude Code loads skills, agents and hooks from it, is a live gate (plan §10).
//
// Hook events map onto Claude Code's: `tool.before` → `PreToolUse`, `tool.after` → `PostToolUse`, `message.in` and
// `turn.start` → `UserPromptSubmit`, `turn.end` → `Stop`, `compact.before` → `PreCompact`, `compact.after` →
// `SessionStart` (matcher `compact`). `message.out` has no Claude Code event, so those hooks aren't placed.
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { HookEvent, PluginParts } from "../placement";
import { DEFAULT_HOOK_TIMEOUT_MS } from "./hook-shim";

export const CLAUDE_PLUGIN_FOLDER = "claude-plugin";

const EVENTS: Partial<Record<HookEvent, { event: string; matcher?: string }>> = {
  "tool.before": { event: "PreToolUse" },
  "tool.after": { event: "PostToolUse" },
  "message.in": { event: "UserPromptSubmit" },
  "turn.start": { event: "UserPromptSubmit" },
  "turn.end": { event: "Stop" },
  "compact.before": { event: "PreCompact" },
  "compact.after": { event: "SessionStart", matcher: "compact" },
};

/** A name safe as one folder or file name. */
function safeName(name: string): string {
  const n = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  return n || "unnamed";
}

/** POSIX shell quoting, for the hook commands Claude Code runs through a shell. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Clover tool patterns (`*` any run of characters) as one Claude Code matcher; undefined for every tool. */
export function matcherOf(tools: readonly string[] | undefined): string | undefined {
  if (!tools || tools.length === 0 || tools.includes("*")) return undefined;
  return tools.map((t) => `^${t.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).join("|");
}

export interface PlacementResult {
  /** `_meta` for `session/new`. */
  meta: Record<string, unknown>;
  placed: { skills: string[]; agents: string[]; hooks: string[]; skipped: { id: string; why: string }[] };
}

/** Writes the session's Claude Code plugin into `dir` and returns the `_meta` that hands it to the adapter. */
/** The longest a hook may run (§5.3's per-hook limits stop here). */
export const MAX_HOOK_TIMEOUT_MS = 60_000;

export function placeInClaudeCode(parts: PluginParts, ctx: { dir: string; shim: { command: string; args: readonly string[] } }): PlacementResult {
  const root = join(ctx.dir, CLAUDE_PLUGIN_FOLDER);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "clover", version: "0.0.0", description: "Skills, agents and hooks from Clover's plugins, for this session." }, null, 2)}\n`);
  const placed: PlacementResult["placed"] = { skills: [], agents: [], hooks: [], skipped: [] };

  for (const s of parts.skills) {
    if (!existsSync(join(s.dir, "SKILL.md"))) {
      placed.skipped.push({ id: s.name, why: "no SKILL.md" });
      continue;
    }
    const name = safeName(s.name || basename(s.dir));
    cpSync(s.dir, join(root, "skills", name), { recursive: true, dereference: false });
    placed.skills.push(name);
  }

  if (parts.agents.length > 0) mkdirSync(join(root, "agents"), { recursive: true });
  for (const a of parts.agents) {
    const name = safeName(a.name);
    writeFileSync(join(root, "agents", `${name}.md`), a.markdown);
    placed.agents.push(name);
  }

  const hooks: Record<string, { matcher?: string; hooks: { type: "command"; command: string; timeout: number }[] }[]> = {};
  for (const h of parts.hooks) {
    // A hook runs as an absolute path, never a name a PATH could swap (K-M2 review 9).
    if (!isAbsolute(h.command)) {
      placed.skipped.push({ id: h.id, why: "its command isn't an absolute path" });
      continue;
    }
    const timeoutMs = Math.min(Math.max(1, Math.floor(h.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)), MAX_HOOK_TIMEOUT_MS);
    const command = [ctx.shim.command, ...ctx.shim.args, "--timeout", String(timeoutMs), "--", h.command, ...(h.args ?? [])].map(shellQuote).join(" ");
    let any = false;
    for (const on of h.on) {
      const ev = EVENTS[on];
      if (!ev) continue;
      const matcher = ev.matcher ?? (on === "tool.before" || on === "tool.after" ? matcherOf(h.tools) : undefined);
      // Claude Code's own limit sits above the shim's, so the shim's skip wins.
      (hooks[ev.event] ??= []).push({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command, timeout: Math.ceil(timeoutMs / 1000) + 5 }] });
      any = true;
    }
    if (any) placed.hooks.push(h.id);
    else placed.skipped.push({ id: h.id, why: "none of its events has a Claude Code hook" });
  }
  if (Object.keys(hooks).length > 0) {
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);
  }
  return { meta: { claudeCode: { options: { plugins: [{ type: "local", path: root }] } } }, placed };
}
