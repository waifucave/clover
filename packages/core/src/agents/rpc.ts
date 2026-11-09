// Lane K's methods of the protocol's agents area (packages/protocol/src/agents.ts), as handlers lane C's server mounts
// (C-M1: roles, tokens, the caller check). Each checks its params with the method's own schema and throws a
// `ContractError` the server maps to its JSON-RPC code. The bridge's own methods (`bridge.*`, `glossary.query`) are
// served on the daemon's main socket in the bridge role (bridge/handlers.ts), bound to one agent session each.
//
// `session.setModel` for agents and coding sessions is lane D's method; D's handler calls `AgentManager.setModel`.
import { randomUUID } from "node:crypto";
import { AGENTS_METHODS, AgentDefView, ERR, type AgentBackendView, type BackendMark, type Caller, type MethodSpec } from "@waifucave/clover-protocol";
import type { z } from "zod";
import type { AgentBackend } from "../contracts/agent-backend";
import type { PluginRegistry } from "../contracts/plugin-registry";
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
  /** Agent definitions from plugins (`pluginAgentDefinitions` over B-M2's registry). */
  definitions?: () => AgentDefView[];
  /** This computer's device id: the device of a user's call made on this computer (the app or the terminal here), whose
   *  caller names none. */
  localDevice: () => string;
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
        caller: { kind: "user", device: ctx.caller.device ?? o.localDevice(), clientMessageId: randomUUID() },
        backend: p.backend, computer: p.computer, root: p.root, prompt: p.prompt ?? "",
        ...(p.model === undefined ? {} : { model: p.model }), ...(p.effort === undefined ? {} : { effort: p.effort }),
      });
      return { session: r.sessionId };
    },
  };
}

/** What `agentMethods` needs of the agents the daemon runs (`createAgents`'s). */
export type RunningAgents = Pick<AgentMethodsOptions, "manager" | "backends" | "computer">;

/** The agent definitions plugins contribute (the `agents` point, §5.3): each active entry that is a preset, as the
 *  protocol shows it. An entry that is a path (a Claude-style agent file) isn't a preset, and one that doesn't fit the
 *  view (a computer or root folder it can't name) is left out. */
export function pluginAgentDefinitions(registry: Pick<PluginRegistry, "entries">): AgentDefView[] {
  const out: AgentDefView[] = [];
  for (const c of registry.entries("agents")) {
    if (c.state !== "active" || typeof c.value !== "object" || c.value === null) continue;
    const d = c.value as { id: string; name: string; backend: string; model?: string; effort?: string; computer?: string; root?: string };
    const view = AgentDefView.safeParse({
      id: d.id, name: d.name, pluginId: c.pluginId, backend: d.backend,
      ...(d.model === undefined ? {} : { model: d.model }), ...(d.effort === undefined ? {} : { effort: d.effort }),
      ...(d.computer === undefined ? {} : { computer: d.computer }), ...(d.root === undefined ? {} : { root: d.root }),
    });
    if (view.success) out.push(view.data);
  }
  return out;
}

/** `agentMethods` over agents that start after the server and stop before it: each call reads them through the
 *  getter, and is refused while none run. A thrown `ContractError` becomes its JSON-RPC code (`toMethodError`). */
export function lateAgentMethods(
  agents: () => RunningAgents | undefined,
  o: Pick<AgentMethodsOptions, "localDevice" | "definitions">,
): Record<string, AgentMethod> {
  const made = new WeakMap<RunningAgents, Record<string, AgentMethod>>();
  const methodsOf = (a: RunningAgents): Record<string, AgentMethod> => {
    let m = made.get(a);
    if (!m) made.set(a, (m = agentMethods({ manager: a.manager, backends: a.backends, computer: a.computer, localDevice: o.localDevice, ...(o.definitions ? { definitions: o.definitions } : {}) })));
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
