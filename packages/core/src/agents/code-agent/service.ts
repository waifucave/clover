// `clover-core code-agent` on the daemon's side (K-M3b; the controller's rulings A and B on it): Clover's coding agent
// for an outside ACP client (Zed and others). The client starts `clover-core code-agent`, a thin relay (relay.ts) that
// says hello on the daemon's endpoint as `cli` with the user's terminal token, so the caller check counts it as the
// user only from outside every sandbox and escape floor. Its one `codeAgent.open { cwd }` binds the connection to one
// session here; after it the connection takes only `codeAgent.send`, and the session ends with the connection.
//
// * **The session** is a direct coding session of the user's: recorded (its transcript under the Clover home, like any
//   agent's) and listed (a `coding` session on the host). Its root is the folder the client opened, which must be a
//   folder of this computer's tree under the fence; the agent runs with the sandbox and the fenced set denied, as for
//   any clover-code session. The bots' pause doesn't hold it.
// * **Its permission requests** go to the outside client, within this computer's level for the user: what the level
//   allows or refuses is answered here, without asking; only what it would ask about reaches the client, and never with
//   an "always" (nothing is saved from the client's answers, so the broker's saved rules and their floors are never
//   bypassed). A request touching the Clover home or the fenced set is refused here at every level.
// * **The client's own reach is narrowed:** no MCP server it names is started (none runs inside the daemon for it), a
//   session's folder stays inside the root, one ACP session per connection, and no mode that skips asking unless the
//   level allows it.
// * **Credentials never cross:** the relay moves ACP lines only, each bounded (`CODE_AGENT_MAX_LINE`); the model's
//   credentials stay in the daemon, and the client's token never reaches the session, its transcript or a log.
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { pathsOf, readPermissionOptions, type JsonRpcMessage } from "@waifucave/clover-agent-sdk/acp";
import { CODE_AGENT_MAX_LINE, type Level } from "@waifucave/clover-protocol";
import { levelDecision } from "../../contracts/approval-broker";
import type { Clock } from "../../contracts/clock";
import { ContractError } from "../../contracts/common";
import type { Fence } from "../../contracts/fence";
import type { SessionDriver, SessionHost, TurnEnd } from "../../contracts/session-host";
import type { Tree } from "../../contracts/tree";
import { homeTreePath } from "../../bots/paths";
import { CLOVER_CODE_ID, type CloverCodeBackend, type CodeAgentServed } from "../clover-code/backend";
import { effectOf } from "../manager";
import { agentPolicyOf, homeReach, withHomeDenied } from "../memory";
import { agentPaths } from "../paths";
import { AgentTranscript, type AgentRecordFile } from "../transcript";
import type { CodeAgentDoor } from "../../ipc/clover";
import { toMethodError } from "../../rpc/handler";

export interface CodeAgentServiceOptions {
  /** The Clover home: the session's transcript goes under it. */
  home: string;
  /** This computer's name in the folder tree. */
  computer: string;
  /** The user's home folder, which `home/<Computer>/` names (the OS's by default). */
  userHome?: string;
  host: SessionHost;
  tree: Pick<Tree, "resolve">;
  fence: Pick<Fence, "checkAgentRoot" | "policy" | "touches">;
  clock: Pick<Clock, "now">;
  /** Clover's coding agent on this computer, when it is there. */
  backend(): Pick<CloverCodeBackend, "serve" | "detect"> | undefined;
  /** This computer's level for the user (§9.1); read-only when it isn't known. */
  levelOf?(computer: string): Level | undefined;
  log?(line: string): void;
}

/** What the daemon's endpoint gives the service for one bound connection. */
export interface CodeAgentConnection {
  readonly connId: number;
  readonly clientName: string;
  /** One line to the client (`codeAgent.line`). */
  toClient(line: string): void;
  /** Closes the connection (the session ended here). */
  end(): void;
}

/** A JSON-RPC error answered to the client in the agent's place (ACP's invalid params). */
const RPC_INVALID_PARAMS = -32602;
/** Permission kinds the client is offered: never an "always", so nothing is saved from its answers. */
const OFFERED_KINDS = new Set(["allow_once", "reject_once"]);
/** Modes that ask before edits and commands; any other (`acceptEdits`) needs a level that allows edits. */
const ASKING_MODES = new Set(["default", "plan"]);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
type RpcId = string | number;
const idOf = (m: Obj): RpcId | undefined => (typeof m["id"] === "string" || typeof m["id"] === "number" ? (m["id"] as RpcId) : undefined);

interface Relay {
  readonly id: string;
  readonly conn: CodeAgentConnection;
  readonly root: string;
  readonly transcript: AgentTranscript;
  served?: CodeAgentServed;
  /** The one ACP session the client opened on this connection, once the agent answered. */
  acpSession?: string;
  /** The client's `session/new` or `session/resume` still unanswered: its id. */
  opening?: RpcId;
  /** The agent's permission requests the client was asked: the option ids it was offered. */
  readonly asked: Map<RpcId, Set<string>>;
  closed: boolean;
}

export class CodeAgentService {
  readonly #o: CodeAgentServiceOptions;
  readonly #relays = new Map<number, Relay>();

  constructor(o: CodeAgentServiceOptions) {
    this.#o = o;
  }

  /** `codeAgent.open`: the session for this connection, bound to it. */
  async open(conn: CodeAgentConnection, p: { cwd: string; model?: string; effort?: string }): Promise<{ session: string }> {
    if (this.#relays.has(conn.connId)) throw new ContractError("refused", "this connection already relays a session");
    const backend = this.#o.backend();
    if (!backend) throw new ContractError("not_installed", "Clover's coding agent isn't on this computer");
    const detected = await backend.detect();
    if (!detected.installed) throw new ContractError("not_installed", detected.reason ?? "Clover's coding agent isn't available on this computer");
    const { root, treePath } = this.#root(p.cwd);
    const id = `agent_${randomBytes(9).toString("base64url")}`;
    const transcript = new AgentTranscript(this.#o.home, id);
    const record: AgentRecordFile = {
      v: 1, sessionId: id, backend: CLOVER_CODE_ID, computer: this.#o.computer, root: treePath, startedAt: this.#o.clock.now(),
      ...(p.model === undefined ? {} : { model: p.model }), ...(p.effort === undefined ? {} : { effort: p.effort }),
    };
    transcript.writeRecord(record);
    const relay: Relay = { id, conn, root, transcript, asked: new Map(), closed: false };
    this.#relays.set(conn.connId, relay);
    try {
      relay.served = await backend.serve({
        root,
        ...(p.model === undefined ? {} : { model: p.model }),
        ...(p.effort === undefined ? {} : { effort: p.effort }),
        // The Clover home is out of its reach, whole, as for every agent (#208's check 2).
        fence: withHomeDenied(agentPolicyOf(this.#o.fence.policy()), this.#o.home),
      }, (line) => this.#fromAgent(relay, line));
      this.#o.host.open({
        id, kind: "coding", computer: this.#o.computer, backend: CLOVER_CODE_ID, root: treePath, title: `From ${conn.clientName}`,
        ...(p.model === undefined ? {} : { model: p.model }), ...(p.effort === undefined ? {} : { effort: p.effort }),
      }, this.#driver(relay));
    } catch (err) {
      await this.#close(relay, "failed to start", { host: false, end: false });
      throw err;
    }
    // The agent ending on its own (its server failed) ends the session and the connection.
    void relay.served.ended.then(() => this.#close(relay, "the coding agent ended"));
    this.#o.log?.(`code-agent: ${id} opened for ${conn.clientName} (connection ${conn.connId})`);
    return { session: id };
  }

  /** `codeAgent.send`: one line from the client. */
  input(connId: number, line: string): void {
    const relay = this.#relays.get(connId);
    if (!relay || relay.closed || !relay.served) throw new ContractError("closed", "no coding session on this connection");
    let msg: Obj | undefined;
    try {
      msg = obj(JSON.parse(line));
    } catch {
      msg = undefined;
    }
    // Not a JSON-RPC object: the agent answers it as it would any (a parse error).
    if (!msg) return relay.served.feed(line);
    const out = this.#fromClient(relay, msg);
    if (out === undefined) return;
    relay.transcript.wire("out", out as unknown as JsonRpcMessage, false, this.#o.clock.now());
    relay.served.feed(out === msg ? line : JSON.stringify(out));
  }

  /** The connection closed: its session ends. */
  close(connId: number): void {
    const relay = this.#relays.get(connId);
    if (relay) void this.#close(relay, "the client's connection closed", { end: false });
  }

  /** The connections that relay a session (for the endpoint's refusals). */
  bound(connId: number): boolean {
    return this.#relays.has(connId);
  }

  // ---- The client's lines ----

  /** A client message on its way to the agent: the line to send (the message itself, or a narrowed copy), or
   *  undefined when it was answered here in the agent's place. */
  #fromClient(relay: Relay, msg: Obj): Obj | undefined {
    const id = idOf(msg);
    const method = str(msg["method"]);
    // The client's answer to a permission request it was asked: only an option it was offered counts.
    if (method === undefined && id !== undefined && relay.asked.has(id)) {
      const offered = relay.asked.get(id)!;
      relay.asked.delete(id);
      const outcome = obj(obj(msg["result"])?.["outcome"]);
      const picked = str(outcome?.["optionId"]);
      const ok = str(outcome?.["outcome"]) === "selected" && picked !== undefined && offered.has(picked);
      relay.transcript.call({ ts: this.#o.clock.now(), type: "permission", toolCallId: String(id), allowed: ok && picked !== undefined, by: "client" });
      return ok ? msg : { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
    }
    if (method === undefined) return msg;
    const params = obj(msg["params"]) ?? {};
    const refuse = (why: string): undefined => {
      if (id !== undefined) this.#toClient(relay, { jsonrpc: "2.0", id, error: { code: RPC_INVALID_PARAMS, message: why } });
      return undefined;
    };
    switch (method) {
      case "session/new":
      case "session/resume":
      case "session/load": {
        if (relay.acpSession !== undefined || relay.opening !== undefined) {
          return refuse("this connection serves one session; start Clover's coding agent again for another");
        }
        const cwd = str(params["cwd"]);
        const real = cwd === undefined ? relay.root : this.#real(cwd);
        if (real === undefined || !within(relay.root, real)) return refuse(`a session's folder must be ${relay.root} or a folder in it`);
        if (id !== undefined) relay.opening = id;
        // No MCP server the client names runs inside the daemon.
        return { ...msg, params: { ...params, cwd: real, mcpServers: [] } };
      }
      case "session/set_mode":
        return this.#modeOk(str(params["modeId"])) ? msg : refuse(`the mode ${str(params["modeId"]) ?? "(none)"} would skip asking, which this computer's level doesn't allow`);
      case "session/set_config_option":
        if (str(params["configId"]) === "mode" && !this.#modeOk(str(params["value"]))) {
          return refuse(`the mode ${str(params["value"]) ?? "(none)"} would skip asking, which this computer's level doesn't allow`);
        }
        return msg;
      default:
        return msg;
    }
  }

  /** A mode the client may pick: one that asks, or one that edits without asking where the level allows edits. */
  #modeOk(mode: string | undefined): boolean {
    if (mode !== undefined && ASKING_MODES.has(mode)) return true;
    return mode === "acceptEdits" && levelDecision(this.#level(), "edit") === "allow";
  }

  // ---- The agent's lines ----

  #fromAgent(relay: Relay, line: string): void {
    if (relay.closed) return;
    if (line.length > CODE_AGENT_MAX_LINE) {
      this.#o.log?.(`code-agent: ${relay.id}: the agent sent a line over ${CODE_AGENT_MAX_LINE} characters; the session ends`);
      void this.#close(relay, "the agent sent a line too long to relay");
      return;
    }
    let msg: Obj | undefined;
    try {
      msg = obj(JSON.parse(line));
    } catch {
      msg = undefined;
    }
    if (!msg) return relay.conn.toClient(line);
    relay.transcript.wire("in", msg as unknown as JsonRpcMessage, false, this.#o.clock.now());
    const id = idOf(msg);
    const method = str(msg["method"]);
    // The agent's answer to the client's session/new or resume: the connection's one session.
    if (method === undefined && id !== undefined && id === relay.opening) {
      relay.opening = undefined;
      const result = obj(msg["result"]);
      if (result) relay.acpSession = str(result["sessionId"]) ?? relay.acpSession ?? "";
    }
    if (method === "session/request_permission" && id !== undefined) return this.#permission(relay, id, obj(msg["params"]) ?? {});
    relay.conn.toClient(line);
  }

  /** The agent asks before a call: answered here where this computer's level decides, else asked of the client. */
  #permission(relay: Relay, id: RpcId, params: Obj): void {
    const toolCall = obj(params["toolCall"]);
    const options = readPermissionOptions(params["options"]);
    const kind = str(toolCall?.["kind"]) ?? "other";
    const answer = (allowed: boolean, by: string) => {
      const option = options.find((o) => o.kind === (allowed ? "allow_once" : "reject_once"));
      relay.transcript.call({ ts: this.#o.clock.now(), type: "permission", toolCallId: str(toolCall?.["toolCallId"]) ?? String(id), toolKind: kind, allowed, by });
      const outcome = option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
      relay.served?.feed(JSON.stringify({ jsonrpc: "2.0", id, result: { outcome } }));
    };
    const resolved = agentPaths(pathsOf(toolCall, toolCall?.["rawInput"]), relay.root);
    if (resolved.over) return answer(false, "too-many-paths");
    // The Clover home and the fenced set: refused at every level, never asked about.
    if (resolved.paths.some((p) => homeReach(this.#o.home, p, relay.root) === "inside")) return answer(false, "clover-home");
    if (resolved.paths.some((p) => this.#o.fence.touches([p]) !== null)) return answer(false, "fenced");
    const verdict = levelDecision(this.#level(), effectOf(kind));
    if (verdict === "allow") return answer(true, "level");
    if (verdict === "deny") return answer(false, "level");
    // What the level would ask about goes to the client, without an "always".
    const offered = options.filter((o) => OFFERED_KINDS.has(o.kind));
    if (offered.length === 0) return answer(false, "no-option");
    relay.asked.set(id, new Set(offered.map((o) => o.optionId)));
    this.#toClient(relay, { jsonrpc: "2.0", id, method: "session/request_permission", params: { ...params, options: offered } });
  }

  #toClient(relay: Relay, msg: Obj): void {
    relay.conn.toClient(JSON.stringify(msg));
  }

  // ---- The session ----

  #driver(relay: Relay): SessionDriver {
    return {
      canFold: false,
      // The client drives it: a message from Clover's own surfaces is answered, never sent on.
      turn: async (): Promise<TurnEnd> => ({ reason: "refusal", text: `This session is driven from ${relay.conn.clientName}: message it there.` }),
      // The user's interrupt from Clover cancels the client's running prompt.
      interrupt: async () => {
        if (relay.acpSession === undefined || relay.closed) return;
        const cancel = { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: relay.acpSession } };
        relay.transcript.wire("out", cancel as unknown as JsonRpcMessage, false, this.#o.clock.now());
        relay.served?.feed(JSON.stringify(cancel));
      },
      // Stopped from Clover: the agent and the connection end.
      stop: async () => this.#close(relay, "stopped", { host: false }),
    };
  }

  async #close(relay: Relay, reason: string, o: { host?: boolean; end?: boolean } = {}): Promise<void> {
    if (relay.closed) return;
    relay.closed = true;
    this.#relays.delete(relay.conn.connId);
    relay.asked.clear();
    await relay.served?.close().catch(() => {});
    if (o.host !== false && this.#o.host.get(relay.id)) await this.#o.host.stop(relay.id, reason).catch(() => {});
    if (o.end !== false) {
      try {
        relay.conn.end();
      } catch {
        // Already gone.
      }
    }
    this.#o.log?.(`code-agent: ${relay.id} ended (${reason})`);
  }

  // ---- The root ----

  /** The client's folder as this computer's tree names it, under the fence; its real path. */
  #root(cwd: string): { root: string; treePath: string } {
    if (!isAbsolute(cwd)) throw new ContractError("invalid", "the client's folder must be an absolute path");
    const real = this.#real(cwd);
    if (real === undefined) throw new ContractError("not_found", `the folder ${cwd} isn't there`);
    const userHome = this.#real(this.#o.userHome ?? homedir()) ?? (this.#o.userHome ?? homedir());
    const treePath = homeTreePath({ userHome, computer: this.#o.computer, dir: real });
    if (treePath === undefined) throw new ContractError("refused", "Clover's coding agent works in a folder of your home folder on this computer");
    const loc = this.#o.tree.resolve(treePath);
    if (loc.area !== "home" || loc.computer !== this.#o.computer) throw new ContractError("refused", `${treePath} isn't a folder of this computer`);
    const verdict = this.#o.fence.checkAgentRoot(loc.path);
    if (!verdict.allowed) throw new ContractError("fenced", `an agent's root may not hold Clover's own folders (${verdict.reason})`, { path: verdict.path });
    return { root: this.#real(loc.path) ?? loc.path, treePath };
  }

  /** A folder's real path, or undefined when it isn't a folder that's there. */
  #real(path: string): string | undefined {
    try {
      const real = realpathSync(path);
      return statSync(real).isDirectory() ? real : undefined;
    } catch {
      return undefined;
    }
  }

  #level(): Level {
    return this.#o.levelOf?.(this.#o.computer) ?? "read-only";
  }
}

/** Whether `path` is `root` or inside it (both real paths). */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

/** The service as the daemon's endpoint takes it (`CloverServerDeps.codeAgent`): its refusals as JSON-RPC errors. */
export function codeAgentDoor(service: CodeAgentService): CodeAgentDoor {
  return {
    open: async (conn, p) => {
      try {
        return await service.open(conn, p);
      } catch (err) {
        throw toMethodError(err);
      }
    },
    input: (connId, line) => {
      try {
        service.input(connId, line);
      } catch (err) {
        throw toMethodError(err);
      }
    },
    close: (connId) => service.close(connId),
  };
}
