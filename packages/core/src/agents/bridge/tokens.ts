// The bridge's tokens (spec §9.3 "The bridge's link", spike S5 edit 4).
//
// * One token per agent session, the only secret handed to the agent, and only in the bridge entry's `env`.
// * Tokens live in the daemon's memory only, never on disk: a daemon restart revokes every one. A reattach (`load`
//   or `resume`) mints a new one; `TaskStop` and the session's end revoke it.
// * The daemon accepts a token only from a process under that session's agent process: the kernel names the
//   connecting pid (peer.ts), and the process table must show it descending from the agent. On Windows this becomes
//   job-object membership (lane C); until then a caller the kernel can't name is refused.
// * One live connection per token. The agent may restart its MCP server; a new connection is accepted once the old
//   one has closed, from the same tree.
// * A copy that leaked (Antigravity keeps the bridge's entry, token included, in plain text) is useless once the agent
//   is gone: the token is revoked when the agent's process exits, not only at `TaskStop`, and it expires after
//   `TOKEN_TTL_MS` whatever happens, so a session that outlives that reattaches under a new one.
import { createHash, randomBytes } from "node:crypto";
import { Listeners, type Unsubscribe } from "../../contracts/common";
import { isDescendant, readProcessTable, type ProcessTableReader } from "../process/table";

export type BridgeRefusal = "unknown-token" | "wrong-session" | "revoked" | "expired" | "in-use" | "unverified-caller" | "not-the-agent" | "agent-not-started";

export type BridgeAcceptance =
  | { ok: true; sessionId: string; connection: number }
  | { ok: false; reason: BridgeRefusal };

interface Grant {
  sessionId: string;
  hash: string;
  mintedAt: number;
  agentPid?: number;
  pidKnown: Promise<number>;
  setPid: (pid: number) => void;
  live?: number;
  revoked: boolean;
}

/** How long a bridge that connects before the daemon has bound its agent's pid waits for it. */
export const BIND_WAIT_MS = 30_000;
/** A token's longest life: no new connection is accepted on it after this, live or not. */
export const TOKEN_TTL_MS = 12 * 60 * 60_000;

function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class BridgeTokens {
  readonly #byHash = new Map<string, Grant>();
  readonly #bySession = new Map<string, Grant>();
  readonly #revoked = new Listeners<{ sessionId: string; connection?: number }>();
  readonly #table: ProcessTableReader;
  readonly #bindWaitMs: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #connSeq = 0;

  constructor(opts: { table?: ProcessTableReader; bindWaitMs?: number; ttlMs?: number; now?: () => number } = {}) {
    this.#table = opts.table ?? readProcessTable;
    this.#bindWaitMs = opts.bindWaitMs ?? BIND_WAIT_MS;
    this.#ttlMs = opts.ttlMs ?? TOKEN_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** A new token for the session, revoking any earlier one. Bind the agent's pid once it is known. */
  mint(sessionId: string): string {
    this.revoke(sessionId);
    const token = randomBytes(32).toString("base64url");
    let setPid!: (pid: number) => void;
    const pidKnown = new Promise<number>((r) => (setPid = r));
    const g: Grant = { sessionId, hash: hashOf(token), mintedAt: this.#now(), pidKnown, setPid, revoked: false };
    this.#byHash.set(g.hash, g);
    this.#bySession.set(sessionId, g);
    return token;
  }

  /** The agent process the session's token is bound to. */
  bind(sessionId: string, agentPid: number): void {
    const g = this.#bySession.get(sessionId);
    if (!g || g.revoked || g.agentPid !== undefined || agentPid <= 0) return;
    g.agentPid = agentPid;
    g.setPid(agentPid);
  }

  has(sessionId: string): boolean {
    const g = this.#bySession.get(sessionId);
    return g !== undefined && !g.revoked;
  }

  /** Checks a bridge's hello: its token, the session it names, and the kernel's pid for the caller. */
  async accept(token: string, sessionId: string, peerPid: number | null): Promise<BridgeAcceptance> {
    const g = this.#byHash.get(hashOf(token));
    if (!g) return { ok: false, reason: "unknown-token" };
    if (g.revoked) return { ok: false, reason: "revoked" };
    if (g.sessionId !== sessionId) return { ok: false, reason: "wrong-session" };
    if (this.#now() - g.mintedAt > this.#ttlMs) return { ok: false, reason: "expired" };
    if (peerPid === null) return { ok: false, reason: "unverified-caller" };
    const agentPid = g.agentPid ?? (await Promise.race([g.pidKnown, new Promise<undefined>((r) => setTimeout(() => r(undefined), this.#bindWaitMs))]));
    if (agentPid === undefined) return { ok: false, reason: "agent-not-started" };
    if (g.revoked) return { ok: false, reason: "revoked" };
    const rows = await this.#table().catch(() => []);
    if (!isDescendant(rows, peerPid, agentPid)) return { ok: false, reason: "not-the-agent" };
    if (g.live !== undefined) return { ok: false, reason: "in-use" };
    g.live = ++this.#connSeq;
    return { ok: true, sessionId, connection: g.live };
  }

  /** The bridge's connection closed: the token may be used again from the same tree. */
  release(sessionId: string, connection: number): void {
    const g = this.#bySession.get(sessionId);
    if (g && g.live === connection) delete g.live;
  }

  revoke(sessionId: string): void {
    const g = this.#bySession.get(sessionId);
    if (!g) return;
    g.revoked = true;
    this.#byHash.delete(g.hash);
    this.#bySession.delete(sessionId);
    const live = g.live;
    delete g.live;
    this.#revoked.emit({ sessionId, ...(live === undefined ? {} : { connection: live }) });
  }

  revokeAll(): void {
    for (const id of [...this.#bySession.keys()]) this.revoke(id);
  }

  /** A token was revoked; the endpoint closes its live connection. */
  onRevoke(fn: (e: { sessionId: string; connection?: number }) => void): Unsubscribe {
    return this.#revoked.add(fn);
  }
}
