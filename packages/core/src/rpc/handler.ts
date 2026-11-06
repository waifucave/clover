// The helpers every lane's protocol methods are written with (H-M1's ask: lanes D and H each had a copy): a handler
// checks its params with the method's own schema, acts as the caller the server gives it, and fails with the JSON-RPC
// code a client branches on. The server (lane C's endpoint, the link's peer side) applies the allow lists, the
// capabilities and `userOnly` before a handler runs; handlers check the caller again where they change something.
// Owner: lane B, for every lane that serves methods.
import { CLOVER_ERR, ERR, type Caller, type MethodSpec } from "@waifucave/clover-protocol";
import type { z } from "zod";
import { isContractError, RPC_ERROR_OF, type Unsubscribe } from "../contracts/common";

/** A JSON-RPC failure with the code a client branches on. Its message never holds a secret. */
export class MethodError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = "MethodError";
  }
}

/** The JSON-RPC error for anything a handler throws: a contract's failure by its code (`RPC_ERROR_OF`, or the detail's
 *  own `rpc`), anything else internal. */
export function toMethodError(err: unknown): MethodError {
  if (err instanceof MethodError) return err;
  if (isContractError(err)) {
    const rpc = typeof err.detail?.rpc === "number" ? err.detail.rpc : undefined;
    const code = rpc ?? RPC_ERROR_OF[err.code] ?? {
      not_found: ERR.NOT_FOUND, invalid: ERR.INVALID_PARAMS, refused: ERR.INVALID_REQUEST, closed: ERR.INVALID_REQUEST,
      conflict: ERR.INVALID_REQUEST, timeout: ERR.INTERNAL, cancelled: ERR.INTERNAL,
    }[err.code as string] ?? ERR.INTERNAL;
    return new MethodError(code, err.message, { code: err.code });
  }
  return new MethodError(ERR.INTERNAL, err instanceof Error ? err.message : String(err));
}

/** Who calls, and for a connection that takes events (`session.attach`), where they go: the connection's sender and
 *  what it follows, each with the unsubscribe the connection's close runs. */
export interface MethodContext {
  caller: Caller;
  stream?: { send(event: unknown): void; follows: Map<string, Unsubscribe> };
}

export type MethodHandler = (params: unknown, ctx: MethodContext) => Promise<unknown>;

/** Wraps an implementation in the method's params check and the error mapping. */
export function handler<S extends MethodSpec>(
  spec: S,
  impl: (params: z.output<S["params"]>, ctx: MethodContext) => Promise<z.input<S["result"]>> | z.input<S["result"]>,
): MethodHandler {
  return async (raw, ctx) => {
    const parsed = spec.params.safeParse(raw);
    if (!parsed.success) throw new MethodError(ERR.INVALID_PARAMS, `${spec.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ")}`);
    try {
      return await impl(parsed.data as z.output<S["params"]>, ctx);
    } catch (err) {
      throw toMethodError(err);
    }
  };
}

/** Refuses anyone but the user (`NOT_THE_USER`). */
export function requireUser(ctx: MethodContext, what: string): Extract<Caller, { kind: "user" }> {
  if (ctx.caller.kind !== "user") throw new MethodError(CLOVER_ERR.NOT_THE_USER, `only the user can ${what}`);
  return ctx.caller;
}
