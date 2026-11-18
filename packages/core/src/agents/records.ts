// The daemon's own record of each agent session (review 1): what a reattach after a restart trusts. It lives in
// `<home>/run/agents/<session>.json`, inside the daemon's run folder, which the fence denies to every bot and agent
// for reading and writing (`run-folder`). The `agent.json` in the transcript folder is the bot's copy to read, and
// nothing reads it back.
//
// A reattach takes who the session is (kind, bot, parent, backend, root, computer) from the session host's own view,
// and checks this record against it; the record adds only what the host doesn't keep: the agent's own session id and
// a routine's raised level. The root is resolved and checked again (`checkAgentRoot`) as if the agent were new.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEVELS, type Level } from "@waifucave/moss-protocol";

export interface DaemonAgentRecord {
  v: 1;
  sessionId: string;
  backend: string;
  /** The plugin whose entry the backend was (`moss/agent-cursor`, or `moss` for the core's own): a reattach goes on
   *  only with the same plugin's backend, never another plugin's that took the id since (#233's review). */
  pluginId?: string;
  bot?: string;
  parent?: string;
  computer: string;
  /** The root's tree path. */
  root: string;
  /** A routine's raised level the delegation runs at (§7). */
  level?: Level;
  /** The agent's own session id, for `session/load` or `session/resume`. */
  agentSessionId?: string;
  /** The plugin agent definition it started from, `<plugin>:<id>`. */
  definition?: string;
  /** The name of the session's bridge server (`moss_` and 16 hex digits). It is the session's for good: the agent's own
   *  history holds the tools it was offered under that name (`mcp__<server>__<tool>`, its frozen tool list and the tools it
   *  loaded), so a reattach after a restart goes on under the same name, never a new one that leaves that history naming a
   *  server the agent no longer has. */
  bridge?: string;
  startedAt: number;
}

/** A bridge server name as the manager mints it: `moss_` and 16 hex digits. */
export const BRIDGE_NAME_RE = /^moss_[0-9a-f]{16}$/;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function agentRecordPath(home: string, sessionId: string): string {
  if (!ID_RE.test(sessionId)) throw new Error("not an agent session id");
  return join(home, "run", "agents", `${sessionId}.json`);
}

export function writeAgentRecord(home: string, rec: DaemonAgentRecord): void {
  const path = agentRecordPath(home, rec.sessionId);
  mkdirSync(join(home, "run", "agents"), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, path);
}

export function readAgentRecord(home: string, sessionId: string): DaemonAgentRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(agentRecordPath(home, sessionId), "utf8")) as Partial<DaemonAgentRecord>;
    if (r.v !== 1 || r.sessionId !== sessionId || typeof r.backend !== "string" || typeof r.root !== "string" || typeof r.computer !== "string") return undefined;
    if (r.level !== undefined && !(LEVELS as readonly string[]).includes(r.level)) return undefined;
    // A name of any other shape is dropped, not trusted: the session then gets a new one.
    if (r.bridge !== undefined && !(typeof r.bridge === "string" && BRIDGE_NAME_RE.test(r.bridge))) delete r.bridge;
    return r as DaemonAgentRecord;
  } catch {
    return undefined;
  }
}

export function removeAgentRecord(home: string, sessionId: string): void {
  try {
    rmSync(agentRecordPath(home, sessionId), { force: true });
  } catch {
    // Already gone.
  }
}
