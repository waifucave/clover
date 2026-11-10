// The terminal panel's own methods on this computer (lane J; K's audit): `terminal.open`, `terminal.write`,
// `terminal.resize` and `terminal.close` for the app (and the bundled tree's layer, which holds `terminal`), served by
// the computer node's terminals: this computer's shells, and another computer's through the link (judged there, R1).
//
// * A terminal belongs to the connection that opened it: only that connection writes to it, resizes or closes it, and
//   its output (`terminal_output`, owner-scoped) goes to that connection alone. When the connection closes, its
//   terminals close with it.
// * A paste of several lines goes through the node's paste card (`nodeParts`'s `confirmPaste`); without a card path it
//   is refused with the reason, which the method's error carries to the panel: never dropped silently.
import { COMPUTERS_METHODS, type Caller } from "@waifucave/clover-protocol";
import type { CloverConn, CloverHandler } from "../ipc/clover";
import type { CoreEventInput, CoreEventOptions } from "../ipc/core-events";
import { MethodError, toMethodError } from "../rpc/handler";
import { ERR } from "@waifucave/clover-protocol";
import type { TerminalRouter } from "../tree/terminals";

const M = COMPUTERS_METHODS;

export interface AppTerminalsOptions {
  terminals: Pick<TerminalRouter, "open" | "write" | "resize" | "close" | "onOutput">;
  /** The Clover server's `core.event` sender (`CloverServer.coreEvent`), which routes each event by its rules. */
  coreEvent: (event: CoreEventInput, opts?: CoreEventOptions) => number;
  log?: (line: string) => void;
}

/** The handlers, and their teardown (every terminal they opened closes). */
export function appTerminals(o: AppTerminalsOptions): { handlers: Record<string, CloverHandler>; close(): Promise<void> } {
  /** Each open terminal's owner: the connection that opened it. */
  const owners = new Map<string, CloverConn>();
  const offOutput = o.terminals.onOutput((out) => {
    const conn = owners.get(out.terminalId);
    if (!conn) return;
    o.coreEvent({ type: "terminal_output", terminalId: out.terminalId, data: out.data, ...(out.exited ? { exited: out.exited } : {}) }, { to: (c) => c === conn });
    if (out.exited) {
      owners.delete(out.terminalId);
      conn.follows.delete(followKey(out.terminalId));
    }
  });
  const followKey = (id: string) => `terminal:${id}`;
  const parse = <T>(spec: { name: string; params: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } } }, raw: unknown): T => {
    const r = spec.params.safeParse(raw);
    if (!r.success) throw new MethodError(ERR.INVALID_PARAMS, `${spec.name}: ${r.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ")}`);
    return r.data;
  };
  /** The terminal, when this connection opened it; not found otherwise (another connection's terminal isn't there). */
  const mine = (conn: CloverConn, id: string): void => {
    if (owners.get(id) !== conn) throw new MethodError(ERR.NOT_FOUND, `no terminal ${id}`);
  };
  const wrap = (fn: (conn: CloverConn, params: unknown) => Promise<unknown>): CloverHandler => async (conn, params) => {
    try {
      return await fn(conn, params);
    } catch (err) {
      throw toMethodError(err);
    }
  };
  const closeOne = async (id: string): Promise<void> => {
    const conn = owners.get(id);
    owners.delete(id);
    conn?.follows.delete(followKey(id));
    await o.terminals.close(id).catch((e: Error) => o.log?.(`terminal ${id} didn't close: ${e.message}`));
  };

  const handlers: Record<string, CloverHandler> = {
    [M.terminalOpen.name]: wrap(async (conn, raw) => {
      const p = parse(M.terminalOpen, raw);
      // The app's shape names a computer; the other one is a peer's, which comes over the link, never here.
      if (!("computer" in p)) throw new MethodError(ERR.INVALID_PARAMS, "terminal.open: name the computer to open it on");
      const as: Caller = conn.caller;
      const { terminalId } = await o.terminals.open({ computer: p.computer, cols: p.cols, rows: p.rows, ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.session ? { session: p.session } : {}) }, as);
      owners.set(terminalId, conn);
      // The connection's close ends its terminals.
      conn.follows.set(followKey(terminalId), () => void closeOne(terminalId));
      return { terminalId };
    }),
    [M.terminalWrite.name]: wrap(async (conn, raw) => {
      const p = parse(M.terminalWrite, raw);
      mine(conn, p.terminalId);
      await o.terminals.write(p.terminalId, p.data, { ...(p.paste ? { paste: true } : {}) });
      return { ok: true };
    }),
    [M.terminalResize.name]: wrap(async (conn, raw) => {
      const p = parse(M.terminalResize, raw);
      mine(conn, p.terminalId);
      await o.terminals.resize(p.terminalId, p.cols, p.rows);
      return { ok: true };
    }),
    [M.terminalClose.name]: wrap(async (conn, raw) => {
      const p = parse(M.terminalClose, raw);
      mine(conn, p.terminalId);
      await closeOne(p.terminalId);
      return { ok: true };
    }),
  };
  return {
    handlers,
    close: async () => {
      offOutput();
      await Promise.all([...owners.keys()].map(closeOne));
    },
  };
}
