// Clover's roles and their tokens (spec §3.1; B's roles.ts; plan §4 C M1). Every client says hello with
// a role and proves it with a token, and the token is bound to what the connection may be:
//   app          this run's app token (`<home>/run/app.token`, minted at each daemon start; ruling R2)
//   cli          the user's terminal token, the inherited harness token in the OS secret store
//   layer        a token `layer.token` minted for one plugin's UI layer, bound to its plugin id
//   plugin-host  a token minted when the daemon starts a plugin-host process, bound to that process
//                (`clover`, `shared` or a plugin's `own`) and, where known, its pid: a hello naming
//                another process is refused (CLOVER_ERR.PROCESS_REFUSED), so a third-party worker can
//                never speak as the `clover` process (S4)
//   bridge       a token minted for one ACP agent session's bridge (§9.3), bound to that session
//   remote, web, peer   tokens the link's lanes mint for a paired device, bound to that device
// Minted tokens live in memory only, by SHA-256, for the daemon's run; none is ever logged.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CloverHelloParams, CloverRole, HostProcess } from "@waifucave/clover-protocol";
import { CLOVER_ERR } from "@waifucave/clover-protocol";

export type CloverBinding =
  | { readonly role: "app" }
  | { readonly role: "cli" }
  | { readonly role: "layer"; readonly pluginId: string }
  | { readonly role: "plugin-host"; readonly hostProcess: HostProcess; readonly pid?: number; readonly pluginId?: string }
  | { readonly role: "bridge"; readonly agentSessionId: string }
  | { readonly role: "remote" | "web" | "peer"; readonly device: string };

/** A refused hello: the JSON-RPC error code and a message that names no secret. */
export interface HelloRefusal { readonly code: number; readonly message: string }

/** JSON-RPC's own "unauthorized" in the inherited protocol (`ERR.UNAUTHORIZED`). */
export const ERR_UNAUTHORIZED = -32001;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(digest(a)), y = Buffer.from(digest(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface CloverTokensDeps {
  /** This run's app token (from `startDaemonPairSide`); undefined on a daemon with no pair side. */
  readonly appToken?: string;
  /** Check the user's terminal token (the inherited harness token). */
  verifyCli(token: string): Promise<boolean>;
}

export class CloverTokens {
  private readonly minted = new Map<string, CloverBinding>();

  constructor(private readonly deps: CloverTokensDeps) {}

  /** Mint a token for a binding the daemon decided (a layer, a plugin-host process it starts, a
   *  bridge, a paired device). The caller hands it to that party alone. */
  mint(binding: Exclude<CloverBinding, { role: "app" } | { role: "cli" }>): string {
    const token = randomBytes(32).toString("base64url");
    this.minted.set(digest(token), binding);
    return token;
  }

  /** Revoke one token, or every token whose binding matches. */
  revoke(token: string): void { this.minted.delete(digest(token)); }
  revokeWhere(match: (b: CloverBinding) => boolean): number {
    let n = 0;
    for (const [k, b] of this.minted) if (match(b)) { this.minted.delete(k); n++; }
    return n;
  }

  /** What a hello's token is bound to, or why it is refused. */
  async verify(hello: CloverHelloParams): Promise<CloverBinding | HelloRefusal> {
    const refused = (message = "invalid token for role"): HelloRefusal => ({ code: ERR_UNAUTHORIZED, message });
    switch (hello.role) {
      case "app":
        return this.deps.appToken !== undefined && same(hello.token, this.deps.appToken) ? { role: "app" } : refused();
      case "cli":
        return (await this.deps.verifyCli(hello.token)) ? { role: "cli" } : refused();
      default: break;
    }
    const b = this.minted.get(digest(hello.token));
    if (b === undefined || b.role !== hello.role) return refused();
    switch (b.role) {
      case "layer":
        return hello.pluginId === b.pluginId ? b : refused("the token is for another plugin's layer");
      case "plugin-host":
        if (hello.hostProcess !== b.hostProcess) {
          return { code: CLOVER_ERR.PROCESS_REFUSED, message: `this token is the ${b.hostProcess} plugin-host process's` };
        }
        return b;
      case "bridge":
        return hello.agentSessionId === b.agentSessionId ? b : refused("the token is for another agent session");
      case "remote": case "web": case "peer":
        return hello.device === b.device ? b : refused("the token is for another device");
      default:
        return refused();
    }
  }
}

export function isRefusal(x: CloverBinding | HelloRefusal): x is HelloRefusal {
  return "code" in x;
}

/** The roles whose tokens the daemon mints itself (the rest come from the pair and the secret store). */
export const MINTED_ROLES: readonly CloverRole[] = ["layer", "plugin-host", "bridge", "remote", "web", "peer"];
