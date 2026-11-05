// The caller check (spec §3.1): who a Clover connection counts as, and what it may call. On top of the
// role and its token (clover-tokens.ts), the daemon probes the peer process (platform/caller-probe.ts):
//   app   the user, only from outside every sandbox and escape floor and not under a process the daemon
//         started for a bot, an agent or a plugin; otherwise refused (an app inside a sandbox is not
//         the app)
//   cli   the user on the same terms; a CLI started under a session's process acts as that session; a
//         fenced CLI that belongs to no session is refused (fail closed)
//   layer a plugin (its token names it); plugin-host the plugin its process serves, with each
//         `pluginHost.api` call acting as the plugin the host stamps (R7)
//   bridge the agent session it serves; remote, web the user on that device; peer another computer,
//         always fenced (J-M1's review)
// and then, per request: the role's allow list (B's `allowedMethods`, CLOVER_ERR.ROLE_REFUSED), and a
// `userOnly` method only for the user (CLOVER_ERR.NOT_THE_USER).
import {
  allowedMethods, CLOVER_ERR, CLOVER_METHODS, type Caller, type CloverRole, type SessionKind,
} from "@waifucave/clover-protocol";
import { descendsFrom, type PeerFacts } from "../platform/caller-probe";
import type { CloverBinding, HelloRefusal } from "./clover-tokens";

/** The session a process belongs to: the daemon's record of the processes it started for sessions
 *  (a Bash call, an agent, a hook). The executors register them (C-M2's fence and the session host). */
export interface SessionRef { readonly sessionId: string; readonly sessionKind: SessionKind; readonly bot?: string }

export class SessionProcesses {
  private readonly byPid = new Map<number, SessionRef>();
  /** Every pid the daemon started for a bot, an agent or a plugin, whether or not it has a session. */
  private readonly spawned = new Set<number>();

  add(pid: number, session?: SessionRef): void {
    this.spawned.add(pid);
    if (session) this.byPid.set(pid, session);
  }
  remove(pid: number): void { this.spawned.delete(pid); this.byPid.delete(pid); }
  pids(): ReadonlySet<number> { return this.spawned; }
  /** The session of the nearest of `chain` (the peer, then its parents) the daemon started. */
  sessionOf(chain: readonly number[]): SessionRef | null {
    for (const pid of chain) { const s = this.byPid.get(pid); if (s) return s; }
    return null;
  }
}

export interface CallerInput {
  readonly binding: CloverBinding;
  /** The peer process, probed from the connection. */
  readonly peer: PeerFacts;
  readonly processes: SessionProcesses;
  /** The pid the daemon started a plugin-host process with, to check a plugin-host connection's peer. */
  readonly hostPid?: number;
}

const notTheUser = (message: string): HelloRefusal => ({ code: CLOVER_ERR.NOT_THE_USER, message });

/** Who a connection counts as, or why its hello is refused. */
export function resolveCloverCaller(input: CallerInput): Caller | HelloRefusal {
  const { binding, peer, processes } = input;
  const chain = peer.pid === null ? [] : [peer.pid, ...peer.ancestors];
  const underSpawned = descendsFrom(peer, processes.pids());
  const asUser = peer.floor === "outside-floor" && !underSpawned;
  switch (binding.role) {
    case "app":
      return asUser ? { kind: "user", client: "app" } : notTheUser("an app connection from inside a sandbox, or from a bot's process, is not the app");
    case "cli": {
      if (asUser) return { kind: "user", client: "cli" };
      const s = processes.sessionOf(chain);
      if (s) return { kind: "session", sessionId: s.sessionId, sessionKind: s.sessionKind, ...(s.bot ? { bot: s.bot } : {}) };
      return notTheUser("a CLI inside a sandbox that belongs to no session");
    }
    case "layer":
      return { kind: "plugin", pluginId: binding.pluginId };
    case "plugin-host":
      if (input.hostPid !== undefined && peer.pid !== null && peer.pid !== input.hostPid) {
        return { code: CLOVER_ERR.PROCESS_REFUSED, message: `this connection doesn't come from the ${binding.hostProcess} plugin-host process` };
      }
      return { kind: "plugin", pluginId: binding.hostProcess === "clover" ? "clover" : binding.pluginId ?? "shared" };
    case "bridge":
      return { kind: "session", sessionId: binding.agentSessionId, sessionKind: "agent" };
    case "remote":
      return { kind: "user", client: "ios", device: binding.device };
    case "web":
      return { kind: "user", client: "web", device: binding.device };
    case "peer":
      return { kind: "peer", device: binding.device };
  }
}

/** Whether a caller's work runs fenced: everything but the user and the core itself. A `peer` (another
 *  computer's session) is always fenced, whatever it claims (J-M1's review). */
export function isFencedCaller(caller: Caller): boolean {
  return caller.kind !== "user" && caller.kind !== "core";
}

/** The per-request gate for a Clover connection: the role's allow list, then `userOnly`. Returns the
 *  refusal, or null to dispatch. A `change` method from a plugin's layer is let through for the
 *  handler to turn into a sealed card (§5.5). */
export function gateCloverRequest(role: CloverRole, caller: Caller, method: string): HelloRefusal | null {
  if (!allowedMethods(role).has(method)) return { code: CLOVER_ERR.ROLE_REFUSED, message: `the ${role} role may not call ${method}` };
  const spec = CLOVER_METHODS.get(method)!;
  if (spec.userOnly && caller.kind !== "user") {
    if (role === "layer" && spec.change !== undefined) return null;
    return notTheUser(`${method} is the user's`);
  }
  return null;
}
