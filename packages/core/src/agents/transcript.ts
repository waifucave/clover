// An agent's transcript (spec §9.3 "The transcript", §6.5; spike S5 edit 8): `bots/<bot>/agents/<session>/` in the
// tree, which is `<home>/bots/<bot>/agents/<session>/` on the computer running the bot (lane D's bots/paths.ts), so the
// path in a task notification opens with the bot's own file tools.
//
// | File               | What                                                                      |
// | :----------------- | :------------------------------------------------------------------------ |
// | `acp.ndjson`       | the raw ACP wire, both ways, minus replays: `{ ts, dir, msg }` per line   |
// | `calls.ndjson`     | Clover's own record: each permission answer and each call Clover closed   |
// | `agent.json`       | who the agent is: backend, the agent's own session id, root, model       |
// | `agent.stderr.log` | the agent's stderr                                                        |
//
// The bridge's token is the one secret handed to an agent (S5 edit 4); it appears in `session/new`'s server entry,
// and this writer replaces it wherever it occurs before a line reaches the disk. A session with no bot (a coding
// session the user started) keeps its transcript under `<home>/agents/<session>/`.
//
// `agent.json` is the bot's copy to read; nothing reads it back. A reattach trusts only the daemon's own record in
// the fenced run folder (records.ts), since this folder is the bot's own (review 1).
//
// Each file has a size cap (`TRANSCRIPT_CAPS`, review 12): past it, one line says so and the file takes no more, so
// a runaway agent can't fill the disk. The session's own log still has the agent's events.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAnyPluginId, pluginIdToSegment } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { JsonRpcMessage } from "./acp/jsonrpc";

/** A bot's id as one path segment: `/` written `--` (`pack--luna`, spec §5.1), as lane D's paths write it. Anything
 *  that isn't a plugin id is refused, so no id can climb out of `bots/`. */
export function botSegment(botId: string): string {
  if (!isAnyPluginId(botId)) throw new ContractError("invalid", `"${botId.slice(0, 80)}" isn't a bot's id`);
  return pluginIdToSegment(botId);
}

/** A session id as a folder name: never `.`, `..` or anything with a separator. */
function sessionSegment(id: string): string {
  if (!/^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new ContractError("invalid", `"${id.slice(0, 80)}" isn't a session id`);
  return id;
}

/** The transcript folder's real path and its tree path. */
export function transcriptPaths(home: string, sessionId: string, bot?: string): { dir: string; treeDir: string } {
  sessionSegment(sessionId);
  if (bot === undefined) return { dir: join(home, "agents", sessionId), treeDir: `agents/${sessionId}` };
  const seg = botSegment(bot);
  return { dir: join(home, "bots", seg, "agents", sessionId), treeDir: `bots/${seg}/agents/${sessionId}` };
}

export const REDACTED_TOKEN = "<bridge-token>";

/** Each file's cap in bytes. */
export const TRANSCRIPT_CAPS: Readonly<Record<string, number>> = {
  "acp.ndjson": 256 * 1024 * 1024,
  "calls.ndjson": 16 * 1024 * 1024,
  "agent.stderr.log": 8 * 1024 * 1024,
};

/** Every string in a value with each secret replaced, keys too; the value itself is left as it was. */
export function redactDeep<T>(value: T, secrets: Iterable<string>): T {
  const list = [...secrets].filter((x) => x.length >= 8);
  if (list.length === 0) return value;
  const text = (t: string) => {
    for (const x of list) if (t.includes(x)) t = t.split(x).join(REDACTED_TOKEN);
    return t;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return text(v);
    if (v === null || typeof v !== "object" || depth > 64) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[text(k)] = walk(x, depth + 1);
    return out;
  };
  return walk(value, 0) as T;
}

/** What `agent.json` says, for the bot to read (S5 §8). */
export interface AgentRecordFile {
  v: 1;
  sessionId: string;
  backend: string;
  /** The agent's own session id, for `session/load` or `session/resume`. */
  agentSessionId?: string;
  bot?: string;
  parent?: string;
  computer: string;
  /** The root's tree path. */
  root: string;
  model?: string;
  effort?: string;
  startedAt: number;
}

export class AgentTranscript {
  readonly dir: string;
  readonly treeDir: string;
  readonly #secrets = new Set<string>();
  readonly #written = new Map<string, number>();
  readonly #full = new Set<string>();
  #broken = false;
  #stderrTail = "";

  readonly #caps: Readonly<Record<string, number>>;

  /** `caps`: each file's cap in bytes, `TRANSCRIPT_CAPS` by default. */
  constructor(home: string, sessionId: string, bot?: string, caps: Readonly<Record<string, number>> = TRANSCRIPT_CAPS) {
    this.#caps = caps;
    const p = transcriptPaths(home, sessionId, bot);
    this.dir = p.dir;
    this.treeDir = p.treeDir;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  get wirePath(): string {
    return join(this.dir, "acp.ndjson");
  }

  get stderrPath(): string {
    return join(this.dir, "agent.stderr.log");
  }

  /** The tree path a task notification gives (`bots/<bot>/agents/<session>/acp.ndjson`). */
  get treeWirePath(): string {
    return `${this.treeDir}/acp.ndjson`;
  }

  /** A value never written: the bridge's token (a new one on each reattach). */
  redact(secret: string): void {
    if (secret.length >= 8) this.#secrets.add(secret);
  }

  /** A value with every secret replaced, for what leaves the transcript's own files (the session's log, cards). */
  redacted<T>(value: T): T {
    return redactDeep(value, this.#secrets);
  }

  /** The wire tap: replays are dropped (S5 edit 8). */
  wire(dir: "in" | "out", msg: JsonRpcMessage, replay: boolean, ts: number): void {
    if (replay) return;
    this.#append("acp.ndjson", { ts, dir, msg });
  }

  /** The agent's stderr, a line at a time so a token split across chunks is still caught. */
  stderr(chunk: Uint8Array): void {
    const text = this.#stderrTail + new TextDecoder().decode(chunk);
    const cut = text.lastIndexOf("\n");
    // A runaway line is flushed in pieces rather than held forever.
    if (cut < 0 && text.length < 64 * 1024) {
      this.#stderrTail = text;
      return;
    }
    const upto = cut < 0 ? text.length : cut + 1;
    this.#stderrTail = text.slice(upto);
    this.#appendRaw("agent.stderr.log", text.slice(0, upto));
  }

  call(record: Record<string, unknown>): void {
    this.#append("calls.ndjson", record);
  }

  writeRecord(rec: AgentRecordFile): void {
    writeFileSync(join(this.dir, "agent.json"), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  }

  #append(file: string, record: unknown): void {
    this.#appendRaw(file, `${JSON.stringify(record)}\n`);
  }

  #appendRaw(file: string, text: string): void {
    if (this.#broken || this.#full.has(file)) return;
    for (const s of this.#secrets) text = text.split(s).join(REDACTED_TOKEN);
    const path = join(this.dir, file);
    try {
      let size = this.#written.get(file);
      if (size === undefined) {
        try {
          size = statSync(path).size;
        } catch {
          size = 0;
        }
      }
      const bytes = Buffer.byteLength(text);
      const cap = this.#caps[file] ?? TRANSCRIPT_CAPS[file] ?? Number.POSITIVE_INFINITY;
      if (size + bytes > cap) {
        this.#full.add(file);
        const note = file.endsWith(".ndjson") ? `${JSON.stringify({ clover: "truncated", cap })}\n` : `\n[Clover: this log reached its ${cap}-byte cap; the rest isn't kept]\n`;
        appendFileSync(path, note, { mode: 0o600 });
        return;
      }
      appendFileSync(path, text, { mode: 0o600 });
      this.#written.set(file, size + bytes);
    } catch {
      // A full disk loses transcript lines, never the agent; the session's own log still has its events.
      this.#broken = true;
    }
  }
}
