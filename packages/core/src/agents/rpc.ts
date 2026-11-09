// Lane K's methods of the protocol's agents area (packages/protocol/src/agents.ts), as handlers lane C's server mounts
// (C-M1: roles, tokens, the caller check). Each checks its params with the method's own schema and throws a
// `ContractError` the server maps to its JSON-RPC code. The bridge's own methods (`bridge.*`, `glossary.query`) are
// served on the daemon's main socket in the bridge role (bridge/handlers.ts), bound to one agent session each.
//
// `session.setModel` for agents and coding sessions is lane D's method; D's handler calls `AgentManager.setModel`.
import { randomUUID } from "node:crypto";
import { AGENTS_METHODS, ERR, type AgentBackendView, type AgentDefView, type BackendMark, type Caller, type MethodSpec } from "@waifucave/clover-protocol";
import type { z } from "zod";
import type { AgentBackend } from "../contracts/agent-backend";
import { ContractError } from "../contracts/common";
import { MethodError, toMethodError } from "../rpc/handler";
import type { AgentManager } from "./manager";

export interface AgentMethodsOptions {
  manager: AgentManager;
  backends: () => readonly AgentBackend[];
  /** This computer's name. */
  computer: string;
  /** Display names by backend id; the id when missing. */
  names?: Readonly<Record<string, string>>;
  /** Agent definitions from plugins (B-M2's registry); none until then. */
  definitions?: () => AgentDefView[];
}

export type AgentMethod = (params: unknown, ctx: { caller: Caller }) => Promise<unknown>;


function parse<S extends MethodSpec>(spec: S, raw: unknown): z.output<S["params"]> {
  const r = spec.params.safeParse(raw ?? {});
  if (!r.success) throw new ContractError("invalid", `${spec.name}: ${r.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ")}`);
  return r.data as z.output<S["params"]>;
}

export function agentMethods(o: AgentMethodsOptions): Record<string, AgentMethod> {
  return {
    [AGENTS_METHODS.agentBackends.name]: async (raw) => {
      parse(AGENTS_METHODS.agentBackends, raw);
      const backends: AgentBackendView[] = [];
      for (const b of o.backends()) {
        const d = await b.detect().catch(() => ({ installed: false, sandboxed: false, version: undefined }));
        const marks = new Set<BackendMark>(b.quirks.marks);
        if (d.installed && !d.sandboxed) marks.add("unsandboxed");
        backends.push({
          id: b.id,
          name: o.names?.[b.id] ?? (b as { name?: string }).name ?? b.id,
          pluginId: b.pluginId,
          // Devin's cloud is ACP with cloud placement (spec §9.3); a cloud agent with no command to start is a vendor's
          // own API. Local backends, the in-process ones included, are ACP.
          protocol: b.quirks.placement === "cloud" && Object.keys(b.quirks.launch.command).length === 0 ? "cloud" : "acp",
          placement: b.quirks.placement,
          computers: [{
            computer: o.computer, installed: d.installed, sandboxed: d.sandboxed, marks: [...marks],
            ...(d.version === undefined ? {} : { version: d.version.slice(0, 64) }),
          }],
        });
      }
      return { backends };
    },
    [AGENTS_METHODS.agentDefinitions.name]: async (raw) => {
      parse(AGENTS_METHODS.agentDefinitions, raw);
      return { definitions: o.definitions?.() ?? [] };
    },
    [AGENTS_METHODS.agentStart.name]: async (raw, ctx) => {
      const p = parse(AGENTS_METHODS.agentStart, raw);
      if (ctx.caller.kind !== "user") throw new ContractError("refused", "only the user starts a coding session");
      if (p.definition !== undefined) throw new ContractError("invalid", "agent definitions come with K-M2");
      const r = await o.manager.start({
        caller: { kind: "user", device: ctx.caller.device ?? "local", clientMessageId: randomUUID() },
        backend: p.backend, computer: p.computer, root: p.root, prompt: p.prompt ?? "",
        ...(p.model === undefined ? {} : { model: p.model }), ...(p.effort === undefined ? {} : { effort: p.effort }),
      });
      return { session: r.sessionId };
    },
  };
}

/** What `agentMethods` needs of the agents the daemon runs (`createAgents`'s). */
export type RunningAgents = Pick<AgentMethodsOptions, "manager" | "backends" | "computer">;

/** `agentMethods` over agents that start after the server and stop before it: each call reads them through the
 *  getter, and is refused while none run. A thrown `ContractError` becomes its JSON-RPC code (`toMethodError`). */
export function lateAgentMethods(agents: () => RunningAgents | undefined): Record<string, AgentMethod> {
  const made = new WeakMap<RunningAgents, Record<string, AgentMethod>>();
  const methodsOf = (a: RunningAgents): Record<string, AgentMethod> => {
    let m = made.get(a);
    if (!m) made.set(a, (m = agentMethods({ manager: a.manager, backends: a.backends, computer: a.computer })));
    return m;
  };
  const names = [AGENTS_METHODS.agentBackends.name, AGENTS_METHODS.agentDefinitions.name, AGENTS_METHODS.agentStart.name];
  return Object.fromEntries(names.map((name) => [name, async (params: unknown, ctx: { caller: Caller }) => {
    const a = agents();
    if (!a) throw new MethodError(ERR.RETRY, "Clover's agents aren't running on this computer yet: try again in a moment");
    try {
      return await methodsOf(a)[name]!(params, ctx);
    } catch (err) {
      throw toMethodError(err);
    }
  }]));
}
