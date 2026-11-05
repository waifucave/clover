// How each agent is started. Every agent gets a minimal environment (none of the caller's
// keys), and a PATH whose first folder holds logging stand-ins for the commands that open
// windows, browsers or sounds, so nothing reaches the owner's screen.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AgentSpec {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  note: string;
}

const HERE = resolve(import.meta.dir);

export const AGENTS: Record<string, AgentSpec> = {
  cursor: {
    id: "cursor",
    command: "/opt/homebrew/bin/cursor-agent",
    args: ["acp"],
    env: { NO_OPEN_BROWSER: "1" },
    note: "Cursor CLI, hidden `acp` command",
  },
  agy: {
    id: "agy",
    command: "/opt/homebrew/bin/agy",
    args: ["acp", "--disable-telemetry"],
    env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
    note: "Antigravity CLI, `agy acp`",
  },
  fake: {
    id: "fake",
    command: process.execPath,
    args: [join(HERE, "fake-agent.ts")],
    note: "the probe's own fake ACP agent, for self-tests",
  },
};

const SHIMS = ["open", "xdg-open", "osascript", "afplay", "say", "terminal-notifier"];

/** Writes the stand-ins into `<runDir>/shims` and returns that folder. */
export function writeShims(runDir: string): string {
  const dir = join(runDir, "shims");
  mkdirSync(dir, { recursive: true });
  for (const name of SHIMS) {
    const file = join(dir, name);
    // Logs only that it ran and how many arguments it got: URLs can carry login codes.
    writeFileSync(file, `#!/bin/sh\necho "$(date +%s) ${name} argc=$#" >> "${join(runDir, "shims.log")}"\nexit 1\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

export function agentEnv(spec: AgentSpec, shimDir: string): Record<string, string> {
  const pass = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"];
  const env: Record<string, string> = {};
  for (const k of pass) if (process.env[k]) env[k] = process.env[k]!;
  env.PATH = [shimDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  return { ...env, ...(spec.env ?? {}) };
}
