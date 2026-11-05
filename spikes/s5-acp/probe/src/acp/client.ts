// The probe's ACP client: the official SDK's `client()` app (v1, the `/unstable` entrypoint
// so newer fields such as config options survive parsing), with handlers that record
// everything the agent asks of the client.
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { RunLog } from "../util/log.ts";
import { readTextFile, writeTextFile, Terminals } from "./client-host.ts";

export type Decision = "allow" | "reject" | "cancel";

export interface PermissionRecord {
  atMs: number; // since the client started; the log stamps its own `ms`
  sessionId: string;
  toolCallId?: string;
  title?: string | null;
  kind?: string | null;
  optionKinds: string[];
  decision: Decision;
  optionId?: string;
}

export interface ProbeState {
  updates: acp.SessionNotification[];
  text: Map<string, string>; // agent_message_chunk text per session
  toolCalls: Map<string, { title?: string | null; kind?: string | null; status?: string | null; rawInput?: unknown }>;
  permissions: PermissionRecord[];
  fsCalls: { method: string; path: string; ok: boolean; error?: string }[];
  terminalCalls: { method: string; terminalId?: string; command?: string; args?: string[] }[];
  elicitations: unknown[];
  unknown: { kind: "request" | "notification"; method: string }[];
  /** Called for every session/update after it is recorded. */
  onUpdate?: (n: acp.SessionNotification) => void;
}

export interface ClientOptions {
  log: RunLog;
  root: string; // the session cwd; fs and terminals are confined to it
  childEnv: Record<string, string>;
  /** Decides each permission request. Default: allow once. */
  decide?: (req: acp.RequestPermissionRequest) => Decision;
  /** Register every handler as a raw fallback instead of a typed one (no SDK parsing). */
  raw?: boolean;
}

export function newState(): ProbeState {
  return {
    updates: [],
    text: new Map(),
    toolCalls: new Map(),
    permissions: [],
    fsCalls: [],
    terminalCalls: [],
    elicitations: [],
    unknown: [],
  };
}

export function buildClient(opts: ClientOptions, state: ProbeState) {
  const { log, root } = opts;
  const terminals = new Terminals(root, opts.childEnv);
  const t0 = Date.now();

  const onUpdate = (n: acp.SessionNotification) => {
    state.updates.push(n);
    const u = n.update as any;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") state.text.set(n.sessionId, (state.text.get(n.sessionId) ?? "") + u.content.text);
        break;
      case "tool_call":
      case "tool_call_update": {
        const prev = state.toolCalls.get(u.toolCallId) ?? {};
        const next = {
          title: u.title ?? prev.title,
          kind: u.kind ?? prev.kind,
          status: u.status ?? prev.status,
          rawInput: u.rawInput ?? prev.rawInput,
        };
        state.toolCalls.set(u.toolCallId, next);
        log.event(`update.${u.sessionUpdate}`, { toolCallId: u.toolCallId, title: next.title, kind: next.kind, status: next.status });
        break;
      }
      case "agent_thought_chunk":
      case "user_message_chunk":
        break;
      default:
        log.event(`update.${u.sessionUpdate}`, {});
    }
    state.onUpdate?.(n);
  };

  const requestHandlers: Record<string, (params: any) => unknown> = {
    "session/request_permission": (p: acp.RequestPermissionRequest): acp.RequestPermissionResponse => {
      const decision = opts.decide?.(p) ?? "allow";
      const allow = p.options.find((o) => o.kind === "allow_once");
      // Never "always": an agent writes those into its own saved rules, past Clover's levels.
      const reject = p.options.find((o) => o.kind === "reject_once");
      const chosen = decision === "allow" ? allow : decision === "reject" ? reject : undefined;
      const rec: PermissionRecord = {
        atMs: Date.now() - t0,
        sessionId: p.sessionId,
        toolCallId: p.toolCall?.toolCallId,
        title: p.toolCall?.title,
        kind: p.toolCall?.kind,
        optionKinds: p.options.map((o) => `${o.kind}:${o.optionId}`),
        decision: chosen ? decision : "cancel",
        optionId: chosen?.optionId,
      };
      state.permissions.push(rec);
      log.event("permission", rec as unknown as Record<string, unknown>);
      return chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : { outcome: { outcome: "cancelled" } };
    },
    "fs/read_text_file": async (p: acp.ReadTextFileRequest) => {
      try {
        const r = await readTextFile(root, p);
        state.fsCalls.push({ method: "fs/read_text_file", path: p.path, ok: true });
        log.event("fs.read", { path: p.path, bytes: r.content.length });
        return r;
      } catch (e) {
        state.fsCalls.push({ method: "fs/read_text_file", path: p.path, ok: false, error: String(e) });
        log.event("fs.read.error", { path: p.path, error: String(e) });
        throw e;
      }
    },
    "fs/write_text_file": async (p: acp.WriteTextFileRequest) => {
      try {
        const r = await writeTextFile(root, p);
        state.fsCalls.push({ method: "fs/write_text_file", path: p.path, ok: true });
        log.event("fs.write", { path: p.path, bytes: p.content.length });
        return r;
      } catch (e) {
        state.fsCalls.push({ method: "fs/write_text_file", path: p.path, ok: false, error: String(e) });
        log.event("fs.write.error", { path: p.path, error: String(e) });
        throw e;
      }
    },
    "terminal/create": (p: acp.CreateTerminalRequest) => {
      const r = terminals.create(p);
      state.terminalCalls.push({ method: "terminal/create", terminalId: r.terminalId, command: p.command, args: p.args });
      log.event("terminal.create", { terminalId: r.terminalId, command: p.command, args: p.args, cwd: p.cwd });
      return r;
    },
    "terminal/output": (p: acp.TerminalOutputRequest) => {
      state.terminalCalls.push({ method: "terminal/output", terminalId: p.terminalId });
      return terminals.output(p);
    },
    "terminal/wait_for_exit": async (p: acp.WaitForTerminalExitRequest) => {
      state.terminalCalls.push({ method: "terminal/wait_for_exit", terminalId: p.terminalId });
      const r = await terminals.waitForExit(p);
      log.event("terminal.exit", { terminalId: p.terminalId, ...r });
      return r;
    },
    "terminal/kill": (p: acp.KillTerminalRequest) => {
      state.terminalCalls.push({ method: "terminal/kill", terminalId: p.terminalId });
      log.event("terminal.kill", { terminalId: p.terminalId });
      return terminals.kill(p);
    },
    "terminal/release": (p: acp.ReleaseTerminalRequest) => {
      state.terminalCalls.push({ method: "terminal/release", terminalId: p.terminalId });
      return terminals.release(p);
    },
    "elicitation/create": (p: unknown) => {
      state.elicitations.push(p);
      log.event("elicitation", {});
      return { action: "decline" };
    },
  };

  let app = acp.client({ name: "clover-s5-probe" });
  if (opts.raw) {
    app = app
      .onRequest("*", ({ method, params }) => {
        const h = requestHandlers[method];
        if (h) return h(params);
        state.unknown.push({ kind: "request", method });
        log.event("unknown.request", { method });
        throw acp.RequestError.methodNotFound(method);
      })
      .onNotification("*", ({ method, params }) => {
        if (method === "session/update") return onUpdate(params as acp.SessionNotification);
        state.unknown.push({ kind: "notification", method });
        log.event("unknown.notification", { method });
      });
  } else {
    app = app.onNotification(acp.methods.client.session.update, ({ params }) => onUpdate(params));
    for (const [method, h] of Object.entries(requestHandlers)) {
      app = app.onRequest(method as any, (({ params }: { params: unknown }) => h(params)) as any);
    }
    app = app
      .onRequest("*", ({ method }) => {
        state.unknown.push({ kind: "request", method });
        log.event("unknown.request", { method });
        throw acp.RequestError.methodNotFound(method);
      })
      .onNotification("*", ({ method }) => {
        state.unknown.push({ kind: "notification", method });
        log.event("unknown.notification", { method });
      });
  }
  return { app, terminals };
}

/** What the probe tells every agent it can do. */
export const CLIENT_CAPABILITIES: acp.ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

export const CLIENT_INFO = { name: "clover-s5-probe", title: "Clover S5 ACP probe", version: "0.0.1" };
