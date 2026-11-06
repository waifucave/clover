// The user's OK for an agent with no sandbox Clover counts as holding the fence (spec §9.3: it "starts only after the
// user's OK, which says it could read Clover's logins and approve its own cards; like Devin, Clover never quietly
// runs one unsandboxed").
//
// The OK is asked once per backend, version and computer, as a change card (`agent-unsandboxed`, which the broker
// always shows and never offers "always" for), and kept here; a new version of the agent asks again. The record is
// Clover's own, in `<home>/trust/agent-oks.json`, inside the fenced set's `trust` folder, so no bot or agent can
// write itself an OK (lane C confirms the path in its fenced set).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AgentOkKey {
  backend: string;
  version: string;
  computer: string;
}

export interface AgentOks {
  has(key: AgentOkKey): boolean;
  grant(key: AgentOkKey, by: { cardId?: string; at: number }): void;
}

const keyOf = (k: AgentOkKey) => `${k.computer}\u0000${k.backend}\u0000${k.version}`;

export class MemoryAgentOks implements AgentOks {
  readonly #set = new Set<string>();
  has(key: AgentOkKey): boolean {
    return this.#set.has(keyOf(key));
  }
  grant(key: AgentOkKey): void {
    this.#set.add(keyOf(key));
  }
}

interface OkFile {
  v: 1;
  oks: (AgentOkKey & { cardId?: string; at: number })[];
}

export function agentOksPath(home: string): string {
  return join(home, "trust", "agent-oks.json");
}

export class FileAgentOks implements AgentOks {
  readonly #path: string;

  constructor(home: string) {
    this.#path = agentOksPath(home);
  }

  #read(): OkFile {
    try {
      const f = JSON.parse(readFileSync(this.#path, "utf8")) as OkFile;
      return f.v === 1 && Array.isArray(f.oks) ? f : { v: 1, oks: [] };
    } catch {
      return { v: 1, oks: [] };
    }
  }

  has(key: AgentOkKey): boolean {
    return this.#read().oks.some((o) => keyOf(o) === keyOf(key));
  }

  grant(key: AgentOkKey, by: { cardId?: string; at: number }): void {
    const f = this.#read();
    if (f.oks.some((o) => keyOf(o) === keyOf(key))) return;
    f.oks.push({ ...key, ...(by.cardId === undefined ? {} : { cardId: by.cardId }), at: by.at });
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}
